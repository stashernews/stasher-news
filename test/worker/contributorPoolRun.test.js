/* eslint-env jest */
import { buildContributorParams, decideContributorMode } from '@/worker/contributorPoolRun'
import { resolveContributorPoolConfig } from '@/lib/contributorPool'

const CONFIG = {
  contributorPoolMode: 'ACTIVE',
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

const scored = (itemId, S, extra = {}) => ({
  itemId,
  authorId: itemId,
  turf: 'stasher',
  tipperCount: 3,
  trustedTippers: 3,
  base: S,
  B: 1,
  E: 0,
  G: 1,
  S,
  words: 100,
  L: 0.7,
  weight: Math.sqrt(S) * 0.7,
  qualifies: true,
  ...extra
})
const WINDOW = [new Date('2026-10-05T00:00:00Z'), new Date('2026-10-12T00:00:00Z')]

function snapshot (decision, selection) {
  return buildContributorParams({ decision, funding: null, selection, allocation: null })
}

describe('buildContributorParams', () => {
  test.each(['selection failure', 'invalid config'])('%s retains an unscored window before the first success', failure => {
    const config = failure === 'invalid config' ? { ...CONFIG, contributorShareBps: 0 } : CONFIG
    const decision = decideContributorMode(config, {})
    const out = buildContributorParams({ decision, weekStart: new Date('2026-10-19T00:00:00Z'), error: failure === 'selection failure' ? new Error('selection unavailable') : null })
    expect(out.windowNotScored).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'])
    expect(out.window).toBeUndefined()
    expect(out.errors).toEqual(failure === 'selection failure' ? ['selection_failed'] : ['shareBps_out_of_range'])
  })

  test('stores trusted account IDs without adding tip amounts or trust values', () => {
    const decision = { resolved: resolveContributorPoolConfig(CONFIG), configuredMode: 'ACTIVE', effectiveMode: 'ACTIVE', configErrors: [] }
    const winner = scored(7, 5, { trustedTipperIds: [10, 20, 30] })
    const out = snapshot(decision, { window: WINDOW, scored: [winner], winners: [winner] })
    expect(out.scored[0].trustedTipperIds).toEqual([10, 20, 30])
    expect(out.scored[0]).not.toHaveProperty('tips')
    expect(out.scored[0]).not.toHaveProperty('recipientAddress')
  })

  test('winners always make the snapshot, even when more than 200 non-qualifying posts score higher', () => {
    const decision = { resolved: resolveContributorPoolConfig(CONFIG), configuredMode: 'ACTIVE', effectiveMode: 'ACTIVE', configErrors: [] }
    const strongButUnqualified = Array.from({ length: 250 }, (_, i) =>
      scored(1000 + i, 500 - i * 0.1, { qualifies: false, trustedTippers: 2 }))
    const winner = scored(7, 5)
    const selection = {
      window: WINDOW,
      catchUpWeeks: 0,
      candidates: 251,
      eligible: 251,
      ineligible: {},
      qualifying: 1,
      nearMisses: 250,
      scored: [...strongButUnqualified, winner],
      winners: [winner]
    }
    const out = snapshot(decision, selection)
    expect(out.scored).toHaveLength(200) // the cap, with the winner kept inside it
    expect(out.scored.find(s => s.itemId === 7)?.rank).toBe(1)
  })

  test('a scored ACTIVE or plain SHADOW week records its window', () => {
    for (const [configured, effective] of [['ACTIVE', 'ACTIVE'], ['SHADOW', 'SHADOW']]) {
      const decision = { resolved: resolveContributorPoolConfig({ ...CONFIG, contributorPoolMode: configured }), configuredMode: configured, effectiveMode: effective, configErrors: [] }
      const out = snapshot(decision, { window: WINDOW, catchUpWeeks: 0, candidates: 0, eligible: 0, ineligible: {}, qualifying: 0, nearMisses: 0, scored: [], winners: [] })
      expect(out.window).toEqual(WINDOW.map(d => d.toISOString()))
      expect(out.windowNotScored).toBeUndefined()
    }
  })

  test('a week configured ACTIVE but degraded to SHADOW does not count as scored', () => {
    const decision = { resolved: resolveContributorPoolConfig(CONFIG), configuredMode: 'ACTIVE', effectiveMode: 'SHADOW', configErrors: [] }
    const out = snapshot(decision, { window: WINDOW, catchUpWeeks: 0, candidates: 0, eligible: 0, ineligible: {}, qualifying: 0, nearMisses: 0, scored: [], winners: [] })
    expect(out.window).toBeUndefined()
    expect(out.windowNotScored).toEqual(WINDOW.map(d => d.toISOString()))
  })
})

describe('decideContributorMode', () => {
  test('ACTIVE needs a clean ACTIVE curator plan', () => {
    const clean = { record: { curatorBudgetMode: 'ACTIVE' }, configErrors: [], targetPiconeros: 1n, limitPiconeros: 1n }
    expect(decideContributorMode(CONFIG, clean).effectiveMode).toBe('ACTIVE')
    expect(decideContributorMode(CONFIG, { ...clean, fallbackError: new Error('x') }).effectiveMode).toBe('SHADOW')
    expect(decideContributorMode(CONFIG, { ...clean, record: { curatorBudgetMode: 'LEGACY' } }).effectiveMode).toBe('SHADOW')
  })
})
