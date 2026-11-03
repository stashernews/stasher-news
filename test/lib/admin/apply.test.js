/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminApply, adminCreateInviteCode, adminRevokeInviteCode } from '@/lib/admin/apply'
import { readMaintenance, writeMaintenance } from '@/lib/admin/maintenance'
import { issueGateToken, verifyGateToken, clearGateCache } from '@/lib/invite-gate'
import { getSiteSettings, clearSiteSettingsCache } from '@/lib/siteSettings'
import { getCachedPlatformFeeConfig, clearFeeConfigCache } from '@/api/monero/postingFee'

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('admin writes (isolated DB)', () => {
  const models = new PrismaClient()
  const env = { ...process.env }
  let savedSettings, savedFees, savedSnl, directory, fetchSpy
  beforeAll(async () => {
    savedSettings = await models.siteSettings.findUnique({ where: { id: 1 } })
    savedFees = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    savedSnl = await models.snl.findFirst()
    directory = await mkdtemp(join(tmpdir(), 'admin-apply-'))
  })
  beforeEach(async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
    process.env.NEXTAUTH_SECRET = 'test-only-secret'
    delete process.env.SITE_INVITE_CODES
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, body: { cancel: async () => {} } })
    await models.siteSettings.update({ where: { id: 1 }, data: savedSettings })
    await models.platformFeeConfig.update({ where: { id: 1 }, data: savedFees })
    await writeMaintenance(false, 'test reset', directory)
    clearGateCache()
    clearSiteSettingsCache()
    clearFeeConfigCache()
  })
  afterEach(() => { fetchSpy.mockRestore(); process.env = { ...env } })
  afterAll(async () => {
    await models.siteSettings.update({ where: { id: 1 }, data: savedSettings })
    await models.platformFeeConfig.update({ where: { id: 1 }, data: savedFees })
    if (savedSnl) await models.snl.update({ where: { id: savedSnl.id }, data: savedSnl })
    else await models.snl.deleteMany()
    await rm(directory, { recursive: true, force: true })
    await models.$disconnect()
  })
  const apply = changes => adminApply({ models, changes, reason: 'isolated admin test', maintenanceDirectory: directory })

  test('one invalid change rejects all changes and writes no audit rows', async () => {
    const before = await models.adminConfigChange.count()
    await expect(apply([
      { key: 'maxItemTurfs', expected: '5', value: '6' },
      { key: 'itemEditSeconds', expected: '600', value: '0', confirmedJump: true }
    ])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect((await models.siteSettings.findUnique({ where: { id: 1 } })).maxItemTurfs).toBe(5)
    expect(await models.adminConfigChange.count()).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('stale expected values reject the entire apply and identify keys', async () => {
    await expect(apply([{ key: 'maxItemTurfs', expected: '4', value: '6' }])).rejects.toMatchObject({ code: 'STALE_VALUE', keys: ['maxItemTurfs'] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('audit values match committed writes and exactly one warning alert is delivered', async () => {
    const result = await apply([
      { key: 'postingFeeFloorPiconeros', expected: '0.001', value: '0.002' },
      { key: 'maxItemTurfs', expected: '5', value: '6' }
    ])
    expect(result).toMatchObject({ applied: true, alertDelivered: true })
    expect((await models.platformFeeConfig.findUnique({ where: { id: 1 } })).postingFeeFloorPiconeros).toBe(2000000000n)
    const rows = await models.adminConfigChange.findMany({ where: { applyId: result.applyId }, orderBy: { id: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ actor: 'ssh-tunnel', field: 'postingFeeFloorPiconeros', oldValue: '0.001', newValue: '0.002', applied: true })
    expect(rows[1]).toMatchObject({ field: 'maxItemTurfs', oldValue: '5', newValue: '6' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(payload.text).toContain('[WARN]')
    expect(payload.text).toContain('postingFeeFloorPiconeros: 0.001 → 0.002')
    expect(payload.text).toContain('isolated admin test')
  })

  test('jump confirmation is enforced server-side; large trust thresholds remain exact', async () => {
    const changes = [{ key: 'trustPicoMin', expected: '1001', value: '1000000000000' }]
    await expect(apply(changes)).rejects.toMatchObject({ code: 'JUMP_CONFIRMATION_REQUIRED' })
    await apply([{ ...changes[0], confirmedJump: true }])
    expect((await models.siteSettings.findUnique({ where: { id: 1 } })).trustPicoMin).toBe(1000000000000n)
  })

  test('unconfigured alerts, empty reasons and duplicate keys refuse before writes', async () => {
    const changes = [{ key: 'maxItemTurfs', expected: '5', value: '6' }]
    delete process.env.ALERT_WEBHOOK_URL
    await expect(apply(changes)).rejects.toThrow(/alert channel isn't configured/)
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
    await expect(adminApply({ models, changes, reason: '   ' })).rejects.toThrow(/reason/i)
    await expect(apply([...changes, ...changes])).rejects.toThrow(/duplicate/i)
  })

  test('maintenance creates and removes its flag, and failure marks its audit row unapplied', async () => {
    await apply([{ key: 'maintenance', expected: 'false', value: 'true' }])
    expect(await readMaintenance(directory)).toBe(true)
    expect(await readFile(join(directory, 'enabled'), 'utf8')).toContain('isolated admin test')
    await apply([{ key: 'maintenance', expected: 'true', value: 'false' }])
    expect(await readMaintenance(directory)).toBe(false)
    const result = await adminApply({ models, changes: [{ key: 'maintenance', expected: 'false', value: 'true' }], reason: 'failed flag write', maintenanceDirectory: join(directory, 'nonexistent') })
    expect(result).toMatchObject({ applied: false, error: 'maintenance flag could not be updated' })
    expect(await models.adminConfigChange.findMany({ where: { applyId: result.applyId } })).toEqual([expect.objectContaining({ applied: false, field: 'maintenance' })])
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  test('user exclusions must resolve to existing users', async () => {
    await expect(apply([{ key: 'distributionExcludedCuratorIds', expected: savedFees.distributionExcludedCuratorIds.join(','), value: '2147483647' }])).rejects.toThrow(/existing user/)
  })

  test('concurrent stale tabs cannot both overwrite one another', async () => {
    const results = await Promise.allSettled([
      apply([{ key: 'maxItemTurfs', expected: '5', value: '6' }]),
      apply([{ key: 'maxItemTurfs', expected: '5', value: '7' }])
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('STALE_VALUE')
  })

  test('committed changes invalidate this process caches immediately', async () => {
    expect((await getSiteSettings(models)).maxItemTurfs).toBe(5)
    expect((await getCachedPlatformFeeConfig(models)).postingFeeFloorPiconeros).toBe(1000000000n)
    await apply([{ key: 'maxItemTurfs', expected: '5', value: '6' }, { key: 'postingFeeFloorPiconeros', expected: '0.001', value: '0.002' }])
    expect((await getSiteSettings(models)).maxItemTurfs).toBe(6)
    expect((await getCachedPlatformFeeConfig(models)).postingFeeFloorPiconeros).toBe(2000000000n)
  })

  test('concurrent maintenance requests compare file state only after the preceding write', async () => {
    const results = await Promise.allSettled([
      apply([{ key: 'maintenance', expected: 'false', value: 'true' }]),
      apply([{ key: 'maintenance', expected: 'false', value: 'true' }])
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('STALE_VALUE')
    expect(await readMaintenance(directory)).toBe(true)
  })

  test('a coordinator release failure after commit still announces the committed maintenance change', async () => {
    const wrapped = { adminConfigChange: models.adminConfigChange }
    wrapped.$transaction = async (operation, options) => {
      const result = await models.$transaction(operation, options)
      if (!options?.isolationLevel) throw Object.assign(new Error('coordinator ended'), { code: 'P2028' })
      return result
    }
    const result = await adminApply({ models: wrapped, changes: [{ key: 'maintenance', expected: 'false', value: 'true' }], reason: 'coordinator release test', maintenanceDirectory: directory })
    expect(result.applied).toBe(true)
    expect(await readMaintenance(directory)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await models.adminConfigChange.findMany({ where: { applyId: result.applyId } })).toEqual([expect.objectContaining({ applied: true })])
  })

  test('missing live-banner row handles concurrent first writes with a stale loser, not an internal error', async () => {
    const rows = await models.snl.findMany()
    try {
      await models.snl.deleteMany()
      const turnOn = () => apply([
        { key: 'snl.live', expected: 'false', value: 'true' },
        { key: 'snl.message', expected: '', value: 'banner is live' }
      ])
      const results = await Promise.allSettled([turnOn(), turnOn()])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(result => result.status === 'rejected').reason.code).toBe('STALE_VALUE')
      const winner = await models.snl.findFirst()
      expect(winner.live).toBe(true)
      expect(winner.message).toBe('banner is live')
      await apply([{ key: 'snl.live', expected: 'true', value: 'false' }])
      expect((await models.snl.findFirst()).live).toBe(false)
    } finally {
      await models.snl.deleteMany()
      if (rows.length) await models.snl.createMany({ data: rows })
    }
  })

  test('turning the banner on from a missing row succeeds when a message is provided', async () => {
    const rows = await models.snl.findMany()
    try {
      await models.snl.deleteMany()
      await apply([
        { key: 'snl.live', expected: 'false', value: 'true' },
        { key: 'snl.message', expected: '', value: 'banner is live' }
      ])
      const row = await models.snl.findFirst()
      expect(row.live).toBe(true)
      expect(row.message).toBe('banner is live')
    } finally {
      await models.snl.deleteMany()
      if (rows.length) await models.snl.createMany({ data: rows })
    }
  })

  test('mixed apply preserves successful DB audit rows when only the file change fails', async () => {
    const result = await adminApply({ models, changes: [{ key: 'maxItemTurfs', expected: '5', value: '6' }, { key: 'maintenance', expected: 'false', value: 'true' }], reason: 'mixed apply failure test', maintenanceDirectory: join(directory, 'nonexistent') })
    expect((await models.siteSettings.findUnique({ where: { id: 1 } })).maxItemTurfs).toBe(6)
    expect(await models.adminConfigChange.findMany({ where: { applyId: result.applyId }, orderBy: { id: 'asc' } })).toEqual([
      expect.objectContaining({ field: 'maxItemTurfs', applied: true }),
      expect.objectContaining({ field: 'maintenance', applied: false })
    ])
  })

  test('unknown keys are rejected and content-only applies announce info severity', async () => {
    await expect(apply([{ key: 'notASetting', expected: '0', value: '1' }])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await apply([{ key: 'maxItemTurfs', expected: '5', value: '6' }])
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).text).toContain('[INFO]')
  })

  test('invite codes are shown once, stored only as hashes, audited and revoked with cache invalidation', async () => {
    const result = await adminCreateInviteCode({ models, label: 'isolated new code', reason: 'test invitation' })
    try {
      expect(result.code).toMatch(/^[A-Za-z0-9_-]{32,}$/)
      const row = await models.inviteGateCode.findUnique({ where: { id: result.id } })
      expect(JSON.stringify(row)).not.toContain(result.code)
      expect(await verifyGateToken(issueGateToken(result.code), models)).toBe(true)
      expect(await verifyGateToken(row.tokenHash, models)).toBe(false)
      const revoked = await adminRevokeInviteCode({ models, id: result.id, reason: 'test revocation' })
      expect(revoked.applied).toBe(true)
      expect(await verifyGateToken(issueGateToken(result.code), models)).toBe(false)
      expect(await models.adminConfigChange.findMany({ where: { applyId: result.applyId } })).toEqual([expect.objectContaining({ store: 'inviteGateCode', targetId: String(result.id), newValue: 'active' })])
      expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(result.code)
    } finally {
      await models.inviteGateCode.delete({ where: { id: result.id } })
    }
  })
})
