/* eslint-env jest */
import { territoryFeePiconeros, territoryFeePrivatesFor } from '@/api/monero/territoryFee'

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
  ...CONFIG,
  postingFeeFloorPiconeros: 1_000_000_000n
}

test('territoryFeePrivatesFor returns the live config bundle for a logged-in viewer', async () => {
  const models = { platformFeeConfig: { findUnique: jest.fn(async () => PRIVATES_CONFIG) } }
  const result = await territoryFeePrivatesFor(models, 7)
  expect(result).toEqual({
    territoryMonthlyPiconeros: 20_000_000_000n,
    territoryYearlyPiconeros: 200_000_000_000n,
    territoryOncePiconeros: 1_000_000_000_000n,
    commentFeePiconeros: 1_000_000_000n
  })
})

test('territoryFeePrivatesFor zeroes everything for anonymous viewers', async () => {
  const models = { platformFeeConfig: { findUnique: jest.fn() } }
  expect(await territoryFeePrivatesFor(models, null)).toEqual({
    territoryMonthlyPiconeros: 0n,
    territoryYearlyPiconeros: 0n,
    territoryOncePiconeros: 0n,
    commentFeePiconeros: 0n
  })
  expect(models.platformFeeConfig.findUnique).not.toHaveBeenCalled()
})

test('territoryFeePrivatesFor zeroes everything when the config is missing', async () => {
  const models = { platformFeeConfig: { findUnique: jest.fn(async () => null) } }
  expect(await territoryFeePrivatesFor(models, 7)).toEqual({
    territoryMonthlyPiconeros: 0n,
    territoryYearlyPiconeros: 0n,
    territoryOncePiconeros: 0n,
    commentFeePiconeros: 0n
  })
})
