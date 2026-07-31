/* eslint-env jest */
import { territoryFeePiconeros } from '@/api/monero/territoryFee'

const CONFIG = {
  territoryMonthlyPiconeros: 200_000_000_000n, // 0.2 XMR
  territoryYearlyPiconeros: 2_000_000_000_000n, // 2 XMR
  territoryOncePiconeros: 10_000_000_000_000n // 10 XMR
}

test('territoryFeePiconeros returns the right amount per billing cycle (§6.2)', () => {
  expect(territoryFeePiconeros('MONTHLY', CONFIG)).toBe(200_000_000_000n)
  expect(territoryFeePiconeros('YEARLY', CONFIG)).toBe(2_000_000_000_000n)
  expect(territoryFeePiconeros('ONCE', CONFIG)).toBe(10_000_000_000_000n)
})

test('territoryFeePiconeros rejects an unknown billing type', () => {
  expect(() => territoryFeePiconeros('BIENNIAL', CONFIG)).toThrow(/unknown billingType/)
})
