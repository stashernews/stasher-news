/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { recordAdminEdge } from '@/lib/admin/edge-check'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('edge health bridge (isolated DB)', () => {
  const db = new PrismaClient()
  let saved
  beforeAll(async () => { saved = await db.healthSnapshot.findUnique({ where: { id: 1 } }) })
  afterAll(async () => {
    if (saved) await db.healthSnapshot.upsert({ where: { id: 1 }, create: saved, update: saved })
    else await db.healthSnapshot.deleteMany({ where: { id: 1 } })
    await db.$disconnect()
  })

  test('edge checks do not refresh stale daemon/chain health', async () => {
    const staleAt = new Date('2020-01-01T00:00:00Z')
    await db.healthSnapshot.upsert({ where: { id: 1 }, create: { id: 1, updatedAt: staleAt }, update: { updatedAt: staleAt } })
    const checkedAt = new Date('2026-11-02T00:00:00Z')
    await recordAdminEdge(db, true, checkedAt)
    expect(await db.healthSnapshot.findUnique({ where: { id: 1 } })).toMatchObject({ adminEdgeOk: true, adminEdgeCheckedAt: checkedAt, updatedAt: staleAt })
  })

  test('a first edge check inserts only stale chain health and records failure', async () => {
    await db.healthSnapshot.deleteMany({ where: { id: 1 } })
    const checkedAt = new Date('2026-11-02T01:00:00Z')
    await recordAdminEdge(db, false, checkedAt)
    expect(await db.healthSnapshot.findUnique({ where: { id: 1 } })).toMatchObject({ adminEdgeOk: false, adminEdgeCheckedAt: checkedAt, updatedAt: new Date(0) })
  })

  test('edge timestamps are stored as UTC regardless of the database session timezone', async () => {
    await db.healthSnapshot.deleteMany({ where: { id: 1 } })
    const checkedAt = new Date('2026-11-02T02:30:00Z')
    // A non-UTC session must not shift the naive TIMESTAMP columns: the stored
    // wall-clock has to be the UTC instant either way.
    await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Zagreb'`
      await recordAdminEdge(tx, true, checkedAt)
    })
    expect(await db.healthSnapshot.findUnique({ where: { id: 1 } })).toMatchObject({ adminEdgeOk: true, adminEdgeCheckedAt: checkedAt, updatedAt: new Date(0) })
  })
})
