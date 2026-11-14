import { amountSchema, validateSchema } from '@/lib/validate'
import { getItem } from './item'
import { GqlInputError } from '@/lib/error'
import pay from '../payIn'
import { getNextRewardsPool, readNextRewardsPool, rewardsFromInflow } from '@/lib/rewardsPool'
import { POOL_HEALTH_WEEKS, poolHealth } from '@/lib/rewardsPoolHealth'
import { readRewardsInflow } from '../monero/rewardsInflow'
import { resolveCuratorBudgetConfig, DRAWDOWN_WEEKS_MIN, DRAWDOWN_WEEKS_MAX } from '@/lib/curatorBudget'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { logError } from '@/lib/logger'
import {
  incomeFromInflow,
  planCuratorBudget,
  readTrustWeighting
} from '@/worker/curatorBudget'
import { budgetMinTipPiconeros, resolveCuratorShareConfig, resolveExcludedCuratorIds } from '@/worker/curatorShares'
import { resolveContributorPoolConfig } from '@/lib/contributorPool'
import { nextUtcWeekStart } from '@/lib/utcWeek'
import { decideContributorMode, selectContributorCandidates, selectContributorWinners, prepareContributorRun } from '@/worker/contributorPoolRun'
import { isSerializationFailure, withSavepoint } from '@/lib/rewardsPlanning'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TARGET_MULT_BPS = 15000
// A fallback curatorBudget projection (refresh failure or invalid config)
// holds only this long before the next caller retries the live walk, so a
// transient DB failure can never pin the fallback cap on the UI for a day.
const CURATOR_FALLBACK_RETRY_MS = 60 * 1000

let rewardCache
let curatorBudgetCache
let contributorPoolCache
const CONTRIBUTOR_POOL_STALE_MS = 5 * 60 * 1000
let poolHealthCache

// The next 12:00 UTC strictly after t (t exactly at noon -> tomorrow noon).
// The daily expiry anchor for the curatorBudget projection and pool health:
// weekly-scale figures that only need one refresh a day, at a predictable
// mid-day moment away from the Monday 00:00 UTC distribution run.
function nextNoonUtcAfter (t) {
  const d = new Date(t)
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)
  return t < noon ? noon : noon + DAY_MS
}

// At most one refresh in flight per cache. Every caller that arrives while a
// refresh is running — cold start or TTL expiry — shares that ONE refresh
// transaction instead of each opening its own. Without this, each footer
// poll/pageview landing inside an expiry window spawned its own Serializable
// transaction; the concurrent refreshes exhausted the Prisma connection pool
// (P2028 on new transactions, multi-second queue waits on every other query).
// A rejected refresh clears the slot so the next caller retries.
function singleFlight (refresh) {
  let inFlight = null
  return models => {
    if (!inFlight) {
      inFlight = refresh(models)
      // settled (either way) clears the slot; the handled rejection branch
      // keeps the clearing chain itself rejection-free (and stands in for
      // any future call site that fails to handle the background refresh)
      inFlight.then(() => {}, () => {}).then(() => { inFlight = null })
    }
    return inFlight
  }
}

async function updateCachedRewards (models) {
  const rewards = await getActiveRewards(models)
  rewardCache = { rewards, createdAt: Date.now() }
  return rewards
}

const refreshActiveRewards = singleFlight(updateCachedRewards)

async function getCachedActiveRewards (staleIn, models) {
  if (rewardCache) {
    const { rewards, createdAt } = rewardCache
    const expired = createdAt + staleIn < Date.now()
    if (expired) refreshActiveRewards(models).catch(console.error)
    return rewards // serve stale rewards
  }
  return await refreshActiveRewards(models)
}

const minBigInt = (a, b) => (a < b ? a : b)

function targetMultBpsFor (resolved, config) {
  for (const value of [resolved?.params?.multBps, config?.curatorBudgetMultBps]) {
    if (Number.isSafeInteger(value)) return value
  }
  return DEFAULT_TARGET_MULT_BPS
}

// The configured drawdown weeks W (valid 4..104). Exposed so the
// copy can quote the ACTUAL configuration instead of hardcoding the 13-week
// ledger default; null when nothing valid is configured — an out-of-range W
// fails closed to LEGACY anyway, so no limit sentence is ever rendered from it.
function drawdownWeeksFor (resolved) {
  const weeks = resolved?.params?.drawdownWeeks
  return Number.isSafeInteger(weeks) && weeks >= DRAWDOWN_WEEKS_MIN && weeks <= DRAWDOWN_WEEKS_MAX
    ? weeks
    : null
}

// Safe projection returned on ANY read/planning failure. The page must never
// fail because the projection is unavailable; the administrator config is
// still shown, and the fixed fallback cap applies that week. Before the pool is
// known, the cap itself is the truthful upper bound ("Up to ..."), never zero.
function fallbackCuratorBudget ({
  mode = 'LEGACY',
  targetMultBps = DEFAULT_TARGET_MULT_BPS,
  drawdownWeeks = null,
  poolPiconeros = CURATOR_FALLBACK_CAP_PICONEROS
} = {}) {
  return {
    mode,
    fallbackBudgetPiconeros: minBigInt(poolPiconeros, CURATOR_FALLBACK_CAP_PICONEROS),
    projectedPiconeros: null,
    multBps: null,
    targetMultBps,
    t4Piconeros: null,
    targetPiconeros: null,
    drawdownWeeks,
    dynamicBudgetMode: null,
    windingDown: false,
    breakerTripped: false
  }
}

async function getLiveCuratorBudget (models) {
  let fallback = fallbackCuratorBudget()
  try {
    return await models.$transaction(async tx => {
      const config = await tx.platformFeeConfig.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 }
      })
      const resolved = resolveCuratorBudgetConfig(config)
      const targetMultBps = targetMultBpsFor(resolved, config)
      const drawdownWeeks = drawdownWeeksFor(resolved)
      // The configured mode is known even if the pool read fails; the cap is
      // the pre-pool upper bound. Once the pool is read below, use min(pool, cap).
      fallback = fallbackCuratorBudget({ mode: resolved.mode, targetMultBps, drawdownWeeks })

      const lastDistribution = await tx.rewardDistribution.findFirst({
        orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }]
      })
      const periodEnd = new Date()
      const periodStart = lastDistribution?.periodEnd ??
        new Date(periodEnd.getTime() - 7 * DAY_MS)

      const pool = await readNextRewardsPool(tx, config)
      fallback = fallbackCuratorBudget({
        mode: resolved.mode,
        targetMultBps,
        drawdownWeeks,
        poolPiconeros: pool.poolPiconeros
      })

      // F excludes donations: a donation raises the pool but never
      // the weekly run rate.
      const inflow = await readRewardsInflow(tx, {
        start: periodStart,
        end: periodEnd,
        config
      })
      const incomePiconeros = incomeFromInflow(inflow)
      // T is weighted by the budget's own trust floor, not the share floor.
      const {
        budgetTrustWeightFloor: trustWeightFloor,
        budgetTrustStale: trustStale
      } = await readTrustWeighting(tx, config)

      const budgetPlan = await planCuratorBudget(tx, {
        periodStart,
        periodEnd,
        poolPiconeros: pool.poolPiconeros,
        incomePiconeros,
        config,
        excludedCuratorIds: resolveExcludedCuratorIds(config.distributionExcludedCuratorIds),
        trustWeightFloor,
        trustStale,
        minTipPiconeros: budgetMinTipPiconeros(resolveCuratorShareConfig(config)),
        previousDistribution: lastDistribution,
        fallbackCapPiconeros: CURATOR_FALLBACK_CAP_PICONEROS
      })
      const record = budgetPlan.record
      let projectedPiconeros = record.dynamicBudgetPiconeros ?? null
      let multBps = record.multBps ?? null
      const decision = decideContributorMode(config, budgetPlan)
      if (decision.effectiveMode === 'ACTIVE') {
        try {
          const prepared = await withSavepoint(tx, async () => {
            const run = await selectContributorWinners(tx, {
              decision,
              budgetPlan,
              poolPiconeros: pool.poolPiconeros,
              weekStart: nextMondayUtc(periodEnd),
              excludedCuratorIds: resolveExcludedCuratorIds(config.distributionExcludedCuratorIds)
            })
            return prepareContributorRun({ decision, ...run, minPayout: BigInt(config.distributionMinPayoutPiconeros ?? 0) })
          })
          if (prepared.funding) {
            projectedPiconeros = prepared.funding.curatorBudget
            if (projectedPiconeros !== budgetPlan.appliedCuratorBudgetPiconeros && record.tipT4Piconeros > 0n) {
              multBps = Number(projectedPiconeros * 10000n / record.tipT4Piconeros)
            }
          }
        } catch (err) {
          if (isSerializationFailure(err)) throw err
          // Match distribution failure isolation: no contributor funding,
          // retain the valid curator plan, not the global fallback cap.
          logError({ code: err?.code, phase: 'contributor-budget-projection' },
            'curatorBudget: contributor selection unavailable; curator budget unchanged')
        }
      }

      // "Pool winding down": the last two RECORDED runs must both
      // have ended in DRAWDOWN. The live projection itself never counts, so a
      // one-off binding cannot flash the label, and a NULL outcome (pre-feature
      // or backfilled row) does not satisfy the condition.
      const recentRuns = await tx.rewardDistribution.findMany({
        orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }],
        take: 2,
        select: { dynamicBudgetMode: true }
      })
      const windingDown = recentRuns.length === 2 &&
        recentRuns.every(row => row.dynamicBudgetMode === 'DRAWDOWN')

      // This week's target from the budget's own inputs: T4 x configured k + the
      // approved make-up — the same arithmetic the pure function used, exposed
      // so the page can compare the limit against what the budget needs.
      const targetPiconeros = record.tipT4Piconeros != null
        ? BigInt(record.tipT4Piconeros) * BigInt(targetMultBps) / 10000n +
          (record.makeupPiconeros == null ? 0n : BigInt(record.makeupPiconeros))
        : null

      return {
        mode: resolved.mode,
        fallbackBudgetPiconeros: minBigInt(pool.poolPiconeros, CURATOR_FALLBACK_CAP_PICONEROS),
        projectedPiconeros,
        multBps,
        targetMultBps,
        t4Piconeros: record.tipT4Piconeros ?? null,
        targetPiconeros,
        drawdownWeeks,
        dynamicBudgetMode: record.dynamicBudgetMode ?? null,
        windingDown,
        breakerTripped: record.breakerTripped === true
      }
    }, { isolationLevel: 'Serializable', timeout: 10000 })
  } catch (err) {
    logError(
      { code: err?.code, phase: 'curator-budget-projection' },
      'curatorBudget: live projection unavailable; serving the fallback cap'
    )
    return fallback
  }
}

async function updateCachedCuratorBudget (models) {
  const curatorBudget = await getLiveCuratorBudget(models)
  // The projection is a weekly-scale figure: a live result holds until the
  // next mid-day UTC slot, so the heavy Serializable walk runs once a day.
  // A fallback result holds only for the short retry window instead.
  const now = Date.now()
  const staleIn = curatorBudget.projectedPiconeros == null
    ? CURATOR_FALLBACK_RETRY_MS
    : nextNoonUtcAfter(now) - now
  curatorBudgetCache = { curatorBudget, createdAt: now, staleIn }
  return curatorBudget
}

const refreshCuratorBudget = singleFlight(updateCachedCuratorBudget)

async function getCachedCuratorBudget (models) {
  if (curatorBudgetCache) {
    const { curatorBudget, createdAt, staleIn } = curatorBudgetCache
    const expired = createdAt + staleIn < Date.now()
    if (expired) refreshCuratorBudget(models).catch(console.error)
    return curatorBudget // serve stale projection
  }
  return await refreshCuratorBudget(models)
}

// The active cycle publishes this cycle's income by source and the next
// distribution slot, but no total: the pool total (and the rollover it
// contains) is the reserve, which is never advertised. The rollover is
// therefore never a source either; the footer and /rewards show the curator
// budget and pool health instead.
async function getActiveRewards (models) {
  const { time, sources } = await getNextRewardsPool(models)
  return [{ total: null, time, sources }]
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
    // Same reader/window as the distributor that created the covering row.
    const inflow = await readRewardsInflow(models, { start: covering.periodStart, end: covering.periodEnd, config })
    const { sources } = rewardsFromInflow(inflow.raw, d, config)
    return [{
      total: covering.distributedPiconeros,
      time: d,
      sources,
      periodStart: covering.periodStart,
      periodEnd: covering.periodEnd
    }]
  }

  // Pre-first-distribution fallback: the requested UTC day's confirmed inflow,
  // read through the same shared reader.
  const inflow = await readRewardsInflow(models, { start: d, end: new Date(d.getTime() + DAY_MS), config })
  return [rewardsFromInflow(inflow.raw, d, config)]
}

// Next Monday 00:00 UTC: the upcoming run's weekStart.
export const nextMondayUtc = nextUtcWeekStart

// Recorded winners (or would-have-won in SHADOW) of the latest run, from the
// stored snapshot. Only item id, rank and amount leave this function.
function lastContributorRun (row) {
  if (!row) return null
  const scored = Array.isArray(row.contributorParams?.scored) ? row.contributorParams.scored : []
  const results = scored
    .filter(s => s.rank != null)
    .sort((a, b) => a.rank - b.rank)
    .map(s => ({ rank: s.rank, piconeros: BigInt(s.share ?? 0), itemId: s.itemId }))
    .filter(r => r.piconeros > 0n)
  return {
    periodEnd: row.periodEnd,
    mode: row.contributorPoolMode,
    budgetPiconeros: row.contributorBudgetPiconeros ?? 0n,
    results
  }
}

async function readContributorMode (models) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const resolved = resolveContributorPoolConfig(config)
  let mode = resolved.ok ? resolved.mode : 'OFF'
  // ACTIVE only pays while the curator budget is ACTIVE too; otherwise the run
  // behaves as SHADOW (a planning fallback on the day cannot be known here).
  if (mode === 'ACTIVE') {
    const curator = resolveCuratorBudgetConfig(config)
    if (!curator.ok || curator.mode !== 'ACTIVE') mode = 'SHADOW'
  }
  return { config, resolved, mode }
}

async function loadContributorPool (models) {
  const { config, resolved, mode } = await readContributorMode(models)
  if (mode === 'OFF') return { mode, lastRun: null, candidates: [] }

  const row = await models.rewardDistribution.findFirst({
    where: { contributorPoolMode: { in: ['SHADOW', 'ACTIVE'] } },
    orderBy: { periodEnd: 'desc' },
    select: { periodEnd: true, contributorPoolMode: true, contributorBudgetPiconeros: true, contributorParams: true }
  })
  let candidates = []
  try {
    // Heavy read on a public page: cached for CONTRIBUTOR_POOL_STALE_MS.
    const selection = await selectContributorCandidates(models, {
      weekStart: nextMondayUtc(),
      decision: { configuredMode: resolved.mode, effectiveMode: mode, resolved },
      excludedCuratorIds: resolveExcludedCuratorIds(config.distributionExcludedCuratorIds)
    })
    candidates = selection.winners.map((w, i) => ({ rank: i + 1, itemId: w.itemId }))
  } catch (err) {
    logError({ err: err?.message }, 'rewards: contributor candidates unavailable')
  }
  return { mode, lastRun: lastContributorRun(row), candidates }
}

// `lastRun` and `candidates` resolve concurrently: share one refresh in flight.
let contributorPoolRefresh = null

async function updateCachedContributorPool (models) {
  contributorPoolRefresh ??= loadContributorPool(models)
    .then(pool => {
      contributorPoolCache = { pool, createdAt: Date.now() }
      return pool
    })
    .finally(() => { contributorPoolRefresh = null })
  return await contributorPoolRefresh
}

// Same stale-while-revalidate style as getCachedCuratorBudget.
async function getCachedContributorPool (staleIn, models) {
  if (contributorPoolCache) {
    const { pool, createdAt } = contributorPoolCache
    if (createdAt + staleIn < Date.now()) updateCachedContributorPool(models).catch(console.error)
    return pool
  }
  return await updateCachedContributorPool(models)
}

// test seam
export function resetContributorPoolCache () { contributorPoolCache = null; contributorPoolRefresh = null }

// Trend, runway range and activity totals over COMPLETE distributions. Every
// figure is a label, a share, a count or a single payout size: nothing here
// can be multiplied back into the reserve (lib/rewardsPoolHealth.js).
async function getPoolHealth (models) {
  return await models.$transaction(async tx => {
    const config = await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    const rows = await tx.rewardDistribution.findMany({
      where: { status: 'COMPLETE' },
      orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }],
      take: POOL_HEALTH_WEEKS + 1,
      select: { id: true, poolPiconeros: true, distributedPiconeros: true, rolledOverPiconeros: true }
    })
    const pool = await readNextRewardsPool(tx, config)
    const health = poolHealth({ rows, poolPiconeros: pool.poolPiconeros })

    const distributionCount = await tx.rewardDistribution.count({ where: { status: 'COMPLETE' } })
    const byState = await tx.rewardPayout.groupBy({ by: ['state'], _count: { _all: true } })
    const countOf = state => byState.find(row => row.state === state)?._count?._all ?? 0
    const paid = countOf('SENT') + countOf('CONFIRMED')
    const settled = paid + countOf('FAILED')
    const curators = await tx.rewardPayout.findMany({
      where: { state: { in: ['SENT', 'CONFIRMED'] } },
      distinct: ['curatorId'],
      select: { curatorId: true }
    })
    const recent = await tx.rewardPayout.findMany({
      where: {
        distributionId: { in: rows.slice(0, POOL_HEALTH_WEEKS).map(row => row.id) },
        state: { in: ['SENT', 'CONFIRMED'] }
      },
      select: { piconeros: true }
    })

    return {
      ...health,
      distributionCount,
      payoutCount: paid,
      curatorCount: curators.length,
      // SENT is the settled state (CONFIRMED is never set today), so delivery
      // is paid over paid + failed.
      deliveredPayoutBps: settled > 0 ? Math.floor(paid * 10000 / settled) : null,
      medianPayoutPiconeros: median(recent.map(row => BigInt(row.piconeros)))
    }
  }, { isolationLevel: 'Serializable', timeout: 10000 })
}

function median (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n
}

async function updateCachedPoolHealth (models) {
  const health = await getPoolHealth(models)
  // Trend/runway labels move on weekly distributions: the same daily
  // mid-day UTC anchor applies.
  const now = Date.now()
  poolHealthCache = {
    health,
    createdAt: now,
    staleIn: nextNoonUtcAfter(now) - now
  }
  return health
}

const refreshPoolHealth = singleFlight(updateCachedPoolHealth)

async function getCachedPoolHealth (models) {
  if (poolHealthCache) {
    const { health, createdAt, staleIn } = poolHealthCache
    if (createdAt + staleIn < Date.now()) refreshPoolHealth(models).catch(console.error)
    return health
  }
  return await refreshPoolHealth(models)
}

export default {
  Query: {
    // Cheap on purpose (one config row): the post form asks only for the mode.
    // lastRun and candidates are resolved lazily and cached below.
    contributorPool: async (parent, args, { models }) =>
      ({ mode: (await readContributorMode(models)).mode }),
    rewards: async (parent, { when }, { models }) =>
      when ? await getRewards(when, models) : await getCachedActiveRewards(10000, models),
    curatorBudget: async (parent, args, { models }) =>
      await getCachedCuratorBudget(models),
    rewardsPoolHealth: async (parent, args, { models }) =>
      await getCachedPoolHealth(models),
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

      const rows = await models.$queryRaw`
        SELECT coalesce(sum(piconeros), 0) as total,
               json_agg(json_build_object('type', type, 'rank', rank, 'piconeros', piconeros::text, 'typeId', "typeId")) as rewards
        FROM "Earn"
        WHERE "Earn"."userId" = ${me.id}
          AND (type IS NULL OR type NOT IN ('FOREVER_REFERRAL', 'ONE_DAY_REFERRAL'))
          AND "Earn"."distributionId" = ${covering.id}
        GROUP BY "Earn"."distributionId"`
      return rows.map(r => ({ ...r, total: BigInt(r.total.toString()) }))
    }
  },
  Rewards: {
    // null for the active cycle: its pool total is never published
    total: (parent) => parent.total ?? null,
    // array_agg over an empty result set yields NULL; default to [] for the non-null schema field
    sources: (parent) => parent.sources ?? []
  },
  Mutation: {
    donateToRewards: async (parent, { piconeros, rewardsPct, sendProtocolId }, { me, models }) => {
      await validateSchema(amountSchema, { amount: piconeros })
      if (rewardsPct != null && (!Number.isInteger(rewardsPct) || rewardsPct < 0 || rewardsPct > 100)) {
        throw new GqlInputError('rewardsPct must be an integer between 0 and 100')
      }

      return await pay('DONATE', { piconeros, rewardsPct }, { me, models, sendProtocolId })
    }
  },
  ContributorPool: {
    lastRun: async (pool, args, { models }) => (await getCachedContributorPool(CONTRIBUTOR_POOL_STALE_MS, models)).lastRun,
    candidates: async (pool, args, { models }) => (await getCachedContributorPool(CONTRIBUTOR_POOL_STALE_MS, models)).candidates
  },
  ContributorResult: {
    item: async (r, args, { me, models }) => getItem(r, { id: r.itemId }, { me, models })
  },
  ContributorCandidate: {
    item: async (c, args, { me, models }) => getItem(c, { id: c.itemId }, { me, models })
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
