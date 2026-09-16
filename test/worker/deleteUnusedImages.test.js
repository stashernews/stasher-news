/* eslint-env jest */

// Integration test for the unused-image cleanup worker (Task 3 of the upload-fee
// plan; 2026-09-12 tightened). Seeds Upload rows with past created_at timestamps
// and runs deleteUnusedImages directly (no pg-boss), asserting only the old,
// unreferenced uploads are deleted — 24 hours for everyone — regardless of the
// paid flag, while recent or referenced uploads survive. "Referenced" now means
// attached to LIVE content: media whose only attachment is a soft-deleted
// (abandoned) item is swept too. References cover every real attachment path:
// the ItemUpload join table (the path posts/comments actually use), Item.uploadId
// (job listings), the SubBranding.logoId and faviconId (territory logos/favicons),
// users.photoId and a /uploads/<id> or PUBLIC_MEDIA_URL/<id> URL in a turf
// description (Sub.desc).
//
// S3 is stubbed (deleteObjects returns its input keys) so the test is hermetic:
// with NODE_ENV=test the real @/api/s3 targets Amazon S3 with the localstack
// example creds and fails, which would leave the DB rows undeleted. The mock
// must use a relative path — next/jest registers no `@/*` moduleNameMapper, so
// jest.mock cannot resolve the `@/` alias as its first argument. babel-jest
// hoists the mock above the imports at runtime. Mirrors the fixture style of
// test/worker/rewardsWalletObserver.fee.test.js.

import { PrismaClient } from '@prisma/client'
import { USER_ID, BOSS_RETRY, PUBLIC_MEDIA_URL } from '@/lib/constants'
import { deleteObjects } from '../../api/s3'
import { deleteUnusedImages, mediaUrlRegexPrefix } from '@/worker/deleteUnusedImages'

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
//   - 'favicon': SubBranding.faviconId — territory favicons
//   - 'subDesc': a /uploads/<id> URL in Sub.desc — turf descriptions render their media
//   - 'subDescPrefix': a /uploads/<id>0 URL — must NOT pin upload <id> (digit boundary)
//   - 'subDescPublic': a PUBLIC_MEDIA_URL/<id> URL in Sub.desc — domain-root media config
//   - 'subDescPublicPrefix': a PUBLIC_MEDIA_URL/<id>0 URL — must NOT pin upload <id>
//   - 'subDescInternal': the decoded mainnet form http://minio:9000/uploads/<id> in Sub.desc
//   - 'photo': users.photoId — user profile photos
async function seedUpload ({ userId, ageMs, paid = false, reference = null, abandoned = false }) {
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
    if (abandoned) await prisma.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
  } else if (reference === 'itemUploadId') {
    const item = await createItem(userId, { uploadId: upload.id })
    if (abandoned) await prisma.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
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
  } else if (reference === 'favicon') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-favicon-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000
      }
    })
    created.subs.push(sub.name)
    await prisma.subBranding.create({ data: { subName: sub.name, faviconId: upload.id } })
  } else if (reference === 'subDesc') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-desc-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000,
        desc: `see ![](https://stasher.news/uploads/${upload.id})`
      }
    })
    created.subs.push(sub.name)
  } else if (reference === 'subDescPrefix') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-desc-prefix-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000,
        desc: `see ![](https://stasher.news/uploads/${upload.id}0)`
      }
    })
    created.subs.push(sub.name)
  } else if (reference === 'subDescPublic') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-desc-public-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000,
        desc: `see ![](${PUBLIC_MEDIA_URL}/${upload.id})`
      }
    })
    created.subs.push(sub.name)
  } else if (reference === 'subDescPublicPrefix') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-desc-public-prefix-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000,
        desc: `see ![](${PUBLIC_MEDIA_URL}/${upload.id}0)`
      }
    })
    created.subs.push(sub.name)
  } else if (reference === 'subDescInternal') {
    const sub = await prisma.sub.create({
      data: {
        name: `sub-desc-internal-${upload.id}`,
        userId,
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 1000000000,
        // decoded form of a signed imgproxy URL on mainnet (canonical source)
        desc: `see ![](http://minio:9000/uploads/${upload.id})`
      }
    })
    created.subs.push(sub.name)
  } else if (reference === 'photo') {
    await prisma.user.update({ where: { id: userId }, data: { photoId: upload.id } })
  }
  return upload
}

test('deleteUnusedImages deletes unreferenced uploads after 24h for everyone and media whose only attachment is an abandoned (soft-deleted) item, keeping recent and live-referenced ones, and self-requeues', async () => {
  const userId = await createUser()

  // 25h-old unreferenced upload: past the 24h window (was 7 days) -> swept
  const oldEnough = await seedUpload({ userId, ageMs: 25 * 60 * 60 * 1000 })
  // an old upload that paid the fee: unreferenced, so it is swept too
  const oldPaid = await seedUpload({ userId, ageMs: 8 * DAY_MS, paid: true })
  const recent = await seedUpload({ userId, ageMs: 12 * 60 * 60 * 1000 })
  // old uploads survive when referenced through ANY attachment path to LIVE content
  const refItemUpload = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUpload' })
  const refItemUploadId = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUploadId' })
  const refLogo = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'logo' })
  const refFavicon = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'favicon' })
  const refPhoto = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'photo' })
  // a soft-deleted (abandoned) item no longer pins its media: swept via both paths
  const refDeletedItemUpload = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUpload', abandoned: true })
  const refDeletedItemUploadId = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'itemUploadId', abandoned: true })
  // anon uploads are deleted after 24h instead of 7d
  const oldAnon = await seedUpload({ userId: USER_ID.anon, ageMs: 2 * DAY_MS })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: {
      id: { in: [oldEnough.id, oldPaid.id, recent.id, refItemUpload.id, refItemUploadId.id, refLogo.id, refFavicon.id, refPhoto.id, refDeletedItemUpload.id, refDeletedItemUploadId.id, oldAnon.id] }
    },
    select: { id: true }
  })
  const remainingIds = remaining.map(({ id }) => id).sort()
  expect(remainingIds).toEqual([recent.id, refItemUpload.id, refItemUploadId.id, refLogo.id, refFavicon.id, refPhoto.id].sort())
  // the daily sweep re-queues itself for the next run
  expect(boss.send).toHaveBeenCalledWith('deleteUnusedImages', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
})

test('an old upload referenced only from a turf description survives the sweep, and a longer id built from its prefix is not pinned', async () => {
  const userId = await createUser()

  // desc contains /uploads/<id> followed by ')' -> pinned, survives
  const descReferenced = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'subDesc' })
  // desc contains /uploads/<id>0 -> the digit boundary means upload <id> is NOT pinned, swept
  const prefixOnly = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'subDescPrefix' })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: { id: { in: [descReferenced.id, prefixOnly.id] } },
    select: { id: true }
  })
  expect(remaining.map(({ id }) => id)).toEqual([descReferenced.id])
})

test('a desc referencing the configured public media URL also pins the upload, with the same digit boundary', async () => {
  const userId = await createUser()
  const referenced = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'subDescPublic' })
  const prefixOnly = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'subDescPublicPrefix' })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: { id: { in: [referenced.id, prefixOnly.id] } },
    select: { id: true }
  })
  expect(remaining.map(({ id }) => id)).toEqual([referenced.id])
})

test('a desc holding the decoded internal source url (canonical mainnet form) pins the upload', async () => {
  const userId = await createUser()
  const referenced = await seedUpload({ userId, ageMs: 8 * DAY_MS, reference: 'subDescInternal' })

  const boss = { send: jest.fn() }
  await deleteUnusedImages({ models: prisma, boss })

  const remaining = await prisma.upload.findMany({
    where: { id: { in: [referenced.id] } },
    select: { id: true }
  })
  expect(remaining.map(({ id }) => id)).toEqual([referenced.id])
})

test('mediaUrlRegexPrefix escapes metacharacters and drops a trailing slash', () => {
  expect(mediaUrlRegexPrefix('https://m.stasher.news/')).toBe('https://m\\.stasher\\.news')
})

test('a failing deleteObjects rejects the run — no DB deletion, no requeue — so pg-boss retries and alerts instead of reporting completed', async () => {
  const userId = await createUser()
  const orphan = await seedUpload({ userId, ageMs: 25 * 60 * 60 * 1000 })

  deleteObjects.mockRejectedValueOnce(new Error('The AWS Access Key Id you provided does not exist in our records. (InvalidAccessKeyId)'))
  const boss = { send: jest.fn() }
  await expect(deleteUnusedImages({ models: prisma, boss })).rejects.toThrow(/InvalidAccessKeyId/)

  // rows survive for the retry; the success-path-only requeue was not sent
  expect(await prisma.upload.findUnique({ where: { id: orphan.id } })).not.toBeNull()
  expect(boss.send).not.toHaveBeenCalled()
})
