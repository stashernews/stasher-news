/* eslint-env jest */

// Integration tests for Query.statistics — the /statistics history feed.
// Real DB against the migrated dev database; fixtures are tracked and removed
// after each test (mirrors test/api/resolvers/monero.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/payIn'

// The resolver transitively imports api/payIn (types barrel -> itemCreate ->
// lib/lexical/server/mentions) and api/resolvers/item (-> lib/lexical/server/html),
// which pull ESM-only node_modules (mdast-util-from-markdown) that next/jest does
// not transform. Mirror the mocks in test/api/resolvers/item-freebie.test.js to
// break that chain — the statistics resolver and getItemsById stay real.
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

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createAccount (userId) {
  // The base address is shared across fixture accounts, but MoneroAccount has
  // @@unique([address, network]) — append a random suffix so two fixture users
  // can both hold an ACTIVE account in one test (the statistics resolver only
  // joins on recipientAccountId; it never validates the address).
  const address = `${STAGENET_ADDR}${Math.random().toString(36).slice(2, 10)}`
  const acct = await prisma.moneroAccount.create({
    data: { address, label: 'author', network: 'STAGENET', ownerUserId: userId }
  })
  return acct
}

async function createPost (userId) {
  const item = await prisma.item.create({ data: { userId, title: 'history test post', status: 'ACTIVE' } })
  created.items.push(item.id)
  // Real posts reach getItemsById with an ItemPayIn link to their ITEM_CREATE
  // PayIn (payInJoinFilter INNER JOINs through ItemPayIn), so fixtures must too —
  // otherwise hydration returns no items and every row's `item` is null.
  const payIn = await prisma.payIn.create({ data: { userId, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return item
}

async function createTip ({ postId, recipientAccountId, piconeros, confirmedAt, state = 'CONFIRMED', tipperId }) {
  const tip = await prisma.observedTip.create({
    data: {
      txHash: Buffer.from(`tip${Math.random()}`).toString('hex').padStart(64, '0'),
      postId,
      tipperId,
      recipientAccountId,
      paymentId: `pid-${Math.random()}`,
      piconeros,
      state,
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

describe('Query.statistics', () => {
  test('returns confirmed tips received, downvotes sent, and fees sent in one feed', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)
    const other = await createUser()
    const otherPost = await createPost(other)

    const now = new Date()
    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n, confirmedAt: now })
    const downvote = await prisma.observedDownvote.create({
      data: { txHash: 'bb'.repeat(32), postId: otherPost.id, downvoterId: me, paymentId: 'pid-b', piconeros: 500000000n, state: 'CONFIRMED', confirmedAt: now }
    })
    created.downvotes.push(downvote.id)
    const payIn = await prisma.payIn.create({ data: { userId: me, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
    created.payIns.push(payIn.id)
    const fee = await prisma.feeObservation.create({
      data: { txHash: 'cc'.repeat(32), payInId: payIn.id, feeType: 'POSTING', postId: post.id, recipientMajor: 1, recipientMinor: 1, piconeros: 1000000000n, state: 'CONFIRMED', confirmedAt: now }
    })
    created.fees.push(fee.id)

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    expect(payIns).toHaveLength(3)

    const tip = payIns.find(p => p.payInType === 'TIP')
    expect(tip.isSend).toBe(false)
    expect(tip.piconeros).toBe(1000000000n)
    expect(tip.payInState).toBe('PAID')
    expect(tip.item.id).toBe(post.id)

    const down = payIns.find(p => p.payInType === 'DOWNVOTE')
    expect(down.isSend).toBe(true)
    expect(down.piconeros).toBe(500000000n)
    expect(down.item.id).toBe(otherPost.id)

    const feeRow = payIns.find(p => p.payInType === 'ITEM_CREATE')
    expect(feeRow.isSend).toBe(true)
    expect(feeRow.piconeros).toBe(1000000000n)
    expect(feeRow.item.id).toBe(post.id)
  })

  test('excludes DETECTED tips, tips to other users, and others’ spends', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)
    const other = await createUser()
    const otherAcct = await createAccount(other)
    const otherPost = await createPost(other)

    const now = new Date()
    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n, confirmedAt: now, state: 'DETECTED' })
    await createTip({ postId: post.id, recipientAccountId: otherAcct.id, piconeros: 1000000000n, confirmedAt: now })
    const downvote = await prisma.observedDownvote.create({
      data: { txHash: 'dd'.repeat(32), postId: otherPost.id, downvoterId: other, paymentId: 'pid-d', piconeros: 500000000n, state: 'CONFIRMED', confirmedAt: now }
    })
    created.downvotes.push(downvote.id)
    const otherPayIn = await prisma.payIn.create({ data: { userId: other, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
    created.payIns.push(otherPayIn.id)
    const otherFee = await prisma.feeObservation.create({
      data: { txHash: 'ee'.repeat(32), payInId: otherPayIn.id, feeType: 'POSTING', postId: otherPost.id, recipientMajor: 1, recipientMinor: 2, piconeros: 1000000000n, state: 'CONFIRMED', confirmedAt: now }
    })
    created.fees.push(otherFee.id)

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    expect(payIns).toHaveLength(0)
  })

  test('requires auth', async () => {
    await expect(resolvers.Query.statistics(null, {}, { models: prisma }))
      .rejects.toThrow(/logged in/i)
  })

  test('territory-fee rows carry subName (not a post) so they link to the turf', async () => {
    const me = await createUser()
    const payIn = await prisma.payIn.create({ data: { userId: me, piconeros: 0n, payInType: 'TERRITORY_BILLING', payInState: 'PAID' } })
    created.payIns.push(payIn.id)
    const now = new Date()
    const fee = await prisma.feeObservation.create({
      data: {
        txHash: 'ff'.repeat(32),
        payInId: payIn.id,
        feeType: 'TERRITORY_BILLING',
        postId: null,
        subName: 'monero',
        recipientMajor: 2,
        recipientMinor: 1,
        piconeros: 200000000000n,
        state: 'CONFIRMED',
        confirmedAt: now
      }
    })
    created.fees.push(fee.id)

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    expect(payIns).toHaveLength(1)
    const turfFee = payIns[0]
    expect(turfFee.payInType).toBe('TERRITORY_BILLING')
    expect(turfFee.isSend).toBe(true)
    expect(turfFee.piconeros).toBe(200000000000n)
    expect(turfFee.subPayIn?.subName).toBe('monero')
    expect(turfFee.item).toBeNull()
  })

  test('territory-create fee rows map to TERRITORY_CREATE (not mislabeled TERRITORY_BILLING)', async () => {
    const me = await createUser()
    const payIn = await prisma.payIn.create({ data: { userId: me, piconeros: 0n, payInType: 'TERRITORY_CREATE', payInState: 'PAID' } })
    created.payIns.push(payIn.id)
    const now = new Date()
    const fee = await prisma.feeObservation.create({
      data: {
        txHash: 'gg'.repeat(32),
        payInId: payIn.id,
        feeType: 'TERRITORY_CREATE',
        postId: null,
        subName: 'monero',
        recipientMajor: 2,
        recipientMinor: 1,
        piconeros: 300000000000n,
        state: 'CONFIRMED',
        confirmedAt: now
      }
    })
    created.fees.push(fee.id)

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    expect(payIns).toHaveLength(1)
    const turfFee = payIns[0]
    expect(turfFee.payInType).toBe('TERRITORY_CREATE')
    expect(turfFee.isSend).toBe(true)
    expect(turfFee.subPayIn?.subName).toBe('monero')
    expect(turfFee.item).toBeNull()
  })

  test('boost-fee rows map to BOOST (regression: no feeType may yield a null payInType)', async () => {
    const me = await createUser()
    const post = await createPost(me)
    const now = new Date()
    const payIn = await prisma.payIn.create({ data: { userId: me, piconeros: 0n, payInType: 'BOOST', payInState: 'PAID' } })
    created.payIns.push(payIn.id)
    const fee = await prisma.feeObservation.create({
      data: { txHash: 'hh'.repeat(32), payInId: payIn.id, feeType: 'BOOST', postId: post.id, recipientMajor: 1, recipientMinor: 1, piconeros: 1000000000n, state: 'CONFIRMED', confirmedAt: now }
    })
    created.fees.push(fee.id)

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    expect(payIns).toHaveLength(1)
    const boostRow = payIns[0]
    expect(boostRow.payInType).toBe('BOOST')
    expect(boostRow.isSend).toBe(true)
    expect(boostRow.piconeros).toBe(1000000000n)
    expect(boostRow.item.id).toBe(post.id)
  })

  test('returns confirmed tips I sent as isSend=true TIP rows', async () => {
    const me = await createUser()
    const other = await createUser()
    const otherAcct = await createAccount(other)
    const otherPost = await createPost(other)

    const now = new Date()
    await createTip({ postId: otherPost.id, recipientAccountId: otherAcct.id, piconeros: 700000000n, confirmedAt: now, tipperId: me })
    // DETECTED (unconfirmed) sent tips are excluded — the feed is CONFIRMED-only
    await createTip({ postId: otherPost.id, recipientAccountId: otherAcct.id, piconeros: 100000000n, confirmedAt: null, state: 'DETECTED', tipperId: me })
    // tips sent by someone else are invisible to me
    await createTip({ postId: otherPost.id, recipientAccountId: otherAcct.id, piconeros: 200000000n, confirmedAt: now, tipperId: other })

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    const sentTips = payIns.filter(p => p.payInType === 'TIP' && p.isSend)
    expect(sentTips).toHaveLength(1)
    expect(sentTips[0].piconeros).toBe(700000000n)
    expect(sentTips[0].payInState).toBe('PAID')
    expect(sentTips[0].item.id).toBe(otherPost.id)
  })

  // Intentionally stays green: this seeds a CONFIRMED self-tip row directly (a
  // legacy state reachable before self-tip exclusion) and documents that the
  // statistics resolver still reports such rows; new direct self-tips can no
  // longer reach CONFIRMED (they go EXCLUDED at detection).
  test('a self-tip appears as BOTH a receive row and a send row', async () => {
    const me = await createUser()
    const acct = await createAccount(me)
    const post = await createPost(me)

    const now = new Date()
    await createTip({ postId: post.id, recipientAccountId: acct.id, piconeros: 1000000000n, confirmedAt: now, tipperId: me })

    const { payIns } = await resolvers.Query.statistics(null, {}, { models: prisma, me: { id: me } })

    const tipRows = payIns.filter(p => p.payInType === 'TIP')
    expect(tipRows).toHaveLength(2)
    expect(tipRows.filter(r => r.isSend)).toHaveLength(1)
    expect(tipRows.filter(r => !r.isSend)).toHaveLength(1)
  })
})
