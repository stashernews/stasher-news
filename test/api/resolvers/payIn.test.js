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

const created = { users: [], fees: [], subFees: [], payIns: [] }

async function cleanupTracked () {
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.observedSubFee.deleteMany({ where: { id: { in: created.subFees } } })
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

async function createFeeObservation (payInId, state, piconeros = 1000000000n) {
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: Buffer.from(`fee${Math.random()}`).toString('hex').padStart(64, '0'),
      payInId,
      feeType: 'DONATE',
      recipientMajor: 3,
      recipientMinor: 1,
      piconeros,
      state
    }
  })
  created.fees.push(fee.id)
  return fee
}

// a fee payIn as the monero-fee engine creates it: born PAID, piconeros 0, and a
// stored monero: URI quoting the on-chain amount the coverage gate reads
async function createFeePayIn ({ moneroUri } = {}) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      piconeros: 0n,
      payInType: 'TERRITORY_UPDATE',
      payInState: 'PAID',
      moneroUri: moneroUri ?? null
    }
  })
  created.payIns.push(payIn.id)
  return payIn
}

// owner-routed fee receipt (the ObservedSubFee leg) — payInId links it to the
// covering payIn, mirroring applySubFeeReceipt
async function createObservedSubFee (payInId, piconeros) {
  const subFee = await prisma.observedSubFee.create({
    data: {
      txHash: Buffer.from(`subfee${Math.random()}`).toString('hex').padStart(64, '0'),
      paymentId: Buffer.from(`pid${Math.random()}`).toString('hex').padStart(16, '0'),
      payInId,
      subName: `test-sub-${Math.random().toString(36).slice(2)}`,
      ownerUserId: 1,
      piconeros,
      state: 'DETECTED'
    }
  })
  created.subFees.push(subFee.id)
  return subFee
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

// feeCovered is the settle signal for fee payIns whose gated record only flips at
// FULL coverage (the >10MB upload fees attached to turf/post edits): feeObserved
// flips on any partial payment, so those modals must poll coverage instead.
describe('PayIn.feeCovered', () => {
  // valid base58 filler; tx_amount drives the expected coverage
  const URI = 'monero:5' + 'F'.repeat(94) + '?tx_amount=0.001'

  test('false when no observation exists for the payIn', async () => {
    const payIn = await createFeePayIn({ moneroUri: URI })
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id, moneroUri: URI }, {}, { models: prisma })).toBe(false)
  })

  test('false while the cumulative observations are short of the URI amount', async () => {
    const payIn = await createFeePayIn({ moneroUri: URI })
    await createFeeObservation(payIn.id, 'DETECTED', 400000000n) // 0.4 of 1 mXMR
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id, moneroUri: URI }, {}, { models: prisma })).toBe(false)
  })

  test('true once cumulative observations cover the URI amount', async () => {
    const payIn = await createFeePayIn({ moneroUri: URI })
    await createFeeObservation(payIn.id, 'DETECTED', 400000000n)
    await createFeeObservation(payIn.id, 'DETECTED', 600000000n) // 0.4 + 0.6 = 1 mXMR
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id, moneroUri: URI }, {}, { models: prisma })).toBe(true)
  })

  test('a URI-less payIn keeps feeObserved semantics (any observation covers it)', async () => {
    const payIn = await createFeePayIn()
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id }, {}, { models: prisma })).toBe(false)
    await createFeeObservation(payIn.id, 'DETECTED')
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id }, {}, { models: prisma })).toBe(true)
  })

  test('false while an owner-routed receipt is short, true once it covers', async () => {
    const payIn = await createFeePayIn({ moneroUri: URI })
    await createObservedSubFee(payIn.id, 400000000n)
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id, moneroUri: URI }, {}, { models: prisma })).toBe(false)
    await createObservedSubFee(payIn.id, 600000000n)
    expect(await resolvers.PayIn.feeCovered({ id: payIn.id, moneroUri: URI }, {}, { models: prisma })).toBe(true)
  })
})
