/* eslint-env jest */
import { issueGateToken, gateTokenHash, getActiveGateHashes, clearGateCache, verifyGateToken, isGateEnabled, shouldGateRequest } from '@/lib/invite-gate'

jest.mock('../../lib/auth', () => ({ secureCookie: name => name }))
jest.mock('../../api/models', () => ({ __esModule: true, default: { inviteGateCode: { findMany: async () => [] } } }))

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret'
  delete process.env.SITE_INVITE_CODES
  clearGateCache()
  jest.useFakeTimers({ now: 100000 })
})
afterEach(() => { jest.useRealTimers(); delete process.env.NEXTAUTH_SECRET; delete process.env.SITE_INVITE_CODES })

test('DB code admits its HMAC cookie, never the stored hash', async () => {
  const token = issueGateToken('private-code')
  const hash = gateTokenHash(token)
  const models = { inviteGateCode: { findMany: async () => [{ tokenHash: hash }] } }
  expect(await isGateEnabled(models)).toBe(true)
  expect(await verifyGateToken(token, models)).toBe(true)
  expect(await verifyGateToken(hash, models)).toBe(false)
  expect(await shouldGateRequest({ pathname: '/', cookie: token, models })).toBe('pass')
})

test('revocation rejects the cookie after the 60 second cache, or immediately on invalidation', async () => {
  const token = issueGateToken('private-code')
  let active = [{ tokenHash: gateTokenHash(token) }]
  const models = { inviteGateCode: { findMany: async () => active } }
  expect(await verifyGateToken(token, models)).toBe(true)
  active = []
  jest.advanceTimersByTime(59999)
  expect(await verifyGateToken(token, models)).toBe(true)
  jest.advanceTimersByTime(1)
  expect(await verifyGateToken(token, models)).toBe(false)
  active = [{ tokenHash: gateTokenHash(token) }]
  clearGateCache()
  expect(await verifyGateToken(token, models)).toBe(true)
})

test('env codes remain usable and are re-evaluated without waiting for DB cache expiry', async () => {
  const models = { inviteGateCode: { findMany: async () => [] } }
  process.env.SITE_INVITE_CODES = 'alpha'
  const token = issueGateToken('alpha')
  expect((await getActiveGateHashes(models)).has(gateTokenHash(token))).toBe(true)
  process.env.SITE_INVITE_CODES = 'beta'
  expect(await verifyGateToken(token, models)).toBe(false)
  expect(await verifyGateToken(issueGateToken('beta'), models)).toBe(true)
})

test('database failure never disables a potentially enabled gate', async () => {
  const models = { inviteGateCode: { findMany: async () => { throw new Error('offline') } } }
  await expect(shouldGateRequest({ pathname: '/', models })).rejects.toThrow('offline')
})
