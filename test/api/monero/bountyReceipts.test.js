/* eslint-env jest */

// Pure + stubbed contract tests for the confirmed bounty-arrival receipt helper
// (Task 4, rewards accounting repair §4). The integrated attribution/recovery
// behavior (real rows, the absence-of-receipt candidate query, cursor misses)
// lives in test/worker/rewardsWalletObserver.bounty.test.js against the
// dedicated isolated DB; this file never touches a database.
//
// Split rule (§4): for a rollover with net received N and frozen booked prize B
// the rewards component is min(B, N) and the remainder is ops; award/reclaim
// and legacy separate fees are 100% ops. Every row books the ACTUAL net
// received amount, never the requested gross.

import { bountyReceiptSplit, attributeBountyReceipt } from '@/api/monero/bountyReceipts'

test.each([
  ['ROLLOVER', 139n, 100n, 100n],
  ['ROLLOVER', 99n, 100n, 99n],
  ['AWARD', 39n, 100n, 0n],
  ['RECLAIM', 39n, 100n, 0n]
])('%s books received %s only', (kind, received, bounty, reward) => {
  expect(bountyReceiptSplit({ kind, receivedPiconeros: received, bountyPiconeros: bounty }))
    .toEqual({ piconeros: received, rewardsPiconeros: reward })
})

test('a negative received amount is refused', () => {
  expect(() => bountyReceiptSplit({ kind: 'ROLLOVER', receivedPiconeros: -1n, bountyPiconeros: 100n }))
    .toThrow(/negative/)
})

test('a rollover never books more rewards than it received', () => {
  expect(bountyReceiptSplit({ kind: 'ROLLOVER', receivedPiconeros: 0n, bountyPiconeros: 100n }))
    .toEqual({ piconeros: 0n, rewardsPiconeros: 0n })
})

// A models stub that THROWS on any property access: a contract guard must
// refuse before it looks anything up.
const untouchableModels = new Proxy({}, {
  get () { throw new Error('models must not be touched') }
})

test('attributeBountyReceipt refuses a non platform_rewards account before any DB access', async () => {
  await expect(attributeBountyReceipt({
    models: untouchableModels,
    account: { label: 'user', address: '5HOT' },
    tx: { hash: 'aa', piconeros: 1n, height: 700, recipient: { maj_i: 0, min_i: 0 } }
  })).resolves.toBeNull()
})

test('attributeBountyReceipt refuses a sight without recipient metadata (no fabricated 0/0)', async () => {
  const account = { label: 'platform_rewards', address: '5HOT' }
  await expect(attributeBountyReceipt({
    models: untouchableModels,
    account,
    tx: { hash: 'aa', piconeros: 1n, height: 700 }
  })).resolves.toBeNull()
  await expect(attributeBountyReceipt({
    models: untouchableModels,
    account,
    tx: { hash: 'aa', piconeros: 1n, height: 700, recipient: { maj_i: null, min_i: 0 } }
  })).resolves.toBeNull()
})

test('attributeBountyReceipt refuses a sight without an amount before any DB access', async () => {
  await expect(attributeBountyReceipt({
    models: untouchableModels,
    account: { label: 'platform_rewards', address: '5HOT' },
    tx: { hash: 'aa', piconeros: null, height: 700, recipient: { maj_i: 0, min_i: 0 } }
  })).resolves.toBeNull()
})
