/* eslint-env jest */

import { bountyFeePiconeros } from '@/api/monero/bounties'

const config = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }

test('bounty fee = flat 0.01 XMR below the 1% threshold', () => {
  expect(bountyFeePiconeros(1_000_000_000_000n, config)).toBe(10_000_000_000n) // exactly 1 XMR -> 0.01
  expect(bountyFeePiconeros(500_000_000_000n, config)).toBe(10_000_000_000n) // 0.5 XMR -> 0.01
})

test('bounty fee = 1% above the 1% threshold', () => {
  expect(bountyFeePiconeros(3_000_000_000_000n, config)).toBe(30_000_000_000n) // 1% of 3 XMR
})

test('bounty fee is capped at 20% of the bounty for small bounties', () => {
  expect(bountyFeePiconeros(10_000_000_000n, config)).toBe(2_000_000_000n) // min bounty 0.01 -> 20% = 0.002
  expect(bountyFeePiconeros(50_000_000_000n, config)).toBe(10_000_000_000n) // 0.05 -> 20% = 0.01 (cap meets floor)
  expect(bountyFeePiconeros(5_000_000_000n, config)).toBe(1_000_000_000n) // below min bounty but math still caps
})

test('bounty fee never exceeds 20% even when the flat floor applies', () => {
  expect(bountyFeePiconeros(1_000_000_000n, config)).toBe(200_000_000n) // 20% of 0.001
})
