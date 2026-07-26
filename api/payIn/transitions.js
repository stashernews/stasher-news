import { datePivot } from '@/lib/time'
import { Prisma, PayInState } from '@prisma/client'
import { onBegin, onFail, onPaid, onPaidSideEffects } from '.'
import { getPayInFailurePresentation } from '@/lib/pay-in'
import { PayInFailureReasonError } from './errors'

export const PAY_IN_TERMINAL_STATES = ['PAID', 'FAILED']
export const PAY_IN_PENDING_STATES = Object.values(PayInState).filter(state => !PAY_IN_TERMINAL_STATES.includes(state))

const FINALIZE_OPTIONS = { retryLimit: 2 ** 31 - 1, retryBackoff: false, retryDelay: 5, priority: 1000 }

class MissingPayInTransitionError extends Error {}

function logPayInWalletStatus (payIn, payInId, models, { level, message, protocolId = payIn.payInBolt11?.protocolId, userId = payIn.userId, context = {} }) {
  // Wallet logging removed - Monero integration pending
}

function logPayInWalletFailure (payIn, payInId, models, { level, protocolId, userId, context } = {}) {
  const presentation = getPayInFailurePresentation(payIn)
  if (!presentation) {
    return
  }

  logPayInWalletStatus(payIn, payInId, models, {
    level: level ?? presentation.level,
    message: presentation.logMessage,
    protocolId,
    userId,
    context
  })
}

async function transitionPayIn (jobName, data,
  { payInId, fromStates, toState, transitionFunc, cancelOnError },
  { models, boss }) {
  let payIn

  try {
    const include = { payInBolt11: true, payInCustodialTokens: true, payOutBolt11: true, pessimisticEnv: true, payOutCustodialTokens: true, beneficiaries: true }
    const currentPayIn = await models.payIn.findUnique({ where: { id: payInId }, include })

    console.group(`${jobName}: transitioning payIn ${payInId} from ${fromStates} to ${toState}`)

    if (!currentPayIn) {
      throw new MissingPayInTransitionError(`payIn ${payInId} not found before ${jobName}`)
    }

    if (PAY_IN_TERMINAL_STATES.includes(currentPayIn.payInState)) {
      console.log('payIn is already in a terminal state, skipping transition')
      return
    }

    if (!Array.isArray(fromStates)) {
      fromStates = [fromStates]
    }

    const transitionedPayIn = await models.$transaction(async tx => {
      payIn = await tx.payIn.update({
        where: {
          id: payInId,
          payInState: { in: fromStates }
        },
        data: {
          payInState: toState,
          beneficiaries: {
            updateMany: {
              data: {
                payInState: toState
              },
              where: {
                benefactorId: payInId
              }
            }
          }
        },
        include
      })

      if (!payIn) {
        console.log('record not found in our own concurrency check, assuming concurrent worker transitioned it')
        return
      }

      const updateFields = await transitionFunc({ tx, payIn })

      if (updateFields) {
        return await tx.payIn.update({
          where: { id: payIn.id },
          data: updateFields,
          include
        })
      }

      return payIn
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 60000
    })

    if (transitionedPayIn) {
      console.log('transition succeeded')
      return transitionedPayIn
    }
  } catch (error) {
    if (error instanceof MissingPayInTransitionError) {
      console.error(error.message)
      throw error
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        console.log('record not found, assuming concurrent worker transitioned it')
        return
      }
      if (error.code === 'P2034') {
        console.log('write conflict, assuming concurrent worker is transitioning it')
        return
      }
    }

    console.error('unexpected error', error)
    if (cancelOnError) {
      models.pessimisticEnv.updateMany({
        where: { payInId },
        data: {
          error: error.message
        }
      }).catch(e => console.error('failed to store payIn error', e))
      const reason = error instanceof PayInFailureReasonError
        ? error.payInFailureReason
        : 'EXECUTION_FAILED'
      boss.send('payInCancel', { payInId, payInFailureReason: reason }, FINALIZE_OPTIONS)
        .catch(e => console.error('failed to cancel payIn', e))
    } else {
      // retry the job
      boss.send(
        jobName,
        data,
        { startAfter: datePivot(new Date(), { seconds: 30 }), priority: 1000 })
        .catch(e => console.error('failed to retry payIn', e))
    }

    console.error(`${jobName} failed for payIn ${payInId}: ${error}`)
    throw error
  } finally {
    console.groupEnd()
  }
}

export async function payInWithdrawalPaid ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInWithdrawalFailed ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInPaid ({ data, models, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInForwarding ({ data, models, boss, lnd, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInForwarded ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInFailedForward ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInHeld ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInCancel ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

export async function payInFailed ({ data, models, lnd, boss, ...args }) {
  throw new Error('Monero payments not implemented')
}

function deducePayInFailureReason ({ payInFailureReason, payIn }) {
  if (payInFailureReason) {
    return payInFailureReason
  }
  if (payIn.payInFailureReason) {
    return payIn.payInFailureReason
  }
  if (payIn.payInState === 'PENDING_INVOICE_CREATION') {
    return 'INVOICE_CREATION_FAILED'
  }
  if (payIn.payInState === 'PENDING_INVOICE_WRAP') {
    return 'INVOICE_WRAPPING_FAILED_UNKNOWN'
  }
  if (payIn.payInState === 'FAILED_FORWARD') {
    return 'INVOICE_FORWARDING_FAILED'
  }
  if (payIn.payInState === 'PENDING_WITHDRAWAL') {
    return 'WITHDRAWAL_FAILED'
  }
  return 'UNKNOWN_FAILURE'
}