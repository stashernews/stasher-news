/* eslint-env jest */
// Real-DB integrity for post-window addendum media (2026-10-04 spec):
// the unreferenced-media sweep must honor addendum pins ONLY when no upload
// fee is outstanding (paid, or free-tier ≤10MB from a registered user) — a
// never-paid fee-bearing upload keeps its existing abandonment → sweep
// lifecycle even while an addendum references it. Also pins the imgproxy
// worker reading addendum text so reused-media previews resolve.
//
//   docker exec -u apprunner app npx jest test/worker/item-addendum-media.test.js
import { PrismaClient } from '@prisma/client'
import { UPLOAD_FREE_BYTES_MAX } from '@/lib/constants'
import { deleteObjects } from '../../api/s3'
import { deleteUnusedImages } from '@/worker/deleteUnusedImages'
import { createImgproxyUrls } from '@/worker/imgproxy'

jest.mock('../../api/s3', () => ({
  deleteObjects: jest.fn(async keys => keys)
}))
// lib/md is ESM-only (mdast) and cannot load in jest's sandbox; imgproxy only
// consumes extractUrls from it, so provide a plain URL-extraction stub — the
// video path under test short-circuits before any media-metadata fetch.
jest.mock('../../lib/md', () => ({
  __esModule: true,
  extractUrls: text => [...String(text ?? '').matchAll(/https?:\/\/[^\s)]+/g)].map(m => m[0])
}))

const prisma = new PrismaClient()
const created = { users: [], items: [], uploads: [] }

afterAll(async () => {
  await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  await prisma.itemAddendumUpload.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  await prisma.itemUpload.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  for (const id of created.items) await prisma.item.delete({ where: { id } }).catch(() => {})
  for (const id of created.uploads) await prisma.upload.delete({ where: { id } }).catch(() => {})
  for (const id of created.users) await prisma.user.delete({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

const UPLOAD_SIZE_LARGE = UPLOAD_FREE_BYTES_MAX + 1024
const UPLOAD_SIZE_SMALL = 1024

async function createUser () {
  const [user] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(user.id)
  return user.id
}

// Sweeps only touch uploads older than 24h — seed everything past that line.
async function seedUpload (userId, { size = UPLOAD_SIZE_SMALL, paid = false, type = 'image/png' } = {}) {
  const [u] = await prisma.$queryRaw`
    INSERT INTO "Upload" (type, size, "userId", paid, created_at, updated_at)
    VALUES (${type}, ${size}::int, ${userId}::int, ${paid},
            date_trunc('hour', now() - interval '48 hours'),
            date_trunc('hour', now() - interval '48 hours'))
    RETURNING id::int AS id`
  created.uploads.push(u.id)
  return u.id
}

async function createItem (userId, { deleted = false, withText = false } = {}) {
  const item = await prisma.item.create({
    data: {
      userId,
      title: `addendum-media-${Date.now()}-${Math.random()}`,
      text: withText ? 'original body' : null,
      status: 'ACTIVE',
      ...(deleted ? { deletedAt: new Date() } : {})
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

const pinToAddendum = (itemId, uploadId) =>
  prisma.itemAddendumUpload.create({ data: { itemId, uploadId } })

async function runSweep () {
  deleteObjects.mockClear()
  await deleteUnusedImages({ models: prisma, boss: { send: jest.fn() } })
  return deleteObjects.mock.calls.flatMap(([keys]) => keys)
}

test('a paid upload referenced only by a live addendum survives the sweep', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId)
  const paidId = await seedUpload(userId, { size: UPLOAD_SIZE_LARGE, paid: true })
  await pinToAddendum(itemId, paidId)

  const reaped = await runSweep()
  expect(reaped).not.toContain(paidId)
  expect(await prisma.upload.findUnique({ where: { id: paidId } })).not.toBeNull()
})

test('an unpaid fee-bearing upload is reaped even though an addendum references it', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId)
  const unpaidLargeId = await seedUpload(userId, { size: UPLOAD_SIZE_LARGE, paid: false })
  await pinToAddendum(itemId, unpaidLargeId)

  const reaped = await runSweep()
  expect(reaped).toContain(unpaidLargeId)
  expect(await prisma.upload.findUnique({ where: { id: unpaidLargeId } })).toBeNull()
})

test('a free-tier unpaid upload referenced by a live addendum survives (no fee was ever due)', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId)
  const freeTierId = await seedUpload(userId, { size: UPLOAD_SIZE_SMALL, paid: false })
  await pinToAddendum(itemId, freeTierId)

  const reaped = await runSweep()
  expect(reaped).not.toContain(freeTierId)
})

test('clearing the addendum drops its pins and permits normal cleanup', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId)
  const uploadId = await seedUpload(userId)
  await pinToAddendum(itemId, uploadId)
  expect((await runSweep())).not.toContain(uploadId)

  await prisma.itemAddendumUpload.deleteMany({ where: { itemId } })
  expect((await runSweep())).toContain(uploadId)
})

test('a deleted addendum-owner item no longer retains its media', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId, { deleted: true })
  const uploadId = await seedUpload(userId)
  await pinToAddendum(itemId, uploadId)

  expect((await runSweep())).toContain(uploadId)
})

test('an original ItemUpload on the same item is untouched by addendum pin writes', async () => {
  const userId = await createUser()
  const itemId = await createItem(userId, { withText: true })
  const originalId = await seedUpload(userId, { size: UPLOAD_SIZE_LARGE, paid: true })
  const addendumId = await seedUpload(userId, { size: UPLOAD_SIZE_SMALL, paid: true })
  await prisma.itemUpload.create({ data: { itemId, uploadId: originalId } })
  await pinToAddendum(itemId, addendumId)

  const reaped = await runSweep()
  expect(reaped).not.toContain(originalId)
  expect(reaped).not.toContain(addendumId)
  expect(await prisma.itemUpload.count({ where: { itemId } })).toBe(1)
})

test('imgproxy processes addendum urls: a reused video keeps its video hint', async () => {
  const userId = await createUser()
  const uploadId = await seedUpload(userId, { type: 'video/mp4' })

  // original text carries no media; the addendum references a self-hosted video
  const imgproxyUrls = await createImgproxyUrls(
    0, `still no media\n\n${process.env.NEXT_PUBLIC_MEDIA_URL}/${uploadId}`, { models: prisma }
  )
  expect(imgproxyUrls[`${process.env.NEXT_PUBLIC_MEDIA_URL}/${uploadId}`]).toEqual({ video: true })
})
