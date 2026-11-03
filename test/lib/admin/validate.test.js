/* eslint-env jest */
import { validateChanges, needsJumpConfirmation } from '@/lib/admin/validate'
import { SITE_SETTINGS_DEFAULTS } from '@/lib/siteSettings'

const state = {
  ...SITE_SETTINGS_DEFAULTS,
  downvoteMinPiconeros: 100000000n,
  defaultDownvotePiconeros: 1000000000n,
  tipRankRampDays: 14,
  tipRankFactorFloor: 0.7,
  curatorBudgetMode: 'LEGACY',
  curatorBudgetMultBps: 15000,
  curatorBudgetDrawdownWeeks: 13,
  curatorBudgetAvgPeriods: 4,
  curatorTipCapShareBps: 2500,
  curatorBreakerRatioBps: 25000,
  curatorBreakerFloorMedianPeriods: 12,
  curatorBreakerArmPeriods: 4
}
const change = (key, value, confirmedJump = true) => ({ key, value, confirmedJump })

test('post-state validation permits coupled changes and rejects invalid ratios and budgets', () => {
  expect(() => validateChanges({ state, changes: [change('tipRankRampDays', '0')] })).toThrow(/factor floor/i)
  expect(validateChanges({ state, changes: [change('tipRankRampDays', '0'), change('tipRankFactorFloor', '1')] }).postState.tipRankRampDays).toBe(0)
  for (const changes of [
    [change('spamEscalationNumerator', '7'), change('spamEscalationDenominator', '2')],
    [change('spamEscalationNumerator', '1'), change('spamEscalationDenominator', '2')],
    [change('curatorBudgetMultBps', '9999')], [change('curatorTipCapShareBps', '0')],
    [change('curatorBreakerRatioBps', '10000')]
  ]) expect(() => validateChanges({ state, changes })).toThrow()
})

test('a pre-state lock cannot be lifted and edited in the same apply', () => {
  const fields = [
    { key: 'automation', type: 'bool' },
    { key: 'fee', type: 'int', min: '1', max: '100', lockedWhen: { key: 'automation', equals: true, reason: 'managed by automation' } }
  ]
  expect(() => validateChanges({ fields, state: { automation: true, fee: 1 }, changes: [change('automation', 'false'), change('fee', '2')] })).toThrow(/managed by automation/)
})

test('jump check includes zero transitions and negative values, but not exactly tenfold', () => {
  for (const [oldValue, newValue, expected] of [[1, 10, false], [10, 1, false], [1, 11, true], [11, 1, true], [0, 1, true], [1, 0, true], [-1, 1, true], [-1, -11, true], [0, 0, false]]) {
    expect(needsJumpConfirmation(oldValue, newValue)).toBe(expected)
  }
  expect(needsJumpConfirmation(100000000000000000000n, 1000000000000000000001n)).toBe(true)
  expect(() => validateChanges({ state, changes: [change('trustPicoMin', '1000000000000', false)] })).toThrow(/confirm/i)
})
