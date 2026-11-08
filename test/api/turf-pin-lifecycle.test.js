/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { turfPinFixture } from '../helpers/turf-pins'
import { setTurfPin, readTurfPins, lockTurfRows } from '@/api/turf-pins'
import { applyItemUpdate } from '@/api/payIn/types/itemUpdate'
import { deleteItemByAuthor } from '@/lib/item'
import { extractMentions } from '@/lib/lexical/server/mentions'

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: jest.fn(() => ({ userNames: [], itemIds: [] }))
}))
// Persisted-state tests do not need response hydration.
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn(async (parent, { id }) => ({ id: Number(id) }))
}))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('turf pin lifecycle (isolated DB)', () => {
  let f
  beforeAll(() => { f = turfPinFixture() })
  const extraClients = []
  const createdSwapItems = []

  afterAll(async () => {
    // imgproxy jobs enqueued by applyItemUpdate
    await f.db.$executeRaw`
      DELETE FROM pgboss.job
      WHERE name = 'imgproxy'
        AND (data->>'id')::int = ANY(ARRAY[${f.created.items.concat(createdSwapItems).length ? f.created.items.concat(createdSwapItems) : [0]}]::int[])`
      .catch(() => {})
    f.created.items.push(...createdSwapItems)
    for (const client of extraClients) await client.$disconnect().catch(() => {})
    await f.cleanup()
  })

  const seedPinnedEverywhere = async () => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'la')
    const b = await f.sub(owner, 'lb')
    const item = await f.post(author, [a, b])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctx)
    const payIn = await f.db.payIn.create({
      data: { userId: author.id, payInType: 'ITEM_UPDATE', payInState: 'PAID', piconeros: 0n }
    })
    f.created.payIns.push(payIn.id)
    return { owner, author, a, b, item, payIn }
  }

  test('removing a membership through applyItemUpdate clears only that pin', async () => {
    const { owner, a, b, item, payIn } = await seedPinnedEverywhere()
    await applyItemUpdate(f.db, payIn, {
      id: item.id, userId: item.userId, subNames: [a.name]
    })
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    expect(await f.db.itemSub.findUnique({
      where: { itemId_subName: { itemId: item.id, subName: b.name } }
    })).toBeNull()
    expect(await f.db.itemSub.count({
      where: { subName: b.name, pinPosition: { not: null } }
    })).toBe(0)
    expect(owner).toBeDefined()
  })

  test('re-adding a membership starts unpinned', async () => {
    const { a, b, item, payIn } = await seedPinnedEverywhere()
    await applyItemUpdate(f.db, payIn, { id: item.id, userId: item.userId, subNames: [a.name] })
    await applyItemUpdate(f.db, payIn, {
      id: item.id, userId: item.userId, subNames: [a.name, b.name]
    })
    const row = await f.db.itemSub.findUnique({
      where: { itemId_subName: { itemId: item.id, subName: b.name } }
    })
    expect(row).not.toBeNull()
    expect(row.pinPosition).toBeNull()
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
  })

  test('a paid repost (additive subNames) never clears the original pins', async () => {
    const { a, b, item, payIn } = await seedPinnedEverywhere()
    // the repost engine unions the deferred list with the item's turfs before
    // applying — mirrored here by the additive args it ultimately produces
    await applyItemUpdate(f.db, payIn, {
      id: item.id, userId: item.userId, subNames: [a.name, b.name]
    })
    expect(await readTurfPins(f.db, item.id)).toEqual([
      { subName: a.name, position: 1 }, { subName: b.name, position: 1 }
    ])
  })

  test('delete and pin cannot leave a pinned deleted post', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'race')
    const item = await f.post(owner, [a])
    await Promise.allSettled([
      setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db }),
      deleteItemByAuthor({ models: f.db, id: item.id })
    ])
    const saved = await f.db.item.findUnique({ where: { id: item.id } })
    expect(saved.deletedAt).not.toBeNull()
    expect(await readTurfPins(f.db, item.id)).toEqual([])
    expect(await f.db.itemSub.count({ where: { itemId: item.id, pinPosition: { not: null } } })).toBe(0)
  })

  test('soft deletion clears all pins and preserves the author-deletion semantics', async () => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'del1')
    const b = await f.sub(owner, 'del2')
    const item = await f.post(author, [a, b])
    await f.db.item.update({
      where: { id: item.id },
      data: { addendumText: 'extra', addendumUpdatedAt: new Date(), addendumRevision: 1 }
    })
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctx)

    await deleteItemByAuthor({ models: f.db, id: item.id })

    expect(await readTurfPins(f.db, item.id)).toEqual([])
    expect(await f.db.itemSub.count({ where: { itemId: item.id, pinPosition: { not: null } } })).toBe(0)
    const row = await f.db.item.findUnique({ where: { id: item.id } })
    expect(row.deletedAt).not.toBeNull()
    expect(row.addendumText).toBeNull()
    expect(row.addendumRevision).toBe(2)
    expect(row.title).toBe('deleted by author')
    // both turfs freed: the next pin appends at position 1 again
    const fresh = await f.post(author, [a])
    await setTurfPin({ id: fresh.id, subName: a.name, pinned: true }, ctx)
    expect(await readTurfPins(f.db, fresh.id)).toEqual([{ subName: a.name, position: 1 }])
  })

  test('deletion reloads the current item for pin cleanup', async () => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'stale')
    const item = await f.post(author, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    // The fixture's item snapshot predates the pin; deletion takes only its ID.
    await deleteItemByAuthor({ models: f.db, id: item.id })
    expect(await readTurfPins(f.db, item.id)).toEqual([])
    expect(await f.db.itemSub.count({ where: { itemId: item.id, pinPosition: { not: null } } })).toBe(0)
  })

  test('deleting a nonexistent item stays a no-op', async () => {
    await expect(deleteItemByAuthor({ models: f.db, id: 987654321 })).resolves.toBeUndefined()
  })

  test('deleting one of two pinned posts compacts the survivor', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'compact2')
    const [p1, p2] = await Promise.all([f.post(owner, [a]), f.post(owner, [a])])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: p1.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: p2.id, subName: a.name, pinned: true }, ctx)
    await deleteItemByAuthor({ models: f.db, id: p1.id })
    expect(await readTurfPins(f.db, p2.id)).toEqual([{ subName: a.name, position: 1 }])
  })

  test('ownership transfer keeps the pins and the old owner loses access', async () => {
    const owner = await f.user()
    const buyer = await f.user()
    const a = await f.sub(owner, 'transfer')
    const item = await f.post(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    await f.db.sub.update({ where: { id: a.id }, data: { userId: buyer.id } })
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: false }, { me: owner, models: f.db }))
      .rejects.toThrow('not your turf')
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    await setTurfPin({ id: item.id, subName: a.name, pinned: false }, { me: buyer, models: f.db })
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })

  test('a turf rename keeps the pin under the canonical new name', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'rename')
    const item = await f.post(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const newName = `${a.name}renamed`
    await f.db.$executeRaw`UPDATE "Sub" SET name = ${newName} WHERE id = ${a.id}::int`
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: newName, position: 1 }])
    // the old canonical name no longer resolves to a turf at all
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: false }, { me: owner, models: f.db }))
      .rejects.toThrow('turf not found')
    await setTurfPin({ id: item.id, subName: newName, pinned: false }, { me: owner, models: f.db })
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })

  test('a membership removal blocks on the item lock and applies after it frees', async () => {
    const { a, b, item, payIn } = await seedPinnedEverywhere()
    const other = new PrismaClient()
    extraClients.push(other)
    let updateResult
    await f.db.$transaction(async tx1 => {
      await tx1.$queryRaw`SELECT id FROM "Item" WHERE id = ${item.id} FOR UPDATE`
      // starts while the item row is locked; must queue on that lock, not
      // write through it
      updateResult = applyItemUpdate(f.db, payIn, {
        id: item.id, userId: item.userId, subNames: [a.name]
      })
      await tx1.$queryRaw`SELECT 1`
    })
    await updateResult
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    expect(await f.db.itemSub.count({
      where: { subName: b.name, pinPosition: { not: null } }
    })).toBe(0)
    await other.$disconnect()
  })

  test('two concurrent membership removals on different items of one turf both settle', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'concurrent')
    const b = await f.sub(owner, 'concurrentb')
    const [p1, p2] = await Promise.all([f.post(owner, [a, b]), f.post(owner, [a, b])])
    const payIn = await f.db.payIn.create({
      data: { userId: owner.id, payInType: 'ITEM_UPDATE', payInState: 'PAID', piconeros: 0n }
    })
    f.created.payIns.push(payIn.id)
    // interactive transactions so the turf locks actually hold across
    // statements (a bare client autocommits and proves nothing)
    const results = await Promise.allSettled([
      f.db.$transaction(tx => applyItemUpdate(tx, payIn, { id: p1.id, userId: owner.id, subNames: [b.name] })),
      f.db.$transaction(tx => applyItemUpdate(tx, payIn, { id: p2.id, userId: owner.id, subNames: [b.name] }))
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    expect(await f.db.itemSub.count({
      where: { subName: a.name, itemId: { in: [p1.id, p2.id] } }
    })).toBe(0)
  })

  test('a title-only update without subNames leaves memberships and pins alone', async () => {
    const { a, b, item, payIn } = await seedPinnedEverywhere()
    await applyItemUpdate(f.db, payIn, {
      id: item.id, userId: item.userId, title: 'renamed only'
    })
    const memberships = await f.db.itemSub.findMany({ where: { itemId: item.id } })
    expect(memberships.map(m => m.subName.toLowerCase()).sort())
      .toEqual([a.name.toLowerCase(), b.name.toLowerCase()])
    expect(await readTurfPins(f.db, item.id)).toEqual([
      { subName: a.name, position: 1 }, { subName: b.name, position: 1 }
    ])
  })

  test('concurrent edits can reference each other without conflicting with foreign-key checks', async () => {
    const authors = [await f.user(), await f.user()]
    const posts = await Promise.all(authors.map(author => f.post(author, [])))
    const payIns = await Promise.all(authors.map(author => f.db.payIn.create({
      data: { userId: author.id, payInType: 'ITEM_UPDATE', payInState: 'PAID', piconeros: 0n }
    })))
    f.created.payIns.push(...payIns.map(p => p.id))
    let arrived = 0
    let release
    const bothLocked = new Promise(resolve => { release = resolve })
    // Stub only the ESM markdown parser; ItemMention writes and FK locks are real.
    extractMentions.mockImplementation(text => ({ userNames: [], itemIds: [Number(text.split('/').pop())] }))
    try {
      const results = await Promise.allSettled(posts.map((post, index) => f.db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 3000')
        const proxied = new Proxy(tx, {
          get (target, prop, receiver) {
            if (prop === 'item') {
              return {
                ...target.item,
                findUnique: async args => {
                  const item = await target.item.findUnique(args)
                  if (++arrived === 2) release()
                  await bothLocked
                  return item
                }
              }
            }
            return Reflect.get(target, prop, receiver)
          }
        })
        return applyItemUpdate(proxied, payIns[index], {
          id: post.id, userId: post.userId, text: `https://stasher.news/items/${posts[1 - index].id}`
        })
      }, { timeout: 10000 })))
      expect(results.map(r => r.status === 'rejected' ? r.reason.message : r.status))
        .toEqual(['fulfilled', 'fulfilled'])
      const mentions = await f.db.itemMention.findMany({
        where: { referrerId: { in: posts.map(p => p.id) } }, select: { referrerId: true, refereeId: true }
      })
      expect(mentions).toHaveLength(2)
      expect(mentions).toEqual(expect.arrayContaining([
        { referrerId: posts[0].id, refereeId: posts[1].id },
        { referrerId: posts[1].id, refereeId: posts[0].id }
      ]))
    } finally {
      extractMentions.mockImplementation(() => ({ userNames: [], itemIds: [] }))
    }
  })

  test.each(['unpin', 'delete'])('%s does not deadlock an edit referencing its item', async action => {
    const { owner, a, b, item: target } = await seedPinnedEverywhere()
    const author = await f.user()
    const edited = await f.post(author, [a, b])
    let hasSub
    const subLocked = new Promise(resolve => { hasSub = resolve })
    let hasItem
    const itemLocked = new Promise(resolve => { hasItem = resolve })
    extractMentions.mockImplementation(() => ({ userNames: [], itemIds: [target.id] }))
    try {
      const edit = f.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${edited.id} FOR NO KEY UPDATE`
        await lockTurfRows(tx, [a.name])
        hasSub()
        await itemLocked
        return applyItemUpdate(tx, { piconeros: 0n }, {
          id: edited.id, userId: author.id, subNames: [b.name], text: `https://stasher.news/items/${target.id}`
        })
      }, { timeout: 10000 })
      await subLocked
      const models = {
        $transaction: fn => f.db.$transaction(tx => fn(new Proxy(tx, {
          get (db, prop, receiver) {
            if (prop === '$queryRaw') {
              return async (strings, ...values) => {
                const result = await db.$queryRaw(strings, ...values)
                if (/FROM "Item"[\s\S]*FOR (?:NO KEY )?UPDATE/.test(strings.join(''))) hasItem()
                return result
              }
            }
            return Reflect.get(db, prop, receiver)
          }
        })), { timeout: 10000 })
      }
      const write = action === 'unpin'
        ? setTurfPin({ id: target.id, subName: a.name, pinned: false }, { me: owner, models })
        : deleteItemByAuthor({ id: target.id, models })
      const results = await Promise.allSettled([edit, write])
      expect(results.map(r => r.status === 'rejected' ? r.reason.message : r.status))
        .toEqual(['fulfilled', 'fulfilled'])
      expect(await f.db.itemMention.count({ where: { referrerId: edited.id, refereeId: target.id } })).toBe(1)
    } finally {
      extractMentions.mockImplementation(() => ({ userNames: [], itemIds: [] }))
    }
  })

  test('two opposite turf swaps lock the shared turfs in one order and both settle', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'swapa')
    const b = await f.sub(owner, 'swapb')
    const payIn = await f.db.payIn.create({
      data: { userId: owner.id, payInType: 'ITEM_UPDATE', payInState: 'PAID', piconeros: 0n }
    })
    f.created.payIns.push(payIn.id)
    const p1 = await f.post(owner, [a])
    const p2 = await f.post(owner, [b])
    createdSwapItems.push(p1.id, p2.id)
    // p1: a→b while p2: b→a — opposite orders over the same two turf rows
    const results = await Promise.allSettled([
      f.db.$transaction(tx => applyItemUpdate(tx, payIn, { id: p1.id, userId: owner.id, subNames: [b.name] })),
      f.db.$transaction(tx => applyItemUpdate(tx, payIn, { id: p2.id, userId: owner.id, subNames: [a.name] }))
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    expect(await f.db.itemSub.findMany({ where: { itemId: p1.id } }).then(rows => rows.map(r => r.subName)))
      .toEqual([b.name])
    expect(await f.db.itemSub.findMany({ where: { itemId: p2.id } }).then(rows => rows.map(r => r.subName)))
      .toEqual([a.name])
  })
})
