// Deterministic whole-payout planning for the rewards hot wallet (rewards
// accounting repair §6). Pure BigInt helpers: no Prisma client and no wallet is
// created here, so importing this module is inert and the planner is testable
// in isolation.

// Greedy first-fit-decreasing packing of WHOLE payouts onto funded signer
// accounts, keeping the largest-first priority in genuine shortage:
//   - payouts ordered amount descending, ties by payout ID ascending;
//   - accounts ordered remaining capacity descending, ties by lowest account
//     index, so the largest account absorbs the largest payouts;
//   - each payout is assigned whole to at most ONE account;
//   - a payout that fits no account is SKIPPED — it never vetoes the smaller
//     rows behind it;
//   - `feeReserve` (default 0n) subtracts per-account fee headroom from each
//     capacity, floored at zero (a sub-reserve account hosts nothing).
// Returns { buckets: [{ accountIndex, payouts }], skipped } with one bucket per
// used account, in assignment order. This is deliberate priority packing, not a
// claim of globally optimal bin packing.
export function planPartialAccountSends (payouts, unlockedByAccount, feeReserve = 0n) {
  const reserve = BigInt(feeReserve)
  const accounts = Object.entries(unlockedByAccount)
    .map(([idx, value]) => ({
      accountIndex: Number(idx),
      remaining: BigInt(value) > reserve ? BigInt(value) - reserve : 0n
    }))
    .sort((a, b) => (a.remaining > b.remaining ? -1 : a.remaining < b.remaining ? 1 : a.accountIndex - b.accountIndex))
  const ordered = [...payouts].sort((a, b) => (a.piconeros > b.piconeros ? -1 : a.piconeros < b.piconeros ? 1 : a.id - b.id))
  const buckets = new Map()
  const skipped = []
  for (const row of ordered) {
    const account = accounts.find(a => a.remaining >= row.piconeros)
    if (!account) {
      skipped.push(row)
      continue
    }
    account.remaining -= row.piconeros
    if (!buckets.has(account.accountIndex)) {
      buckets.set(account.accountIndex, { accountIndex: account.accountIndex, payouts: [] })
    }
    buckets.get(account.accountIndex).payouts.push(row)
  }
  return { buckets: [...buckets.values()], skipped }
}
