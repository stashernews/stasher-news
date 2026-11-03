/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { handleGate, handleGateCheck } from '@/pages/api/gate'
import { issueGateToken, gateTokenHash, clearGateCache } from '@/lib/invite-gate'

jest.mock('../../lib/auth', () => ({ secureCookie: name => name, cookieOptions: () => ({ path: '/', httpOnly: true, sameSite: 'lax' }) }))

const isolated = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_dynamic_test' } catch { return false }
})()

;(isolated ? describe : describe.skip)('invite gate (isolated DB)', () => {
  const db = new PrismaClient()
  let id
  const previous = {}
  beforeAll(() => {
    for (const key of ['NEXTAUTH_SECRET', 'SITE_INVITE_CODES']) previous[key] = process.env[key]
    process.env.NEXTAUTH_SECRET = 'test-secret'
    process.env.SITE_INVITE_CODES = ''
  })
  afterAll(async () => {
    if (id) await db.inviteGateCode.delete({ where: { id } })
    await db.$disconnect()
    clearGateCache()
    jest.restoreAllMocks()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })

  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() })

  test('admits a DB code, rejects its stored hash, and revokes its cookie after the cache window', async () => {
    const code = randomBytes(24).toString('base64url')
    const token = issueGateToken(code)
    const row = await db.inviteGateCode.create({ data: { label: 'isolated-gate-test', tokenHash: gateTokenHash(token) } })
    id = row.id
    clearGateCache()
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100000)
    const admitted = response()
    await handleGate({ body: { code } }, admitted, db)
    expect(admitted.status).toHaveBeenCalledWith(200)
    expect(admitted.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining(`sn_gate=${token};`))
    const leaked = response()
    await handleGateCheck({ cookies: { sn_gate: row.tokenHash } }, leaked, db)
    expect(leaked.json).toHaveBeenCalledWith({ ok: false })
    await db.inviteGateCode.update({ where: { id }, data: { revokedAt: new Date() } })
    clock.mockReturnValue(160000)
    // Keep another env code active: revocation must lock this cookie out, not
    // disable the gate by removing the last active code.
    process.env.SITE_INVITE_CODES = 'remaining-env-code'
    const revoked = response()
    await handleGateCheck({ cookies: { sn_gate: token } }, revoked, db)
    expect(revoked.json).toHaveBeenCalledWith({ ok: false })
  })
})
