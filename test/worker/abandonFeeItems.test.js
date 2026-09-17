/* eslint-env jest */

// Integration test for the 1-day abandonment sweep (worker/abandonFeeItems.js).
//
// A PENDING_FEE item is author-only-visible until its posting fee is observed
// on-chain; a fee the author never pays would otherwise linger forever (no
// badge, no re-pay path, no expiry). This sweep soft-deletes PENDING_FEE items
// (feeStatus still PENDING_FEE, feePayInId set) older than
// FEE_ITEM_ABANDON_DAYS (1 day), deletes their fee PayIn (the subaddress pool
// is ASSIGN-never-freed, so no reuse/misattribution risk), and clears any
// queued pgboss jobs for the item (timestampItem/imgproxy were queued at
// onPaid; deleteItem/reminder may be queued by performBotBehavior).
//
// Mirrors the real-DB style of test/worker/rewardsWalletObserver.fee.test.js:
// everything is real DB behaviour against the live dev database.

import { PrismaClient } from '@prisma/client'
import { runAbandonFeeItemsOnce } from '@/worker/abandonFeeItems'
import { FEE_ITEM_ABANDON_DAYS } from '@/lib/constants'

const prisma = new PrismaClient()

const created = { users: [], items: [], payIns: [], subFees: [], pidMaps: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Seed a PENDING_FEE item + its fee PayIn (mirrors itemCreate.onBegin's shape),
// created `ageMs` ago. Returns { item, payIn }.
async function seedPendingFeeItem (minor, { ageMs = 0, feeStatus = 'PENDING_FEE', pollCost, moneroPaymentId } = {}) {
  const userId = await createUser()
  const createdAt = new Date(Date.now() - ageMs)
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: `monero:5${'F'.repeat(94)}?tx_amount=0.001`,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor,
      createdAt,
      moneroPaymentId
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: {
      userId,
      title: `abandon-fixture-${minor}`,
      text: 'unpaid fixture reply',
      parentId: null,
      status: 'ACTIVE',
      feeStatus,
      feePayInId: payIn.id,
      pollCost,
      createdAt
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  created.items.push(item.id)
  return { item, payIn }
}

afterAll(async () => {
  for (const id of created.items) {
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE data->>'id' = ${String(id)} OR data->>'itemId' = ${String(id)}`
  }
  await prisma.reply.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.reply.deleteMany({ where: { ancestorId: { in: created.items } } })
  await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  // observation rows first: pre-SET-NULL their payInId may still point at a
  // seeded payIn (RESTRICT would block its deletion below)
  for (const id of created.subFees) await prisma.observedSubFee.deleteMany({ where: { id } })
  for (const pid of created.pidMaps) await prisma.subFeePidMap.deleteMany({ where: { paymentId: pid } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

const DAY_MS = 24 * 60 * 60 * 1000

test('abandons a PENDING_FEE item older than FEE_ITEM_ABANDON_DAYS', async () => {
  const { item, payIn } = await seedPendingFeeItem(501, { ageMs: (FEE_ITEM_ABANDON_DAYS + 1) * DAY_MS, pollCost: 10 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(1)
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).not.toBeNull()
  expect(live.text).toBe('*deleted by author*')
  expect(live.title).toBe('deleted by author')
  // pollCost is nulled like deleteItemByAuthor does
  expect(live.pollCost).toBeNull()
  // the fee PayIn is gone (subaddress stays ASSIGNED in the pool — no reuse)
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  expect(await prisma.itemPayIn.findFirst({ where: { itemId: item.id } })).toBeNull()
})

test('leaves a fresh PENDING_FEE item untouched', async () => {
  const { item } = await seedPendingFeeItem(502, { ageMs: 0 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).toBeNull()
})

test('leaves a PENDING_FEE item younger than the cutoff untouched', async () => {
  const { item } = await seedPendingFeeItem(503, { ageMs: DAY_MS - 60 * 60 * 1000 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).toBeNull()
})

test('leaves FEE_PAID and FEE_NOT_REQUIRED items untouched', async () => {
  const paid = await seedPendingFeeItem(504, { ageMs: 2 * DAY_MS, feeStatus: 'FEE_PAID' })
  const free = await seedPendingFeeItem(505, { ageMs: 2 * DAY_MS, feeStatus: 'FEE_NOT_REQUIRED' })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: paid.item.id } })).deletedAt).toBeNull()
  expect((await prisma.item.findUnique({ where: { id: free.item.id } })).deletedAt).toBeNull()
})

test('is idempotent across re-runs', async () => {
  const { item } = await seedPendingFeeItem(506, { ageMs: 2 * DAY_MS })

  await runAbandonFeeItemsOnce({ models: prisma })
  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).not.toBeNull()
})

// Regression (final review Finding 1): an underpaid owner-routed leg leaves an
// ObservedSubFee DETECTED receipt pointing at the fee PayIn. The sweep deletes
// that PayIn — with ON DELETE RESTRICT the delete threw P2003, rolled the whole
// abandonment tx back, and the hourly cron re-failed forever on the poison row.
// The FK must be ON DELETE SET NULL (same bug class as FeeObservation's
// 20260814202910 fix): the item is abandoned, the PayIn deleted, and the
// receipt survives detached (payInId nulled).
test('abandons an item with an ObservedSubFee receipt: PayIn deleted, receipt survives with payInId nulled', async () => {
  const PAYMENT_ID = 'deadbeef0c0de507'
  const SUB_NAME = '_abandonturf_507'
  const { item, payIn } = await seedPendingFeeItem(507, { ageMs: 2 * DAY_MS, moneroPaymentId: PAYMENT_ID })

  const receipt = await prisma.observedSubFee.create({
    data: {
      txHash: `abandonsubfee-${payIn.id}`,
      paymentId: PAYMENT_ID,
      payInId: payIn.id,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      piconeros: 1_000n, // underpaid vs the quoted fee
      state: 'DETECTED'
    }
  })
  created.subFees.push(receipt.id)
  await prisma.subFeePidMap.create({
    data: {
      paymentId: PAYMENT_ID,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      amountPiconeros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  })
  created.pidMaps.push(PAYMENT_ID)

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(1)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).not.toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  const live = await prisma.observedSubFee.findUnique({ where: { id: receipt.id } })
  expect(live).not.toBeNull()
  expect(live.payInId).toBeNull()
  expect(live.state).toBe('DETECTED')
})

// --- deferred fee-bearing edits (PendingItemUpdate) ---
// A never-paid ITEM_UPDATE upload fee leaves the item untouched but strands the
// stored edit; the sweep purges it after FEE_ITEM_ABANDON_DAYS and deletes the
// fee payIn (a late payment then finds no payIn and is ignored, exactly like the
// abandoned ITEM_CREATE behavior).
async function seedPendingUpdate ({ minor, ageMs }) {
  const userId = await createUser()
  const createdAt = new Date(Date.now() - ageMs)
  const item = await prisma.item.create({
    data: {
      userId,
      title: `pending-update-fixture-${minor}`,
      text: 'original text',
      createdAt,
      feeStatus: 'FEE_NOT_REQUIRED'
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_UPDATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: `monero:5${'F'.repeat(94)}?tx_amount=0.001`,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor,
      createdAt
    }
  })
  created.payIns.push(payIn.id)
  const pending = await prisma.pendingItemUpdate.create({
    data: {
      itemId: item.id,
      payInId: payIn.id,
      oldText: 'original text',
      args: { id: String(item.id), text: 'deferred text' },
      createdAt
    }
  })
  return { item, payIn, pending }
}

test('purges a deferred edit (and its payIn) older than FEE_ITEM_ABANDON_DAYS', async () => {
  const { item, payIn, pending } = await seedPendingUpdate({ minor: 601, ageMs: 2 * DAY_MS })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.pendingPurged).toBe(1)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { id: pending.id } })).toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  // the item itself is untouched — the edit was never applied
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).toBeNull()
  expect(live.text).toBe('original text')
})

test('leaves a fresh deferred edit untouched', async () => {
  const { pending } = await seedPendingUpdate({ minor: 602, ageMs: 0 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.pendingPurged).toBe(0)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { id: pending.id } })).toBeTruthy()
})
