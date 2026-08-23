/* eslint-env jest */
import { TERMINAL_STATES } from '@/components/tip/use-watch-tip'

// No React component test harness in this repo (see tip-modal.test.js), so we
// assert the exported terminal-state classification directly — the contract
// the poll interval teardown depends on.
describe('TERMINAL_STATES', () => {
  test('EXCLUDED is terminal — the poller stops once a tip is excluded', () => {
    expect(TERMINAL_STATES.has('EXCLUDED')).toBe(true)
  })

  test('PENDING and null keep polling; success and failure terminals stop', () => {
    expect(TERMINAL_STATES.has('PENDING')).toBe(false)
    expect(TERMINAL_STATES.has(null)).toBe(false)
    for (const s of ['DETECTED', 'CONFIRMED', 'REORGED', 'EXPIRED']) {
      expect(TERMINAL_STATES.has(s)).toBe(true)
    }
  })
})
