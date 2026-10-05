/* eslint-env jest */
// Pure planner tests for the rewards hot-wallet payout packing (Task 8 / spec
// §6). No wallet, no DB: planPartialAccountSends is a deterministic BigInt
// assignment — largest whole payout first, ties by payout ID, accounts by
// remaining capacity (ties by lowest account index), and a payout that fits no
// account is skipped instead of vetoing the smaller rows behind it.
import { planPartialAccountSends } from '@/api/monero/rewardsPlan'

const payout = (id, amount) => ({ id, piconeros: BigInt(amount) })

test('largest-first subset skips a non-fitting reward but uses room for smaller ones', () => {
  const a = payout(1, 60)
  const b = payout(2, 40)
  const c = payout(3, 15)
  expect(planPartialAccountSends([a, b, c], { 0: 80n }, 0n))
    .toEqual({ buckets: [{ accountIndex: 0, payouts: [a, c] }], skipped: [b] })
})

test('an oversized first reward does not veto an affordable second reward', () => {
  const a = payout(1, 100)
  const b = payout(2, 10)
  expect(planPartialAccountSends([a, b], { 0: 20n }, 1n))
    .toEqual({ buckets: [{ accountIndex: 0, payouts: [b] }], skipped: [a] })
})

test('equal rewards and account capacities have deterministic ID/index priority', () => {
  const a = payout(1, 10)
  const b = payout(2, 10)
  expect(planPartialAccountSends([b, a], { 2: 10n, 0: 10n }, 0n))
    .toEqual({ buckets: [{ accountIndex: 0, payouts: [a] }, { accountIndex: 2, payouts: [b] }], skipped: [] })
})

test('a payout is assigned to exactly one account across buckets and skipped rows keep planner order', () => {
  const a = payout(1, 50)
  const b = payout(2, 40)
  const c = payout(3, 30)
  // account 0 hosts 50, account 1 hosts 40; 30 fits nowhere and is skipped.
  expect(planPartialAccountSends([c, b, a], { 0: 50n, 1: 40n }, 0n))
    .toEqual({ buckets: [{ accountIndex: 0, payouts: [a] }, { accountIndex: 1, payouts: [b] }], skipped: [c] })
})
