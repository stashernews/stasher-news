/* eslint-env jest */

// Integration tests for the growth resolvers — /statistics/graphs (mine) and
// /stashers/[sub]/[when] (global + sub). Real DB, fixtures tracked + removed
// (mirrors test/api/resolvers/monero.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/growth'

const prisma = new PrismaClient()

const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
// MoneroAccount has @@unique([address, network]), so the noise tip needs its
// own distinct address.
const STAGENET_ADDR_2 = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6K'

const created = { users: [], items: [], tips: [], downvotes: [], fees: [], payIns: [] }

async function cleanupTracked () {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.moneroAccount.deleteMany({ where: { ownerUserId: { in: created.users } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  for (const key of Object.keys(created)) created[key].length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  await cleanupTracked()
  await prisma.$disconnect()
})

// fixtures land inside the CT hour that contains 2026-08-06T20:00:00Z; the
// custom range [t-1h, t+1h] always covers that bucket, so assertions can sum
// across buckets without timezone math. The window is chosen after all
// pre-existing confirmed observations in the dev DB (last: 14:35Z), so
// global/sub slices stay deterministic.
const T = new Date('2026-08-06T20:00:00.000Z')
const RANGE = { when: 'custom', from: String(T.getTime() - 60 * 60 * 1000), to: String(T.getTime() + 60 * 60 * 1000) }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createAccount (userId, address = STAGENET_ADDR) {
  const acct = await prisma.moneroAccount.create({
    data: { address, label: 'author', network: 'STAGENET', ownerUserId: userId }
  })
  return acct
}

async function createPost (userId, subName = undefined) {
  const item = await prisma.item.create({ data: { userId, title: 'growth test post', status: 'ACTIVE', subName } })
  created.items.push(item.id)
  return item
}

async function createTip ({ postId, recipientAccountId, piconeros, state = 'CONFIRMED' }) {
  const tip = await prisma.observedTip.create({
    data: {
      txHash: Buffer.from(`tip${Math.random()}`).toString('hex').padStart(64, '0'),
      postId,
      recipientAccountId,
      paymentId: `pid-${Math.random()}`,
      piconeros,
      state,
      confirmedAt: T
    }
  })
  created.tips.push(tip.id)
  return tip
}

async function createDownvote ({ postId, downvoterId, piconeros }) {
  const downvote = await prisma.observedDownvote.create({
    data: { txHash: 'ab'.repeat(32), postId, downvoterId, paymentId: `pid-b${Math.random()}`, piconeros, state: 'CONFIRMED', confirmedAt: T }
  })
  created.downvotes.push(downvote.id)
  return downvote
}

async function createFee ({ userId, postId, subName = undefined, feeType = 'POSTING', piconeros }) {
  const payIn = await prisma.payIn.create({ data: { userId, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
  created.payIns.push(payIn.id)
  const fee = await prisma.feeObservation.create({
    data: { txHash: 'cd'.repeat(32), payInId: payIn.id, feeType, postId, subName, recipientMajor: 1, recipientMinor: 1, piconeros, state: 'CONFIRMED', confirmedAt: T }
  })
  created.fees.push(fee.id)
  return fee
}

function sumSeries (rows, name) {
  return rows.reduce((acc, r) => {
    const d = r.data.find(x => x.name === name)
    return acc + (d ? Number(d.value) : 0)
  }, 0)
}

const meCtx = me => ({ models: prisma, me: { id: me } })

describe('growth resolvers', () => {
  test('growthTotals mine: true sums tips received and spends sent', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)
    const other = await createUser()
    const otherPost = await createPost(other)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n })
    await createDownvote({ postId: otherPost.id, downvoterId: me, piconeros: 500000000n })
    await createFee({ postId: post.id, userId: me, piconeros: 1000000000n })
    // noise that must NOT count for mine: a tip to someone else
    await createTip({ postId: otherPost.id, recipientAccountId: (await createAccount(other, STAGENET_ADDR_2)).id, piconeros: 700000000n })

    const totals = await resolvers.Query.growthTotals(null, { ...RANGE, mine: true }, meCtx(me))

    expect(Number(totals.stashing) * 1000).toBe(1000000000)
    expect(Number(totals.spending) * 1000).toBe(1500000000)
    expect(totals.items).toBe(2)
    expect(totals.registrations).toBeNull()
  })

  test('stashingGrowth and spendingGrowth bucket confirmed activity', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n })
    await createFee({ userId: me, postId: post.id, piconeros: 1000000000n })

    const stashing = await resolvers.Query.stashingGrowth(null, { ...RANGE, mine: true }, meCtx(me))
    expect(sumSeries(stashing, 'TIP') * 1000).toBe(1000000000)

    const spending = await resolvers.Query.spendingGrowth(null, { ...RANGE, mine: true }, meCtx(me))
    expect(sumSeries(spending, 'POSTING') * 1000).toBe(1000000000)
  })

  test('itemGrowth counts spend actions; spenderGrowth counts unique users', async () => {
    const me = await createUser()
    const post = await createPost(me)

    await createDownvote({ postId: post.id, downvoterId: me, piconeros: 500000000n })
    await createFee({ userId: me, postId: post.id, piconeros: 1000000000n })

    const items = await resolvers.Query.itemGrowth(null, { ...RANGE, mine: true }, meCtx(me))
    expect(sumSeries(items, 'DOWNVOTE') + sumSeries(items, 'POSTING')).toBe(2)

    const spenders = await resolvers.Query.spenderGrowth(null, { ...RANGE, mine: true }, meCtx(me))
    expect(sumSeries(spenders, 'total')).toBe(1)
  })

  test('stasherGrowth counts unique tip recipients', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n })
    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 500000000n })

    const stashers = await resolvers.Query.stasherGrowth(null, { ...RANGE, mine: true }, meCtx(me))
    expect(sumSeries(stashers, 'total')).toBe(1)
  })

  test('sub slice scopes tips/downvotes to the sub’s posts', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const inSub = await createPost(me, 'monero')
    const outOfSub = await createPost(me)

    await createTip({ postId: inSub.id, recipientAccountId: acct.id, piconeros: 1000000000n })
    await createTip({ postId: outOfSub.id, recipientAccountId: acct.id, piconeros: 900000000n })

    const subLoader = { load: async name => ({ name }) }
    const totals = await resolvers.Query.growthTotals(null, { ...RANGE, sub: 'monero' }, { models: prisma, subLoader })

    expect(Number(totals.stashing) * 1000).toBe(1000000000)
  })

  test('registrationGrowth counts new users', async () => {
    const rows = await prisma.$queryRaw`
      INSERT INTO users (created_at) VALUES (${T}::timestamptz AT TIME ZONE 'UTC') RETURNING id::int AS id`
    created.users.push(rows[0].id)

    const reg = await resolvers.Query.registrationGrowth(null, RANGE, { models: prisma })
    expect(sumSeries(reg, 'organic')).toBe(1)
  })

  test('global totals include all confirmed activity', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n })

    const totals = await resolvers.Query.growthTotals(null, { ...RANGE, sub: 'all' }, { models: prisma })
    expect(Number(totals.stashing) * 1000).toBe(1000000000)
  })
})
