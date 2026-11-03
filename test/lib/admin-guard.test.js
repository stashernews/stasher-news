/* eslint-env jest */
import { NextRequest } from 'next/server'
import { isAdminRequest, assertAdminMutationOrigin, isAdminPath } from '@/lib/admin/guard'
import { proxy, config } from '@/proxy'

jest.mock('../../lib/auth', () => ({ secureCookie: name => name, cookieOptions: () => ({}) }))
jest.mock('../../lib/domains', () => ({
  getDomainMapping: () => { throw new Error('admin must not use domain mapping') },
  createDomainsDebugLogger: () => () => {}
}))
jest.mock('../../lib/invite-gate', () => ({ GATE_COOKIE: 'sn_gate', shouldGateRequest: () => { throw new Error('admin must bypass invite gate') } }))

const secret = 'a'.repeat(32)
const before = { ...process.env }
test.each(['/_next/data/build-id/admin.json', '/_next/data/build-id/admin/settings.json'])('Next data path %s is guarded before domain and invite handling', async path => {
  expect(isAdminPath(path)).toBe(true)
  const denied = await proxy(new NextRequest(`http://localhost${path}`))
  expect(denied.status).toBe(404)
  const allowed = await proxy(new NextRequest(`http://localhost${path}`, { headers: { 'x-admin-gate': secret } }))
  expect(allowed.headers.get('x-middleware-next')).toBe('1')
})
beforeEach(() => { process.env.ADMIN_GATE_SECRET = secret })
afterEach(() => { process.env = { ...before } })

test.each([undefined, '', 'a'.repeat(31)])('unset or short secret %s disables admin', value => {
  if (value === undefined) delete process.env.ADMIN_GATE_SECRET; else process.env.ADMIN_GATE_SECRET = value
  expect(isAdminRequest({ headers: { 'x-admin-gate': value } })).toBe(false)
})

test('only a matching single header is accepted, with timing-safe Unicode length handling', () => {
  expect(isAdminRequest({ headers: {} })).toBe(false)
  expect(isAdminRequest({ headers: { 'x-admin-gate': 'b'.repeat(32) } })).toBe(false)
  expect(isAdminRequest({ headers: { 'x-admin-gate': 'é'.repeat(32) } })).toBe(false)
  expect(isAdminRequest({ headers: { 'x-admin-gate': [secret, secret] } })).toBe(false)
  expect(isAdminRequest({ headers: { 'x-admin-gate': secret } })).toBe(true)
  expect(isAdminRequest(new NextRequest('http://localhost/admin', { headers: { 'x-admin-gate': secret } }))).toBe(true)
})

test('mutations require the explicit client header', () => {
  expect(() => assertAdminMutationOrigin({ headers: {} })).toThrow()
  expect(() => assertAdminMutationOrigin({ headers: { 'x-admin-client': '0' } })).toThrow()
  expect(() => assertAdminMutationOrigin({ headers: { 'x-admin-client': '1' } })).not.toThrow()
})

test.each(['/admin', '/admin/settings', '/api/admin', '/api/admin/graphql'])('%s is bare 404 regardless of account cookies/API key', async path => {
  const response = await proxy(new NextRequest(`http://localhost${path}`, { headers: { cookie: 'sn_gate=valid; next-auth.session-token=stasher', 'x-api-key': 'anything' } }))
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('')
})

test.each(['/live', '/live/', '/_next/data/build-id/live.json'])('retired live route %s returns 404 rather than falling through to the user-profile route', async path => {
  const response = await proxy(new NextRequest(`http://localhost${path}`))
  expect(response.status).toBe(404)
})

test('a valid admin request skips invite/custom-domain logic but retains CSP nonce over plain HTTP', async () => {
  process.env.NODE_ENV = 'production'
  const response = await proxy(new NextRequest('http://custom.example/admin', { headers: { host: 'custom.example', 'x-admin-gate': secret } }))
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  expect(response.headers.get('content-security-policy')).toContain("'nonce-")
  expect(response.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests')
  expect(response.headers.get('strict-transport-security')).toBeNull()
  expect(config.matcher).toContainEqual({ source: '/api/admin/:path*' })
})
