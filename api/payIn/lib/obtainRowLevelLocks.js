import { Prisma } from '@prisma/client'

// we lock all users in the payIn in order to avoid deadlocks with other payIns
// that might be competing to update the same users, e.g. two users simultaneously zapping each other
// https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
// alternative approaches:
// 1. do NOT lock all users, but use NOWAIT on users locks so that we can catch AND retry transactions that fail with a deadlock error
// anything we can do to minimize the time spent in these interactive txs would also help
export async function obtainRowLevelLocks (tx, payIn) {
  // StasherNews fee-based payIns (territory create/billing, posting, downvote) return
  // piconeros=0n with no custodial pay-outs, so payOutCustodialTokens is undefined. Guard it
  // to avoid "Cannot read properties of undefined (reading 'map')" — matches the
  // optional-chaining already used in api/payIn/lib/assert.js.
  const payOutUserIds = [...new Set((payIn.payOutCustodialTokens ?? []).map(t => t.userId)).add(payIn.userId)]
  await tx.$executeRaw`SELECT * FROM users WHERE id IN (${Prisma.join(payOutUserIds)}) ORDER BY id ASC FOR NO KEY UPDATE`
}
