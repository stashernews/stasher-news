/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { readContributorPost, setContributorEligibility } from '@/lib/admin/contributor-eligibility'
import { alert } from '@/lib/alert'
jest.mock('../../../lib/alert', () => ({ alert: jest.fn(async () => true) }))

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_contributor_pool_test' } catch { return false }
})()
;(isolated ? describe : describe.skip)('contributor admin writes', () => {
  const db = new PrismaClient()
  const env = { ...process.env }
  let user, id
  beforeEach(async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
    alert.mockClear()
    alert.mockResolvedValue(true)
    user = await db.user.create({ data: {} })
    const [post] = await db.$queryRaw`INSERT INTO "Item" ("userId", title, "bountyPiconeros") VALUES (${user.id}, 'Review me', 0) RETURNING id`
    id = post.id
  })
  afterEach(async () => {
    await db.item.delete({ where: { id } })
    await db.user.delete({ where: { id: user.id } })
    process.env = { ...env }
  })
  afterAll(() => db.$disconnect())
  const request = async extra => ({ models: db, id, expectedVersion: (await readContributorPost(db, id)).version, disqualified: true, disqualificationReason: 'PLAGIARISM', note: 'private-source-canary', reason: 'Checked source', ...extra })

  test('silent, notified, silent edit and restore transitions are audited without leaking notes', async () => {
    const silent = await setContributorEligibility(await request())
    expect(silent.applied).toBe(true)
    let post = await readContributorPost(db, id)
    expect(post.disqualifiedAt).not.toBeNull()
    expect(post.notifyAt).toBeNull()
    expect(JSON.stringify(alert.mock.calls)).not.toContain('private-source-canary')
    const rows = await db.adminConfigChange.findMany({ where: { applyId: silent.applyId } })
    expect(rows).toContainEqual(expect.objectContaining({ store: 'item', targetId: String(id), field: 'contributorDisqualifiedNote', newValue: 'private-source-canary' }))
    await setContributorEligibility(await request({ notifyAuthor: true }))
    post = await readContributorPost(db, id)
    expect(post.notifyAt).not.toBeNull()
    await setContributorEligibility(await request({ note: 'edited privately' }))
    expect((await readContributorPost(db, id)).notifyAt).toBe(post.notifyAt)
    await setContributorEligibility(await request({ disqualified: false }))
    expect(await readContributorPost(db, id)).toMatchObject({ disqualifiedAt: null, notifyAt: null, note: null, disqualificationReason: null })
  })

  test('concurrent decisions and replay cannot overwrite or notify twice', async () => {
    const req = await request({ notifyAuthor: true })
    const results = await Promise.allSettled([setContributorEligibility(req), setContributorEligibility(req)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected').reason.code).toBe('STALE_VALUE')
    await expect(setContributorEligibility(req)).rejects.toMatchObject({ code: 'STALE_VALUE' })
    expect(alert).toHaveBeenCalledTimes(1)
  })

  test('an old unflagged version stays stale after disqualifying and restoring', async () => {
    const old = await request({ notifyAuthor: true })
    await setContributorEligibility(await request())
    await setContributorEligibility(await request({ disqualified: false }))
    await expect(setContributorEligibility(old)).rejects.toMatchObject({ code: 'STALE_VALUE' })
  })

  test('audit failure rolls back the flag', async () => {
    const wrapped = { $transaction: (fn, options) => db.$transaction(tx => fn(new Proxy(tx, { get: (target, key) => key === 'adminConfigChange' ? { createMany: async () => { throw new Error('audit unavailable') } } : target[key] })), options) }
    await expect(setContributorEligibility(await request({ models: wrapped }))).rejects.toThrow('audit unavailable')
    expect((await readContributorPost(db, id)).disqualifiedAt).toBeNull()
    expect(alert).not.toHaveBeenCalled()
  })

  test('unconfigured alerts refuse writes and delivery failure does not undo a committed decision', async () => {
    const req = await request()
    delete process.env.ALERT_WEBHOOK_URL
    await expect(setContributorEligibility(req)).rejects.toMatchObject({ code: 'ALERTS_NOT_CONFIGURED' })
    expect((await readContributorPost(db, id)).disqualifiedAt).toBeNull()
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
    alert.mockRejectedValue(new Error('offline'))
    expect(await setContributorEligibility(req)).toMatchObject({ applied: true, alertDelivered: false })
    expect((await readContributorPost(db, id)).disqualifiedAt).not.toBeNull()
  })
})
