import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Sweeps leaked FAKE platform_rewards rows from the shared dev DB.
//
// Incident background ('base58xmr: wrong padding' breaking tips/downvotes):
// several suites seed MoneroAccount rows with label 'platform_rewards' and
// unique placeholder addresses so the findFirst(orderBy: id asc) resolution
// picks them. jest afterAll hooks don't run when a worker dies mid-suite, and
// mid-test failures can skip tracked cleanup — a leaked fake then keeps
// winning the resolver lookup and breaks tipping/downvoting on the dev stack
// until manually deleted (fake addresses fail base58xmr decode).
//
// Race-free across parallel jest workers: each suite sweeps ONLY its own
// unique placeholder addresses (suites never share addresses by design), so
// one worker can never delete a row another worker's suite is actively using.
// The real wallet registered via `sndev monero register-rewards-wallet` is
// never touched (its address is never in a suite's sweep list).
//
// Usage: call in beforeAll (self-heal leaks from crashed prior runs) and in
// afterAll (normal-path cleanup that doesn't depend on row tracking).
export async function sweepFakeRewardsWallets (addresses) {
  if (!addresses?.length) return
  const leaked = await prisma.moneroAccount.findMany({
    where: { label: 'platform_rewards', address: { in: addresses } },
    select: { id: true }
  })
  if (!leaked.length) return
  const ids = leaked.map((a) => a.id)
  // dependents first (FK RESTRICT) — mirrors cleanupTracked in monero.test.js
  await prisma.observedTip.deleteMany({ where: { recipientAccountId: { in: ids } } })
  await prisma.observedBounty.deleteMany({ where: { recipientAccountId: { in: ids } } })
  await prisma.subaddressIndex.deleteMany({ where: { accountId: { in: ids } } })
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: ids } } })
  const deleted = await prisma.moneroAccount.deleteMany({ where: { id: { in: ids } } })
  return deleted.count
}
