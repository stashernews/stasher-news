/* eslint-env jest */
import { graphql } from 'graphql'
import { makeExecutableSchema } from '@graphql-tools/schema'
import typeDefs from '@/api/typeDefs'
import itemResolvers from '@/api/resolvers/item'
import { setTurfPin, readTurfPins } from '@/api/turf-pins'
import { turfPinFixture } from '../helpers/turf-pins'

jest.mock('../../lib/lexical/server/html', () => ({ lexicalHTMLGenerator: async () => '' }))
jest.mock('../../lib/lexical/server/mentions', () => ({ extractMentions: () => ({ userNames: [], itemIds: [] }) }))

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('core turf pins', () => {
  let f
  beforeAll(() => { f = turfPinFixture() })
  afterAll(() => f.cleanup())
  const ctx = (me = null) => ({
    me,
    models: f.db,
    userLoader: { load: async () => ({ nsfwMode: false }) },
    subLoader: { load: async name => ({ name, postsPiconerosFilter: -100000000000n }) }
  })
  const feed = (sub, me = null, extra = {}) => itemResolvers.Query.items(null,
    { sort: 'lit', type: 'posts', limit: 21, sub: sub.name, ...extra }, ctx(me))

  test('ownership, per-turf isolation and desired-state retries', async () => {
    const aOwner = await f.user()
    const bOwner = await f.user()
    const a = await f.sub(aOwner, 'a')
    const b = await f.sub(bOwner, 'b')
    const item = await f.post(aOwner, [a, b])
    const pin = { id: item.id, subName: a.name, pinned: true }
    await expect(setTurfPin(pin, ctx())).rejects.toThrow()
    await expect(setTurfPin(pin, ctx(bOwner))).rejects.toThrow('not your turf')
    await setTurfPin(pin, ctx(aOwner))
    await setTurfPin(pin, ctx(aOwner))
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    expect((await feed(a)).pins.map(i => i.id)).toContain(item.id)
    const other = await feed(b)
    expect(other.pins).toEqual([])
    expect(other.items.map(i => i.id)).toContain(item.id)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctx(bOwner))
    await setTurfPin({ ...pin, pinned: false }, ctx(aOwner))
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: b.name, position: 1 }])
    const elsewhere = await f.sub(aOwner, 'elsewhere')
    await expect(setTurfPin({ ...pin, subName: elsewhere.name }, ctx(aOwner))).rejects.toThrow('post is not in this turf')
  })

  test('concurrent additions respect capacity and unpin compacts positions', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'cap')
    const posts = await Promise.all(Array.from({ length: 7 }, () => f.post(owner, [a])))
    const pin = item => setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx(owner))
    for (const item of posts.slice(0, 5)) await pin(item)
    const results = await Promise.allSettled(posts.slice(5).map(pin))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected').reason.message).toBe('max 6 pins allowed')
    await setTurfPin({ id: posts[1].id, subName: a.name, pinned: false }, ctx(owner))
    const rows = await f.db.itemSub.findMany({ where: { subName: a.name, pinPosition: { not: null } }, orderBy: { pinPosition: 'asc' } })
    expect(rows.map(r => r.pinPosition)).toEqual([1, 2, 3, 4, 5])
  })

  test.each([
    { status: 'STOPPED' },
    { feeStatus: 'PENDING_FEE' },
    { bountyPiconeros: 1000n, bountyStatus: 'UNFUNDED' },
    { bountyPiconeros: 1000n, bountyStatus: 'PENDING_FUNDING' },
    { bountyPiconeros: 1000n, bountyStatus: 'DETECTED' }
  ])('pins cannot bypass visibility (case %#)', async data => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'visibility')
    const item = await f.post(author, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx(owner))
    await f.db.item.update({ where: { id: item.id }, data })
    for (const viewer of [null, owner]) {
      const result = await feed(a, viewer)
      expect(result.pins.map(i => i.id)).not.toContain(item.id)
      expect(result.items.map(i => i.id)).not.toContain(item.id)
    }
    expect((await feed(a, author)).pins.map(i => i.id)).toContain(item.id)
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx(owner))).rejects.toThrow('post is not live')
    await setTurfPin({ id: item.id, subName: a.name, pinned: false }, ctx(owner))
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })

  test('paid-post filter applies to pins too', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'payment')
    const item = await f.post(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx(owner))
    await f.db.itemPayIn.deleteMany({ where: { itemId: item.id } })
    const result = await feed(a)
    expect(result.pins.map(i => i.id)).not.toContain(item.id)
    expect(result.items.map(i => i.id)).not.toContain(item.id)
  })

  test('pin injection does not duplicate organic results or later pages', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'pages')
    const posts = await Promise.all(Array.from({ length: 24 }, () => f.post(owner, [a])))
    await setTurfPin({ id: posts[0].id, subName: a.name, pinned: true }, ctx(owner))
    const first = await feed(a)
    expect(first.pins.map(i => i.id)).toEqual([posts[0].id])
    expect(first.items.map(i => i.id)).not.toContain(posts[0].id)
    expect(first.cursor).not.toBeNull()
    const next = await feed(a, null, { cursor: first.cursor })
    expect(next.pins).toBeUndefined()
    expect(next.items.map(i => i.id)).not.toContain(posts[0].id)
  })

  test.each(['setTurfPin', 'pinItem'])('%s returns a usable GraphQL Item', async mutation => {
    const owner = await f.user()
    const a = await f.sub(owner, 'graphql')
    const item = await f.post(owner, [a])
    const schema = makeExecutableSchema({ typeDefs, resolvers: itemResolvers })
    const args = `id: "${item.id}"${mutation === 'setTurfPin' ? `, subName: "${a.name}", pinned: true` : ''}`
    const result = await graphql({ schema, source: `mutation { ${mutation}(${args}) { id status text turfPins { subName position } } }`, contextValue: ctx(owner) })
    expect(result.errors).toBeUndefined()
    expect(result.data[mutation].status).toBe('ACTIVE')
    expect(result.data[mutation].text).toBe('body')
    expect(result.data[mutation].turfPins).toEqual([{ subName: a.name, position: 1 }])
  })

  test('successful unpin does not disclose hidden content', async () => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'hidden')
    const item = await f.post(author, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx(owner))
    await f.db.item.update({ where: { id: item.id }, data: { feeStatus: 'PENDING_FEE' } })
    const schema = makeExecutableSchema({ typeDefs, resolvers: itemResolvers })
    const result = await graphql({ schema, source: `mutation { setTurfPin(id: "${item.id}", subName: "${a.name}", pinned: false) { id text } }`, contextValue: ctx(owner) })
    expect(result.errors).toBeUndefined()
    expect(result.data.setTurfPin).toBeNull()
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })
})
