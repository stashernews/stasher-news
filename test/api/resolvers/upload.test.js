/* eslint-env jest */

// Unit tests for the uploadFees resolver — proportional fee schedule: registered
// users get the first 10MB free per upload, then 0.001 XMR per full 10MB block
// (floor); anons get no free tier (0.001 minimum on every upload). Real DB,
// fixtures tracked + removed (mirrors test/api/resolvers/growth.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers, { uploadFees } from '@/api/resolvers/upload'
import { UPLOAD_FEE_PICONEROS } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'

const prisma = new PrismaClient()
const MB = 1024 * 1024

const created = { users: [], uploads: [] }

async function cleanupTracked () {
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  for (const key of Object.keys(created)) created[key].length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  await cleanupTracked()
  await prisma.$disconnect()
})

async function createUser () {
  const user = await prisma.user.create({ data: {} })
  created.users.push(user.id)
  return user.id
}

async function createUploads (userId, specs) {
  await prisma.upload.createMany({
    data: specs.map(({ size, paid = false }) => ({ userId, size, type: 'image/png', paid }))
  })
  // userId is fresh per test, so all of its uploads are ours
  const rows = await prisma.upload.findMany({ where: { userId }, select: { id: true } })
  created.uploads.push(...rows.map(r => r.id))
  return rows.map(r => r.id)
}

describe('uploadFees — proportional fee schedule', () => {
  test('empty s3Keys returns zeroed fees', async () => {
    const fees = await uploadFees([], { models: prisma, me: { id: 27 } })
    expect(fees).toEqual({
      bytes24h: 0n,
      bytesUnpaid: 0n,
      nUnpaid: 0n,
      uploadFees: 0n,
      uploadFeesPiconeros: 0n,
      totalFees: 0n,
      totalFeesPiconeros: 0n
    })
  })

  test('registered uploads at or under 10MB are free', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 1024 }, { size: 10 * MB }]) // 1KB + exactly 10MB
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(0n)
    expect(fees.totalFeesPiconeros).toBe(0n)
  })

  test('registered uploads over 10MB pay 0.001 XMR per full 10MB block', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 11 * MB }, { size: 20 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(2n)
    expect(fees.totalFeesPiconeros).toBe(3n * UPLOAD_FEE_PICONEROS) // 0.001 + 0.002
  })

  test('registered 30MB pays 3 blocks (0.003 XMR)', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 30 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(3n * UPLOAD_FEE_PICONEROS)
  })

  test('registered 20.5MB floors to 2 blocks (0.002 XMR)', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: Math.floor(20.5 * MB) }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(2n * UPLOAD_FEE_PICONEROS)
  })

  test('anon uploads have no free tier: 1KB costs 0.001 XMR', async () => {
    const ids = await createUploads(27, [{ size: 1024 }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: 27 } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(UPLOAD_FEE_PICONEROS)
  })

  test('anon 10MB costs 0.001 XMR (exact boundary counts one block)', async () => {
    const ids = await createUploads(27, [{ size: 10 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: 27 } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(UPLOAD_FEE_PICONEROS)
  })

  test('anon 11MB costs 0.001 XMR', async () => {
    const ids = await createUploads(27, [{ size: 11 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: 27 } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(UPLOAD_FEE_PICONEROS)
  })

  test('anon 20MB costs 0.002 XMR', async () => {
    const ids = await createUploads(27, [{ size: 20 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: 27 } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(2n * UPLOAD_FEE_PICONEROS)
  })

  test('mixed batch: registered {1KB, 20MB} charges only the 20MB upload', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 1024 }, { size: 20 * MB }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(1n)
    expect(fees.totalFeesPiconeros).toBe(2n * UPLOAD_FEE_PICONEROS)
  })

  test('already-paid uploads are exempt from the fee', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 11 * MB, paid: true }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(0n)
    expect(fees.bytesUnpaid).toBe(0n)
    expect(fees.totalFeesPiconeros).toBe(0n)
  })
})

describe('getSignedPOST quota', () => {
  test('rejects a logged-in user over 100MB outstanding', async () => {
    const userId = await createUser()
    await createUploads(userId, [{ size: 95 * MB }])
    await expect(resolvers.Mutation.getSignedPOST(
      null,
      { type: 'image/png', size: 10 * MB, width: 1, height: 1 },
      { models: prisma, me: { id: userId }, headers: {} }
    )).rejects.toThrow(GqlInputError)
  })

  test('allows a logged-in user under the cap', async () => {
    const userId = await createUser()
    const result = await resolvers.Mutation.getSignedPOST(
      null,
      { type: 'image/png', size: 1024, width: 1, height: 1 },
      { models: prisma, me: { id: userId }, headers: {} }
    )
    expect(result.url).toBeTruthy()
  })

  test('anonymous uploads are keyed by IP and persist ipHash', async () => {
    await expect(resolvers.Mutation.getSignedPOST(
      null,
      { type: 'image/png', size: 1024, width: 1, height: 1 },
      { models: prisma, me: null, headers: { 'x-forwarded-for': '7.7.7.7' } }
    )).resolves.toBeTruthy()
    const rows = await prisma.upload.findMany({ where: { userId: 27 }, orderBy: { id: 'desc' }, take: 1 })
    created.uploads.push(...rows.map(r => r.id))
    const { hashUploadClientIp } = await import('@/lib/upload-quota')
    expect(rows[0].ipHash).toBe(hashUploadClientIp('7.7.7.7'))
  })
})
