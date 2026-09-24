/* eslint-env jest */
import { discountedTerritoryFee } from '@/api/monero/territoryFee'

test('a 15% discount floors to whole piconeros and never underflows', () => {
  expect(discountedTerritoryFee(20_000_000_000n, true)).toBe(17_000_000_000n)
  expect(discountedTerritoryFee(20_000_000_000n, false)).toBe(20_000_000_000n)
  // odd remainder floors the discount down, never the fee below zero
  expect(discountedTerritoryFee(1_000_000_000_001n, true)).toBe(850_000_000_001n)
  expect(discountedTerritoryFee(1n, true)).toBe(1n)
  expect(discountedTerritoryFee(0n, true)).toBe(0n)
})
