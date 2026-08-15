/* eslint-env jest */
// Regression test: the account-switch route writes the next account's JWT
// as the session cookie; when that multi_auth.<id> JWT cookie is missing,
// cookie.serialize(undefined) writes the literal 'undefined' — a value the
// server can never decrypt, which 500s every multiAuthMiddleware page and
// bounces login/signup navigation. The session cookie must never be written
// in that case.
jest.mock('next-auth/jwt', () => ({
  encode: jest.fn(),
  decode: jest.fn()
}))

const path = require('path')
const ROOT = path.join(__dirname, '..', '..')

const b64Encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64')

describe('next-account switch', () => {
  const loadAuth = () => {
    jest.resetModules()
    process.env.NEXTAUTH_SECRET = 'test-secret'
    return require(`${ROOT}/lib/auth`)
  }

  test('does not set an invalid session cookie when the next account JWT is missing', () => {
    const auth = loadAuth()
    const handler = require(`${ROOT}/pages/api/next-account`).default

    const list = b64Encode([{ id: 7, name: 'stale' }, { id: 42, name: 'current' }])
    const headers = []
    const req = {
      method: 'POST',
      cookies: {
        [auth.MULTI_AUTH_POINTER]: '7',
        [auth.MULTI_AUTH_LIST]: list,
        // multi_auth.42 JWT cookie is MISSING
        [auth.SESSION_COOKIE]: 'old-session'
      }
    }
    const res = {
      setHeader: (name, value) => headers.push([name, value]),
      status: code => ({ end: () => code })
    }

    handler(req, res)

    const setCookies = headers
      .filter(([name]) => name === 'Set-Cookie')
      .flatMap(([, value]) => value)
    // pointer and list still switch to the next account ...
    expect(setCookies.some(c => c.startsWith(`${auth.MULTI_AUTH_POINTER}=42;`))).toBe(true)
    // ... but the session cookie is never written with an undecryptable value
    expect(setCookies.some(c => c.startsWith(`${auth.SESSION_COOKIE}=`))).toBe(false)
    expect(handler(req, res)).toBe(302)
  })

  test('cleanup path clears a corrupt multi-auth list cookie without throwing', () => {
    const auth = loadAuth()
    const handler = require(`${ROOT}/pages/api/next-account`).default

    const headers = []
    const req = {
      method: 'POST',
      cookies: {
        [auth.MULTI_AUTH_POINTER]: '7',
        [auth.MULTI_AUTH_LIST]: Buffer.from('not-json').toString('base64')
      }
    }
    const res = {
      setHeader: (name, value) => headers.push([name, value]),
      status: code => ({ end: () => code })
    }

    expect(() => handler(req, res)).not.toThrow()
    expect(handler(req, res)).toBe(204)

    const setCookies = headers
      .filter(([name]) => name === 'Set-Cookie')
      .flatMap(([, value]) => value)
    const listClear = setCookies.find(c =>
      c.startsWith(`${auth.MULTI_AUTH_LIST}=;`) && c.includes('Max-Age=0'))
    expect(listClear).toBeDefined()
  })
})
