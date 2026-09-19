/* eslint-env jest */
import { territoryFeePiconeros, territoryFeePrivatesFor, TERRITORY_FEE_PRIVATES_ZERO } from '@/api/monero/territoryFee'

const CONFIG = {
  territoryMonthlyPiconeros: 20_000_000_000n, // 0.02 XMR
  territoryYearlyPiconeros: 200_000_000_000n, // 0.2 XMR
  territoryOncePiconeros: 1_000_000_000_000n // 1 XMR
}

test('territoryFeePiconeros returns the right amount per billing cycle (§6.2)', () => {
  expect(territoryFeePiconeros('MONTHLY', CONFIG)).toBe(20_000_000_000n)
  expect(territoryFeePiconeros('YEARLY', CONFIG)).toBe(200_000_000_000n)
  expect(territoryFeePiconeros('ONCE', CONFIG)).toBe(1_000_000_000_000n)
})

test('territoryFeePiconeros rejects an unknown billing type', () => {
  expect(() => territoryFeePiconeros('BIENNIAL', CONFIG)).toThrow(/unknown billingType/)
})

const PRIVATES_CONFIG = {
  territoryMonthlyPiconeros: 20_000_000_000n,
  territoryYearlyPiconeros: 200_000_000_000n,
  territoryOncePiconeros: 1_000_000_000_000n,
  commentFeePiconeros: 600_000_000n
}

test('territoryFeePrivatesFor quotes the live commentFeePiconeros knob', async () => {
  const models = { platformFeeConfig: { findUnique: async () => PRIVATES_CONFIG } }
  await expect(territoryFeePrivatesFor(models, 7)).resolves.toEqual({
    territoryMonthlyPiconeros: 20_000_000_000n,
    territoryYearlyPiconeros: 200_000_000_000n,
    territoryOncePiconeros: 1_000_000_000_000n,
    commentFeePiconeros: 600_000_000n
  })
})

test('territoryFeePrivatesFor returns zeros for logged-out viewers', async () => {
  await expect(territoryFeePrivatesFor({}, null)).resolves.toEqual(TERRITORY_FEE_PRIVATES_ZERO)
})
