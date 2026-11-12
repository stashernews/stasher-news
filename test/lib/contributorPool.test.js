/* eslint-env jest */
import {
  CONTRIBUTOR_POOL_MODES,
  resolveContributorPoolConfig,
  lengthMultiplier,
  scorePost,
  planContributorFunding,
  refitCuratorBudget,
  allocateContributorPayouts
} from '@/lib/contributorPool'

// Money-path tests for the contributor pool. Pure functions: no DB, no
// wallet. Scenario S values are hand-checked reference scores.

const DEFAULT_CONFIG = {
  contributorPoolMode: 'SHADOW',
  contributorShareBps: 1500,
  contributorTopN: 5,
  contributorWinnerCapBps: 4000,
  contributorCombinedCapBps: 0,
  contributorMinTipPiconeros: 500000000n,
  contributorTrustThreshold: 0.1,
  contributorMinTrustedTippers: 3,
  contributorTipperCapBps: 3334,
  contributorBreadthTarget: 5,
  contributorReciprocityMult: 0.5,
  contributorReciprocityDays: 30,
  contributorCommentBonusBps: 500,
  contributorCommentBonusMax: 8,
  contributorMinAccountAgeDays: 14,
  contributorLengthFloor: 0.6,
  contributorLengthScaleWords: 100,
  contributorLengthCapWords: 1500
}

const P = resolveContributorPoolConfig(DEFAULT_CONFIG).params

const mx = m => BigInt(Math.round(m * 1e9)) // mXMR → piconeros
const tipper = (id, trust, mXmr, reciprocal = false) => ({ tipperId: id, piconeros: mx(mXmr), trust, reciprocal })
const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps

describe('resolveContributorPoolConfig', () => {
  it('accepts the defaults in every mode', () => {
    for (const mode of CONTRIBUTOR_POOL_MODES) {
      const r = resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorPoolMode: mode })
      expect(r.errors).toEqual([])
      expect(r.ok).toBe(true)
      expect(r.mode).toBe(mode)
    }
  })

  it('maps columns to params and keeps the minimum tip a BigInt', () => {
    expect(P.shareBps).toBe(1500)
    expect(P.minTipPiconeros).toBe(500000000n)
    expect(resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorMinTipPiconeros: 1000n }).params.minTipPiconeros).toBe(1000n)
  })

  it('combined cap 0 means off and is valid', () => {
    expect(resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorCombinedCapBps: 0 }).ok).toBe(true)
    expect(resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorCombinedCapBps: 2500 }).ok).toBe(true)
  })

  it.each([
    ['contributorPoolMode', 'BOGUS', 'mode_invalid'],
    ['contributorPoolMode', null, 'mode_invalid'],
    ['contributorShareBps', 0, 'shareBps_out_of_range'],
    ['contributorShareBps', 5001, 'shareBps_out_of_range'],
    ['contributorShareBps', 1.5, 'shareBps_not_safe_integer'],
    ['contributorTopN', 0, 'topN_below_one'],
    ['contributorWinnerCapBps', 0, 'winnerCapBps_out_of_range'],
    ['contributorWinnerCapBps', 10001, 'winnerCapBps_out_of_range'],
    ['contributorCombinedCapBps', -1, 'combinedCapBps_out_of_range'],
    ['contributorCombinedCapBps', 10001, 'combinedCapBps_out_of_range'],
    ['contributorTipperCapBps', 0, 'tipperCapBps_out_of_range'],
    ['contributorMinTrustedTippers', 0, 'minTrustedTippers_below_one'],
    ['contributorMinTrustedTippers', 2, 'tipperCap_unsatisfiable_by_minTrustedTippers'],
    ['contributorTipperCapBps', 3000, 'tipperCap_unsatisfiable_by_minTrustedTippers'],
    ['contributorReciprocityMult', 0, 'reciprocityMult_out_of_range'],
    ['contributorTrustThreshold', 1.5, 'trustThreshold_out_of_range'],
    ['contributorTrustThreshold', NaN, 'trustThreshold_not_finite'],
    ['contributorReciprocityMult', -0.1, 'reciprocityMult_out_of_range'],
    ['contributorLengthFloor', 2, 'lengthFloor_out_of_range'],
    ['contributorLengthScaleWords', 0, 'lengthScaleWords_below_one'],
    ['contributorLengthCapWords', 0, 'lengthCapWords_below_one'],
    ['contributorMinTipPiconeros', -1n, 'minTipPiconeros_negative'],
    ['contributorMinTipPiconeros', undefined, 'minTipPiconeros_invalid']
  ])('fails closed on %s = %s', (field, value, code) => {
    const r = resolveContributorPoolConfig({ ...DEFAULT_CONFIG, [field]: value })
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('OFF')
    expect(r.errors).toContain(code)
  })

  it('does not validate tuning values while the mode is OFF', () => {
    const r = resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorPoolMode: 'OFF', contributorTopN: 0, contributorShareBps: -5 })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('OFF')
    expect(r.errors).toEqual([])
  })

  it('still rejects an invalid mode itself', () => {
    expect(resolveContributorPoolConfig({ ...DEFAULT_CONFIG, contributorPoolMode: 'off' }).errors).toContain('mode_invalid')
  })

  it('fails closed on a missing row', () => {
    const r = resolveContributorPoolConfig(null)
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('OFF')
  })
})

describe('lengthMultiplier', () => {
  it('follows the floor + log length curve', () => {
    expect(near(lengthMultiplier(0, P), 0.6, 1e-9)).toBe(true)
    expect(near(lengthMultiplier(1500, P), 1, 1e-9)).toBe(true)
    expect(near(lengthMultiplier(5000, P), 1, 1e-9)).toBe(true)
    expect(near(lengthMultiplier(300, P), 0.8)).toBe(true)
  })

  it('treats negative words as zero', () => {
    expect(lengthMultiplier(-10, P)).toBe(lengthMultiplier(0, P))
  })
})

describe('scorePost', () => {
  it('records each trusted counting account once using the scoring threshold and per-payment floor', () => {
    const result = scorePost({ tips: [tipper(9, 0.1, 0.5), tipper(9, 0.1, 1), tipper(2, 0.4, 1, true), tipper(3, 0.09, 10), tipper(4, 0.8, 0.25), tipper(4, 0.8, 0.25)] }, P)
    expect(result.trustedTipperIds).toEqual([2, 9])
    expect(result.trustedTippers).toBe(2)
    expect(scorePost({ tips: [] }, P).trustedTipperIds).toEqual([])
  })

  const sims = {
    honest_broad: { tips: [1, 2, 3, 4, 5, 6].map(i => tipper(i, 0.5, 1)), commenters: [1, 2, 3, 4].map(i => ({ userId: 100 + i, trust: 0.4 })) },
    honest_minimal: { tips: [1, 2, 3].map(i => tipper(i, 0.3, 0.5)), commenters: [] },
    whale_friend: { tips: [tipper(1, 0.9, 100), tipper(2, 0.3, 1), tipper(3, 0.3, 1)], commenters: [] },
    sock_ring: {
      tips: [...[1, 2, 3, 4, 5, 6, 7, 8].map(i => tipper(i, 0, 1000)), tipper(9, 0.4, 1), tipper(10, 0.4, 1)],
      commenters: [1, 2, 3, 4, 5].map(i => ({ userId: 200 + i, trust: 0 }))
    },
    dust_swarm: { tips: Array.from({ length: 30 }, (_, i) => tipper(i + 1, 0.05, 0.2)), commenters: [] },
    mutual_ring: { tips: [1, 2, 3, 4].map(i => tipper(i, 0.6, 10, true)), commenters: [] }
  }
  const score = name => scorePost(sims[name], P)

  it('scores the honest, whale and mutual scenarios', () => {
    expect(score('honest_broad').qualifies).toBe(true)
    expect(near(score('honest_broad').S, 32.4, 0.05)).toBe(true)
    expect(score('honest_minimal').qualifies).toBe(true)
    expect(near(score('honest_minimal').S, 4.7, 0.005)).toBe(true)
    expect(score('whale_friend').qualifies).toBe(true)
    expect(near(score('whale_friend').S, 4.86, 0.005)).toBe(true)
    expect(score('mutual_ring').qualifies).toBe(true)
    expect(near(score('mutual_ring').S, 9.6, 0.005)).toBe(true)
  })

  it('does not qualify a sock ring or a dust swarm', () => {
    expect(score('sock_ring').qualifies).toBe(false)
    expect(score('sock_ring').trustedTippers).toBe(2)
    expect(score('dust_swarm').qualifies).toBe(false)
    expect(score('dust_swarm').tipperCount).toBe(0) // each tip below the 0.5 mXMR floor
  })

  it('breadth beats a single whale', () => {
    expect(score('honest_broad').S).toBeGreaterThan(score('whale_friend').S)
  })

  it('caps a whale at an equal share and passes three equal tippers', () => {
    const w = score('whale_friend')
    expect(w.tipperCapTrimmed).toBe(true)
    expect(w.sumCapped).toBeLessThan(w.sumRaw)
    const eq = scorePost({ tips: [1, 2, 3].map(i => tipper(i, 0.5, 1)) }, P)
    expect(eq.tipperCapTrimmed).toBe(false)
    expect(near(eq.sumCapped, eq.sumRaw, 1e-6)).toBe(true)
  })

  it('zeroes the base when fewer than 1/cap positive tippers exist', () => {
    const s = scorePost({ tips: [tipper(1, 0.5, 5), tipper(2, 0.5, 5)] }, P)
    expect(s.base).toBe(0)
    expect(s.qualifies).toBe(false)
  })

  it('matches the float water level: one whale over three small tippers', () => {
    // c_whale = 1 × log10(1e12) = 12; each other c = 0.1 × log10(1e9) = 0.9
    const tips = [tipper(1, 1, 1000), tipper(2, 0.1, 1), tipper(3, 0.1, 1), tipper(4, 0.1, 1)]
    const s = scorePost({ tips }, P)
    const rest = 3 * 0.9
    const share = 0.3334
    const L = share * rest / (1 - share) // closed form with k = 1
    expect(s.tipperCapTrimmed).toBe(true)
    expect(near(s.sumCapped, L + rest, 1e-6)).toBe(true)
  })

  it('sums a tipper’s payments after the per-payment minimum', () => {
    const tips = [
      { tipperId: 1, piconeros: mx(0.3), trust: 0.5, reciprocal: false }, // below floor, dropped
      { tipperId: 1, piconeros: mx(0.6), trust: 0.5, reciprocal: false },
      { tipperId: 1, piconeros: mx(0.6), trust: 0.5, reciprocal: false },
      tipper(2, 0.5, 1),
      tipper(3, 0.5, 1)
    ]
    const s = scorePost({ tips }, P)
    expect(s.tipperCount).toBe(3)
    expect(s.sumRaw).toBeCloseTo(0.5 * Math.log10(Number(mx(1.2))) + 2 * 0.5 * Math.log10(Number(mx(1))), 6)
  })

  it('halves a reciprocal tipper’s contribution', () => {
    const a = scorePost({ tips: [tipper(1, 0.5, 1, true)] }, P)
    const b = scorePost({ tips: [tipper(1, 0.5, 1, false)] }, P)
    expect(near(a.sumRaw * 2, b.sumRaw, 1e-9)).toBe(true)
  })

  it('subtracts weighted downvotes but never below zero', () => {
    const base = score('honest_broad').base
    expect(scorePost({ ...sims.honest_broad, weightedDownVotes: 1 }, P).base).toBeCloseTo(base - 1, 9)
    expect(scorePost({ ...sims.honest_broad, weightedDownVotes: 1e6 }, P).base).toBe(0)
    expect(scorePost({ ...sims.honest_broad, weightedDownVotes: 1e6 }, P).qualifies).toBe(false)
  })

  it('applies the comment bonus up to the max and only for trusted commenters', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ userId: i, trust: 0.5 }))
    const s = scorePost({ tips: sims.honest_broad.tips, commenters: many }, P)
    expect(s.E).toBe(8)
    expect(s.G).toBeCloseTo(1.4, 9)
    const untrusted = scorePost({ tips: sims.honest_broad.tips, commenters: [{ userId: 1, trust: 0 }] }, P)
    expect(untrusted.E).toBe(0)
    expect(untrusted.G).toBe(1)
  })
})

describe('planContributorFunding', () => {
  it('pays both targets in full when they fit (FULL)', () => {
    const f = planContributorFunding({ curatorTarget: 150n, limit: 1000n, pool: 5000n }, P)
    expect(f.curatorBudget).toBe(150n)
    expect(f.contributorBudget).toBe(26n) // 150 × 1500 / 8500 floored
    expect(f.contributorTarget).toBe(26n)
    expect(f.scaled).toBe(false)
    expect(f.fitBps).toBe(10000n)
  })

  it('scales both budgets to fit the limit', () => {
    const f = planContributorFunding({ curatorTarget: 850n, limit: 500n, pool: 5000n }, P)
    expect(f.contributorTarget).toBe(150n)
    expect(f.scaled).toBe(true)
    expect(f.curatorBudget).toBe(425n) // 850 × 500 / 1000
    expect(f.contributorBudget).toBe(75n)
    expect(f.curatorBudget + f.contributorBudget).toBeLessThanOrEqual(500n)
    expect(f.fitBps).toBe(5000n)
  })

  it('uses the pool when it is below the limit', () => {
    const f = planContributorFunding({ curatorTarget: 850n, limit: 5000n, pool: 500n }, P)
    expect(f.room).toBe(500n)
    expect(f.scaled).toBe(true)
    expect(f.curatorBudget + f.contributorBudget).toBeLessThanOrEqual(500n)
  })

  it('keeps the 85/15 ratio when scaled', () => {
    const f = planContributorFunding({ curatorTarget: 8_500_000_000n, limit: 3_000_000_000n, pool: 9_000_000_000n }, P)
    const total = f.curatorBudget + f.contributorBudget
    expect(total).toBeLessThanOrEqual(3_000_000_000n)
    expect(Number(f.contributorBudget) / Number(total)).toBeCloseTo(0.15, 6)
  })

  it('returns zeros for a zero target or an empty room', () => {
    expect(planContributorFunding({ curatorTarget: 0n, limit: 100n, pool: 100n }, P).contributorBudget).toBe(0n)
    const f = planContributorFunding({ curatorTarget: 100n, limit: 0n, pool: 100n }, P)
    expect(f.curatorBudget).toBe(0n)
    expect(f.contributorBudget).toBe(0n)
  })
})

describe('refitCuratorBudget', () => {
  const tight = planContributorFunding({ curatorTarget: 850n, limit: 500n, pool: 5000n }, P)

  it('gives curators the whole room when nobody is paid', () => {
    expect(refitCuratorBudget(tight, 0n).curatorBudget).toBe(500n)
  })

  it('takes only what contributors were actually paid', () => {
    const f = refitCuratorBudget(tight, 40n)
    expect(f.curatorBudget).toBe(460n)
    expect(f.curatorBudget + 40n).toBeLessThanOrEqual(tight.room)
  })

  it('never exceeds the curator target', () => {
    const roomy = planContributorFunding({ curatorTarget: 400n, limit: 450n, pool: 5000n }, P)
    expect(roomy.scaled).toBe(true) // 400 + 70 > 450
    expect(refitCuratorBudget(roomy, 0n).curatorBudget).toBe(400n)
  })

  it('never goes negative and leaves unscaled weeks alone', () => {
    expect(refitCuratorBudget(tight, 9999n).curatorBudget).toBe(0n)
    const full = planContributorFunding({ curatorTarget: 150n, limit: 1000n, pool: 5000n }, P)
    expect(refitCuratorBudget(full, 20n)).toBe(full)
  })
})

describe('allocateContributorPayouts', () => {
  const winners = [{ authorId: 1, weight: 10 }, { authorId: 2, weight: 1 }]
  const budgets = { contributorBudget: 1000n, curatorBudget: 3000n, curatorPaid: new Map([[2, 995n]]), minPayout: 20n }

  it('applies the winner cap and the combined cap when enabled', () => {
    const p = allocateContributorPayouts(winners, budgets, { ...P, combinedCapBps: 2500 })
    expect(p.payouts[0].share).toBe(400n)
    expect(p.payouts[0].trims.map(t => t.rule)).toContain('winner_cap')
    expect(p.payouts[1].share).toBe(0n)
    expect(p.payouts[1].trims.map(t => t.rule)).toContain('combined_cap')
    expect(p.paid + p.rolledOver).toBe(1000n)
  })

  it('treats a combined cap of 0 as off, not as a cap at zero', () => {
    const p = allocateContributorPayouts(winners, budgets, P)
    expect(p.combinedCap).toBeNull()
    expect(p.payouts[1].share).toBe(90n)
    expect(p.payouts[1].trims).toEqual([])
    expect(p.paid + p.rolledOver).toBe(1000n)
  })

  it('combined cap on a top curator-author: cap on zeroes the top winner, off pays 40%', () => {
    const top = [{ authorId: 7, weight: 1 }]
    const curatorPaid = new Map([[7, 900n]])
    const args = { contributorBudget: 1000n, curatorBudget: 4000n, curatorPaid, minPayout: 1n }
    const on = allocateContributorPayouts(top, args, { ...P, combinedCapBps: 1500 })
    expect(on.payouts[0].share).toBe(0n)
    const off = allocateContributorPayouts(top, args, P)
    expect(off.payouts[0].share).toBe(400n)
    expect(off.rolledOver).toBe(600n)
  })

  it('drops payouts below the minimum and rolls the money over', () => {
    const p = allocateContributorPayouts(
      [{ authorId: 1, weight: 100 }, { authorId: 2, weight: 1 }],
      { contributorBudget: 1000n, curatorBudget: 0n, minPayout: 50n },
      { ...P, winnerCapBps: 10000 }
    )
    expect(p.payouts[1].share).toBe(0n)
    expect(p.payouts[1].trims.map(t => t.rule)).toContain('min_payout')
    expect(p.paid + p.rolledOver).toBe(1000n)
  })

  it('always closes the ledger and never overpays the budget', () => {
    for (const n of [1, 2, 3, 5, 7]) {
      const ws = Array.from({ length: n }, (_, i) => ({ authorId: i + 1, weight: Math.sqrt(i + 1.37) * 0.9173 }))
      const p = allocateContributorPayouts(ws, { contributorBudget: 123_456_789_013n, curatorBudget: 0n, minPayout: 1n }, { ...P, winnerCapBps: 10000 })
      expect(p.paid).toBeLessThanOrEqual(123_456_789_013n)
      expect(p.paid + p.rolledOver).toBe(123_456_789_013n)
      expect(p.payouts.every(x => x.share >= 0n)).toBe(true)
    }
  })

  it('pays nothing with no winners or a zero budget', () => {
    expect(allocateContributorPayouts([], { contributorBudget: 1000n, curatorBudget: 0n, minPayout: 1n }, P).rolledOver).toBe(1000n)
    const z = allocateContributorPayouts(winners, { contributorBudget: 0n, curatorBudget: 0n, minPayout: 1n }, P)
    expect(z.paid).toBe(0n)
    expect(z.rolledOver).toBe(0n)
  })
})
