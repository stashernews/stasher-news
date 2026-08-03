import { USER_ID } from '@/lib/constants'
import { Prisma } from '@prisma/client'
import payInTypeModules from './types'
import { isPessimistic, isProxyPayment, isWithdrawal } from './lib/is'
import { payInCreate } from './lib/payInCreate'
import { obtainRowLevelLocks } from './lib/obtainRowLevelLocks'
import { payInClone } from './lib/payInPrisma'

// grab a greedy connection for the payIn system on any server
// if we have lock contention of payIns, we don't want to block other queries
import createPrisma from '@/lib/create-prisma'
import { payInReplacePayOuts } from './lib/payInFailed'
import { GqlInputError, GqlPayInRetryRaceError } from '@/lib/error'
const models = createPrisma({ connectionParams: { connection_limit: 2 } })

export default async function pay (payInType, payInArgs, { me, custodialOnly, sendProtocolId } = {}) {
  try {
    const payInModule = payInTypeModules[payInType]

    if (!payInModule) {
      throw new Error(`Invalid payIn type ${payInType}`)
    }

    if (!me && !payInModule.anonable) {
      throw new Error('You must be logged in to perform this action')
    }

    me ??= { id: USER_ID.anon }

    if (payInModule.systemOnly) {
      if (!custodialOnly) {
        throw new Error('System payIns must be performed with custodialOnly set to true')
      }
      if (![USER_ID.rewards, USER_ID.sn].includes(me.id)) {
        throw new Error('You must be the rewards or sn user to perform this system-only action: ' + me.id)
      }
    }

    sendProtocolId = await resolveRequestedSendProtocolId(sendProtocolId, { me })
    console.group('payIn', payInType, payInArgs)

    const payIn = await payInModule.getInitial(models, payInArgs, { me, sendProtocolId })
    return await begin(models, payIn, payInArgs, { me, custodialOnly, sendProtocolId })
  } catch (e) {
    console.error('payIn failed', e)
    throw e
  } finally {
    console.groupEnd()
  }
}

// we lock all users in the payIn in order to avoid deadlocks with other payIns
// that might be competing to update the same users, e.g. two users simultaneously zapping each other
// https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
// alternative approaches:
// 1. do NOT lock all users, but use NOWAIT on users locks so that we can catch AND retry transactions that fail with a deadlock error
// anything we can do to minimize the time spent in these interactive txs would also help

// after begin and retry, we want to double check that the invoice we're assuming will be created is actually created
// so this is inserted atomically with the payIn creation
async function queueCheckPayInInvoiceCreation (tx, payInId) {
  // pg-boss v9 dropped the DB-side default on pgboss.job.id (uuids are now minted
  // by the JS client), so raw INSERTs must supply it themselves via gen_random_uuid.
  await tx.$executeRaw`INSERT INTO pgboss.job (id, name, data, startafter, priority)
    VALUES (gen_random_uuid(), 'checkPayInInvoiceCreation', jsonb_build_object('payInId', ${payInId}::INTEGER), now() + INTERVAL '60 seconds', 1000)`
}

async function begin (models, payInInitial, payInArgs, { me, custodialOnly, sendProtocolId }) {
  const { payIn, result, mCostRemaining } = await models.$transaction(async tx => {
    await obtainRowLevelLocks(tx, payInInitial)
    await payInTypeModules[payInInitial.payInType].validateBeforeCreate?.(tx, payInInitial, payInArgs, { me, sendProtocolId })
    const { payIn, mCostRemaining } = await payInCreate(tx, payInInitial, payInArgs, { me })

    if (mCostRemaining > 0n && custodialOnly) {
      throw new Error('Insufficient funds')
    }

    // if it's pessimistic, we don't perform the action until the invoice is held
    if (payIn.pessimisticEnv) {
      await queueCheckPayInInvoiceCreation(tx, payIn.id)

      return {
        payIn,
        mCostRemaining
      }
    }

    // if it's optimistic or already paid, we perform the action
    const result = await onBegin(tx, payIn.id, payInArgs)

    // if it's already paid, we run onPaid and do payOuts in the same transaction
    if (payIn.payInState === 'PAID') {
      await onPaid(tx, payIn.id, payInArgs)
      return {
        payIn,
        result,
        mCostRemaining: 0n
      }
    }

    await queueCheckPayInInvoiceCreation(tx, payIn.id)
    return {
      payIn,
      result,
      mCostRemaining
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 })

  return await afterBegin(models, { payIn, result, mCostRemaining }, { me, sendProtocolId, payInArgs })
}

export async function onBegin (tx, payInId, payInArgs, benefactorResult) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId }, include: { beneficiaries: true } })
  if (!payIn) {
    throw new Error('PayIn not found')
  }

  const result = await payInTypeModules[payIn.payInType].onBegin?.(tx, payIn.id, payInArgs, benefactorResult)

  for (const beneficiary of payIn.beneficiaries) {
    await onBegin(tx, beneficiary.id, payInArgs, result)
  }

  return result
}

async function afterBegin (models, { payIn, result, mCostRemaining }, { me, sendProtocolId, payInArgs }) {
  if (payIn.payInState === 'PAID') {
    onPaidSideEffects(models, payIn.id).catch(console.error)
    return {
      ...payIn,
      result: result ? { ...result, payIn } : undefined
    }
  } else if (payIn.payInState === 'PENDING_INVOICE_CREATION') {
    throw new Error('Monero payments not implemented')
  } else if (payIn.payInState === 'PENDING_INVOICE_WRAP') {
    throw new Error('Monero payments not implemented')
  } else if (payIn.payInState === 'PENDING_WITHDRAWAL') {
    throw new Error('Monero payments not implemented')
  } else {
    throw new Error('Invalid payIn begin state')
  }
}

// NOTE: I considered using Promise.all within these onFail and onPaid txs to avoid round trips to the database, but
// prisma does not support pipelining this way (or any other way afaict), but a lot of the
// deadlock and timeout risks of these interactive txs would be helped by such a thing
export async function onFail (tx, payInId) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId }, include: { beneficiaries: true } })
  if (!payIn) {
    throw new Error('PayIn not found')
  }

  // refund the custodial tokens
  for (const payInCustodialToken of payIn.payInCustodialTokens ?? []) {
    const isSats = payInCustodialToken.custodialTokenType === 'SATS'
    await tx.$executeRaw`
      WITH refunduser AS (
        UPDATE users
        SET msats = msats + ${isSats ? payInCustodialToken.mtokens : 0},
          mcredits = mcredits + ${!isSats ? payInCustodialToken.mtokens : 0}
        WHERE id = ${payIn.userId}
        RETURNING mcredits as "mcreditsAfter", msats as "msatsAfter"
      )
      INSERT INTO "RefundCustodialToken" ("payInId", "mtokens", "mtokensAfter", "custodialTokenType")
      SELECT ${payIn.id}, ${payInCustodialToken.mtokens}, ${isSats ? Prisma.sql`refunduser."msatsAfter"` : Prisma.sql`refunduser."mcreditsAfter"`}, ${payInCustodialToken.custodialTokenType}::"CustodialTokenType"
      FROM refunduser`
  }

  await payInTypeModules[payIn.payInType].onFail?.(tx, payInId)
  for (const beneficiary of payIn.beneficiaries) {
    await onFail(tx, beneficiary.id)
  }
}

export async function onPaid (tx, payInId) {
  const payIn = await tx.payIn.findUnique({
    where: { id: payInId },
    include: {
      beneficiaries: true
    }
  })
  if (!payIn) {
    throw new Error('PayIn not found')
  }

  await obtainRowLevelLocks(tx, payIn)

  if (!isWithdrawal(payIn) && !isProxyPayment(payIn)) {
    // most paid actions are eligible for a cowboy hat streak
    // pg-boss v9 dropped the DB-side default on pgboss.job.id (uuids are now minted
    // by the JS client), so this raw INSERT must supply it via gen_random_uuid.
    await tx.$executeRaw`
      INSERT INTO pgboss.job (id, name, data)
      VALUES (gen_random_uuid(), 'checkStreak', jsonb_build_object('id', ${payIn.userId}, 'type', 'COWBOY_HAT'))`
  }

  const payInModule = payInTypeModules[payIn.payInType]
  await payInModule.onPaid?.(tx, payInId)
  for (const beneficiary of payIn.beneficiaries) {
    await onPaid(tx, beneficiary.id)
  }
}

export async function onPaidSideEffects (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { beneficiaries: true } })
  if (!payIn) {
    throw new Error('PayIn not found')
  }

  await payInTypeModules[payIn.payInType].onPaidSideEffects?.(models, payInId)
  for (const beneficiary of payIn.beneficiaries) {
    await onPaidSideEffects(models, beneficiary.id)
  }
}

export async function retry (payInId, { me, sendProtocolId }) {
  let payInFailedInitial
  let shouldConsumeRetryAttempt = false
  try {
    const requestedSendProtocolId = await resolveRequestedSendProtocolId(sendProtocolId, { me })
    const include = {
      subPayIn: true,
      itemPayIn: true,
      uploadPayIns: true
    }
    const where = { id: payInId, userId: me.id, payInState: 'FAILED', successorId: null, benefactorId: null }

    payInFailedInitial = await models.payIn.findFirst({
      where,
      include: { ...include, beneficiaries: { include } }
    })
    if (!payInFailedInitial) {
      throw new GqlPayInRetryRaceError('PayIn with id ' + payInId + ' not found')
    }
    if (isWithdrawal(payInFailedInitial)) {
      throw new Error('Withdrawal payIns cannot be retried')
    }
    // the Bolt11 invoice that previously attributed a send protocol is gone; there is no
    // "previous protocol" to honor on retry
    const retrySendProtocolId = sendProtocolId !== undefined
      ? requestedSendProtocolId
      : await findOwnedEnabledSendProtocolId(undefined, { me })
    if (isPessimistic(payInFailedInitial, { me })) {
      // pessimistic payIns are fully re-executed without tracking
      return await pay(
        payInFailedInitial.payInType,
        { ...(payInFailedInitial.pessimisticEnv?.args ?? {}) },
        { me, sendProtocolId: retrySendProtocolId }
      )
    }
    await payInTypeModules[payInFailedInitial.payInType].validateRetry?.(models, payInFailedInitial, { me })
    shouldConsumeRetryAttempt = true

    const payInFailed = await payInReplacePayOuts(models, payInFailedInitial)

    const { payIn, result, mCostRemaining } = await models.$transaction(async tx => {
      const payInInitial = { ...payInClone(payInFailed), retryCount: payInFailed.retryCount + 1 }
      await obtainRowLevelLocks(tx, payInInitial)
      const { payIn, mCostRemaining } = await payInCreate(tx, payInInitial, undefined, { me })

      // use an optimistic lock on successorId on the payIn
      const rows = await tx.$queryRaw`UPDATE "PayIn" SET "successorId" = ${payIn.id} WHERE "id" = ${payInFailed.id} AND "successorId" IS NULL RETURNING id`
      if (rows.length === 0) {
        throw new GqlPayInRetryRaceError('PayIn with id ' + payInFailed.id + ' is already being retried')
      }

      // run the onRetry hook for the payIn and its beneficiaries
      const result = await payInTypeModules[payIn.payInType].onRetry?.(tx, payInFailed.id, payIn.id)
      for (const beneficiary of payIn.beneficiaries) {
        await payInTypeModules[beneficiary.payInType].onRetry?.(tx, beneficiary.id, payIn.id)
      }

      // if it's already paid, we run onPaid and do payOuts in the same transaction
      if (payIn.payInState === 'PAID') {
        await onPaid(tx, payIn.id, { me })
        return {
          payIn,
          result,
          mCostRemaining: 0n
        }
      }

      await queueCheckPayInInvoiceCreation(tx, payIn.id)

      return {
        payIn,
        result,
        mCostRemaining
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 })

    return await afterBegin(models, {
      payIn,
      result,
      mCostRemaining
    }, { me, sendProtocolId: retrySendProtocolId })
  } catch (e) {
    console.error('retry failed', e)
    if (shouldConsumeRetryAttempt && payInFailedInitial) {
      // consume an attempt only for the owned FAILED payIn lineage we are retrying
      // (e.g. replace payOuts/invoice setup failures) and never for unrelated ids.
      await models.payIn.updateMany({
        where: {
          id: payInFailedInitial.id,
          userId: me.id,
          payInState: 'FAILED',
          successorId: null,
          benefactorId: null
        },
        data: { retryCount: { increment: 1 } }
      }).catch(() => {})
    }
    throw e
  }
}

// sendProtocolId has three meanings at the API boundary:
// - undefined: no selection was supplied; retries may reuse the previous protocol if it is still usable
// - null: explicitly clear protocol attribution
// - any other value: explicitly select a protocol that must be owned, enabled, and send-capable
async function findOwnedEnabledSendProtocolId (sendProtocolId, { me }) {
  const protocolId = Number(sendProtocolId)
  if (!Number.isInteger(protocolId) || protocolId <= 0 || !me || Number(me.id) === USER_ID.anon) {
    return undefined
  }

  const protocol = await models.walletProtocol.findFirst({
    where: {
      id: protocolId,
      send: true,
      enabled: true,
      wallet: {
        userId: Number(me.id)
      }
    },
    select: {
      id: true
    }
  })

  return protocol?.id
}

async function resolveRequestedSendProtocolId (sendProtocolId, { me }) {
  if (sendProtocolId === undefined || sendProtocolId === null) {
    return sendProtocolId
  }

  const protocolId = await findOwnedEnabledSendProtocolId(sendProtocolId, { me })
  if (!protocolId) {
    throw new GqlInputError('invalid send protocol')
  }

  return protocolId
}
