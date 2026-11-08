/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { turfPinFixture } from '../helpers/turf-pins'
import { backfillTurfPins } from '../../scripts/backfill-turf-pins'
import { readTurfPins } from '@/api/turf-pins'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_turf_pins_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('turf pin migration safety', () => {
  let f
  beforeAll(() => { f = turfPinFixture() })
  afterAll(() => f.cleanup())
  test('position updates do not lock the parent Item', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'trigger')
    const item = await f.post(owner, [a])
    const other = new PrismaClient()
    try {
      await f.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${item.id} FOR UPDATE`
        await other.$transaction(async tx => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 2000')
          await tx.itemSub.update({ where: { itemId_subName: { itemId: item.id, subName: a.name } }, data: { pinPosition: 1 } })
        })
      })
      expect(await readTurfPins(f.db, item.id)).toEqual([{ subName: a.name, position: 1 }])
    } finally {
      await other.$disconnect()
    }
  })

  test('backfill rolls back on failure, preserves legacy history and is idempotent', async () => {
    const owner = await f.user()
    const a = await f.sub(owner, 'backfill')
    const posts = [await f.post(owner, [a]), await f.post(owner, [a])]
    for (const item of posts) {
      const pin = await f.db.pin.create({ data: { position: 1 } })
      f.created.pins.push(pin.id)
      await f.db.item.update({ where: { id: item.id }, data: { pinId: pin.id } })
    }
    const broken = {
      $transaction: fn => f.db.$transaction(tx => {
        let writes = 0
        return fn(new Proxy(tx, {
          get (db, prop, receiver) {
            if (prop === 'itemSub') {
              return {
                ...db.itemSub,
                update: args => {
                  if (++writes === 2) throw new Error('injected failure')
                  return db.itemSub.update(args)
                }
              }
            }
            return Reflect.get(db, prop, receiver)
          }
        }))
      })
    }
    await expect(backfillTurfPins(broken, { apply: true })).rejects.toThrow('injected failure')
    for (const item of posts) {
      expect(await readTurfPins(f.db, item.id)).toEqual([])
      expect((await f.db.item.findUnique({ where: { id: item.id } })).pinId).not.toBeNull()
    }
    expect((await backfillTurfPins(f.db, { apply: true })).promoted).toBe(2)
    expect((await backfillTurfPins(f.db, { apply: true })).promoted).toBe(0)
    expect(await f.db.pin.count({ where: { id: { in: f.created.pins } } })).toBe(2)
  })
})
