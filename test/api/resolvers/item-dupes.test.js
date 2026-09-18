/* eslint-env jest */

// Regression: Item.dupes must apply the same PENDING_FEE visibility gate
// (activeOrMine) as the feeds. The dupes query previously used only
// payInJoinFilter — whose ITEM_CREATE PayIn is born PAID the moment the item is
// created — so another user's PENDING_FEE post (invisible everywhere else) was
// surfaced to a viewer as a dupe, complete with a pay-the-posting-fee button
// that would let the viewer pay the other author's fee.
// Real DB against the migrated dev database; fixtures tracked and removed
// after each test (mirrors test/api/resolvers/item-me-piconeros.test.js).

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy ESM-only transitive deps; the mocks
// below break that chain — the
// SQL in itemQueryWithMeta and the dupes resolver stay real.
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

// A real posted link reaches dupes through the ItemPayIn INNER JOIN
// (payInJoinFilter), and its ITEM_CREATE PayIn is born PAID — the shape that
// previously leaked another user's PENDING_FEE dupe to a viewer.
async function createDupedPost (userId, { url, feeStatus } = {}) {
  const item = await prisma.item.create({
    data: { userId, title: 'dupe test', status: 'ACTIVE', url, ...(feeStatus ? { feeStatus } : {}) }
  })
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({ data: { userId, piconeros: 0n, payInType: 'ITEM_CREATE', payInState: 'PAID' } })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return item
}

const URL = 'https://example.com/dupe'

describe('Item.dupes visibility gate', () => {
  test('hides another user PENDING_FEE dupe but still shows a live dupe', async () => {
    const viewer = await createUser()
    const pendingAuthor = await createUser()
    const liveAuthor = await createUser()

    const pending = await createDupedPost(pendingAuthor, { url: URL, feeStatus: 'PENDING_FEE' })
    const live = await createDupedPost(liveAuthor, { url: URL })

    const result = await resolvers.Query.dupes(null, { url: URL }, { me: { id: viewer }, models: prisma })
    const ids = result.map(i => i.id)

    expect(ids).toContain(live.id)
    expect(ids).not.toContain(pending.id)
  })

  test('anonymous viewer does not see another user PENDING_FEE dupe', async () => {
    const pendingAuthor = await createUser()
    const pending = await createDupedPost(pendingAuthor, { url: URL, feeStatus: 'PENDING_FEE' })

    const result = await resolvers.Query.dupes(null, { url: URL }, { models: prisma })
    expect(result.map(i => i.id)).not.toContain(pending.id)
  })

  test('viewer still sees their own PENDING_FEE dupe', async () => {
    const me = await createUser()
    const mine = await createDupedPost(me, { url: URL, feeStatus: 'PENDING_FEE' })

    const result = await resolvers.Query.dupes(null, { url: URL }, { me: { id: me }, models: prisma })
    expect(result.map(i => i.id)).toContain(mine.id)
  })
})
