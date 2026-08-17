/* eslint-env jest */
import prisma from '@/api/models'
import resolver from '@/api/resolvers/sub'
import { validateSchema, linkSchema } from '@/lib/validate'

// sub.js statically imports @/lib/lexical/server/html (ESM-only github-slugger via
// the headless editor); the read surfaces exercise none of it, so stub it like
// test/api/bountyFunding.test.js. jest.mock is hoisted above the imports.
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

// The read surfaces never call the payIn engine; stub it so sub.js's `import pay`
// resolves without side effects (mirrors test/api/paySub.test.js).
jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn()
}))

process.env.MONERO_NETWORK = 'stagenet'

const ADDR = '5' + 'F'.repeat(94)
const FEE_URI = (xmr) => `monero:${ADDR}?tx_amount=${xmr}`

const created = { users: [], subs: [], payIns: [] }

afterAll(async () => {
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

// A turf with a billing PayIn of the given type. billingStatus PENDING_FEE +
// payInType TERRITORY_CREATE/TERRITORY_UNARCHIVE = never-seen (hidden);
// TERRITORY_BILLING = renewal (visible during grace).
async function seedTurf ({ payInType = 'TERRITORY_CREATE', billingStatus = 'PENDING_FEE' } = {}) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType,
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: FEE_URI('0.001'),
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: 7
    }
  })
  created.payIns.push(payIn.id)
  const sub = await prisma.sub.create({
    data: {
      name: 'vis-test-' + Math.random().toString(36).slice(2, 10),
      userId,
      billingType: 'ONCE',
      billingCost: 1,
      billingStatus,
      billingPayInId: payIn.id,
      rankingType: 'WOT',
      postTypes: ['LINK']
    }
  })
  created.subs.push(sub.id)
  return { userId, sub, payIn }
}

const userLoader = { load: async () => ({ nsfwMode: false }) }

describe('turf visibility gate (never-seen PENDING_FEE)', () => {
  test('activeSubs hides a never-seen turf from anon and strangers, shows it to the owner', async () => {
    const { userId, sub } = await seedTurf()
    const strangerId = await createUser()

    const anon = await resolver.Query.activeSubs(null, {}, { models: prisma, me: null })
    expect(anon.map(s => s.name)).not.toContain(sub.name)

    const stranger = await resolver.Query.activeSubs(null, {}, { models: prisma, me: { id: strangerId }, userLoader })
    expect(stranger.map(s => s.name)).not.toContain(sub.name)

    const owner = await resolver.Query.activeSubs(null, {}, { models: prisma, me: { id: userId }, userLoader })
    expect(owner.map(s => s.name)).toContain(sub.name)
  })

  test('a renewal (TERRITORY_BILLING) PENDING_FEE turf stays visible to strangers', async () => {
    const { sub } = await seedTurf({ payInType: 'TERRITORY_BILLING' })
    const strangerId = await createUser()

    const stranger = await resolver.Query.activeSubs(null, {}, { models: prisma, me: { id: strangerId }, userLoader })
    expect(stranger.map(s => s.name)).toContain(sub.name)

    const anon = await resolver.Query.activeSubs(null, {}, { models: prisma, me: null })
    expect(anon.map(s => s.name)).toContain(sub.name)
  })

  test('subSuggestions excludes a never-seen turf for anon/strangers, includes it for the owner', async () => {
    const { userId, sub } = await seedTurf()
    const strangerId = await createUser()

    const anon = await resolver.Query.subSuggestions(null, { q: sub.name, limit: 5 }, { models: prisma, me: null })
    expect(anon.map(s => s.name)).not.toContain(sub.name)

    const stranger = await resolver.Query.subSuggestions(null, { q: sub.name, limit: 5 }, { models: prisma, me: { id: strangerId } })
    expect(stranger.map(s => s.name)).not.toContain(sub.name)

    const owner = await resolver.Query.subSuggestions(null, { q: sub.name, limit: 5 }, { models: prisma, me: { id: userId } })
    expect(owner.map(s => s.name)).toContain(sub.name)
  })

  test('topSubs excludes a never-seen turf for anon, includes it for the owner', async () => {
    const { userId, sub } = await seedTurf()

    const anon = await resolver.Query.topSubs(null, { when: 'month', limit: 100 }, { models: prisma, me: null })
    expect(anon.subs.map(s => s.name)).not.toContain(sub.name)

    const owner = await resolver.Query.topSubs(null, { when: 'month', limit: 100 }, { models: prisma, me: { id: userId } })
    expect(owner.subs.map(s => s.name)).toContain(sub.name)
  })

  test('mySubscribedSubs excludes a hidden turf even when the viewer is subscribed', async () => {
    const { sub } = await seedTurf()
    const strangerId = await createUser()
    await prisma.subSubscription.create({ data: { userId: strangerId, subName: sub.name } })

    const res = await resolver.Query.mySubscribedSubs(null, {}, { models: prisma, me: { id: strangerId } })
    expect(res.subs.map(s => s.name)).not.toContain(sub.name)
  })

  test('getSub returns null for anon/strangers of a never-seen turf, the sub for its owner', async () => {
    const { userId, sub } = await seedTurf()
    const strangerId = await createUser()

    expect(await resolver.Query.sub(null, { name: sub.name }, { models: prisma, me: null })).toBeNull()
    expect(await resolver.Query.sub(null, { name: sub.name }, { models: prisma, me: { id: strangerId } })).toBeNull()

    const owner = await resolver.Query.sub(null, { name: sub.name }, { models: prisma, me: { id: userId } })
    expect(owner.name).toBe(sub.name)
  })

  test('a renewal PENDING_FEE turf is reachable by name for strangers', async () => {
    const { sub } = await seedTurf({ payInType: 'TERRITORY_BILLING' })
    const strangerId = await createUser()
    const res = await resolver.Query.sub(null, { name: sub.name }, { models: prisma, me: { id: strangerId } })
    expect(res.name).toBe(sub.name)
  })

  test('flipping a hidden turf to PAID makes it visible to strangers again', async () => {
    const { sub } = await seedTurf()
    const strangerId = await createUser()
    await prisma.sub.update({ where: { name: sub.name }, data: { billingStatus: 'PAID' } })

    const stranger = await resolver.Query.activeSubs(null, {}, { models: prisma, me: { id: strangerId }, userLoader })
    expect(stranger.map(s => s.name)).toContain(sub.name)
  })

  test('subs(subNames) hides a never-seen turf from anon and strangers, returns it for the owner', async () => {
    const { userId, sub } = await seedTurf()
    const strangerId = await createUser()

    const anon = await resolver.Query.subs(null, { subNames: [sub.name] }, { models: prisma, me: null })
    expect(anon.map(s => s.name)).not.toContain(sub.name)

    const stranger = await resolver.Query.subs(null, { subNames: [sub.name] }, { models: prisma, me: { id: strangerId } })
    expect(stranger.map(s => s.name)).not.toContain(sub.name)

    const owner = await resolver.Query.subs(null, { subNames: [sub.name] }, { models: prisma, me: { id: userId } })
    expect(owner.map(s => s.name)).toContain(sub.name)
  })

  test('subs(subNames) returns a renewal PENDING_FEE turf to strangers', async () => {
    const { sub } = await seedTurf({ payInType: 'TERRITORY_BILLING' })
    const strangerId = await createUser()
    const res = await resolver.Query.subs(null, { subNames: [sub.name] }, { models: prisma, me: { id: strangerId } })
    expect(res.map(s => s.name)).toContain(sub.name)
  })
})

describe('posting gate (never-seen PENDING_FEE)', () => {
  test('validateSchema rejects posting into a hidden turf for the owner and a stranger', async () => {
    const { userId, sub } = await seedTurf()
    const strangerId = await createUser()
    const data = { title: 'My test post', url: 'https://example.com', subNames: [sub.name] }

    await expect(validateSchema(linkSchema, data, { models: prisma, me: { id: userId } }))
      .rejects.toThrow(/not live yet/)
    await expect(validateSchema(linkSchema, data, { models: prisma, me: { id: strangerId } }))
      .rejects.toThrow(/not live yet/)
  })

  test('validateSchema allows posting into a renewal PENDING_FEE turf', async () => {
    const { sub } = await seedTurf({ payInType: 'TERRITORY_BILLING' })
    const strangerId = await createUser()
    const data = { title: 'My test post', url: 'https://example.com', subNames: [sub.name] }

    await expect(validateSchema(linkSchema, data, { models: prisma, me: { id: strangerId } })).resolves.toBeTruthy()
  })

  test('validateSchema allows posting once the turf is PAID', async () => {
    const { sub } = await seedTurf()
    const strangerId = await createUser()
    await prisma.sub.update({ where: { name: sub.name }, data: { billingStatus: 'PAID' } })
    const data = { title: 'My test post', url: 'https://example.com', subNames: [sub.name] }

    await expect(validateSchema(linkSchema, data, { models: prisma, me: { id: strangerId } })).resolves.toBeTruthy()
  })
})
