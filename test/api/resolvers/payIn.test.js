/* eslint-env jest */

// Integration tests for the PayIn.feeObserved field resolver — the on-chain
// confirmation signal the DONATE client modal polls. The DONATE payIn is born
// PAID (piconeros=0n; the FeeObservation carries the real amount), so payInState
// alone can't tell the client the donation landed. feeObserved flips true once a
// FeeObservation exists for the payIn in a "payment succeeded" state
// (DETECTED/CONFIRMED). Real DB against the migrated dev database; fixtures are
// tracked and removed after each test (mirrors test/api/resolvers/statistics.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/payIn'

// The resolver transitively imports api/payIn (types barrel -> itemCreate ->
// lib/lexical/server/mentions) and api/resolvers/item (-> lib/lexical/server/html),
// which pull ESM-only node_modules that next/jest does not transform. Mirror the
// mocks in test/api/resolvers/statistics.test.js to break that chain.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const prisma = new PrismaClient()

const created = { users: [], fees: [], payIns: [] }

async function cleanupTracked () {
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  for (const key of Object.keys(created)) created[key].length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  await cleanupTracked()
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createDonatePayIn () {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: { userId, piconeros: 0n, payInType: 'DONATE', payInState: 'PAID' }
  })
  created.payIns.push(payIn.id)
  return payIn
}

async function createFeeObservation (payInId, state) {
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: Buffer.from(`fee${Math.random()}`).toString('hex').padStart(64, '0'),
      payInId,
      feeType: 'DONATE',
      recipientMajor: 3,
      recipientMinor: 1,
      piconeros: 1000000000n,
      state
    }
  })
  created.fees.push(fee.id)
  return fee
}

describe('PayIn.feeObserved', () => {
  test('false when no FeeObservation exists for the payIn', async () => {
    const payIn = await createDonatePayIn()
    const observed = await resolvers.PayIn.feeObserved(
      { id: payIn.id }, {}, { models: prisma })
    expect(observed).toBe(false)
  })

  test('true once a DETECTED FeeObservation lands', async () => {
    const payIn = await createDonatePayIn()
    await createFeeObservation(payIn.id, 'DETECTED')
    const observed = await resolvers.PayIn.feeObserved(
      { id: payIn.id }, {}, { models: prisma })
    expect(observed).toBe(true)
  })

  test('true once a CONFIRMED FeeObservation lands', async () => {
    const payIn = await createDonatePayIn()
    await createFeeObservation(payIn.id, 'CONFIRMED')
    const observed = await resolvers.PayIn.feeObserved(
      { id: payIn.id }, {}, { models: prisma })
    expect(observed).toBe(true)
  })
})
