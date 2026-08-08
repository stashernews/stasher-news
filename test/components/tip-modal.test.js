/* eslint-env jest */
import { initialTipAmount } from '@/components/tip-modal'

// No React component test harness in this repo (see downvote-modal.test.js), so
// we test the extracted prefill derivation — the real behavior the modal's
// amount input enforces — directly. components/tip-modal imports ./item-act and
// ./monero-payment-view, which pull ./form -> the lexical editor whose
// node_modules deps are ESM-only and untransformable by next/jest, so stub the
// editor away (same trick as fee-button.test.js). 1e9 piconeros = 0.001 XMR.

jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

describe('initialTipAmount', () => {
  test('prefills with the saved default when random tips are off', () => {
    expect(initialTipAmount({ tipDefault: 1000000000 })).toBe('0.001')
  })

  test('picks an amount within range when random tips are on', () => {
    const privates = { tipRandom: true, tipRandomMin: 500000000, tipRandomMax: 2000000000 }
    // randomness: assert each call lands in [0.0005, 0.002], never equality
    expect(Number(initialTipAmount(privates))).toBeGreaterThanOrEqual(0.0005)
    expect(Number(initialTipAmount(privates))).toBeLessThanOrEqual(0.002)
    expect(Number(initialTipAmount(privates))).toBeGreaterThanOrEqual(0.0005)
    expect(Number(initialTipAmount(privates))).toBeLessThanOrEqual(0.002)
  })

  test('falls back to 0.001 XMR when no settings exist', () => {
    expect(initialTipAmount({})).toBe('0.001')
    expect(initialTipAmount(undefined)).toBe('0.001')
  })
})
