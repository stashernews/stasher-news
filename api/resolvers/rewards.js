import { amountSchema, validateSchema } from '@/lib/validate'
import { getItem } from './item'
import { GqlInputError } from '@/lib/error'
import pay from '../payIn'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

let rewardCache

async function updateCachedRewards (models) {
  const rewards = await getActiveRewards(models)
  rewardCache = { rewards, createdAt: Date.now() }
  return rewards
}

async function getCachedActiveRewards (staleIn, models) {
  if (rewardCache) {
    const { rewards, createdAt } = rewardCache
    const expired = createdAt + staleIn < Date.now()
    if (expired) updateCachedRewards(models).catch(console.error)
    return rewards // serve stale rewards
  }
  return await updateCachedRewards(models)
}

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// Rewards earmark per the PlatformFeeConfig allocation split (spec §6.4):
// downvote 100% / posting 70% / turf 30% / wallet-less tips 50%. BigInt
// division floors each source independently, matching
// worker/rewardsDistributor.js.
function rewardsFromInflow (inflow, time, config) {
  const sourceShares = [
    { name: 'downvote', piconeros: toBigInt(inflow.downvote) * BigInt(config.downvoteRewardsPct) / 100n },
    { name: 'posting fee', piconeros: toBigInt(inflow.posting) * BigInt(config.postingFeeRewardsPct) / 100n },
    { name: 'turf fee', piconeros: toBigInt(inflow.territory) * BigInt(config.territoryFeeRewardsPct) / 100n },
    // donations and boosts go 100% to the pool
    { name: 'extra', piconeros: toBigInt(inflow.extra) },
    // wallet-less-author tips (TIP_UNWALLETED) go walletlessTipRewardsPct% to the pool
    { name: 'wallet-less tips', piconeros: toBigInt(inflow.walletlesstip) * BigInt(config.walletlessTipRewardsPct) / 100n }
  ]
  const sources = sourceShares.filter(s => s.piconeros > 0n).map(s => ({ name: s.name, value: s.piconeros.toString() }))
  const total = sourceShares.reduce((acc, s) => acc + s.piconeros, 0n)
  return { total, time, sources }
}

// Sum CONFIRMED platform-wallet inflow by source over [periodStart, periodEnd).
// Used by getRewards for the covering distribution's source pie. `confirmedAt`
// is a timestamp-without-timezone column holding UTC wall time; binding the JS
// Dates matches the worker's Prisma aggregate semantics exactly.
async function inflowByPeriod (periodStart, periodEnd, models) {
  const [{ downvote, posting, territory, extra, walletlesstip }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedDownvote" WHERE state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart} AND "confirmedAt" < ${periodEnd}), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart} AND "confirmedAt" < ${periodEnd}), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart} AND "confirmedAt" < ${periodEnd}), 0)::bigint AS territory,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('DONATE','BOOST') AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart} AND "confirmedAt" < ${periodEnd}), 0)::bigint AS extra,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'TIP_UNWALLETED' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart} AND "confirmedAt" < ${periodEnd}), 0)::bigint AS walletlesstip`
  return { downvote, posting, territory, extra, walletlesstip }
}

async function getActiveRewards (models) {
  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  const lastDistribution = await models.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
  const periodStart = lastDistribution?.periodEnd ?? new Date(Date.now() - WEEK_MS)
  const [{ downvote, posting, territory, extra, walletlesstip, time }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedDownvote" WHERE state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS territory,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('DONATE','BOOST') AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS extra,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'TIP_UNWALLETED' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS walletlesstip,
      (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 week') AT TIME ZONE 'UTC' AS time`

  return [rewardsFromInflow({ downvote, posting, territory, extra, walletlesstip }, time, config)]
}

async function getRewards (when, models) {
  if (when.length > 1) {
    throw new GqlInputError('too many dates')
  }
  for (const w of when) {
    if (isNaN(new Date(w))) {
      throw new GqlInputError('invalid date')
    }
  }

  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  // `when[0]` is 'YYYY-MM-DD'; Date parses a date-only ISO string as UTC midnight.
  const d = new Date(when[0])

  // Covering distribution = the most recent one whose period started at or before
  // the requested date. For any date after the first distribution began, this is
  // the latest distribution overall (so the current week shows last week's
  // payout); future dates still 404 via the page's `time` future-guard (time = d).
  const covering = await models.rewardDistribution.findFirst({
    where: { periodStart: { lte: d } },
    orderBy: { periodEnd: 'desc' }
  })

  if (covering) {
    const { sources } = rewardsFromInflow(
      await inflowByPeriod(covering.periodStart, covering.periodEnd, models), d, config)
    return [{
      total: covering.distributedPiconeros,
      time: d,
      sources,
      periodStart: covering.periodStart,
      periodEnd: covering.periodEnd
    }]
  }

  // Pre-first-distribution fallback: the requested UTC day's confirmed inflow.
  const [{ downvote, posting, territory, extra, walletlesstip }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedDownvote" WHERE state = 'CONFIRMED' AND "confirmedAt" >= ${d} AND "confirmedAt" < ${d} + interval '1 day'), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= ${d} AND "confirmedAt" < ${d} + interval '1 day'), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= ${d} AND "confirmedAt" < ${d} + interval '1 day'), 0)::bigint AS territory,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('DONATE','BOOST') AND state = 'CONFIRMED' AND "confirmedAt" >= ${d} AND "confirmedAt" < ${d} + interval '1 day'), 0)::bigint AS extra,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'TIP_UNWALLETED' AND state = 'CONFIRMED' AND "confirmedAt" >= ${d} AND "confirmedAt" < ${d} + interval '1 day'), 0)::bigint AS walletlesstip`
  return [rewardsFromInflow({ downvote, posting, territory, extra, walletlesstip }, d, config)]
}

export default {
  Query: {
    rewards: async (parent, { when }, { models }) =>
      when ? await getRewards(when, models) : await getCachedActiveRewards(10000, models),
    meRewards: async (parent, { when }, { me, models }) => {
      if (!me) {
        return null
      }
      if (!when || when.length > 1) {
        throw new GqlInputError('too many dates')
      }
      for (const w of when) {
        if (isNaN(new Date(w))) {
          throw new GqlInputError('invalid date')
        }
      }

      const d = new Date(when[0])
      const covering = await models.rewardDistribution.findFirst({
        where: { periodStart: { lte: d } },
        orderBy: { periodEnd: 'desc' }
      })
      if (!covering) return []

      return await models.$queryRaw`
        SELECT coalesce(sum(piconeros), 0) as total,
               json_agg(json_build_object('type', type, 'rank', rank, 'piconeros', piconeros, 'typeId', "typeId")) as rewards
        FROM "Earn"
        WHERE "Earn"."userId" = ${me.id}
          AND (type IS NULL OR type NOT IN ('FOREVER_REFERRAL', 'ONE_DAY_REFERRAL'))
          AND "Earn"."distributionId" = ${covering.id}
        GROUP BY "Earn"."distributionId"`
    }
  },
  Rewards: {
    total: async (parent, args, { models }) => {
      if (!parent.total) {
        return 0
      }
      return parent.total
    },
    // array_agg over an empty result set yields NULL; default to [] for the non-null schema field
    sources: (parent) => parent.sources ?? []
  },
  Mutation: {
    donateToRewards: async (parent, { piconeros, sendProtocolId }, { me, models }) => {
      await validateSchema(amountSchema, { amount: piconeros })

      return await pay('DONATE', { piconeros }, { me, models, sendProtocolId })
    }
  },
  Reward: {
    item: async (reward, args, { me, models }) => {
      if (!reward.typeId) {
        return null
      }

      return getItem(reward, { id: reward.typeId }, { me, models })
    }
  }
}
