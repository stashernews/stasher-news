/* eslint-env jest */
// Stresses the webhook receiver under concurrent 0-conf deliveries. Requires the live stack
// (./sndev start) with LWS_WEBHOOK_TOKEN empty (dev default → no auth check). The DETECTED
// path never calls lws, so no lws dependency is exercised — this is a pure DB-throughput test.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const N = Number(process.env.WEBHOOK_LOAD_N || 500)
const BUDGET_MS = Number(process.env.WEBHOOK_LOAD_BUDGET_MS || 30_000)
const URL = process.env.LWS_WEBHOOK_URL || 'http://app:3000/api/monero/webhook'

test(`webhook receiver handles ${N} concurrent 0-conf callbacks within budget with no double-count`, async () => {
  const tips = await prisma.observedTip.findMany({
    where: { state: 'PENDING' },
    select: { id: true, paymentId: true, piconeros: true, postId: true },
    take: N
  })
  expect(tips.length).toBeGreaterThan(0)

  const postBefore = await prisma.item.findUnique({ where: { id: tips[0].postId }, select: { msats: true } })
  const sumExpected = tips.reduce((s, t) => s + t.piconeros, 0n)

  const start = Date.now()
  // Fire all callbacks concurrently — worst case for the receiver's atomic claim.
  await Promise.all(tips.map((t) =>
    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: t.paymentId,
        confirmations: 0,
        tx_info: { tx_hash: '0x' + t.paymentId.padEnd(8, '0'), block: null, amount: t.piconeros.toString() }
      })
    })
  ))
  const elapsed = Date.now() - start

  // Every tip should now be DETECTED (exactly once — no double-apply under concurrency).
  const stillPending = await prisma.observedTip.count({ where: { id: { in: tips.map(t => t.id) }, state: 'PENDING' } })
  const detected = await prisma.observedTip.count({ where: { id: { in: tips.map(t => t.id) }, state: 'DETECTED' } })
  expect(stillPending).toBe(0)
  expect(detected).toBe(tips.length)

  // msats bumped by EXACTLY the sum (the atomic claim guarantees no double-count).
  const postAfter = await prisma.item.findUnique({ where: { id: tips[0].postId }, select: { msats: true } })
  expect(postAfter.msats - postBefore.msats).toBe(sumExpected)

  console.log(`webhook load: ${tips.length} callbacks in ${elapsed}ms (budget ${BUDGET_MS}ms)`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
}, BUDGET_MS + 60_000)
