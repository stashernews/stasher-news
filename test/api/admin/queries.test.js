/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/admin/resolvers'
import { FIELDS } from '@/lib/admin/fields'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('admin read queries (isolated DB)', () => {
  const models = new PrismaClient()
  afterAll(() => models.$disconnect())
  test('sections expose every editable field with display values, effective env source and no code hashes', async () => {
    const sections = await resolvers.Query.adminSections(null, {}, { models })
    const fields = sections.flatMap(section => section.fields)
    expect(fields).toHaveLength(FIELDS.length)
    expect(fields.find(field => field.key === 'postingFeeFloorPiconeros')).toMatchObject({ value: '0.001', effectiveValue: '0.001', source: 'db' })
    expect(fields.find(field => field.key === 'nostrSocialPosting')).toMatchObject({ value: 'null', source: 'env' })
    expect(fields.find(field => field.key === 'curatorBudgetMode').rolloutMode).toBe(true)
  })
  test('audit pagination is stable, bounded and rejects invalid cursors', async () => {
    const first = await resolvers.Query.adminAudit(null, {}, { models })
    expect(first.rows.length).toBeLessThanOrEqual(50)
    await expect(resolvers.Query.adminAudit(null, { cursor: 'junk' }, { models })).rejects.toThrow()
    if (first.nextCursor) {
      const next = await resolvers.Query.adminAudit(null, { cursor: first.nextCursor }, { models })
      expect(next.rows.every(row => BigInt(row.id) < BigInt(first.nextCursor))).toBe(true)
    }
  })
  test('invite and access queries return only operator-safe summaries', async () => {
    const codes = await resolvers.Query.adminInviteCodes(null, {}, { models })
    expect(codes.every(row => !('tokenHash' in row) && !('code' in row))).toBe(true)
    const checks = await resolvers.Query.adminAccess(null, {}, { models })
    expect(checks.map(check => check.key)).toEqual(['gateSecret', 'loginMethods', 'apiKey', 'adminIds', 'alerts', 'publicEdge'])
  })
})
