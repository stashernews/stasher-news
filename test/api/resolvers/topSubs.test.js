/* eslint-env jest */

// Integration tests for topSubs — the /top/territories leaderboard. Real DB,
// fixtures tracked + removed (mirrors test/api/resolvers/leaderboard.test.js).

import { PrismaClient } from '@prisma/client'
import { topSubs } from '@/api/resolvers/sub'
import { SUB_SORTS } from '@/lib/constants'

// api/resolvers/sub.js transitively imports lexical/server deps (ESM-only).
// Mirror the mocks in test/api/resolvers/leaderboard.test.js.
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

const created = { users: [], subs: [], items: [], tips: [], downvotes: [], fees: [], payIns: [], accounts: [] }

async function cleanupTracked () {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
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

async function createSub (userId, name) {
  await prisma.sub.create({
    data: { name, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 1000000000 }
  })
  created.subs.push(name)
  const rows = await prisma.$queryRaw`SELECT id::int AS id FROM "Sub" WHERE name = ${name}`
  return rows[0].id
}

async function createPostInSub (userId, subName) {
  const item = await prisma.item.create({ data: { userId, title: 'topsubs test post', status: 'ACTIVE', subName } })
  created.items.push(item.id)
  return item
}

let accountSeq = 0
async function createAccount (userId) {
  accountSeq += 1
  const acct = await prisma.moneroAccount.create({
    data: { address: '5A' + 'B'.repeat(93) + String(accountSeq), label: 'author', network: 'STAGENET', ownerUserId: userId }
  })
  created.accounts.push(acct.id)
  return acct
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
  // mirror the real posting-fee flow: the item carries its fee PayIn (feePayInId),
  // and the fee is observed + paid (FEE_PAID) — the sub_items CTE joins through it.
  await prisma.item.update({
    where: { id: postId },
    data: { feePayInId: payIn.id, feeStatus: 'FEE_PAID' }
  })
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
  return fee
}

// Fixtures at a fixed past instant so the global topSubs window is guaranteed
// disjoint from all real platform observations (confirmed in 2026).
const T = new Date('2024-02-01T12:00:00.000Z')
const RANGE = { when: 'custom', from: String(T.getTime() - 60 * 60 * 1000), to: String(T.getTime() + 60 * 60 * 1000) }

const { Prisma } = require('@prisma/client')
const ALL_SUBS_QUERY = Prisma.sql`
  SELECT "Sub".name, "Sub".id
  FROM "Sub"
  WHERE "Sub".status <> 'STOPPED'
  AND "Sub".name NOT LIKE '\\_p4downvote\\_%'
  GROUP BY "Sub".name
`

describe('topSubs reads live observations', () => {
  test('by stacked ranks subs by tips received into their posts', async () => {
    const owner = await createUser()
    await createSub(owner, 'topsubs-a')
    await createSub(owner, 'topsubs-b')
    const postA = await createPostInSub(owner, 'topsubs-a')
    const postB = await createPostInSub(owner, 'topsubs-b')
    const acct = await createAccount(owner)

    await createTip({ postId: postA.id, recipientAccountId: acct.id, piconeros: 1000000000n, confirmedAt: T })
    await createTip({ postId: postB.id, recipientAccountId: acct.id, piconeros: 3000000000n, confirmedAt: T })

    const { subs } = await topSubs(null, { query: ALL_SUBS_QUERY, ...RANGE, by: 'stacked', limit: 50 }, { models: prisma, me: null })

    const a = subs.find(s => s.name === 'topsubs-a')
    const b = subs.find(s => s.name === 'topsubs-b')
    expect(b.stacked).toBe(3000000000n)
    expect(a.stacked).toBe(1000000000n)
    expect(subs.findIndex(s => s.name === 'topsubs-b')).toBeLessThan(subs.findIndex(s => s.name === 'topsubs-a'))
  })

  test('by spent ranks subs by downvotes plus posting fees in the sub', async () => {
    const owner = await createUser()
    await createSub(owner, 'topsubs-spent-a')
    await createSub(owner, 'topsubs-spent-b')
    const postA = await createPostInSub(owner, 'topsubs-spent-a')
    const postB = await createPostInSub(owner, 'topsubs-spent-b')

    await createDownvote({ postId: postA.id, downvoterId: owner, piconeros: 500000000n, confirmedAt: T })
    await createPostingFee({ userId: owner, postId: postA.id, piconeros: 1000000000n, confirmedAt: T })
    await createDownvote({ postId: postB.id, downvoterId: owner, piconeros: 200000000n, confirmedAt: T })

    const { subs } = await topSubs(null, { query: ALL_SUBS_QUERY, ...RANGE, by: 'spent', limit: 50 }, { models: prisma, me: null })

    const a = subs.find(s => s.name === 'topsubs-spent-a')
    const b = subs.find(s => s.name === 'topsubs-spent-b')
    expect(a.spent).toBe(1500000000n)
    expect(b.spent).toBe(200000000n)
  })

  test('by items ranks subs by posts created in the sub', async () => {
    const owner = await createUser()
    await createSub(owner, 'topsubs-items-a')
    await createSub(owner, 'topsubs-items-b')
    const postA1 = await createPostInSub(owner, 'topsubs-items-a')
    const postA2 = await createPostInSub(owner, 'topsubs-items-a')
    const postB1 = await createPostInSub(owner, 'topsubs-items-b')

    await createPostingFee({ userId: owner, postId: postA1.id, piconeros: 1000000000n, confirmedAt: T })
    await createPostingFee({ userId: owner, postId: postA2.id, piconeros: 1000000000n, confirmedAt: T })
    await createPostingFee({ userId: owner, postId: postB1.id, piconeros: 1000000000n, confirmedAt: T })

    const { subs } = await topSubs(null, { query: ALL_SUBS_QUERY, ...RANGE, by: 'items', limit: 50 }, { models: prisma, me: null })

    const a = subs.find(s => s.name === 'topsubs-items-a')
    const b = subs.find(s => s.name === 'topsubs-items-b')
    expect(Number(a.nitems)).toBe(2)
    expect(Number(b.nitems)).toBe(1)
  })

  test('revenue is no longer a valid sort', async () => {
    await expect(topSubs(null, { query: ALL_SUBS_QUERY, ...RANGE, by: 'revenue', limit: 50 }, { models: prisma, me: null }))
      .rejects.toThrow(/invalid sort/i)
  })

  test('excludes DETECTED tips and tips to posts in other subs', async () => {
    const owner = await createUser()
    await createSub(owner, 'topsubs-excl')
    const post = await createPostInSub(owner, 'topsubs-excl')
    await createSub(owner, 'topsubs-excl-other')
    const otherPost = await createPostInSub(owner, 'topsubs-excl-other')
    const acct = await createAccount(owner)

    // a DETECTED tip in the sub must NOT count
    await prisma.observedTip.create({
      data: {
        txHash: Buffer.from(`detected${Math.random()}`).toString('hex').padStart(64, '0'),
        postId: post.id,
        recipientAccountId: acct.id,
        paymentId: `pid-det-${Math.random()}`,
        piconeros: 9000000000n,
        state: 'DETECTED',
        confirmedAt: T
      }
    }).then(t => created.tips.push(t.id))
    // a CONFIRMED tip to a post in a DIFFERENT sub must NOT count for this sub
    await createTip({ postId: otherPost.id, recipientAccountId: acct.id, piconeros: 8000000000n, confirmedAt: T })

    const { subs } = await topSubs(null, { query: ALL_SUBS_QUERY, ...RANGE, by: 'stacked', limit: 50 }, { models: prisma, me: null })

    const sub = subs.find(s => s.name === 'topsubs-excl')
    expect(sub.stacked).toBe(0n)
    const other = subs.find(s => s.name === 'topsubs-excl-other')
    expect(other.stacked).toBe(8000000000n)
  })

  test('the SubOptional GraphQL type no longer exposes revenue', async () => {
    // Import the schema's typeDefs and assert revenue is absent from SubOptional.
    // (Kept lightweight: a string check on the printed typeDef source.)
    const { readFileSync } = require('fs')
    const src = readFileSync('/app/api/typeDefs/sub.js', 'utf8')
    expect(src).not.toMatch(/revenue\s*\(/)
  })

  test('SUB_SORTS no longer includes revenue', async () => {
    expect(SUB_SORTS).not.toContain('revenue')
    expect(SUB_SORTS).toEqual(['stacked', 'spent', 'items'])
  })
})
