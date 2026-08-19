/* eslint-env jest */

// Integration tests for the item "me" aggregates: mePiconeros (my tips on the
// item) and meDontLikePiconeros (my downvotes) must come from ItemUserAgg —
// the fork's per-(item,user) observation aggregate — NOT PayIn, because tips
// never create PayIns and DOWNVOTE PayIns carry piconeros=0n.
// Real DB against the migrated dev database; fixtures tracked and removed
// after each test (mirrors test/api/resolvers/statistics.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers, { getItem } from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy ESM-only transitive deps; mirror the
// mocks in test/api/resolvers/item-freebie.test.js to break that chain — the
// SQL in itemQueryWithMeta and the field resolvers stay real.
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

const created = { users: [], items: [], payIns: [] }

async function cleanupTracked () {
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  // ItemUserAgg cascades on item delete (onDelete: Cascade)
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

async function createPost (userId) {
  const item = await prisma.item.create({ data: { userId, title: 'from-me test post', status: 'ACTIVE' } })
  created.items.push(item.id)
  // Real posts reach getItem through the ItemPayIn INNER JOIN (payInJoinFilter),
  // so the fixture needs an ITEM_CREATE PayIn link — same as statistics.test.js
  const payIn = await prisma.payIn.create({ data: { userId, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return item
}

const TIP = 123456789n
const DOWN = 987654321n

describe('Item.mePiconeros / meDontLikePiconeros (SQL fast path via getItem)', () => {
  test('reflect ItemUserAgg tipPiconeros/downvotePiconeros for the viewer', async () => {
    const me = await createUser()
    const post = await createPost(me)
    await prisma.itemUserAgg.create({
      data: { itemId: post.id, userId: me, tipPiconeros: TIP, downvotePiconeros: DOWN }
    })

    const item = await getItem(null, { id: post.id }, { me: { id: me }, models: prisma })
    expect(item).toBeTruthy()

    expect(await resolvers.Item.mePiconeros(item, {}, { me: { id: me }, models: prisma })).toBe(TIP)
    expect(await resolvers.Item.meDontLikePiconeros(item, {}, { me: { id: me }, models: prisma })).toBe(DOWN)
  })

  test('viewer with no ItemUserAgg row gets 0n', async () => {
    const author = await createUser()
    const viewer = await createUser()
    const post = await createPost(author)

    const item = await getItem(null, { id: post.id }, { me: { id: viewer }, models: prisma })

    expect(await resolvers.Item.mePiconeros(item, {}, { me: { id: viewer }, models: prisma })).toBe(0n)
    expect(await resolvers.Item.meDontLikePiconeros(item, {}, { me: { id: viewer }, models: prisma })).toBe(0n)
  })
})

describe('Item.mePiconeros / meDontLikePiconeros (fallback path, bare item)', () => {
  test('falls back to ItemUserAgg when meMsats is not on the item', async () => {
    const me = await createUser()
    const post = await createPost(me)
    await prisma.itemUserAgg.create({
      data: { itemId: post.id, userId: me, tipPiconeros: TIP, downvotePiconeros: DOWN }
    })

    // bare item object — no meMsats/meMcredits, so the resolver must hit the DB
    const bare = { id: post.id }

    expect(await resolvers.Item.mePiconeros(bare, {}, { me: { id: me }, models: prisma })).toBe(TIP)
    expect(await resolvers.Item.meDontLikePiconeros(bare, {}, { me: { id: me }, models: prisma })).toBe(DOWN)
    expect(await resolvers.Item.meCredits(bare, {}, { me: { id: me }, models: prisma })).toBe(0)
  })

  test('no ItemUserAgg row and anonymous viewer return 0', async () => {
    const me = await createUser()
    const post = await createPost(me)
    const bare = { id: post.id }

    expect(await resolvers.Item.mePiconeros(bare, {}, { me: { id: me }, models: prisma })).toBe(0n)
    expect(await resolvers.Item.meDontLikePiconeros(bare, {}, { me: { id: me }, models: prisma })).toBe(0n)
    expect(await resolvers.Item.mePiconeros(bare, {}, { models: prisma })).toBe(0n)
  })
})
