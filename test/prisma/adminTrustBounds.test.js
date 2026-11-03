/* eslint-env jest */
import { PrismaClient } from '@prisma/client'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('admin trust threshold storage (isolated DB)', () => {
  const db = new PrismaClient()
  afterAll(() => db.$disconnect())
  test('both trust thresholds store the approved trillion-piconero bound without changing defaults', async () => {
    const saved = await db.siteSettings.findUnique({ where: { id: 1 } })
    try {
      await db.$executeRaw`UPDATE "SiteSettings" SET "trustPicoMin" = ${1000000000000n}, "trustAgainstPicoMin" = ${1000000000000n} WHERE id = 1`
      expect(await db.siteSettings.findUnique({ where: { id: 1 } })).toMatchObject({ trustPicoMin: 1000000000000n, trustAgainstPicoMin: 1000000000000n })
    } finally {
      await db.siteSettings.update({ where: { id: 1 }, data: { trustPicoMin: saved.trustPicoMin, trustAgainstPicoMin: saved.trustAgainstPicoMin, updatedAt: saved.updatedAt } })
    }
  })
})
