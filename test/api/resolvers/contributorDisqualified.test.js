/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import notificationResolvers from '@/api/resolvers/notifications'
import userResolvers from '@/api/resolvers/user'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

// ContributorDisqualified notification and its bell check. Runs the real notifications union
// SQL, so it only runs against the dedicated stasher_contributor_pool_test DB.
const ISOLATED_DB = (() => {
  try {
    return new URL(process.env.DATABASE_URL).pathname === '/stasher_contributor_pool_test'
  } catch { return false }
})()

const { Query: { notifications } } = notificationResolvers
const { Query: { hasNewNotes } } = userResolvers

;(ISOLATED_DB ? describe : describe.skip)('ContributorDisqualified notification', () => {
  const db = new PrismaClient()
  const created = { users: [], items: [] }

  const ctxFor = async userId => {
    const user = await db.user.findUnique({ where: { id: userId } })
    return { me: { id: userId }, models: db, userLoader: { load: async () => user } }
  }
  const types = async userId => {
    const r = await notifications(null, { cursor: null }, await ctxFor(userId))
    return r.notifications.filter(n => n.type === 'ContributorDisqualified')
  }

  async function user () {
    const u = await db.user.create({ data: {} })
    created.users.push(u.id)
    return u.id
  }

  async function post (userId, extra = '') {
    const [row] = await db.$queryRaw`INSERT INTO "Item" ("userId", title, "bountyPiconeros") VALUES (${userId}::int, 'dq', 0) RETURNING id::int AS id`
    await db.$executeRaw`UPDATE "Item" SET path = ${String(row.id)}::ltree WHERE id = ${row.id}::int`
    created.items.push(row.id)
    return row.id
  }

  afterEach(async () => {
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    created.users = []; created.items = []
  })

  afterAll(async () => { await db.$disconnect() })

  test('a silent disqualification creates no notice or new-note badge', async () => {
    const author = await user()
    const id = await post(author)
    await db.user.update({ where: { id: author }, data: { checkedNotesAt: new Date(Date.now() - 3600000) } })
    await db.item.update({ where: { id }, data: { contributorDisqualifiedAt: new Date() } })
    expect(await types(author)).toEqual([])
    expect(await hasNewNotes(null, {}, await ctxFor(author))).toBe(false)
  })

  test('appears for the author only and carries the item id', async () => {
    const author = await user()
    const other = await user()
    const id = await post(author)
    await db.$executeRaw`UPDATE "Item" SET "contributorDisqualifiedAt" = now() - interval '1 minute', "contributorDisqualifiedNotifyAt" = now() - interval '1 minute', "contributorDisqualifiedReason" = 'PLAGIARISM' WHERE id = ${id}::int`

    const mine = await types(author)
    expect(mine).toHaveLength(1)
    expect(mine[0].id).toBe(String(id))
    // the reason loads once per request, however many notifications ask
    const { ContributorDisqualified: fields } = notificationResolvers
    const ctx = await ctxFor(author)
    const spy = jest.spyOn(db.item, 'findMany')
    expect(await fields.reason(mine[0], {}, ctx)).toBe('PLAGIARISM')
    expect(await fields.reason(mine[0], {}, ctx)).toBe('PLAGIARISM')
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    expect(await types(other)).toHaveLength(0)
  })

  test('clearing the flag removes it, and a normal post never appears', async () => {
    const author = await user()
    const flagged = await post(author)
    await post(author)
    await db.$executeRaw`UPDATE "Item" SET "contributorDisqualifiedAt" = now() - interval '1 minute', "contributorDisqualifiedNotifyAt" = now() - interval '1 minute' WHERE id = ${flagged}::int`
    expect(await types(author)).toHaveLength(1)

    await db.$executeRaw`UPDATE "Item" SET "contributorDisqualifiedAt" = NULL WHERE id = ${flagged}::int`
    expect(await types(author)).toHaveLength(0)
  })

  test('the bell rings for a disqualification newer than the last check, for the author only', async () => {
    const author = await user()
    const other = await user()
    const id = await post(author)
    const past = new Date(Date.now() - 3600_000)
    await db.$executeRaw`UPDATE users SET "checkedNotesAt" = ${past} WHERE id IN (${author}::int, ${other}::int)`
    await db.$executeRaw`UPDATE "Item" SET "contributorDisqualifiedAt" = now(), "contributorDisqualifiedNotifyAt" = now() WHERE id = ${id}::int`

    expect(await hasNewNotes(null, {}, await ctxFor(author))).toBe(true)
    expect(await hasNewNotes(null, {}, await ctxFor(other))).toBe(false)
  })
})
