/* eslint-env jest */

import { bountyFeePiconeros } from '@/api/monero/bounties'

test('bounty fee is max(0.01 XMR, 1% of bounty)', () => {
  const config = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }
  expect(bountyFeePiconeros(1_000_000_000n, config)).toBe(10_000_000_000n) // below min -> min
  expect(bountyFeePiconeros(1_000_000_000_000n, config)).toBe(10_000_000_000n) // exactly min
  expect(bountyFeePiconeros(3_000_000_000_000n, config)).toBe(30_000_000_000n) // 1%
})
