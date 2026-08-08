/* eslint-env jest */

// Integration test for the unused-image cleanup worker (Task 3 of the upload-fee
// plan). Seeds Upload rows with past created_at timestamps and runs
// deleteUnusedImages directly (no pg-boss), asserting only the old, unreferenced
// uploads are deleted — 7 days for registered users, 24 hours for anons —
// regardless of the paid flag, while recent or item-referenced uploads survive.
//
// S3 deletes hit the local dev media service (MEDIA_URL_DOCKER = localstack),
// whose delete-objects is idempotent for missing keys. Mirrors the fixture style
// of test/worker/rewardsWalletObserver.fee.test.js.

import { PrismaClient } from '@prisma/client'
import { USER_ID } from '@/lib/constants'
import { deleteUnusedImages } from '@/worker/deleteUnusedImages'

const prisma = new PrismaClient()

const DAY_MS = 24 * 60 * 60 * 1000

const created = { users: [], items: [], uploads: [] }

afterAll(async () => {
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.uploads) await prisma.upload.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function seedUpload ({ userId, ageMs, paid = false, referenced = false }) {
  const upload = await prisma.upload.create({
    data: {
      userId,
      type: 'image/png',
      size: 1024,
      paid,
      createdAt: new Date(Date.now() - ageMs)
    }
  })
  created.uploads.push(upload.id)
  if (referenced) {
    const item = await prisma.item.create({
      data: { userId, title: `image-post-${upload.id}`, status: 'ACTIVE', uploadId: upload.id }
    })
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    created.items.push(item.id)
  }
  return upload
}

test('deleteUnusedImages deletes old unreferenced uploads (7d registered / 24h anon) regardless of paid, keeping recent and referenced ones, and self-requeues', async () => {
  const userId = await createUser()

  const oldUnpaid = await seedUpload({ userId, ageMs: 8 * DAY_MS })
  // an old upload that paid the fee: freed from the paid-gate so it is swept too
  const oldPaid = await seedUpload({ userId, ageMs: 8 * DAY_MS, paid: true })
  const recent = await seedUpload({ userId, ageMs: DAY_MS })
  const referenced = await seedUpload({ userId, ageMs: 8 * DAY_MS, referenced: true })
  // anon uploads are deleted after 24h instead of 7d
  const oldAnon = await seedUpload({ userId: USER_ID.anon, ageMs: 2 * DAY_MS })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: { id: { in: [oldUnpaid.id, oldPaid.id, recent.id, referenced.id, oldAnon.id] } },
    select: { id: true }
  })
  const remainingIds = remaining.map(({ id }) => id).sort()
  expect(remainingIds).toEqual([recent.id, referenced.id].sort())
  // the daily sweep re-queues itself for the next run
  expect(boss.send).toHaveBeenCalledWith('deleteUnusedImages', {}, { startAfter: 24 * 60 * 60 })
})
