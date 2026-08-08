/* eslint-env jest */

// Integration test for the unused-image cleanup worker (Task 3 of the upload-fee
// plan). Seeds Upload rows with past created_at timestamps and runs
// deleteUnusedImages directly (no pg-boss), asserting only the old, unreferenced
// uploads are deleted — 7 days for registered users, 24 hours for anons —
// regardless of the paid flag, while recent or referenced uploads survive.
// References cover every real attachment path: the ItemUpload join table (the
// path posts/comments actually use), Item.uploadId (job listings), the
// SubBranding.logoId (territory logos) and users.photoId.
//
// S3 is stubbed (deleteObjects returns its input keys) so the test is hermetic:
// with NODE_ENV=test the real @/api/s3 targets Amazon S3 with the localstack
// example creds and fails, which would leave the DB rows undeleted. The mock
// must use a relative path — next/jest registers no `@/*` moduleNameMapper, so
// jest.mock cannot resolve the `@/` alias as its first argument. babel-jest
// hoists the mock above the imports at runtime. Mirrors the fixture style of
// test/worker/rewardsWalletObserver.fee.test.js.

import { PrismaClient } from '@prisma/client'
import { USER_ID } from '@/lib/constants'
import { deleteUnusedImages } from '@/worker/deleteUnusedImages'

jest.mock('../../api/s3', () => ({
  deleteObjects: jest.fn(async keys => keys)
}))

const prisma = new PrismaClient()

const DAY_MS = 24 * 60 * 60 * 1000

const created = { users: [], items: [], subs: [], uploads: [] }

afterAll(async () => {
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.uploads) await prisma.upload.deleteMany({ where: { id } })
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Minimal item; path is set via a second statement (ltree is unsupported in
// Prisma create), exactly like test/engine/payInItemCreate.test.js.
async function createItem (userId, { uploadId = null } = {}) {
  const item = await prisma.item.create({
    data: {
      userId,
      title: `image-post-${Date.now()}-${Math.random()}`,
      status: 'ACTIVE',
      ...(uploadId ? { uploadId } : {})
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item
}

// reference selects which attachment path pins the upload to live content:
//   - 'itemUpload': the ItemUpload join table — the real path for posts/comments
//   - 'itemUploadId': Item.uploadId — job listings
//   - 'logo': SubBranding.logoId — territory logos
//   - 'photo': users.photoId — user profile photos
async function seedUpload ({ userId, ageMs, paid = false, reference = null }) {
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
  if (reference === 'itemUpload') {
    const item = await createItem(userId)
    await prisma.itemUpload.create({ data: { itemId: item.id, uploadId: upload.id } })
  } else if (reference === 'itemUploadId') {
    await createItem(userId, { uploadId: upload.id })
  } else if (reference === 'logo') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-logo-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000
      }
    })
    created.subs.push(sub.name)
    await prisma.subBranding.create({ data: { subName: sub.name, logoId: upload.id } })
  } else if (reference === 'photo') {
    await prisma.user.update({ where: { id: userId }, data: { photoId: upload.id } })
  }
  return upload
}

test('deleteUnusedImages deletes old unreferenced uploads (7d registered / 24h anon) regardless of paid, keeping recent and referenced ones, and self-requeues', async () => {
  const userId = await createUser()

  const oldUnpaid = await seedUpload({ userId, ageMs: 8 * DAY_MS })
  // an old upload that paid the fee: freed from the paid-gate so it is swept too
  const oldPaid = await seedUpload({ userId, ageMs: 8 * DAY_MS, paid: true })
  const recent = await seedUpload({ userId, ageMs: DAY_MS })
  // old uploads survive when referenced through ANY attachment path
  const refItemUpload = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUpload' })
  const refItemUploadId = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUploadId' })
  const refLogo = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'logo' })
  const refPhoto = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'photo' })
  // anon uploads are deleted after 24h instead of 7d
  const oldAnon = await seedUpload({ userId: USER_ID.anon, ageMs: 2 * DAY_MS })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: {
      id: { in: [oldUnpaid.id, oldPaid.id, recent.id, refItemUpload.id, refItemUploadId.id, refLogo.id, refPhoto.id, oldAnon.id] }
    },
    select: { id: true }
  })
  const remainingIds = remaining.map(({ id }) => id).sort()
  expect(remainingIds).toEqual([recent.id, refItemUpload.id, refItemUploadId.id, refLogo.id, refPhoto.id].sort())
  // the daily sweep re-queues itself for the next run
  expect(boss.send).toHaveBeenCalledWith('deleteUnusedImages', {}, { startAfter: 24 * 60 * 60 })
})
