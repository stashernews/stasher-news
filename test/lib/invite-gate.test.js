/* eslint-env jest */
import {
  GATE_COOKIE, isGateEnabled, getGateCodes, issueGateToken, verifyGateToken,
  gatePasses, shouldGateRequest, sanitizeNext, buildGateCookieHeader
} from '@/lib/invite-gate'

// lib/invite-gate imports @/lib/auth (next-auth/jwt chain is ESM-only under
// jest CJS require) and @/lib/domains/auth (pure node:crypto). Mock lib/auth
// at the module boundary, same as test/api/monero/webhook.test.js:14-18.
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  secureCookie: (name) => name
}))

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret'
  process.env.SITE_INVITE_CODES = 'alpha,beta'
})

afterEach(() => {
  delete process.env.SITE_INVITE_CODES
  delete process.env.NEXTAUTH_SECRET
})

test('GATE_COOKIE is sn_gate with the lib/auth mock in place', () => {
  expect(GATE_COOKIE).toBe('sn_gate')
})

test('gate is disabled when SITE_INVITE_CODES is unset or empty', () => {
  delete process.env.SITE_INVITE_CODES
  expect(isGateEnabled()).toBe(false)
  process.env.SITE_INVITE_CODES = '  ,  '
  expect(isGateEnabled()).toBe(false)
})

test('gate is enabled when SITE_INVITE_CODES has codes; codes are trimmed and filtered', () => {
  process.env.SITE_INVITE_CODES = ' alpha , ,beta '
  expect(isGateEnabled()).toBe(true)
  expect(getGateCodes()).toEqual(['alpha', 'beta'])
})

test('issueGateToken is deterministic and verifyGateToken accepts the matching token', () => {
  const token = issueGateToken('alpha')
  expect(issueGateToken('alpha')).toBe(token)
  expect(verifyGateToken(token)).toBe(true)
})

it('throws in production when NEXTAUTH_SECRET is unset instead of using an empty key', () => {
  const prevNodeEnv = process.env.NODE_ENV
  const prevSecret = process.env.NEXTAUTH_SECRET
  process.env.NODE_ENV = 'production'
  process.env.NEXTAUTH_SECRET = ''
  try {
    expect(() => issueGateToken('some-code')).toThrow(/NEXTAUTH_SECRET/)
  } finally {
    process.env.NODE_ENV = prevNodeEnv
    process.env.NEXTAUTH_SECRET = prevSecret
  }
})

test('buildGateCookieHeader returns a valid cookie header when enabled, null when disabled', () => {
  const header = buildGateCookieHeader()
  expect(header).toBe(`sn_gate=${issueGateToken('alpha')}`)
  delete process.env.SITE_INVITE_CODES
  expect(buildGateCookieHeader()).toBeNull()
})

test('verifyGateToken rejects wrong, empty, and non-string tokens', () => {
  expect(verifyGateToken(issueGateToken('charlie'))).toBe(false)
  expect(verifyGateToken(issueGateToken('ALPHA'))).toBe(false) // case-sensitive
  expect(verifyGateToken('')).toBe(false)
  expect(verifyGateToken(undefined)).toBe(false)
  expect(verifyGateToken(42)).toBe(false)
})

test('rotating the code list revokes previously issued tokens', () => {
  const oldToken = issueGateToken('alpha')
  process.env.SITE_INVITE_CODES = 'gamma'
  expect(verifyGateToken(oldToken)).toBe(false)
})

test('shouldGateRequest passes everything when the gate is disabled', () => {
  delete process.env.SITE_INVITE_CODES
  expect(shouldGateRequest({ pathname: '/', cookie: undefined })).toBe('pass')
  expect(shouldGateRequest({ pathname: '/api/graphql', cookie: undefined })).toBe('pass')
})

test('shouldGateRequest redirects gated HTML without a valid cookie', () => {
  expect(shouldGateRequest({ pathname: '/', cookie: undefined })).toBe('redirect')
  expect(shouldGateRequest({ pathname: '/items/3', cookie: '' })).toBe('redirect')
  expect(shouldGateRequest({ pathname: '/login', cookie: 'bogus' })).toBe('redirect')
})

test('shouldGateRequest returns data-redirect for _next/data fetches without a cookie', () => {
  expect(shouldGateRequest({ pathname: '/_next/data/build/items/3.json', cookie: undefined }))
    .toBe('data-redirect')
})

test('shouldGateRequest returns api-401 for /api/graphql without a cookie', () => {
  expect(shouldGateRequest({ pathname: '/api/graphql', cookie: undefined })).toBe('api-401')
})

test('shouldGateRequest passes a valid cookie everywhere', () => {
  const token = issueGateToken('alpha')
  expect(shouldGateRequest({ pathname: '/', cookie: token })).toBe('pass')
  expect(shouldGateRequest({ pathname: '/_next/data/build/items/3.json', cookie: token })).toBe('pass')
  expect(shouldGateRequest({ pathname: '/api/graphql', cookie: token })).toBe('pass')
})

test('shouldGateRequest exempts the gate page and static/asset paths', () => {
  for (const pathname of ['/gate', '/sw.js', '/offline', '/404', '/500', '/_error',
    '/favicon.ico', '/.well-known/web-app-origin-association',
    // _document.js <Head> injects these on every page (even /gate) before the
    // visitor has a cookie; gating them 307s the font preloads and the display
    // font silently falls back
    '/fonts/chakra-petch-600.woff2', '/icons/icon_x192.png', '/apple-touch-icon.png']) {
    expect(shouldGateRequest({ pathname, cookie: undefined })).toBe('pass')
  }
})

test('gatePasses reads the gate cookie from the request', () => {
  const token = issueGateToken('alpha')
  expect(gatePasses({ cookies: { [GATE_COOKIE]: token } })).toBe(true)
  expect(gatePasses({ cookies: { [GATE_COOKIE]: 'bogus' } })).toBe(false)
  expect(gatePasses({ cookies: {} })).toBe(false)
})

test('sanitizeNext only allows same-origin relative paths', () => {
  expect(sanitizeNext('/items/3?commentId=5')).toBe('/items/3?commentId=5')
  expect(sanitizeNext('/')).toBe('/')
  expect(sanitizeNext('//evil.com')).toBe('/')
  expect(sanitizeNext('/\\evil.com')).toBe('/')
  expect(sanitizeNext('https://evil.com')).toBe('/')
  expect(sanitizeNext('javascript:alert(1)')).toBe('/')
  expect(sanitizeNext(undefined)).toBe('/')
  expect(sanitizeNext('')).toBe('/')
})
