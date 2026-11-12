// Contributor pool — pure scoring, funding and payout math.
//
// Weekly top-N original posts are paid from a share of the combined curator +
// contributor budget. This module owns config validation, the per-post score,
// the length multiplier, the funding split and the payout allocation. It
// creates no Prisma client, reads no wallet and imports no logger, so importing
// it is inert and the distributor can call it inside its serializable
// transaction.
//
// Money is BigInt piconeros and every division floors. Scores are floats
// (they only rank and weight; the payout split is floored back to BigInt).
// Configuration stays Number because it maps to PostgreSQL int4/float8 and is
// validated before use. Invalid configuration fails closed: mode OFF and a
// zero contributor budget, with the error codes returned for a CRITICAL alert.
//
// Naming: "contributor" in this repo also means a contributors.txt entry
// (`isContributor`). Everything here is contributorPool*/ContributorPool*.

import { capTipperContributions } from '@/lib/curatorBudget'

export const CONTRIBUTOR_POOL_MODES = ['OFF', 'SHADOW', 'ACTIVE']

const BPS_DEN = 10000n
// Fixed-point scale for handing float per-tipper contributions to the BigInt
// water-level cap.
const FIXED_POINT = 1e9

// PlatformFeeConfig column → params key.
const CONFIG_TO_PARAM = {
  contributorShareBps: 'shareBps',
  contributorTopN: 'topN',
  contributorWinnerCapBps: 'winnerCapBps',
  contributorCombinedCapBps: 'combinedCapBps',
  contributorMinTipPiconeros: 'minTipPiconeros',
  contributorTrustThreshold: 'trustThreshold',
  contributorMinTrustedTippers: 'minTrustedTippers',
  contributorTipperCapBps: 'tipperCapBps',
  contributorBreadthTarget: 'breadthTarget',
  contributorReciprocityMult: 'reciprocityMult',
  contributorReciprocityDays: 'reciprocityDays',
  contributorCommentBonusBps: 'commentBonusBps',
  contributorCommentBonusMax: 'commentBonusMax',
  contributorMinAccountAgeDays: 'minAccountAgeDays',
  contributorLengthFloor: 'lengthFloor',
  contributorLengthScaleWords: 'lengthScaleWords',
  contributorLengthCapWords: 'lengthCapWords'
}

const INT_PARAMS = ['shareBps', 'topN', 'winnerCapBps', 'combinedCapBps', 'tipperCapBps',
  'minTrustedTippers', 'breadthTarget', 'reciprocityDays', 'commentBonusBps', 'commentBonusMax',
  'minAccountAgeDays', 'lengthScaleWords', 'lengthCapWords']
const FLOAT_PARAMS = ['trustThreshold', 'reciprocityMult', 'lengthFloor']

// Validate the contributor columns of one PlatformFeeConfig row. Every failed rule
// contributes a stable error code. `params` is returned even on failure so the
// run can snapshot what was configured, but callers must not use it when `ok`
// is false.
export function resolveContributorPoolConfig (config) {
  const row = config ?? {}
  const params = {}
  for (const [field, param] of Object.entries(CONFIG_TO_PARAM)) {
    params[param] = row[field]
  }

  const errors = []
  const mode = row.contributorPoolMode
  if (!CONTRIBUTOR_POOL_MODES.includes(mode)) errors.push('mode_invalid')
  // OFF runs nothing, so tuning values are not used: a bad one must not raise
  // an alert or change anything while the pool is switched off.
  if (mode === 'OFF') return { ok: true, mode: 'OFF', params, errors: [] }

  for (const param of INT_PARAMS) {
    if (!Number.isSafeInteger(params[param])) errors.push(`${param}_not_safe_integer`)
  }
  for (const param of FLOAT_PARAMS) {
    if (typeof params[param] !== 'number' || !Number.isFinite(params[param])) errors.push(`${param}_not_finite`)
  }
  const minTip = params.minTipPiconeros
  if (typeof minTip !== 'bigint' && !(minTip != null && typeof minTip !== 'object' && /^\d+$/.test(String(minTip)))) {
    errors.push('minTipPiconeros_invalid')
  } else {
    params.minTipPiconeros = BigInt(minTip)
    if (params.minTipPiconeros < 0n) errors.push('minTipPiconeros_negative')
  }

  const int = p => Number.isSafeInteger(params[p])
  const flt = p => typeof params[p] === 'number' && Number.isFinite(params[p])
  if (int('shareBps') && (params.shareBps < 1 || params.shareBps > 5000)) errors.push('shareBps_out_of_range')
  if (int('topN') && params.topN < 1) errors.push('topN_below_one')
  if (int('winnerCapBps') && (params.winnerCapBps < 1 || params.winnerCapBps > 10000)) {
    errors.push('winnerCapBps_out_of_range')
  }
  // 0 means "off", never "cap at 0".
  if (int('combinedCapBps') && (params.combinedCapBps < 0 || params.combinedCapBps > 10000)) {
    errors.push('combinedCapBps_out_of_range')
  }
  if (int('tipperCapBps') && (params.tipperCapBps <= 0 || params.tipperCapBps > 10000)) {
    errors.push('tipperCapBps_out_of_range')
  }
  if (int('minTrustedTippers') && params.minTrustedTippers < 1) errors.push('minTrustedTippers_below_one')
  // The per-tipper cap needs at least 10000/tipperCapBps positive contributors;
  // fewer and the capped sum is 0, so no post could ever qualify.
  if (int('tipperCapBps') && int('minTrustedTippers') && params.tipperCapBps > 0 && params.minTrustedTippers >= 1 &&
      params.tipperCapBps * params.minTrustedTippers < 10000) {
    errors.push('tipperCap_unsatisfiable_by_minTrustedTippers')
  }
  if (int('breadthTarget') && params.breadthTarget < 1) errors.push('breadthTarget_below_one')
  if (int('reciprocityDays') && params.reciprocityDays < 0) errors.push('reciprocityDays_negative')
  if (int('commentBonusBps') && params.commentBonusBps < 0) errors.push('commentBonusBps_negative')
  if (int('commentBonusMax') && params.commentBonusMax < 0) errors.push('commentBonusMax_negative')
  if (int('minAccountAgeDays') && params.minAccountAgeDays < 0) errors.push('minAccountAgeDays_negative')
  if (flt('trustThreshold') && (params.trustThreshold < 0 || params.trustThreshold > 1)) {
    errors.push('trustThreshold_out_of_range')
  }
  // 0 would make a reciprocal tipper count toward n but add nothing to the cap
  if (flt('reciprocityMult') && (params.reciprocityMult <= 0 || params.reciprocityMult > 1)) {
    errors.push('reciprocityMult_out_of_range')
  }
  if (flt('lengthFloor') && (params.lengthFloor < 0 || params.lengthFloor > 1)) {
    errors.push('lengthFloor_out_of_range')
  }
  if (int('lengthScaleWords') && params.lengthScaleWords < 1) errors.push('lengthScaleWords_below_one')
  if (int('lengthCapWords') && params.lengthCapWords < 1) errors.push('lengthCapWords_below_one')

  return {
    ok: errors.length === 0,
    mode: errors.length === 0 ? mode : 'OFF',
    params,
    errors
  }
}

// Length multiplier: floor + log curve in effective words, saturating at lengthCapWords.
export function lengthMultiplier (words, params) {
  const f = params.lengthFloor
  const ratio = Math.log(1 + Math.max(0, words) / params.lengthScaleWords) /
    Math.log(1 + params.lengthCapWords / params.lengthScaleWords)
  return f + (1 - f) * Math.min(1, ratio)
}

// Score one post: capped trust-weighted tips, downvotes, breadth and the
// comment bonus (no turf normalization).
// `tips`: per-payment rows already limited to the post's 7-day window, self
//   tips and excluded tippers removed:
//   { tipperId, piconeros: bigint, trust: number, reciprocal: boolean }
// `commenters`: [{ userId, trust }] distinct non-author commenters in window.
export function scorePost ({ tips, commenters = [], weightedDownVotes = 0 }, params) {
  const perTipper = new Map()
  for (const t of tips) {
    if (t.piconeros < params.minTipPiconeros) continue
    const e = perTipper.get(t.tipperId) || { amount: 0n, trust: t.trust, reciprocal: t.reciprocal }
    e.amount += t.piconeros
    perTipper.set(t.tipperId, e)
  }
  const tippers = [...perTipper.entries()].map(([tipperId, e]) => {
    const R = e.reciprocal ? params.reciprocityMult : 1
    return {
      tipperId,
      amount: e.amount,
      trust: e.trust,
      reciprocal: e.reciprocal,
      c: e.trust * Math.log10(Number(e.amount)) * R
    }
  })

  // Water-level cap on a fixed-point copy of the contributions; the one cap
  // implementation in the repo.
  const fixed = tippers.map(t => BigInt(Math.floor(t.c * FIXED_POINT)))
  const cap = capTipperContributions(fixed, params.tipperCapBps)
  const sumCapped = Number(cap.tPiconeros) / FIXED_POINT
  const sumRaw = tippers.reduce((a, t) => a + t.c, 0)
  const tipperCapTrimmed = cap.tPiconeros < fixed.reduce((a, b) => a + b, 0n)

  const base = Math.max(0, sumCapped - (weightedDownVotes || 0))
  const trustedTipperIds = tippers.filter(t => t.trust >= params.trustThreshold).map(t => t.tipperId).sort((a, b) => a - b)
  const n = trustedTipperIds.length
  const B = Math.min(1, n / params.breadthTarget)
  const E = Math.min(params.commentBonusMax, commenters.filter(c => c.trust >= params.trustThreshold).length)
  const G = 1 + (params.commentBonusBps / 10000) * E
  const S = base * B * G
  return {
    tipperCount: tippers.length,
    trustedTippers: n,
    trustedTipperIds,
    reciprocalTippers: tippers.filter(t => t.reciprocal).length,
    sumRaw,
    sumCapped,
    tipperCapTrimmed,
    base,
    B,
    E,
    G,
    S,
    qualifies: n >= params.minTrustedTippers && base > 0
  }
}

// Funding: contributor target is s/(1-s) of the curator target, then both
// scale by room/(sum) when they do not fit inside min(limit, pool).
export function planContributorFunding ({ curatorTarget, limit, pool }, params) {
  const s = BigInt(params.shareBps)
  const contributorTarget = curatorTarget * s / (BPS_DEN - s)
  const room = limit < pool ? limit : pool
  const want = curatorTarget + contributorTarget
  if (want <= room) {
    return { curatorBudget: curatorTarget, contributorBudget: contributorTarget, contributorTarget, curatorTarget, room, fitBps: 10000n, scaled: false }
  }
  if (want <= 0n || room <= 0n) {
    return { curatorBudget: 0n, contributorBudget: 0n, contributorTarget, curatorTarget, room, fitBps: 0n, scaled: true }
  }
  return {
    curatorBudget: curatorTarget * room / want,
    contributorBudget: contributorTarget * room / want,
    contributorTarget,
    curatorTarget,
    room,
    fitBps: room * 10000n / want,
    scaled: true
  }
}

// Tight weeks: contributors are paid first from their scaled share
// and curators take whatever the limit has left, never more than their own
// target. With no winners, curators get the whole room, exactly as without the
// contributor pool; the ratio only costs curators what contributors are
// actually paid. `contributorPaid` must already be final (so it is only valid
// while the combined cap is off). Unscaled weeks are returned unchanged.
export function refitCuratorBudget (funding, contributorPaid) {
  if (!funding.scaled) return funding
  const left = funding.room > contributorPaid ? funding.room - contributorPaid : 0n
  const curatorBudget = left < funding.curatorTarget ? left : funding.curatorTarget
  return { ...funding, curatorBudget }
}

// Payout split by w = √S × L, then winner cap, combined cap (skipped when
// combinedCapBps = 0), then minimum payout. `winners`: [{ authorId, weight, ... }]
// `curatorPaid`: Map userId → curator piconeros this week (already scaled).
// Trimmed and sub-minimum money is not redistributed: it rolls over.
export function allocateContributorPayouts (winners, { contributorBudget, curatorBudget, curatorPaid = new Map(), minPayout }, params) {
  const totalW = winners.reduce((a, w) => a + w.weight, 0)
  const winnerCap = contributorBudget * BigInt(params.winnerCapBps) / BPS_DEN
  const combinedCap = params.combinedCapBps > 0
    ? (contributorBudget + curatorBudget) * BigInt(params.combinedCapBps) / BPS_DEN
    : null
  const payouts = []
  for (const w of winners) {
    const trims = []
    let share = totalW > 0 ? BigInt(Math.floor(w.weight / totalW * Number(contributorBudget))) : 0n
    // float rounding must never push the sum above the budget
    if (share > contributorBudget) share = contributorBudget
    const rawShare = share
    if (share > winnerCap) { trims.push({ rule: 'winner_cap', piconeros: share - winnerCap }); share = winnerCap }
    const curator = curatorPaid.get(w.authorId) || 0n
    if (combinedCap != null && curator + share > combinedCap) {
      const allowed = combinedCap > curator ? combinedCap - curator : 0n
      trims.push({ rule: 'combined_cap', piconeros: share - allowed })
      share = allowed
    }
    if (share > 0n && share < minPayout) { trims.push({ rule: 'min_payout', piconeros: share }); share = 0n }
    payouts.push({ ...w, rawShare, share, curatorPaid: curator, trims })
  }
  let paid = payouts.reduce((a, p) => a + p.share, 0n)
  // Float splitting can overshoot by a few piconeros in total; clip from the
  // last payout so paid never exceeds the budget.
  if (paid > contributorBudget) {
    let over = paid - contributorBudget
    for (let i = payouts.length - 1; i >= 0 && over > 0n; i--) {
      const cut = payouts[i].share < over ? payouts[i].share : over
      if (cut === 0n) continue
      payouts[i].share -= cut
      payouts[i].trims.push({ rule: 'rounding', piconeros: cut })
      over -= cut
    }
    paid = payouts.reduce((a, p) => a + p.share, 0n)
  }
  return { payouts, paid, rolledOver: contributorBudget - paid, winnerCap, combinedCap }
}
