/* eslint-env jest */
// Real-DB behavior for turf pins stored on the ItemSub membership:
// the membership denormalization trigger must stay scoped to membership
// identity columns (so a pin-position write never touches the parent Item
// row or its locks), and the position column enforces positive-or-null.
//
//   DATABASE_URL='postgresql://sn:changeme@127.0.0.1:5431/stasher_turf_pins_test?schema=public' \
//     npm test -- --runInBand --runTestsByPath test/prisma/turf-pins.migration.test.js
import { PrismaClient } from '@prisma/client'
import { turfPinFixture } from '../helpers/turf-pins'
import { backfillTurfPins } from '../../scripts/backfill-turf-pins'
import { setTurfPin, readTurfPins } from '@/api/turf-pins'

// Never point these write/trigger checks at the shared development database.
const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('ItemSub membership pins (isolated DB)', () => {
  // created in beforeAll: jest runs describe bodies even when skipped, and the
  // fixture refuses any database but the dedicated one
  let f
  beforeAll(() => { f = turfPinFixture() })
  const extraClients = []

  afterAll(async () => {
    for (const client of extraClients) await client.$disconnect().catch(() => {})
    await f.cleanup()
  })

  const secondClient = () => {
    const client = new PrismaClient()
    extraClients.push(client)
    return client
  }

  // A legacy-style pin row plus the Item.pinId link, tracked for cleanup.
  const seedLegacyPin = async (item, { position = 1, cron = null, timezone = null } = {}) => {
    const pin = await f.db.pin.create({ data: { position, cron, timezone } })
    f.created.pins.push(pin.id)
    await f.db.item.update({ where: { id: item.id }, data: { pinId: pin.id } })
    return pin
  }

  test('the membership denormalization trigger only fires on membership identity writes', async () => {
    const defs = await f.db.$queryRaw`
      SELECT pg_get_triggerdef(oid) AS def
      FROM pg_trigger
      WHERE tgrelid = '"ItemSub"'::regclass AND tgname = 'item_subnames'`
    expect(defs).toHaveLength(1)
    expect(defs[0].def).toMatch(/UPDATE OF "itemId", "subName"/)
  })

  test('a pin-position write does not rewrite the parent item', async () => {
    const owner = await f.user()
    const turf = await f.sub(owner, 'trigger')
    const item = await f.post(owner, [turf])
    const before = await f.db.item.findUnique({ where: { id: item.id } })
    await f.db.$executeRaw`
      UPDATE "ItemSub" SET "pinPosition" = 1 WHERE "itemId" = ${item.id}`
    const after = await f.db.item.findUnique({ where: { id: item.id } })
    expect(after.subNames).toEqual(before.subNames)
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  test('a position-only update completes while another transaction holds the parent item lock', async () => {
    const owner = await f.user()
    const turf = await f.sub(owner, 'lock')
    const item = await f.post(owner, [turf])
    const other = secondClient()
    await f.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT id FROM "Item" WHERE id = ${item.id} FOR UPDATE`
      await other.$transaction(async otx => {
        await otx.$executeRawUnsafe('SET LOCAL statement_timeout = 2000')
        await otx.$executeRaw`
          UPDATE "ItemSub" SET "pinPosition" = 1
          WHERE "itemId" = ${item.id} AND "subName" = ${turf.name}`
      })
    })
    const [row] = await f.db.itemSub.findMany({ where: { itemId: item.id } })
    expect(row.pinPosition).toBe(1)
  })

  test('pinPosition allows null and positive values and rejects zero or negative', async () => {
    const owner = await f.user()
    const turf = await f.sub(owner, 'check')
    const item = await f.post(owner, [turf])
    await expect(f.db.$executeRaw`
      UPDATE "ItemSub" SET "pinPosition" = 1 WHERE "itemId" = ${item.id}`).resolves.toBe(1)
    await expect(f.db.$executeRaw`
      UPDATE "ItemSub" SET "pinPosition" = 0 WHERE "itemId" = ${item.id}`)
      .rejects.toThrow(/ItemSub_pinPosition_positive/)
    await expect(f.db.$executeRaw`
      UPDATE "ItemSub" SET "pinPosition" = -2 WHERE "itemId" = ${item.id}`)
      .rejects.toThrow(/ItemSub_pinPosition_positive/)
    await expect(f.db.$executeRaw`
      UPDATE "ItemSub" SET "pinPosition" = NULL WHERE "itemId" = ${item.id}`).resolves.toBe(1)
  })

  test('membership identity writes still denormalize Item.subNames', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'denorma')
    const b = await f.sub(owner, 'denormb')
    const item = await f.post(owner, [a])

    await f.db.itemSub.create({ data: { itemId: item.id, subName: b.name } })
    let row = await f.db.item.findUnique({ where: { id: item.id } })
    expect(row.subNames.sort()).toEqual([a.name, b.name].sort())

    const renamedName = `pin${f.tag}denormc`
    await f.db.$executeRaw`UPDATE "Sub" SET name = ${renamedName} WHERE id = ${b.id}::int`
    row = await f.db.item.findUnique({ where: { id: item.id } })
    expect(row.subNames.sort()).toEqual([a.name, renamedName].sort())

    await f.db.itemSub.delete({
      where: { itemId_subName: { itemId: item.id, subName: renamedName } }
    })
    row = await f.db.item.findUnique({ where: { id: item.id } })
    expect(row.subNames).toEqual([a.name])
  })

  describe('legacy pin backfill', () => {
    const seedPost = async (owner, subs) => {
      const item = await f.post(owner, subs)
      await f.db.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
      return item
    }

    test('check writes nothing; apply migrates a single-turf legacy pin and clears only its link', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf1')
      const item = await seedPost(owner, [a])
      const pin = await seedLegacyPin(item, { position: 3 })

      const report = await backfillTurfPins(f.db, { mapping: {}, apply: false })
      expect(report.candidates.map(c => c.itemId)).toContain(String(item.id))
      expect(report.autoMapped).toBe(1)
      expect(await f.db.itemSub.findMany({ where: { itemId: item.id, pinPosition: { not: null } } }))
        .toEqual([])
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBe(pin.id)

      const applied = await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBeNull()
      // the legacy Pin row itself is retained for history/repin references
      expect(await f.db.pin.findUnique({ where: { id: pin.id } })).not.toBeNull()
      expect(applied.promoted).toBeGreaterThanOrEqual(1)

      const second = await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect(second.promoted).toBe(0)
      expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    })

    test('an ambiguous legacy pin is not silently copied into every turf', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf2a')
      const b = await f.sub(owner, 'bf2b')
      const item = await seedPost(owner, [a, b])
      await seedLegacyPin(item, { position: 1 })
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/ambiguous/)
      expect(await f.db.itemSub.count({ where: { itemId: item.id, pinPosition: { not: null } } })).toBe(0)
      await backfillTurfPins(f.db, { mapping: { [item.id]: a.name }, apply: true })
      expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    })

    test('an explicit mapping to a turf the post is not in is rejected', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf3a')
      const elsewhere = await f.sub(owner, 'bf3x')
      const item = await seedPost(owner, [a])
      await seedLegacyPin(item)
      await expect(backfillTurfPins(f.db, { mapping: { [item.id]: elsewhere.name }, apply: true }))
        .rejects.toThrow(/mapping/)
    })

    test('a legacy pin shared by two live turf posts blocks the backfill', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf4')
      const [p1, p2] = await Promise.all([seedPost(owner, [a]), seedPost(owner, [a])])
      const pin = await f.db.pin.create({ data: { position: 1 } })
      f.created.pins.push(pin.id)
      await f.db.item.updateMany({ where: { id: { in: [p1.id, p2.id] } }, data: { pinId: pin.id } })
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/shared/)
      // clear the seeded legacy links so later tests see a clean field
      await f.db.item.updateMany({ where: { id: { in: [p1.id, p2.id] } }, data: { pinId: null } })
    })

    test('a scheduled legacy pin blocks the backfill', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf5')
      const item = await seedPost(owner, [a])
      await seedLegacyPin(item, { cron: '0 0 * * *', timezone: 'UTC' })
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/scheduled/)
      await f.db.item.update({ where: { id: item.id }, data: { pinId: null } })
    })

    test('a queued repin job for a turf pin blocks the backfill', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf6')
      const item = await seedPost(owner, [a])
      const pin = await seedLegacyPin(item)
      const [job] = await f.db.$queryRaw`
        INSERT INTO pgboss.job (name, state) VALUES (${'repin-' + pin.id}, 'created')
        RETURNING id`
      try {
        await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
          .rejects.toThrow(/repin job/)
      } finally {
        await f.db.$executeRaw`DELETE FROM pgboss.job WHERE id = ${job.id}::uuid`
        await f.db.item.update({ where: { id: item.id }, data: { pinId: null } })
      }
    })

    test('a scalar subNames and membership disagreement blocks the backfill', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf7')
      const item = await seedPost(owner, [a])
      await seedLegacyPin(item)
      await f.db.$executeRaw`UPDATE "Item" SET "subNames" = '{}'::CITEXT[] WHERE id = ${item.id}`
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/membership/)
      // restore the denormalized name and clear the seeded legacy link
      await f.db.$executeRaw`UPDATE "Item" SET "subNames" = ${[a.name]}::CITEXT[] WHERE id = ${item.id}`
      await f.db.item.update({ where: { id: item.id }, data: { pinId: null } })
    })

    test('destinations that would exceed six pins block the backfill', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf8')
      const holder = []
      for (let i = 0; i < 5; i++) {
        const p = await seedPost(owner, [a])
        await setTurfPin({ id: p.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
        holder.push(p)
      }
      const [l1, l2] = await Promise.all([seedPost(owner, [a]), seedPost(owner, [a])])
      await seedLegacyPin(l1, { position: 2 })
      await seedLegacyPin(l2, { position: 5 })
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/6 pins/)
      expect(await f.db.itemSub.count({ where: { subName: a.name, pinPosition: { not: null } } })).toBe(5)

      // removing one new-style pin leaves room for both, ordered by legacy position
      await setTurfPin({ id: holder[0].id, subName: a.name, pinned: false }, { me: owner, models: f.db })
      await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect(await readTurfPins(f.db, l1.id)).toEqual([{ subName: a.name, position: 5 }])
      expect(await readTurfPins(f.db, l2.id)).toEqual([{ subName: a.name, position: 6 }])
    })

    test('a deleted legacy post is skipped for promotion and its link cleared on apply', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf9')
      const item = await seedPost(owner, [a])
      const pin = await seedLegacyPin(item)
      await f.db.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
      const report = await backfillTurfPins(f.db, { mapping: {}, apply: false })
      expect(report.candidates.map(c => c.itemId)).not.toContain(String(item.id))
      await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBeNull()
      expect(await f.db.pin.findUnique({ where: { id: pin.id } })).not.toBeNull()
    })

    test('reply and global legacy pins are untouched', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf10')
      const post = await seedPost(owner, [a])
      const reply = await f.db.item.create({ data: { userId: owner.id, parentId: post.id, text: 'reply' } })
      const globalPin = await f.db.pin.create({ data: { position: 1 } })
      f.created.pins.push(globalPin.id)
      await f.db.item.update({ where: { id: reply.id }, data: { pinId: globalPin.id } })
      const noTurf = await seedPost(owner, [])
      await f.db.item.update({ where: { id: noTurf.id }, data: { pinId: globalPin.id } })

      await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect((await f.db.item.findUnique({ where: { id: reply.id } })).pinId).toBe(globalPin.id)
      expect((await f.db.item.findUnique({ where: { id: noTurf.id } })).pinId).toBe(globalPin.id)
    })

    test('case-variant membership names share one cap budget', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'citextcap')
      const legacy = []
      for (let i = 0; i < 7; i++) {
        const p = await seedPost(owner, [a])
        // some memberships persist a case-variant CITEXT spelling of the
        // canonical turf name — they are the SAME turf for the cap
        if (i % 2 === 1) {
          await f.db.$executeRaw`
            UPDATE "ItemSub" SET "subName" = ${a.name.toUpperCase()}
            WHERE "itemId" = ${p.id} AND "subName" = ${a.name}`
        }
        await seedLegacyPin(p, { position: i + 1 })
        legacy.push(p)
      }
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/6 pins/)
      expect(await f.db.itemSub.count({ where: { itemId: { in: legacy.map(p => p.id) }, pinPosition: { not: null } } }))
        .toBe(0)
      // clear the seeded legacy links so later tests see a clean field
      await f.db.item.updateMany({ where: { id: { in: legacy.map(p => p.id) } }, data: { pinId: null } })
    })

    test('a legacy-pinned post with scalar subNames but no membership rows blocks', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'scalarmiss')
      const item = await seedPost(owner, [a])
      const pin = await seedLegacyPin(item)
      // simulate drift: the membership row is gone but the scalar name
      // survives (the trigger recomputes on delete, so this is written back
      // directly — the state this guard exists for)
      await f.db.$executeRaw`DELETE FROM "ItemSub" WHERE "itemId" = ${item.id}`
      await f.db.$executeRaw`
        UPDATE "Item" SET "subNames" = ${[a.name]}::CITEXT[] WHERE id = ${item.id}`
      await expect(backfillTurfPins(f.db, { mapping: {}, apply: true }))
        .rejects.toThrow(/membership/)
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).toBe(pin.id)
      // restore the membership row so cleanup stays consistent
      await f.db.itemSub.create({ data: { itemId: item.id, subName: a.name } })
      await f.db.item.update({ where: { id: item.id }, data: { pinId: null } })
      await f.db.pin.delete({ where: { id: pin.id } })
    })

    test('apply is atomic when a candidate update fails mid-run', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf11')
      const [l1, l2] = await Promise.all([seedPost(owner, [a]), seedPost(owner, [a])])
      await seedLegacyPin(l1)
      await seedLegacyPin(l2)
      const brokenModels = {
        $transaction: (fn, opts) => f.db.$transaction(async tx => {
          let calls = 0
          const proxied = new Proxy(tx, {
            get (target, prop, receiver) {
              if (prop === 'itemSub') {
                return {
                  ...target.itemSub,
                  update: async (...args) => {
                    calls += 1
                    if (calls >= 2) throw new Error('injected mid-run failure')
                    return target.itemSub.update(...args)
                  }
                }
              }
              return Reflect.get(target, prop, receiver)
            }
          })
          return fn(proxied)
        }, opts)
      }
      await expect(backfillTurfPins(brokenModels, { mapping: {}, apply: true }))
        .rejects.toThrow('injected mid-run failure')
      for (const id of [l1.id, l2.id]) {
        expect((await f.db.item.findUnique({ where: { id } })).pinId).not.toBeNull()
        expect(await f.db.itemSub.count({ where: { itemId: id, pinPosition: { not: null } } })).toBe(0)
      }
    })

    test('a rerun after apply never rewrites existing new-style pins', async () => {
      const owner = await f.user()
      const a = await f.sub(owner, 'bf12')
      const legacy = await seedPost(owner, [a])
      await seedLegacyPin(legacy, { position: 1 })
      await backfillTurfPins(f.db, { mapping: {}, apply: true })
      const fresh = await seedPost(owner, [a])
      await setTurfPin({ id: fresh.id, subName: a.name, pinned: true }, { me: owner, models: f.db })
      const report = await backfillTurfPins(f.db, { mapping: {}, apply: true })
      expect(report.promoted).toBe(0)
      expect(await readTurfPins(f.db, legacy.id)).toEqual([{ subName: a.name, position: 1 }])
      expect(await readTurfPins(f.db, fresh.id)).toEqual([{ subName: a.name, position: 2 }])
    })
  })
})
