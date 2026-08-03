import { USER_ID, PAY_IN_NOTIFICATION_TYPES, WALLET_MAX_RETRIES, WALLET_RETRY_BEFORE_MS } from '@/lib/constants'
import { GqlAuthenticationError } from '@/lib/error'
import { retry } from '../payIn'
import { payInTypesSql } from '../payIn/lib/sql'
import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { getItem, getItemsById } from './item'
import { getSub } from './sub'
import { Prisma } from '@prisma/client'

function payInResultType (payInType) {
  switch (payInType) {
    case 'ITEM_CREATE':
    case 'ITEM_UPDATE':
    case 'BOUNTY_PAYMENT':
      return 'Item'
    case 'ZAP':
    case 'DOWN_ZAP':
    case 'BOOST':
      return 'ItemAct'
    case 'POLL_VOTE':
      return 'PollVote'
    case 'TERRITORY_CREATE':
    case 'TERRITORY_UPDATE':
    case 'TERRITORY_BILLING':
    case 'TERRITORY_UNARCHIVE':
      return 'Sub'
  }
}

function isMine (payIn, { me }) {
  const meId = me?.id ?? USER_ID.anon
  return Number(meId) === Number(payIn.userId)
}

async function hydratePayInItems (payIns, { me, models }) {
  const visibleItemPayIns = payIns.filter(payIn =>
    payIn.itemPayIn && !(!isMine(payIn, { me }) && payIn.payInType === 'DOWN_ZAP'))
  if (visibleItemPayIns.length === 0) return

  const items = await getItemsById(
    visibleItemPayIns.map(payIn => payIn.itemPayIn.itemId),
    { me, models }
  )
  const itemMap = new Map(items.map(item => [Number(item.id), item]))

  for (const payIn of visibleItemPayIns) {
    payIn.item = itemMap.get(Number(payIn.itemPayIn.itemId)) || null
  }
}

export async function getPayIn (parent, { id }, { me, models }) {
  const payIn = (await getPayInFull({
    models,
    query: Prisma.sql`SELECT * FROM "PayIn" WHERE "PayIn"."id" = ${id}`
  }))[0]

  if (!payIn) {
    throw new Error('PayIn not found')
  }

  const meId = me?.id ?? USER_ID.anon
  if (Number(payIn.userId) !== Number(meId) &&
    !payIn.payOutCustodialTokens.some(token => Number(token.userId) === Number(meId))) {
    throw new GqlAuthenticationError()
  }
  return payIn
}

export default {
  Query: {
    payIn: getPayIn,
    satistics: async (parent, { cursor, walletId }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const userId = me.id
      // StealthNews: per-wallet filtering was removed with the Lightning strip.
      if (walletId != null) {
        return { payIns: [], cursor: null }
      }

      const decodedCursor = decodeCursor(cursor)
      const offset = decodedCursor.offset
      const limit = LIMIT
      const walletSendFilter = Prisma.empty
      const walletReceiveFilter = Prisma.empty
      // StealthNews: the receive side of the activity feed was backed by the custodial
      // payout tables (PayOutCustodialToken, RefundCustodialToken), which are gone.
      // Monero tips are P2P and don't produce custodial receive-side payIns, so only the
      // user's own (send-side) payIns are surfaced here.
      const receivePredicate = Prisma.sql`AND FALSE`

      // why we need the union:
      // if we are paying in, we want a row for that when it's created, regardless of whether it's succeeded, pending, or failed
      //    that's because payInCustodialTokens are created when the payIn is created
      // if we are paid out, we want a row for that too if the payIn is paid or it failed and we are refunded
      //    that's because payOutCustodialTokens and refundCustodialTokens are created when the payIn is paid and refunded respectively
      // this helps provide a linear timeline of custodial token changes (ie mtokensAfter changes)
      const payIns = await getPayInFull({
        models,
        query: Prisma.sql`
          (
            SELECT "PayIn".*, created_at as "sortTime", true as "isSend"
            FROM "PayIn"
            WHERE "PayIn"."userId" = ${userId}
            AND "PayIn"."benefactorId" IS NULL
            AND "PayIn"."mcost" > 0
            AND "PayIn"."created_at" <= ${decodedCursor.time}
            ${walletSendFilter}
            ORDER BY "sortTime" DESC
            LIMIT ${limit + offset}
          )
          UNION ALL
          (
            SELECT "PayIn".*, "payInStateChangedAt" as "sortTime", false as "isSend"
            FROM "PayIn"
            WHERE "PayIn"."benefactorId" IS NULL
            AND "PayIn"."mcost" > 0
            AND "PayIn"."payInStateChangedAt" <= ${decodedCursor.time}
            ${walletReceiveFilter}
            ${receivePredicate}
            ORDER BY "sortTime" DESC
            LIMIT ${limit + offset}
          )
          ORDER BY "sortTime" DESC, "isSend" ASC
          OFFSET ${offset}
          LIMIT ${limit}`,
        orderBy: Prisma.sql`ORDER BY "sortTime" DESC, "isSend" ASC`
      })
      await hydratePayInItems(payIns, { me, models })

      return {
        payIns,
        cursor: payIns.length === LIMIT ? nextCursorEncoded(decodedCursor) : null
      }
    },
    failedPayIns: async (parent, args, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      return await models.$queryRaw`
          -- payIns whose most recent attempt failed, are not retried enough times yet,
          -- are not too old, and weren't manually cancelled
          SELECT "PayIn".*
          FROM "PayIn"
          WHERE "PayIn"."payInState" = 'FAILED'
          AND "PayIn"."payInType" IN (${payInTypesSql(PAY_IN_NOTIFICATION_TYPES)})
          AND "PayIn"."userId" = ${me.id}
          AND "PayIn"."successorId" IS NULL
          AND "PayIn"."benefactorId" IS NULL
          AND "PayIn"."payInFailureReason" <> 'USER_CANCELLED'
          AND "PayIn"."payInStateChangedAt" > now() - ${`${WALLET_RETRY_BEFORE_MS} milliseconds`}::interval
          AND "PayIn"."retryCount" < ${WALLET_MAX_RETRIES}
          ORDER BY "PayIn"."payInStateChangedAt" ASC`
    }
  },
  Mutation: {
    retryPayIn: async (parent, { payInId, sendProtocolId }, { models, me }) => {
      return await retry(payInId, { me, sendProtocolId })
    }
  },
  PayIn: {
    payerPrivates: (payIn, args, { models, me }) => {
      if (!isMine(payIn, { me })) {
        return null
      }
      return payIn
    },
    item: async (payIn, args, { models, me }) => {
      // downzaps are private to the payer
      if (!payIn.itemPayIn || (!isMine(payIn, { me }) && payIn.payInType === 'DOWN_ZAP')) {
        return null
      }
      if (typeof payIn.item !== 'undefined') {
        return payIn.item
      }
      return await getItem(payIn, { id: payIn.itemPayIn.itemId }, { me, models })
    },
    walletInfo: () => {
      // StealthNews: walletInfo was backed by Lightning wallet protocols, which are
      // gone with the Monero strip — there is never a wallet to report.
      return null
    },
    payOutCustodialTokens: async (payIn, args, { models, me }) => {
      const payOutCustodialTokens = [
        ...(payIn.payOutCustodialTokens ?? []),
        ...(payIn.beneficiaries ?? []).reduce((acc, beneficiary) => {
          if (beneficiary.payOutCustodialTokens) {
            return [...acc, ...beneficiary.payOutCustodialTokens]
          }
          return acc
        }, [])
      ]

      // obscure rewards if they are not mine
      if (payIn.payInType === 'REWARDS') {
        const meId = Number(me.id)
        const myReward = payOutCustodialTokens.find(t => t.payOutType === 'REWARD' && Number(t.userId) === Number(meId))
        const remainingOtherReward = payOutCustodialTokens.find(t => t.payOutType === 'REWARD' && Number(t.userId) !== Number(meId))
        const visibleRewards = myReward ? [myReward] : []
        if (remainingOtherReward) {
          const remainingRewardMtokens = BigInt(payIn.mcost) - BigInt(myReward?.mtokens ?? 0)
          if (remainingRewardMtokens > 0) {
            visibleRewards.push({
              id: remainingOtherReward.id,
              payOutType: 'REWARD',
              mtokens: remainingRewardMtokens,
              custodialTokenType: 'SATS'
            })
          }
        }
        return visibleRewards
      }

      // StealthNews: the routing-fee hiding branch was driven by Lightning pay-out
      // membership, which is gone with the Monero strip — there is nothing to obscure,
      // so the full custodial token list is always visible.
      return payOutCustodialTokens
    }
  },
  PayOutCustodialToken: {
    privates: (payOutCustodialToken, args, { models, me }) => {
      if (!isMine(payOutCustodialToken, { me })) {
        return null
      }
      return payOutCustodialToken
    },
    sometimesPrivates: (payOutCustodialToken, args, { models, me }) => {
      if (!isMine(payOutCustodialToken, { me }) && payOutCustodialToken.payOutType !== 'ZAP') {
        return null
      }
      return payOutCustodialToken
    },
    sub: async (payOutCustodialToken, args, { models }) => {
      if (payOutCustodialToken.sub) {
        return payOutCustodialToken.sub
      }
      if (payOutCustodialToken.subPayOutCustodialToken) {
        return payOutCustodialToken.subPayOutCustodialToken.sub
      }
      if (payOutCustodialToken.subId == null) {
        return null
      }
      return await models.sub.findUnique({ where: { id: payOutCustodialToken.subId } })
    }
  },
  PayerPrivates: {
    payInCustodialTokens: (payIn, args, { me }) =>
      (payIn.payInCustodialTokens ?? []).map(token => ({
        ...token,
        mtokensAfter: isMine(payIn, { me }) ? token.mtokensAfter : null
      })),
    refundCustodialTokens: (payIn, args, { me }) =>
      (payIn.refundCustodialTokens ?? []).map(token => ({
        ...token,
        mtokensAfter: isMine(payIn, { me }) ? token.mtokensAfter : null
      })),
    pessimisticEnv: (payIn) => payIn.pessimisticEnv ?? null,
    result: (payIn, args, { models, me }) => {
      // if the payIn was paid pessimistically, the result is permanently in the pessimisticEnv
      const result = payIn.result || payIn.pessimisticEnv?.result
      if (result) {
        const __typename = payInResultType(payIn.payInType)
        if (payIn.payInType === 'BOUNTY_PAYMENT' && __typename === 'Item') {
          // Bounty result items should not carry item-creation payIn metadata.
          return { ...result, payIn: null, __typename }
        }
        return { ...result, __typename }
      }
      return null
    },
    invite: async (payIn, args, { models, me }) => {
      return payIn.payOutCustodialTokens.find(token => token.payOutType === 'INVITE_GIFT')?.user?.invite
    },
    sub: async (payIn, args, { models, me }) => {
      if (!payIn.subPayIn) {
        return null
      }
      return await getSub(payIn, { name: payIn.subPayIn.subName }, { models, me })
    }
  }
}

/*
  getPayInFull mimics a Prisma query with the same includes, but uses raw SQL
  so we can do more complex selection of payIns

  const INCLUDE_PAYOUT_CUSTODIAL_TOKENS = {
    include: {
      user: {
        include: {
          invite: true
        }
      },
      subPayOutCustodialToken: {
        include: {
          sub: true
        }
      }
    }
  }

  const INCLUDE = {
    pessimisticEnv: true,
    payInCustodialTokens: true,
    payOutCustodialTokens: INCLUDE_PAYOUT_CUSTODIAL_TOKENS,
    beneficiaries: {
      include: {
        payOutCustodialTokens: INCLUDE_PAYOUT_CUSTODIAL_TOKENS
      }
    },
    itemPayIn: true,
    subPayIn: true
  }
*/

async function getPayInFull ({ models, query, orderBy = Prisma.empty }) {
  // StealthNews: the custodial/Lightning pay-in/out tables (PayOutCustodialToken,
  // PayInCustodialToken, RefundCustodialToken, PessimisticEnv, SubPayOutCustodialToken,
  // ...) were removed in the Monero strip. The Lightning wallet history this query fed
  // is obsolete; a Monero wallet history is a separate feature. We return the bare PayIn
  // rows plus the surviving ItemPayIn/SubPayIn links, and default the removed relations
  // to null/empty so the PayIn field resolvers take their fast path and never fall
  // through to the (also removed) lazy-load Prisma models.
  const rows = await models.$queryRaw`
    WITH payins AS (
      ${query}
    )
    SELECT
      p.*,
      p.created_at AS "createdAt",
      p.updated_at AS "updatedAt",
      ip."itemPayIn",
      sp."subPayIn"
    FROM payins p
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x.*) AS "itemPayIn"
      FROM "ItemPayIn" x
      WHERE x."payInId" = p.id
      ORDER BY x.id
      LIMIT 1
    ) ip ON true
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x.*) AS "subPayIn"
      FROM "SubPayIn" x
      WHERE x."payInId" = p.id
      ORDER BY x.id
      LIMIT 1
    ) sp ON true
    ${orderBy}`

  return rows.map(r => ({
    ...r,
    pessimisticEnv: null,
    payInCustodialTokens: [],
    payOutCustodialTokens: [],
    beneficiaries: [],
    refundCustodialTokens: []
  }))
}
