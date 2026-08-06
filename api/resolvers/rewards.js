import { amountSchema, validateSchema } from '@/lib/validate'
import { getItem } from './item'
import { GqlInputError } from '@/lib/error'
import pay from '../payIn'

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
// downvote 100% / posting 70% / turf 30%. BigInt division floors each source
// independently, matching worker/rewardsDistributor.js.
function rewardsFromInflow (inflow, time, config) {
  const sourceShares = [
    { name: 'downvote', piconeros: toBigInt(inflow.downvote) * BigInt(config.downvoteRewardsPct) / 100n },
    { name: 'posting fee', piconeros: toBigInt(inflow.posting) * BigInt(config.postingFeeRewardsPct) / 100n },
    { name: 'turf fee', piconeros: toBigInt(inflow.territory) * BigInt(config.territoryFeeRewardsPct) / 100n }
  ]
  const sources = sourceShares.filter(s => s.piconeros > 0n).map(s => ({ name: s.name, value: s.piconeros.toString() }))
  const total = sourceShares.reduce((acc, s) => acc + s.piconeros, 0n)
  return { total, time, sources }
}

async function getActiveRewards (models) {
  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  const [{ downvote, posting, territory, time }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedBurn" WHERE state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'), 0)::bigint AS territory,
      date_trunc('day', (now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago' AS time`

  return [rewardsFromInflow({ downvote, posting, territory }, time, config)]
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
  const [{ downvote, posting, territory, time }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedBurn" WHERE state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' AND "confirmedAt" < date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' + interval '1 day'), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' AND "confirmedAt" < date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' + interval '1 day'), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' AND "confirmedAt" < date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' + interval '1 day'), 0)::bigint AS territory,
      date_trunc('day', ${when[0]}::text::timestamptz AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago' AS time`

  return [rewardsFromInflow({ downvote, posting, territory }, time, config)]
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

      const results = await models.$queryRaw`
        WITH days_cte (day) AS (
          SELECT date_trunc('day', t)
          FROM generate_series(
            ${when[0]}::text::timestamp,
            ${when[when.length - 1]}::text::timestamp,
            interval '1 day') AS t
        )
        SELECT coalesce(sum(piconeros), 0) as total, json_agg("Earn".*) as rewards
        FROM days_cte
        CROSS JOIN LATERAL (
          (SELECT "Earn".piconeros as piconeros, type, rank, "typeId"
            FROM "Earn"
            WHERE "Earn"."userId" = ${me.id}
            AND (type IS NULL OR type NOT IN ('FOREVER_REFERRAL', 'ONE_DAY_REFERRAL'))
            AND date_trunc('day', "Earn".created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') = days_cte.day
            ORDER BY "Earn".piconeros DESC)
        ) "Earn"
        GROUP BY days_cte.day
        ORDER BY days_cte.day ASC`

      return results
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
