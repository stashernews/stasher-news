import { resolveContributorPoolConfig, planContributorFunding, allocateContributorPayouts, refitCuratorBudget } from '@/lib/contributorPool'
import { computeContributorShares, readWindowStart } from '@/worker/contributorShares'

// Contributor pool orchestration for one weekly distribution. The distributor
// calls these around its curator work:
//
//   decideContributorMode   pure: effective mode from config + curator plan
//   selectContributorWinners  read-only SQL (the caller wraps it in a savepoint)
//   allocateContributorRun  pure: payout split from winners + curator shares
//   buildContributorParams  bounded, JSON-safe record snapshot
//
// OFF runs nothing at all. SHADOW scores and records but leaves every curator
// input alone. ACTIVE refits the curator budget to the 85/15 split first.

const MAX_RECORDED_CANDIDATES = 200

// Effective mode: ACTIVE needs the curator side ACTIVE and a clean
// plan, otherwise a configured ACTIVE degrades to SHADOW. Invalid contributor
// config fails closed to OFF and is reported for a CRITICAL alert.
export function decideContributorMode (config, budgetPlan) {
  const resolved = resolveContributorPoolConfig(config)
  if (!resolved.ok) {
    return { effectiveMode: 'OFF', configuredMode: config?.contributorPoolMode ?? null, resolved, configErrors: resolved.errors }
  }
  if (resolved.mode === 'OFF') {
    return { effectiveMode: 'OFF', configuredMode: 'OFF', resolved, configErrors: [] }
  }
  const curatorActive = budgetPlan.record?.curatorBudgetMode === 'ACTIVE' &&
    !budgetPlan.fallbackError &&
    (budgetPlan.configErrors?.length ?? 0) === 0 &&
    budgetPlan.targetPiconeros != null &&
    budgetPlan.limitPiconeros != null
  const effectiveMode = resolved.mode === 'ACTIVE' && curatorActive ? 'ACTIVE' : 'SHADOW'
  return { effectiveMode, configuredMode: resolved.mode, resolved, configErrors: [], curatorActive }
}

// Funding plan plus candidate selection. Read-only; any non-serialization
// error is for the caller to catch (budget 0, curator budget unchanged).
export async function selectContributorWinners (tx, { decision, budgetPlan, poolPiconeros, weekStart, excludedCuratorIds }) {
  const { params } = decision.resolved
  // The funding plan needs the curator target and the spending limit, which
  // exist only for a valid curator plan (any curator mode).
  const funding = budgetPlan.targetPiconeros != null && budgetPlan.limitPiconeros != null
    ? planContributorFunding({
      curatorTarget: budgetPlan.targetPiconeros,
      limit: budgetPlan.limitPiconeros,
      pool: poolPiconeros
    }, params)
    : null
  const selection = await selectContributorCandidates(tx, { decision, weekStart, excludedCuratorIds })
  return { funding, selection }
}

// Public previews and distribution selection must agree on catch-up versus
// configured-ACTIVE/degraded-SHADOW windows. No funding plan is needed here.
export async function selectContributorCandidates (tx, { decision, weekStart, excludedCuratorIds }) {
  const degraded = decision.configuredMode === 'ACTIVE' && decision.effectiveMode !== 'ACTIVE'
  const windowStart = await readWindowStart(tx, weekStart, { degraded })
  return await computeContributorShares(tx, { weekStart, params: decision.resolved.params, excludedIds: excludedCuratorIds, windowStart })
}

// Split the contributor budget. `curatorPaid`: Map curatorId → piconeros of
// the wallet-filtered curator payout rows (matters only when the combined cap
// is on). In SHADOW the plan's would-be budgets are used so the record shows
// what ACTIVE would have paid.
export function allocateContributorRun ({ decision, funding, selection, curatorPaid, minPayout }) {
  if (!funding) return null
  const { params } = decision.resolved
  return allocateContributorPayouts(selection.winners, {
    contributorBudget: funding.contributorBudget,
    curatorBudget: funding.curatorBudget,
    curatorPaid,
    minPayout
  }, params)
}

// Tight ACTIVE week with the combined cap off: the winners' payouts do not
// depend on curator payouts, so they are settled first and curators get the
// rest of the room. Otherwise null: the fixed split stands and the
// allocation runs after curator shares.
export function settleTightWeek ({ decision, funding, selection, minPayout }) {
  const { params } = decision.resolved
  if (!funding?.scaled || params.combinedCapBps > 0) return null
  const allocation = allocateContributorRun({ decision, funding, selection, curatorPaid: new Map(), minPayout })
  return { allocation, funding: refitCuratorBudget(funding, allocation.paid) }
}

// Shared by ACTIVE payout planning, SHADOW simulation and the live curator
// projection. Combined caps defer allocation until wallet-filtered curators
// are known; otherwise a tight week's unused awards go back to curators.
export function prepareContributorRun (options) {
  return settleTightWeek(options) ?? { funding: options.funding, allocation: null }
}

const jsonSafe = value => JSON.parse(JSON.stringify(value, (_k, v) => {
  if (typeof v === 'bigint') return v.toString()
  return v
}))

// Bounded record snapshot: config, funding, counts and one row per scored
// candidate with tip activity. No per-tip rows.
export function buildContributorParams ({ decision, funding, selection, allocation, error }) {
  if (decision.configErrors.length || error) {
    return jsonSafe({
      configured: decision.resolved.params,
      configuredMode: decision.configuredMode,
      errors: error ? ['selection_failed'] : decision.configErrors
    })
  }
  const paidByItem = new Map((allocation?.payouts ?? []).map(p => [p.itemId, p]))
  const winnerRank = new Map(selection.winners.map((w, i) => [w.itemId, i + 1]))
  // Winners always make the snapshot (the public page reads them); the cap only trims the rest, highest S first.
  const winnerIds = new Set(selection.winners.map(w => w.itemId))
  const candidates = selection.scored
    .filter(p => winnerIds.has(p.itemId) || p.tipperCount > 0 || p.E > 0)
    .sort((a, b) => (winnerIds.has(b.itemId) - winnerIds.has(a.itemId)) || b.S - a.S || a.itemId - b.itemId)
    .slice(0, Math.max(MAX_RECORDED_CANDIDATES, winnerIds.size))
    .map(p => {
      const pay = paidByItem.get(p.itemId)
      return {
        itemId: p.itemId,
        authorId: p.authorId,
        turf: p.turf,
        tippers: p.tipperCount,
        n: p.trustedTippers,
        base: p.base,
        B: p.B,
        E: p.E,
        G: p.G,
        S: p.S,
        words: Math.round(p.words),
        L: p.L,
        w: p.weight,
        qualifies: p.qualifies,
        rank: winnerRank.get(p.itemId) ?? null,
        rawShare: pay?.rawShare ?? null,
        share: pay?.share ?? null,
        trims: pay?.trims ?? []
      }
    })
  return jsonSafe({
    configured: decision.resolved.params,
    configuredMode: decision.configuredMode,
    effectiveMode: decision.effectiveMode,
    funding,
    // A week configured ACTIVE that ran as SHADOW (the curator budget fell
    // back) pays nothing, so it must not count as scored: the next ACTIVE run
    // catches those posts up. Plain SHADOW weeks are scored by design.
    ...(decision.configuredMode === 'ACTIVE' && decision.effectiveMode !== 'ACTIVE'
      ? { windowNotScored: selection.window }
      : { window: selection.window }),
    catchUpWeeks: selection.catchUpWeeks,
    candidates: selection.candidates,
    eligible: selection.eligible,
    ineligible: selection.ineligible,
    qualifying: selection.qualifying,
    nearMisses: selection.nearMisses,
    allocation: allocation && {
      paid: allocation.paid,
      rolledOver: allocation.rolledOver,
      winnerCap: allocation.winnerCap,
      combinedCap: allocation.combinedCap
    },
    scored: candidates,
    errors: []
  })
}
