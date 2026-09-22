/* eslint-env jest */
// Real-DB test: an upload pinned by a draft survives the sweep; an identical
// unpinned one is reaped (row + object). Self-cleaning via created-id tracking.
import { PrismaClient } from '@prisma/client'
import { deleteUnusedImages } from '@/worker/deleteUnusedImages'
// jest.mock cannot resolve the `@/` alias (next/jest registers no `@/*`
// moduleNameMapper), so the mock uses the relative path — same as
// test/worker/deleteUnusedImages.test.js.
import { deleteObjects } from '../../api/s3'

jest.mock('../../api/s3', () => ({
  deleteObjects: jest.fn(async ids => ids)
}))

const prisma = new PrismaClient()
const created = { uploads: [], drafts: [], users: [] }

afterAll(async () => {
  await prisma.draft.deleteMany({ where: { id: { in: created.drafts } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {})
  await prisma.$disconnect()
})

// "Upload"."userId" is NOT NULL in the real schema, so the seed takes the
// fixture user's id (the brief's NULL placeholder would violate the FK).
async function seedUpload (userId) {
  const [u] = await prisma.$queryRaw`
    INSERT INTO "Upload" (type, size, "userId", paid, created_at, updated_at)
    VALUES ('image/png', 1024, ${userId}::int, false,
            date_trunc('hour', now() - interval '48 hours'),
            date_trunc('hour', now() - interval '48 hours'))
    RETURNING id::int AS id`
  created.uploads.push(u.id)
  return u.id
}

test('draft-pinned upload survives; unpinned twin is reaped', async () => {
  deleteObjects.mockClear()

  const [user] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(user.id)
  const [draft] = await prisma.$queryRaw`
    INSERT INTO draft ("user_id", type, text, created_at, updated_at)
    VALUES (${user.id}::int, 'DISCUSSION', 'pinned', now(), now())
    RETURNING id::int AS id`
  created.drafts.push(draft.id)

  const pinnedId = await seedUpload(user.id)
  const looseId = await seedUpload(user.id)
  await prisma.$executeRaw`INSERT INTO draft_upload (draft_id, upload_id) VALUES (${draft.id}::int, ${pinnedId}::int)`

  await deleteUnusedImages({ models: prisma, boss: { send: jest.fn() } })

  expect(deleteObjects).toHaveBeenCalledWith(expect.arrayContaining([looseId]))
  expect(deleteObjects).not.toHaveBeenCalledWith(expect.arrayContaining([pinnedId]))
  const survivors = await prisma.upload.findMany({ where: { id: { in: [pinnedId, looseId] } } })
  expect(survivors.map(s => s.id)).toEqual([pinnedId])
})
