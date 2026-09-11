/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import {
  hashUploadClientIp,
  outstandingUploadBytes,
  assertUploadQuota,
  UPLOAD_QUOTA_WINDOW_USER_MS
} from '@/lib/upload-quota'
import { UPLOAD_OUTSTANDING_CAP_USER, UPLOAD_OUTSTANDING_CAP_ANON } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'

const prisma = new PrismaClient()
const MB = 1024 * 1024
const created = { users: [], uploads: [] }

afterEach(async () => {
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  created.users.length = 0
  created.uploads.length = 0
})
afterAll(async () => { await prisma.$disconnect() })

async function createUser () {
  const user = await prisma.user.create({ data: {} })
  created.users.push(user.id)
  return user.id
}

async function createUploads (data) {
  await prisma.upload.createMany({ data })
  const rows = await prisma.upload.findMany({
    where: { OR: data.map(d => ({ userId: d.userId, ipHash: d.ipHash ?? null })) },
    select: { id: true }
  })
  created.uploads.push(...rows.map(r => r.id))
}

describe('outstandingUploadBytes', () => {
  test('sums only paid = false rows for the given user', async () => {
    const userId = await createUser()
    await createUploads([
      { userId, size: 5 * MB, type: 'image/png', paid: false },
      { userId, size: 7 * MB, type: 'image/png', paid: true }
    ])
    expect(await outstandingUploadBytes(prisma, { userId, windowMs: UPLOAD_QUOTA_WINDOW_USER_MS })).toBe(BigInt(5 * MB))
  })

  test('ignores rows older than the window', async () => {
    const userId = await createUser()
    await prisma.upload.create({
      data: { userId, size: 9 * MB, type: 'image/png', paid: false, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }
    })
    const rows = await prisma.upload.findMany({ where: { userId }, select: { id: true } })
    created.uploads.push(...rows.map(r => r.id))
    expect(await outstandingUploadBytes(prisma, { userId, windowMs: UPLOAD_QUOTA_WINDOW_USER_MS })).toBe(0n)
  })

  test('sums by ipHash for anonymous rows and isolates different hashes', async () => {
    const userId = 27
    await createUploads([
      { userId, size: 3 * MB, type: 'image/png', paid: false, ipHash: 'hash-a' },
      { userId, size: 4 * MB, type: 'image/png', paid: false, ipHash: 'hash-b' }
    ])
    expect(await outstandingUploadBytes(prisma, { ipHash: 'hash-a', windowMs: UPLOAD_QUOTA_WINDOW_USER_MS })).toBe(BigInt(3 * MB))
  })
})

describe('assertUploadQuota', () => {
  test('caps are exactly 100 MiB for users and 50 MiB for anonymous uploads', () => {
    expect(UPLOAD_OUTSTANDING_CAP_USER).toBe(104857600n)
    expect(UPLOAD_OUTSTANDING_CAP_ANON).toBe(52428800n)
  })

  test('allows a user under the cap', async () => {
    const userId = await createUser()
    await createUploads([{ userId, size: 90 * MB, type: 'image/png', paid: false }])
    await expect(assertUploadQuota({ models: prisma, me: { id: userId }, ip: '1.2.3.4', size: 5 * MB })).resolves.toEqual({ ipHash: null })
  })

  test('rejects a user whose upload would exceed 100MB', async () => {
    const userId = await createUser()
    await createUploads([{ userId, size: 95 * MB, type: 'image/png', paid: false }])
    await expect(assertUploadQuota({ models: prisma, me: { id: userId }, ip: '1.2.3.4', size: 10 * MB }))
      .rejects.toThrow(GqlInputError)
  })

  test('paid uploads do not count toward the cap', async () => {
    const userId = await createUser()
    await createUploads([{ userId, size: 100 * MB, type: 'image/png', paid: true }])
    await expect(assertUploadQuota({ models: prisma, me: { id: userId }, ip: '1.2.3.4', size: 100 * MB })).resolves.toBeTruthy()
  })

  test('anonymous cap is 50MB and keyed by salted IP hash', async () => {
    const ipHash = hashUploadClientIp('9.9.9.9')
    await createUploads([{ userId: 27, size: 45 * MB, type: 'image/png', paid: false, ipHash }])
    await expect(assertUploadQuota({ models: prisma, me: null, ip: '9.9.9.9', size: 40 * MB })).rejects.toThrow(GqlInputError)
    await expect(assertUploadQuota({ models: prisma, me: null, ip: '9.9.9.9', size: 4 * MB })).resolves.toEqual({ ipHash })
    await expect(assertUploadQuota({ models: prisma, me: null, ip: '8.8.8.8', size: 4 * MB })).resolves.toEqual({ ipHash: hashUploadClientIp('8.8.8.8') })
  })
})
