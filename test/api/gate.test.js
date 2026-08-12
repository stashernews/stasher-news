/* eslint-env jest */
import * as cookie from 'cookie'
import handler, { handleGate, handleGateCheck } from '@/pages/api/gate'
import { issueGateToken } from '@/lib/invite-gate'

// Same lib/auth module mock as test/api/monero/webhook.test.js:14-18; here the
// handler also needs cookieOptions (kept pure so serialize produces a cookie
// we can assert on).
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  secureCookie: (name) => name,
  cookieOptions: () => ({ path: '/', httpOnly: true, sameSite: 'lax', maxAge: 2592000 })
}))

function mockRes () {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis()
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'test-secret'
  process.env.SITE_INVITE_CODES = 'alpha,beta'
})

afterEach(() => {
  delete process.env.SITE_INVITE_CODES
  delete process.env.NEXTAUTH_SECRET
})

test('returns 404 when the gate is disabled', async () => {
  delete process.env.SITE_INVITE_CODES
  const res = mockRes()
  await handleGate({ body: { code: 'alpha' } }, res)
  expect(res.status).toHaveBeenCalledWith(404)
})

test('accepts a valid code and sets the signed gate cookie', async () => {
  const res = mockRes()
  await handleGate({ body: { code: 'alpha', next: '/items/3' } }, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith({ next: '/items/3' })
  expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('sn_gate='))
  const header = res.setHeader.mock.calls[0][1]
  const parsed = cookie.parse(header.split(';')[0])
  expect(parsed.sn_gate).toBe(issueGateToken('alpha'))
})

test('rejects an invalid code with 401 and no cookie', async () => {
  const res = mockRes()
  await handleGate({ body: { code: 'nope', next: '/' } }, res)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(res.json).toHaveBeenCalledWith({ error: 'invalid invite code' })
  expect(res.setHeader).not.toHaveBeenCalled()
})

test('rejects a non-string code with 401', async () => {
  const res = mockRes()
  await handleGate({ body: { code: 42 } }, res)
  expect(res.status).toHaveBeenCalledWith(401)
})

test('rejects a missing body with 401', async () => {
  const res = mockRes()
  await handleGate({}, res)
  expect(res.status).toHaveBeenCalledWith(401)
})

test('sanitizes the next target against open redirects', async () => {
  const res = mockRes()
  await handleGate({ body: { code: 'alpha', next: '//evil.com' } }, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith({ next: '/' })
})

test('default handler rejects unsupported methods with 405', async () => {
  const res = mockRes()
  await handler({ method: 'PUT', body: {} }, res)
  expect(res.status).toHaveBeenCalledWith(405)
})

test('check reports ok with a valid gate cookie', async () => {
  const res = mockRes()
  const token = issueGateToken('alpha')
  await handleGateCheck({ cookies: { sn_gate: token } }, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith({ ok: true })
})

test('check reports not ok without a valid gate cookie', async () => {
  const res = mockRes()
  await handleGateCheck({ cookies: {} }, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith({ ok: false })
})

test('check returns 404 when the gate is disabled', async () => {
  delete process.env.SITE_INVITE_CODES
  const res = mockRes()
  await handleGateCheck({ cookies: {} }, res)
  expect(res.status).toHaveBeenCalledWith(404)
})
