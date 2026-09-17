/* eslint-env jest */
// Integration test for scripts/detach-unpaid-upload.js — the remediation used
// for post 351432 (an edit attached an unpaid >10MB upload). Real DB, mocked S3.
import { PrismaClient } from '@prisma/client'
import { detachUnpaidUpload, stripUploadFromText, stripUploadFromImgproxyUrls } from '../../scripts/detach-unpaid-upload'

jest.mock('../../api/s3', () => ({
  __esModule: true,
  deleteObjects: jest.fn(async keys => keys)
}))

const { deleteObjects } = require('../../api/s3')

const prisma = new PrismaClient()
const created = { users: [], items: [], uploads: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function seedItemWithUpload ({ paid = false } = {}) {
  const userId = await createUser()
  const upload = await prisma.upload.create({
    data: { userId, size: 18_541_552, type: 'video/mp4', paid }
  })
  created.uploads.push(upload.id)
  const mediaUrl = `http://media.test/uploads/${upload.id}`
  const text = `amazing 2\n\n\n![](${mediaUrl})`
  const imgproxyUrls = { [mediaUrl]: { video: true } }
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, text, "imgproxyUrls", "created_at")
    VALUES (${userId}::int, ${'detach fixture'}, ${text}, ${JSON.stringify(imgproxyUrls)}::jsonb, now())
    RETURNING id::int AS id`
  const itemId = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(itemId)}::ltree WHERE id = ${itemId}::int`
  created.items.push(itemId)
  await prisma.itemUpload.create({ data: { itemId, uploadId: upload.id } })
  return { itemId, uploadId: upload.id, mediaUrl }
}

afterEach(() => {
  jest.clearAllMocks()
})

afterAll(async () => {
  await prisma.itemUpload.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  for (const id of created.items) await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

test('stripUploadFromText removes media and link references but keeps the prose', () => {
  expect(stripUploadFromText('amazing 2\n\n\n![](http://media.test/uploads/7)', 7)).toBe('amazing 2')
  expect(stripUploadFromText('[watch](http://media.test/uploads/7) thanks', 7)).toBe('thanks')
  expect(stripUploadFromText('see http://media.test/uploads/7 now', 7)).toBe('see  now')
  // ids sharing a prefix must not match
  expect(stripUploadFromText('![](http://media.test/uploads/78)', 7)).toBe('![](http://media.test/uploads/78)')
})

test('stripUploadFromImgproxyUrls drops only the matching key', () => {
  const urls = { 'http://media.test/uploads/7': { video: true }, 'https://x.test/a.png': {} }
  expect(stripUploadFromImgproxyUrls(urls, 7)).toEqual({ 'https://x.test/a.png': {} })
})

test('detaches an unpaid upload: rows, text and imgproxyUrls are cleaned, object deleted', async () => {
  const { itemId, uploadId, mediaUrl } = await seedItemWithUpload()

  const out = await detachUnpaidUpload({ models: prisma, itemId, uploadId })

  expect(out.text).toBe('amazing 2')
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBe('amazing 2')
  expect(item.imgproxyUrls[mediaUrl]).toBeUndefined()
  expect(await prisma.itemUpload.findUnique({ where: { itemId_uploadId: { itemId, uploadId } } })).toBeNull()
  expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toBeNull()
  expect(deleteObjects).toHaveBeenCalledWith([uploadId])
})

test('refuses a paid upload and leaves everything in place', async () => {
  const { itemId, uploadId } = await seedItemWithUpload({ paid: true })

  await expect(detachUnpaidUpload({ models: prisma, itemId, uploadId })).rejects.toThrow(/paid/)

  expect(await prisma.itemUpload.findUnique({ where: { itemId_uploadId: { itemId, uploadId } } })).toBeTruthy()
  expect(await prisma.upload.findUnique({ where: { id: uploadId } })).toBeTruthy()
  expect(deleteObjects).not.toHaveBeenCalled()
})

test('refuses an upload that is not attached to the item', async () => {
  const { itemId } = await seedItemWithUpload()
  const userId = await createUser()
  const orphan = await prisma.upload.create({ data: { userId, size: 1024, type: 'image/png' } })
  created.uploads.push(orphan.id)

  await expect(detachUnpaidUpload({ models: prisma, itemId, uploadId: orphan.id })).rejects.toThrow(/not attached/)
})
