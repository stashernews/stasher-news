/* eslint-env jest */
// Real-DB feed behavior for turf pins: a turf's pins are injected only into
// that turf's feed, excluded from its ordinary list, and invisible to other
// turfs (including the same post pinned elsewhere). Global (no-turf) pins,
// sort variants, and metadata completeness are pinned here too.
//
//   DATABASE_URL='postgresql://sn:changeme@127.0.0.1:5431/stasher_turf_pins_test?schema=public' \
//     npm test -- --runInBand --runTestsByPath test/api/turf-pin-feeds.test.js
import { turfPinFixture } from '../helpers/turf-pins'
import { setTurfPin, readTurfPins } from '@/api/turf-pins'
import itemResolvers from '@/api/resolvers/item'

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))
// ESM-only transitive dep of the payIn barrel (mdast-util-from-markdown)
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('turf pin feeds (isolated DB)', () => {
  // created in beforeAll: jest runs describe bodies even when skipped, and the
  // fixture refuses any database but the dedicated one
  let f
  beforeAll(() => { f = turfPinFixture() })

  afterAll(async () => {
    await f.cleanup()
  })

  // seedPost keeps a paid ITEM_CREATE so the payInJoinFilter admits the post.
  const seedPost = async (author, subs, { pay = true } = {}) => {
    const item = await f.db.item.create({
      data: {
        userId: author.id,
        title: 'turf pin feed test',
        text: 'body',
        subs: { create: subs.map(s => ({ subName: s.name })) }
      }
    })
    f.created.items.push(item.id)
    if (pay) {
      const payment = await f.db.payIn.create({
        data: { userId: author.id, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
      })
      f.created.payIns.push(payment.id)
      await f.db.itemPayIn.create({ data: { itemId: item.id, payInId: payment.id } })
    }
    return item
  }

  const ctx = (me = null) => ({
    me,
    models: f.db,
    userLoader: { load: async () => ({ nsfwMode: false }) },
    subLoader: { load: async name => ({ name, postsPiconerosFilter: -100000000000n }) }
  })
  const args = { sort: 'lit', type: 'posts', limit: 21 }

  test('alpha pins neither promote nor remove the post in beta', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fa')
    const b = await f.sub(owner, 'fb')
    const item = await seedPost(owner, [a, b])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const alpha = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    const beta = await itemResolvers.Query.items(null, { ...args, sub: b.name }, ctx())
    expect(alpha.pins.map(i => i.id)).toContain(item.id)
    expect(alpha.items.map(i => i.id)).not.toContain(item.id)
    expect(beta.pins.map(i => i.id)).not.toContain(item.id)
    expect(beta.items.map(i => i.id)).toContain(item.id)
    // metadata travels with every returned post
    const betaCopy = beta.items.find(i => i.id === item.id)
    expect(betaCopy.turfPins).toEqual([{ subName: a.name, position: 1 }])
    // the injected pin copy carries the same metadata
    const alphaCopy = alpha.pins.find(i => i.id === item.id)
    expect(alphaCopy.turfPins).toEqual([{ subName: a.name, position: 1 }])
  })

  test('the same owner pinning both turfs injects both feeds independently', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fa2')
    const b = await f.sub(owner, 'fb2')
    const item = await seedPost(owner, [a, b])
    const ctxOwn = { me: owner, models: f.db }
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctxOwn)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctxOwn)
    const alpha = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    const beta = await itemResolvers.Query.items(null, { ...args, sub: b.name }, ctx())
    expect(alpha.pins.map(i => i.id)).toContain(item.id)
    expect(beta.pins.map(i => i.id)).toContain(item.id)
    await setTurfPin({ id: item.id, subName: b.name, pinned: false }, ctxOwn)
    const betaAfter = await itemResolvers.Query.items(null, { ...args, sub: b.name }, ctx())
    expect(betaAfter.pins.map(i => i.id)).not.toContain(item.id)
    expect(betaAfter.items.map(i => i.id)).toContain(item.id)
  })

  test('turf pins follow pinPosition order and stay off later ordinary pages', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'forder')
    const [p1, p2] = await Promise.all([seedPost(owner, [a]), seedPost(owner, [a])])
    // more than one page of ordinary posts so a real page 2 exists
    await Promise.all(Array.from({ length: 23 }, () => seedPost(owner, [a])))
    await setTurfPin({ id: p2.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    await setTurfPin({ id: p1.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const first = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    expect(first.pins.map(i => i.id)).toEqual([p2.id, p1.id])
    expect(first.items.map(i => i.id)).not.toContain(p1.id)
    expect(first.cursor).not.toBeNull()
    // page 2: pins are not injected again, and the pinned posts are excluded
    const second = await itemResolvers.Query.items(
      null, { ...args, sub: a.name, cursor: first.cursor }, ctx()
    )
    expect(second.pins).toBeUndefined()
    expect(second.items.map(i => i.id)).not.toContain(p1.id)
    expect(second.items.map(i => i.id)).not.toContain(p2.id)
  })

  test('new and top sorts keep the pinned post in the ordinary list', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fnew')
    const item = await seedPost(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    for (const sort of ['new', 'top']) {
      const feed = await itemResolvers.Query.items(null, { sort, type: 'posts', limit: 21, sub: a.name }, ctx())
      expect(feed.pins ?? []).toEqual([])
      expect(feed.items.map(i => i.id)).toContain(item.id)
    }
  })

  test('a post that fails the payment filter is invisible everywhere, pins included', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fpay')
    const item = await seedPost(owner, [a], { pay: false })
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const feed = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    expect(feed.pins.map(i => i.id)).not.toContain(item.id)
    expect(feed.items.map(i => i.id)).not.toContain(item.id)
  })

  test('a deleted pinned post leaves the pins list', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fdel')
    const item = await seedPost(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const before = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    expect(before.pins.map(i => i.id)).toContain(item.id)
    await f.db.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
    const after = await itemResolvers.Query.items(null, { ...args, sub: a.name }, ctx())
    expect(after.pins.map(i => i.id)).not.toContain(item.id)
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })

  test('the home feed does not acquire turf pins', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'fhome')
    const item = await seedPost(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const home = await itemResolvers.Query.items(null, { ...args }, ctx())
    expect((home.pins ?? []).map(i => i.id)).not.toContain(item.id)
    // ordinary home list still shows the post (home only excludes global pins)
    expect(home.items.map(i => i.id)).toContain(item.id)
  })
})
