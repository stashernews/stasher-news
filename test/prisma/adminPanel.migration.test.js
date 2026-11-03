/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { SITE_SETTINGS_DEFAULTS } from '@/lib/siteSettings'

// Never point these write/trigger checks at the shared development database.
const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('admin panel migration (isolated DB)', () => {
  const db = new PrismaClient()
  afterAll(() => db.$disconnect())

  test('seeds the settings singleton with unchanged runtime defaults', async () => {
    const [settings] = await db.$queryRaw`SELECT * FROM "SiteSettings" WHERE id = 1`
    expect(settings).toMatchObject(SITE_SETTINGS_DEFAULTS)
    expect(settings).toMatchObject({
      itemSpamIntervalMinutes: 10,
      spamEscalationNumerator: 3,
      spamEscalationDenominator: 2,
      freePostsPerMonth: 1,
      freeCommentsPerWeek: 1,
      homepagePostsFilterPiconeros: -25000000000n,
      defaultPostsFilterPiconeros: -25000000000n,
      defaultCommentsFilterPiconeros: -25000000000n,
      maxItemTurfs: 5,
      itemEditSeconds: 600,
      anonPostFeeMultiplier: 10,
      anonCommentFeeMultiplier: 3,
      trustSeedWeight: 0.83,
      trustMaxDepth: 40,
      trustPicoMin: 1001n,
      trustAgainstPicoMin: 1000n,
      trustIrrelevantCumulative: 0.001,
      verifiedBadgeEnabled: false,
      nostrSocialPosting: null,
      opsSweepEnabled: null,
      newsletterAutoSend: null
    })
  })

  test('audit is append-only except a single applied true to false transition', async () => {
    const [row] = await db.$queryRaw`
      INSERT INTO "AdminConfigChange" ("applyId", actor, store, field, "oldValue", "newValue", reason)
      VALUES ('migration-test', 'ssh-tunnel', 'maintenance', 'maintenance', 'false', 'true', 'trigger test') RETURNING id`
    await expect(db.$executeRaw`DELETE FROM "AdminConfigChange" WHERE id = ${row.id}`).rejects.toThrow()
    await expect(db.$executeRaw`UPDATE "AdminConfigChange" SET reason = 'changed' WHERE id = ${row.id}`).rejects.toThrow()
    await expect(db.$executeRaw`UPDATE "AdminConfigChange" SET applied = false, reason = 'changed' WHERE id = ${row.id}`).rejects.toThrow()
    expect(await db.$executeRaw`UPDATE "AdminConfigChange" SET applied = false WHERE id = ${row.id}`).toBe(1)
    await expect(db.$executeRaw`UPDATE "AdminConfigChange" SET applied = true WHERE id = ${row.id}`).rejects.toThrow()
    await expect(db.$executeRaw`UPDATE "AdminConfigChange" SET applied = false WHERE id = ${row.id}`).rejects.toThrow()
  })

  test('keeps the unused confirmation column until the contract migration and adds edge health fields', async () => {
    const columns = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'PlatformFeeConfig'`
    // The column is intentionally retained: the currently deployed base client
    // still selects it implicitly, so dropping it here would break the old app
    // during the migrate-then-restart window (and after any code rollback).
    // Removal is deferred to a later contract migration once no base client runs.
    expect(columns.map(c => c.column_name)).toContain('requiredConfirmations')
    const health = await db.$queryRaw`SELECT "adminEdgeCheckedAt", "adminEdgeOk" FROM "HealthSnapshot" LIMIT 1`
    expect(Array.isArray(health)).toBe(true)
  })
})
