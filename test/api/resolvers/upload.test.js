/* eslint-env jest */

// Unit tests for the uploadFees resolver — flat 10MB threshold + 0.001 XMR
// per upload over the free size. Real DB, fixtures tracked + removed
// (mirrors test/api/resolvers/growth.test.js).

import { PrismaClient } from '@prisma/client'
import { uploadFees } from '@/api/resolvers/upload'
import { UPLOAD_FEE_PICONEROS } from '@/lib/constants'

const prisma = new PrismaClient()

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

describe('uploadFees — 10MB threshold', () => {
  test('uploads at or under 10MB are free', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 1024 }, { size: 10 * 1024 * 1024 }]) // 1KB + exactly 10MB
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(0n)
    expect(fees.totalFeesPiconeros).toBe(0n)
  })

  test('each upload over 10MB costs 0.001 XMR', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 11 * 1024 * 1024 }, { size: 50 * 1024 * 1024 }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(2n)
    expect(fees.uploadFeesPiconeros).toBe(UPLOAD_FEE_PICONEROS)
    expect(fees.totalFeesPiconeros).toBe(2n * UPLOAD_FEE_PICONEROS)
  })

  test('anon uploads over 10MB cost the same (no anon surcharge)', async () => {
    const ids = await createUploads(27, [{ size: 11 * 1024 * 1024 }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: 27 } })
    expect(fees.totalFeesPiconeros).toBe(UPLOAD_FEE_PICONEROS)
  })

  test('already-paid uploads over 10MB are exempt from the fee', async () => {
    const userId = await createUser()
    const ids = await createUploads(userId, [{ size: 11 * 1024 * 1024, paid: true }])
    const fees = await uploadFees(ids, { models: prisma, me: { id: userId } })
    expect(fees.nUnpaid).toBe(0n)
    expect(fees.bytesUnpaid).toBe(0n)
    expect(fees.totalFeesPiconeros).toBe(0n)
  })
})
