/* eslint-env jest */

// Real-DB test for the 90-day stale-draft sweep (worker/abandonStaleDrafts.js).
//
// A draft is owner-only state; one untouched for DRAFT_TTL_DAYS (90 days) is
// deleted in bulk (DraftUpload pins cascade with it — the freed Upload rows
// become unpinned and the daily deleteUnusedImages sweep reaps them later).
// Mirrors the real-DB style of test/worker/abandonFeeItems.test.js:
// everything is real DB behaviour against the live dev database.

import { PrismaClient } from '@prisma/client'
import { abandonStaleDrafts } from '@/worker/abandonStaleDrafts'

const prisma = new PrismaClient()
const created = { users: [], drafts: [], uploads: [] }

afterAll(async () => {
  await prisma.draft.deleteMany({ where: { id: { in: created.drafts } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {})
  await prisma.$disconnect()
})

// "Upload"."userId" is NOT NULL in the real schema (same as
// test/worker/deleteUnusedImages-pin.test.js's fixture).
async function seedUpload (userId) {
  const [u] = await prisma.$queryRaw`
    INSERT INTO "Upload" (type, size, "userId", paid, created_at, updated_at)
    VALUES ('image/png', 1024, ${userId}::int, false, now(), now())
    RETURNING id::int AS id`
  created.uploads.push(u.id)
  return u.id
}

test('deletes drafts untouched for 90 days; fresh drafts survive; pins cascade', async () => {
  const [user] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(user.id)
  const stale = await prisma.draft.create({
    data: { userId: user.id, type: 'DISCUSSION', text: 'stale', updatedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) }
  })
  const fresh = await prisma.draft.create({ data: { userId: user.id, type: 'DISCUSSION', text: 'fresh' } })
  created.drafts.push(fresh.id)

  // a media pin on the stale draft — must cascade away with it (the Upload
  // row itself survives unpinned; the daily media sweep reaps it later)
  const uploadId = await seedUpload(user.id)
  await prisma.$executeRaw`INSERT INTO draft_upload (draft_id, upload_id) VALUES (${stale.id}::int, ${uploadId}::int)`

  const summary = await abandonStaleDrafts({ models: prisma })
  expect(summary.deleted).toBeGreaterThanOrEqual(1)

  const gone = await prisma.draft.findUnique({ where: { id: stale.id } })
  const alive = await prisma.draft.findUnique({ where: { id: fresh.id } })
  expect(gone).toBeNull()
  expect(alive?.id).toBe(fresh.id)
  // the pin cascaded; the upload row is merely unpinned, not deleted
  expect(await prisma.draftUpload.findUnique({
    where: { draftId_uploadId: { draftId: stale.id, uploadId } }
  })).toBeNull()
  expect(await prisma.upload.findUnique({ where: { id: uploadId } })).not.toBeNull()
})
