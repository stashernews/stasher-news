/* eslint-env jest */
// Real-DB behavior of api/turf-pins.js: authorization, per-membership
// independence, the six-pin cap under concurrency, idempotency, normalization,
// rollback, and the legacy single-turf compatibility toggle.
//
//   DATABASE_URL='postgresql://sn:changeme@127.0.0.1:5431/stasher_turf_pins_test?schema=public' \
//     npm test -- --runInBand --runTestsByPath test/api/turf-pins.test.js
import { turfPinFixture } from '../helpers/turf-pins'
import {
  setTurfPin, toggleSingleTurfPin, readTurfPins, clearItemTurfPins, normalizeTurfPins
} from '@/api/turf-pins'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('turf pin service (isolated DB)', () => {
  // created in beforeAll: jest runs describe bodies even when skipped, and the
  // fixture refuses any database but the dedicated one
  let f
  beforeAll(() => { f = turfPinFixture() })

  afterAll(async () => {
    await f.cleanup()
  })

  test('one owner can independently manage two memberships of one post', async () => {
    const owner = await f.user()
    const author = await f.user()
    const a = await f.sub(owner, 'a')
    const b = await f.sub(owner, 'b')
    const item = await f.post(author, [a, b])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctx)
    await setTurfPin({ id: item.id, subName: a.name, pinned: false }, ctx)
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: b.name, position: 1 }])
    expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBeNull()
  })

  test('two owners manage the same post independently', async () => {
    const ownerA = await f.user()
    const ownerB = await f.user()
    const a = await f.sub(ownerA, 'owna')
    const b = await f.sub(ownerB, 'ownb')
    const item = await f.post(ownerA, [a, b])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: ownerA, models: f.db })
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    // owner B pins their own turf and unpins owner A's turf
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, { me: ownerB, models: f.db })
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: false }, { me: ownerB, models: f.db }))
      .rejects.toThrow('not your turf')
    expect(await readTurfPins(f.db, item.id)).toEqual([
      { subName: a.name, position: 1 }, { subName: b.name, position: 1 }
    ])
  })

  test('two concurrent additions cannot occupy a seventh slot', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'cap')
    const posts = await Promise.all(Array.from({ length: 7 }, () => f.post(owner, [a])))
    const ctx = { me: owner, models: f.db }
    for (const item of posts.slice(0, 5)) {
      await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)
    }
    const results = await Promise.allSettled(posts.slice(5).map(item =>
      setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')[0].reason.message).toBe('max 6 pins allowed')
    const rows = await f.db.itemSub.findMany({
      where: { subName: a.name, pinPosition: { not: null } }, orderBy: { pinPosition: 'asc' }
    })
    expect(rows.map(r => r.pinPosition)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('repeating the same desired state neither reorders nor moves positions', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'idem')
    const first = await f.post(owner, [a])
    const second = await f.post(owner, [a])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: first.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: second.id, subName: a.name, pinned: true }, ctx)
    const before = await f.db.itemSub.findMany({
      where: { subName: a.name, pinPosition: { not: null } }, orderBy: { pinPosition: 'asc' }
    })
    await setTurfPin({ id: second.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: first.id, subName: a.name, pinned: true }, ctx)
    const after = await f.db.itemSub.findMany({
      where: { subName: a.name, pinPosition: { not: null } }, orderBy: { pinPosition: 'asc' }
    })
    expect(after.map(r => [r.itemId, r.pinPosition])).toEqual(before.map(r => [r.itemId, r.pinPosition]))
    // a pinned post at capacity unpinning and re-pinning stays at position 2
    await setTurfPin({ id: second.id, subName: a.name, pinned: false }, ctx)
    await setTurfPin({ id: second.id, subName: a.name, pinned: true }, ctx)
    expect((await readTurfPins(f.db, second.id))[0].position).toBe(2)
  })

  test('unpinning the middle pin compacts and the next pin appends densely', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'compact')
    const [p1, p2, p3] = await Promise.all([
      f.post(owner, [a]), f.post(owner, [a]), f.post(owner, [a])
    ])
    const ctx = { me: owner, models: f.db }
    for (const p of [p1, p2, p3]) {
      await setTurfPin({ id: p.id, subName: a.name, pinned: true }, ctx)
    }
    await setTurfPin({ id: p2.id, subName: a.name, pinned: false }, ctx)
    const fourth = await f.post(owner, [a])
    await setTurfPin({ id: fourth.id, subName: a.name, pinned: true }, ctx)
    expect(await readTurfPins(f.db, p1.id)).toEqual([{ subName: a.name, position: 1 }])
    expect(await readTurfPins(f.db, p2.id)).toEqual([])
    expect(await readTurfPins(f.db, p3.id)).toEqual([{ subName: a.name, position: 2 }])
    expect(await readTurfPins(f.db, fourth.id)).toEqual([{ subName: a.name, position: 3 }])
  })

  test('a deleted membership item is compacted out of the turf pin order', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'sweep')
    const [p1, p2] = await Promise.all([f.post(owner, [a]), f.post(owner, [a])])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: p1.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: p2.id, subName: a.name, pinned: true }, ctx)
    await f.db.item.update({ where: { id: p1.id }, data: { deletedAt: new Date() } })
    await normalizeTurfPins(f.db, [a.name])
    expect(await readTurfPins(f.db, p1.id)).toEqual([])
    expect(await readTurfPins(f.db, p2.id)).toEqual([{ subName: a.name, position: 1 }])
  })

  test('a normalization failure rolls the whole pin back', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'rollback')
    const item = await f.post(owner, [a])
    const payInsBefore = await f.db.payIn.count()
    const brokenModels = {
      $transaction: (fn, opts) => f.db.$transaction(async tx => {
        const proxied = new Proxy(tx, {
          get (target, prop, receiver) {
            if (prop === '$queryRaw') {
              return (strings, ...values) => {
                if (strings.join('').includes('ROW_NUMBER')) {
                  return Promise.reject(new Error('injected normalization failure'))
                }
                return target.$queryRaw(strings, ...values)
              }
            }
            return Reflect.get(target, prop, receiver)
          }
        })
        return fn(proxied)
      }, opts)
    }
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: brokenModels }))
      .rejects.toThrow('injected normalization failure')
    expect(await readTurfPins(f.db, item.id)).toEqual([])
    expect(await f.db.payIn.count()).toBe(payInsBefore)
  })

  test('pin writes change no money rows or post content', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'money')
    const item = await f.post(owner, [a])
    const before = await f.db.item.findUnique({ where: { id: item.id } })
    const payInsBefore = await f.db.payIn.count()
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const after = await f.db.item.findUnique({ where: { id: item.id } })
    expect(after.piconeros).toBe(before.piconeros)
    expect(after.title).toBe(before.title)
    expect(after.text).toBe(before.text)
    expect(after.pinId).toBeNull()
    expect(await f.db.payIn.count()).toBe(payInsBefore)
  })

  test('adding requires a live post; removing works on an inactive one', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'live')
    const item = await f.post(owner, [a])
    const ctx = { me: owner, models: f.db }
    await f.db.item.update({ where: { id: item.id }, data: { status: 'STOPPED' } })
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx))
      .rejects.toThrow('post is not live')
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx).catch(() => {})
    await f.db.item.update({ where: { id: item.id }, data: { status: 'ACTIVE', feeStatus: 'PENDING_FEE' } })
    await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx))
      .rejects.toThrow('post is not live')
  })

  test('case-variant turf names resolve to the canonical row', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'citext')
    const item = await f.post(owner, [a])
    const result = await setTurfPin(
      { id: item.id, subName: a.name.toUpperCase(), pinned: true },
      { me: owner, models: f.db }
    )
    expect(result.turfPins).toEqual([{ subName: a.name, position: 1 }])
  })

  describe('authorization and input guards', () => {
    const setup = async () => {
      const owner = await f.user()
      const author = await f.user()
      const other = await f.user()
      const a = await f.sub(owner, 'guard')
      const b = await f.sub(owner, 'guardb')
      const item = await f.post(author, [a])
      return { owner, author, other, a, b, item }
    }

    test('rejects an anonymous caller', async () => {
      const { a, item } = await setup()
      await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: null, models: f.db }))
        .rejects.toThrow()
    })

    test('rejects a non-owner', async () => {
      const { other, a, item } = await setup()
      await expect(setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: other, models: f.db }))
        .rejects.toThrow('not your turf')
    })

    test('rejects an owned turf the post is not in', async () => {
      const { owner, b, item } = await setup()
      await expect(setTurfPin({ id: item.id, subName: b.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('post is not in this turf')
    })

    test('rejects a missing post and a deleted post', async () => {
      const { owner, a } = await setup()
      await expect(setTurfPin({ id: 999999999, subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('item not found')
      const deleted = await f.post(owner, [a])
      await f.db.item.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
      await expect(setTurfPin({ id: deleted.id, subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('item not found')
    })

    test('rejects a missing turf', async () => {
      const { owner, item } = await setup()
      await expect(setTurfPin({ id: item.id, subName: 'pinnosuchturf', pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('turf not found')
    })

    test('rejects comments and bios', async () => {
      const { owner, a, item } = await setup()
      const reply = await f.db.item.create({
        data: { userId: item.userId, parentId: item.id, text: 'reply' }
      })
      await expect(setTurfPin({ id: reply.id, subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('only turf posts can be pinned')
      const bio = await f.db.item.create({
        data: { userId: item.userId, bio: true, text: 'bio' }
      })
      await expect(setTurfPin({ id: bio.id, subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('only turf posts can be pinned')
    })

    test('rejects invalid ids and non-boolean desired state', async () => {
      const { owner, a, item } = await setup()
      await expect(setTurfPin({ id: 'not-a-number', subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('item id')
      await expect(setTurfPin({ id: -3, subName: a.name, pinned: true }, { me: owner, models: f.db }))
        .rejects.toThrow('item id')
      await expect(setTurfPin({ id: item.id, subName: a.name }, { me: owner, models: f.db }))
        .rejects.toThrow('pinned must be a boolean')
      await expect(setTurfPin({ id: item.id, subName: a.name, pinned: 'yes' }, { me: owner, models: f.db }))
        .rejects.toThrow('pinned must be a boolean')
    })
  })

  describe('toggleSingleTurfPin compatibility', () => {
    test('toggles the single membership without touching the legacy pin link', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'solo')
      const item = await f.post(owner, [a])
      const ctx = { me: owner, models: f.db }
      await toggleSingleTurfPin({ id: item.id }, ctx)
      expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
      await toggleSingleTurfPin({ id: item.id }, ctx)
      expect(await readTurfPins(f.db, item.id)).toEqual([])
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBeNull()
    })

    test('rejects a post with more than one membership', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'multi1')
      const b = await f.sub(owner, 'multi2')
      const item = await f.post(owner, [a, b])
      await expect(toggleSingleTurfPin({ id: item.id }, { me: owner, models: f.db }))
        .rejects.toThrow('use setTurfPin with a turf name')
    })
  })

  test('clearItemTurfPins clears only the named memberships and compacts', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'cleara')
    const b = await f.sub(owner, 'clearb')
    const item = await f.post(owner, [a, b])
    const ctx = { me: owner, models: f.db }
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, ctx)
    await setTurfPin({ id: item.id, subName: b.name, pinned: true }, ctx)
    await clearItemTurfPins(f.db, { id: item.id, subNames: [a.name] })
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: b.name, position: 1 }])
    // no-op for an empty name list
    await clearItemTurfPins(f.db, { id: item.id, subNames: [] })
    expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: b.name, position: 1 }])
  })

  test('readTurfPins returns [] for comments and deleted posts', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'read')
    const item = await f.post(owner, [a])
    await setTurfPin({ id: item.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
    const reply = await f.db.item.create({
      data: { userId: item.userId, parentId: item.id, text: 'reply' }
    })
    expect(await readTurfPins(f.db, reply.id)).toEqual([])
    await f.db.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
    expect(await readTurfPins(f.db, item.id)).toEqual([])
  })
})

// The guard suite (non-isolated environments) still asserts the service module
// exists and its public surface is importable without a database.
;(isolated ? describe.skip : describe)('turf pin service module surface', () => {
  test('exports the public pin operations', async () => {
    const mod = await import('@/api/turf-pins')
    for (const name of ['setTurfPin', 'toggleSingleTurfPin', 'lockTurfRows', 'normalizeTurfPins', 'clearItemTurfPins', 'readTurfPins']) {
      expect(typeof mod[name]).toBe('function')
    }
  })
})
