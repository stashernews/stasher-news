/* eslint-env jest */

// Integration tests for the leaderboard surface (topUsers + UserOptional
// stacked/spent + userSuggestions). All stats come from LIVE aggregation over
// confirmed observations (ObservedTip / ObservedDownvote / FeeObservation);
// the legacy AggPayIn/AggPayOut aggregate tables were dropped (A-12). Real DB,
// fixtures tracked + removed (mirrors test/api/resolvers/statistics.test.js).

import { PrismaClient } from '@prisma/client'
import userResolvers, { topUsers } from '@/api/resolvers/user'

// api/resolvers/user.js transitively imports api/resolvers/item.js, which drags
// in ESM-only lexical deps (mdast-util-from-markdown). Mirror the mocks in
// test/api/resolvers/userOptional.test.js to break that chain.
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

const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const created = { users: [], items: [], tips: [], downvotes: [], fees: [], payIns: [], accounts: [] }

async function cleanupTracked () {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
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

// The leaderboard excludes nameless users (User.name is non-null), so the topUsers
// fixtures need a nym.
const nameSeq = { n: 0 }
async function nameUser (userId) {
  nameSeq.n += 1
  await prisma.$executeRaw`UPDATE users SET name = 'lb-user-' || ${String(nameSeq.n)} WHERE id = ${userId}::int`
  return userId
}

let accountSeq = 0
async function createAccount (userId) {
  accountSeq += 1
  const acct = await prisma.moneroAccount.create({
    data: { address: STAGENET_ADDR + String(accountSeq), label: 'author', network: 'STAGENET', ownerUserId: userId }
  })
  created.accounts.push(acct.id)
  return acct
}

async function createPost (userId) {
  const item = await prisma.item.create({ data: { userId, title: 'leaderboard test post', status: 'ACTIVE' } })
  created.items.push(item.id)
  return item
}

async function createTip ({ postId, recipientAccountId, piconeros, confirmedAt }) {
  const tip = await prisma.observedTip.create({
    data: {
      txHash: Buffer.from(`tip${Math.random()}`).toString('hex').padStart(64, '0'),
      postId,
      recipientAccountId,
      paymentId: `pid-${Math.random()}`,
      piconeros,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

async function createDownvote ({ postId, downvoterId, piconeros, confirmedAt }) {
  const burn = await prisma.observedDownvote.create({
    data: {
      txHash: Buffer.from(`dv${Math.random()}`).toString('hex').padStart(64, '0'),
      postId,
      downvoterId,
      paymentId: `pid-dv-${Math.random()}`,
      piconeros,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.downvotes.push(burn.id)
  return burn
}

async function createPostingFee ({ userId, postId, piconeros, confirmedAt }) {
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      piconeros: 0n,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      payInStateChangedAt: confirmedAt
    }
  })
  created.payIns.push(payIn.id)
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: Buffer.from(`fee${Math.random()}`).toString('hex').padStart(64, '0'),
      payInId: payIn.id,
      feeType: 'POSTING',
      postId,
      recipientMajor: 1,
      recipientMinor: 1,
      piconeros,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.fees.push(fee.id)
  return { payIn, fee }
}

// Fixtures land at a fixed past instant so the global topUsers window is
// guaranteed disjoint from all real platform observations (which are all
// confirmed in 2026): seeded rows in [2024-01-15 11:00, 13:00 UTC), nothing else
// can ever appear there.
const T = new Date('2024-01-15T12:00:00.000Z')
const RANGE = { when: 'custom', from: String(T.getTime() - 60 * 60 * 1000), to: String(T.getTime() + 60 * 60 * 1000) }

describe('leaderboard reads live observations', () => {
  test('topUsers by stacked ranks users by confirmed tips received in range', async () => {
    const a = await createUser()
    const b = await createUser()
    const aAcct = await createAccount(a)
    const bAcct = await createAccount(b)
    const postA = await createPost(a)
    const postB = await createPost(b)

    await createTip({ postId: postA.id, recipientAccountId: aAcct.id, piconeros: 1000000000n, confirmedAt: T })
    await createTip({ postId: postB.id, recipientAccountId: bAcct.id, piconeros: 3000000000n, confirmedAt: T })

    await nameUser(a)
    await nameUser(b)

    const { users } = await topUsers(null, { ...RANGE, by: 'stacked', limit: 50 }, { models: prisma, me: null })

    expect(users).toHaveLength(2)
    expect(users[0].id).toBe(b)
    expect(Number(users[0].stacked)).toBe(3000000000)
    expect(users[1].id).toBe(a)
    expect(Number(users[1].stacked)).toBe(1000000000)
  })

  test('topUsers by spent ranks users by downvotes plus fees', async () => {
    const a = await createUser()
    const b = await createUser()
    const postA = await createPost(a)
    const postB = await createPost(b)

    await createDownvote({ postId: postB.id, downvoterId: a, piconeros: 500000000n, confirmedAt: T })
    await createPostingFee({ userId: a, postId: postA.id, piconeros: 1000000000n, confirmedAt: T })
    await createDownvote({ postId: postA.id, downvoterId: b, piconeros: 200000000n, confirmedAt: T })

    await nameUser(a)
    await nameUser(b)

    const { users } = await topUsers(null, { ...RANGE, by: 'spent', limit: 50 }, { models: prisma, me: null })

    expect(users).toHaveLength(2)
    expect(users[0].id).toBe(a)
    expect(Number(users[0].spent)).toBe(1500000000)
    expect(Number(users[0].nitems)).toBe(1)
    expect(users[1].id).toBe(b)
    expect(Number(users[1].spent)).toBe(200000000)
  })

  test('topUsers by items ranks users by ITEM_CREATE payins', async () => {
    const a = await createUser()
    const b = await createUser()
    const postA = await createPost(a)
    const postB = await createPost(b)

    await createPostingFee({ userId: a, postId: postA.id, piconeros: 1000000000n, confirmedAt: T })
    await createPostingFee({ userId: a, postId: postB.id, piconeros: 1000000000n, confirmedAt: T })
    await createPostingFee({ userId: b, postId: postB.id, piconeros: 1000000000n, confirmedAt: T })

    await nameUser(a)
    await nameUser(b)

    const { users } = await topUsers(null, { ...RANGE, by: 'items', limit: 50 }, { models: prisma, me: null })

    expect(users).toHaveLength(2)
    expect(users[0].id).toBe(a)
    expect(Number(users[0].nitems)).toBe(2)
    expect(users[1].id).toBe(b)
    expect(Number(users[1].nitems)).toBe(1)
  })

  test('UserOptional.stacked returns the tip sum for a custom range', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n, confirmedAt: T })

    const user = { id: me, hideFromTopUsers: false, hideStashAmount: false, stackedPiconeros: 0n }
    const stacked = await userResolvers.UserOptional.stacked(user, RANGE, { models: prisma, me: { id: me } })

    expect(stacked).toBe(1000000000n)
  })

  test('UserOptional.spent returns downvotes plus fees for a custom range', async () => {
    const me = await createUser()
    const post = await createPost(me)

    await createDownvote({ postId: post.id, downvoterId: me, piconeros: 500000000n, confirmedAt: T })
    await createPostingFee({ userId: me, postId: post.id, piconeros: 1000000000n, confirmedAt: T })

    const user = { id: me, hideFromTopUsers: false, hideStashAmount: false, stackedPiconeros: 0n }
    const spent = await userResolvers.UserOptional.spent(user, RANGE, { models: prisma, me: { id: me } })

    expect(spent).toBe(1500000000n)
  })

  test('userSuggestions lists live top stackers when no query', async () => {
    const heavy = await createUser()
    await prisma.$executeRaw`UPDATE users SET name = 'sugg-heavy' WHERE id = ${heavy}::int`
    const acct = await createAccount(heavy)
    const post = await createPost(heavy)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 100000000000n, confirmedAt: T })

    const users = await userResolvers.Query.userSuggestions(null, { q: null, limit: 50 }, { models: prisma })

    expect(users.map(u => u.name)).toContain('sugg-heavy')
  })

  test('userSuggestions excludes nameless stackers (User.name is non-null)', async () => {
    // a user who received tips but never picked a nym must not surface — returning
    // them would crash GraphQL's non-null User.name.
    const anon = await createUser()
    const acct = await createAccount(anon)
    const post = await createPost(anon)

    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 100000000000n, confirmedAt: T })

    const users = await userResolvers.Query.userSuggestions(null, { q: null, limit: 50 }, { models: prisma })

    expect(users.map(u => u.name)).not.toContain(null)
    expect(users.find(u => u.id === anon)).toBeUndefined()
  })
})
