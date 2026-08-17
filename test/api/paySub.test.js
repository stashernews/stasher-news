/* eslint-env jest */
import prisma from '@/api/models'
import resolver from '@/api/resolvers/sub'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'
import pay from '../../api/payIn'

// sub.js statically imports @/lib/lexical/server/html (ESM-only github-slugger via
// the headless editor); paySub exercises none of it, so stub it like
// test/api/bountyFunding.test.js. jest.mock is hoisted above the imports.
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

// The fresh-mint fall-through path calls pay('TERRITORY_BILLING', ...) which does
// real reserveFeeSubaddress + payInCreate work — stub the module so the test only
// asserts the call, not the whole payIn engine. Re-entry paths never call it.
// NOTE: relative path (repo convention) — jest.mock with the '@/api/payIn' alias
// does not resolve the directory module and never intercepts sub.js's '../payIn'.
jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn()
}))

process.env.MONERO_NETWORK = 'stagenet'

const ADDR = '5' + 'F'.repeat(94)
const FEE_URI = (xmr) => `monero:${ADDR}?tx_amount=${xmr}`

const created = { users: [], subs: [], payIns: [], fees: [] }

beforeEach(() => pay.mockClear())

afterAll(async () => {
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.sub.deleteMany({ where: { id: { in: created.subs } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// A PENDING_FEE turf with a billing PayIn carrying the FULL-fee URI + a reserved
// subaddress (major 2 / minor N) and one partial FeeObservation.
async function seedPendingFeeSub ({ receivedPiconeros = 0n, payInState = 'PAID' } = {}) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'TERRITORY_BILLING',
      payInState,
      piconeros: 0n,
      moneroUri: FEE_URI('0.001'),
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: 7
    }
  })
  created.payIns.push(payIn.id)
  const sub = await prisma.sub.create({
    data: {
      name: 'paySub-test-' + Math.random().toString(36).slice(2, 10),
      userId,
      billingType: 'ONCE',
      billingCost: 1,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payIn.id,
      rankingType: 'WOT'
    }
  })
  created.subs.push(sub.id)
  if (receivedPiconeros > 0n) {
    const fee = await prisma.feeObservation.create({
      data: {
        txHash: 'psub-' + payIn.id,
        payInId: payIn.id,
        feeType: 'TERRITORY_BILLING',
        subName: sub.name,
        recipientMajor: 2,
        recipientMinor: 7,
        piconeros: receivedPiconeros,
        state: 'DETECTED'
      }
    })
    created.fees.push(fee.id)
  }
  return { userId, sub, payIn }
}

describe('paySub re-entry reuse', () => {
  test('re-entry after a partial reuses the SAME billing payIn and subaddress with a remainder-quoted URI', async () => {
    const { sub, payIn } = await seedPendingFeeSub({ receivedPiconeros: 400_000_000n }) // 0.4 of 1.0
    const before = await prisma.payIn.count()

    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: sub.userId }, models: prisma })

    expect(res.id).toBe(payIn.id) // the SAME payIn — no new row
    expect(await prisma.payIn.count()).toBe(before)
    expect(moneroUriAddress(res.moneroUri)).toBe(ADDR) // same subaddress
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(600_000_000n) // 1.0 - 0.4 remainder
    expect(res.receivedPiconeros).toBe(400_000_000n)
    expect(res.expectedPiconeros).toBe(1_000_000_000n)
    // billingPayInId untouched so the observer gate still flips THIS payIn
    const afterSub = await prisma.sub.findUnique({ where: { id: sub.id } })
    expect(afterSub.billingPayInId).toBe(payIn.id)
  })

  test('a fresh PENDING_FEE turf (status ACTIVE) can re-pay — returns a URI, not the bare sub', async () => {
    const { sub } = await seedPendingFeeSub()
    // status defaults ACTIVE in the schema; the OLD early-return would have
    // swallowed this. billingStatus PENDING_FEE must fall through to the pay path.
    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: sub.userId }, models: prisma })
    expect(res).toBeTruthy()
    expect(res.moneroUri).toBeTruthy()
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(1_000_000_000n) // nothing received yet -> full fee
  })

  test('a clean ACTIVE + PAID turf still early-returns the sub (no payIn, no pay() call)', async () => {
    const userId = await createUser()
    const sub = await prisma.sub.create({
      data: {
        name: 'paySub-test-' + Math.random().toString(36).slice(2, 10),
        userId,
        billingType: 'ONCE',
        billingCost: 1,
        billingStatus: 'PAID',
        rankingType: 'WOT'
      }
    })
    created.subs.push(sub.id)
    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: userId }, models: prisma })
    expect(res).toEqual(sub) // the bare sub back, exactly as before
    expect(pay).not.toHaveBeenCalled()
  })

  test('no billingPayInId falls through to a fresh TERRITORY_BILLING mint', async () => {
    const userId = await createUser()
    const sub = await prisma.sub.create({
      data: {
        name: 'paySub-test-' + Math.random().toString(36).slice(2, 10),
        userId,
        billingType: 'ONCE',
        billingCost: 1,
        billingStatus: 'PENDING_FEE',
        rankingType: 'WOT'
      }
    })
    created.subs.push(sub.id)
    pay.mockResolvedValue({ id: 987654, moneroUri: FEE_URI('0.02') })
    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: userId }, models: prisma })
    expect(pay).toHaveBeenCalledWith('TERRITORY_BILLING', { name: sub.name }, expect.any(Object))
    expect(res.id).toBe(987654)
  })

  test('a fully-covered payIn re-quotes the full fee (hint would be null)', async () => {
    const { sub, payIn } = await seedPendingFeeSub({ receivedPiconeros: 1_000_000_000n })
    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: sub.userId }, models: prisma })
    expect(res.id).toBe(payIn.id)
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(1_000_000_000n) // remaining <= 0 -> amount = expected
    expect(res.receivedPiconeros).toBe(1_000_000_000n)
  })
})

describe('paySub response carries received/expected for the hint', () => {
  test('re-entry response exposes receivedPiconeros and expectedPiconeros', async () => {
    const { sub } = await seedPendingFeeSub({ receivedPiconeros: 400_000_000n })
    const res = await resolver.Mutation.paySub(null, { name: sub.name }, { me: { id: sub.userId }, models: prisma })
    expect(res.receivedPiconeros).toBe(400_000_000n)
    expect(res.expectedPiconeros).toBe(1_000_000_000n)
  })
})

describe('Sub fee hint fields', () => {
  test('feeReceivedPiconeros sums the billing PayIn observations for the owner', async () => {
    const { sub } = await seedPendingFeeSub({ receivedPiconeros: 400_000_000n })
    const res = await resolver.Sub.feeReceivedPiconeros(sub, null, { me: { id: sub.userId }, models: prisma })
    expect(res).toBe(400_000_000n)
  })

  test('billingFeePiconeros reads the full fee from the billing PayIn URI', async () => {
    const { sub } = await seedPendingFeeSub({ receivedPiconeros: 400_000_000n })
    const res = await resolver.Sub.billingFeePiconeros(sub, null, { me: { id: sub.userId }, models: prisma })
    expect(res).toBe(1_000_000_000n)
  })

  test('both fields are null for non-owners', async () => {
    const { sub } = await seedPendingFeeSub({ receivedPiconeros: 400_000_000n })
    const strangerId = await createUser()
    const received = await resolver.Sub.feeReceivedPiconeros(sub, null, { me: { id: strangerId }, models: prisma })
    const expected = await resolver.Sub.billingFeePiconeros(sub, null, { me: { id: strangerId }, models: prisma })
    expect(received).toBeNull()
    expect(expected).toBeNull()
  })

  test('feeReceivedPiconeros is 0n when there is no billing PayIn', async () => {
    const userId = await createUser()
    const sub = await prisma.sub.create({
      data: {
        name: 'paySub-test-' + Math.random().toString(36).slice(2, 10),
        userId,
        billingType: 'ONCE',
        billingCost: 1,
        billingStatus: 'PENDING_FEE',
        rankingType: 'WOT'
      }
    })
    created.subs.push(sub.id)
    const res = await resolver.Sub.feeReceivedPiconeros(sub, null, { me: { id: userId }, models: prisma })
    expect(res).toBe(0n)
  })
})
