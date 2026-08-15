/* eslint-env jest */
// Regression test: resetMultiAuthCookies (lib/auth.js) must rebuild the
// multi-auth account list from scratch when it detects inconsistency.
// Appending to the stale list keeps ids whose JWT cookies were just deleted
// (or are invalid), so checkMultiAuthCookies fails on EVERY subsequent
// request and the browser gets reset in a loop — while ssrApollo (which
// applies multiAuthMiddleware) and /login|/signup (which read the raw
// session) permanently disagree about the session, producing an infinite
// 307 ping-pong between auth-required pages and /signup.
jest.mock('next-auth/jwt', () => ({
  encode: jest.fn(async ({ token }) => token ? `ENC(${token.id})` : 'ENC()'),
  decode: jest.fn(async ({ token }) => {
    if (typeof token !== 'string' || !token || token === 'GARBAGE') {
      throw new Error('invalid token')
    }
    return { id: 42, name: 'current', photoId: null, exp: Math.floor(Date.now() / 1000) + 3600 }
  })
}))

const path = require('path')
const ROOT = path.join(__dirname, '..', '..')

const b64Encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64')

describe('multi-auth cookie reset', () => {
  const loadAuth = () => {
    jest.resetModules()
    process.env.NEXTAUTH_SECRET = 'test-secret'
    return require(`${ROOT}/lib/auth`)
  }

  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  const makeReq = cookies => ({ cookies, headers: {} })
  const makeRes = () => {
    const headers = []
    return {
      appendHeader (name, value) {
        headers.push([name, value])
      },
      get setCookies () {
        return headers.filter(([name]) => name === 'Set-Cookie').map(([, value]) => value)
      }
    }
  }

  const cookieValue = (setCookies, name) => {
    // responses contain both the clear (Max-Age=0) and the re-issued cookie;
    // the browser applies them in order, so the last one wins
    const matches = setCookies.filter(c => c.startsWith(`${name}=`))
    if (!matches.length) return undefined
    const raw = matches[matches.length - 1]
    // cookie.serialize percent-encodes the value (e.g. base64 '=' -> %3D)
    return decodeURIComponent(raw.split('=').slice(1).join('=').split(';')[0])
  }

  test('rebuilds the account list from scratch when a listed JWT is invalid', async () => {
    const auth = loadAuth()

    const staleList = b64Encode([{ id: 7, name: 'stale' }, { id: 42, name: 'current' }])
    const req = makeReq({
      [auth.MULTI_AUTH_LIST]: staleList,
      [auth.MULTI_AUTH_POINTER]: '7',
      [auth.MULTI_AUTH_JWT(7)]: 'GARBAGE',
      [auth.MULTI_AUTH_JWT(42)]: 'session-jwt',
      [auth.SESSION_COOKIE]: 'session-jwt'
    })
    const res = makeRes()

    await auth.multiAuthMiddleware(req, res)

    const listRaw = cookieValue(res.setCookies, auth.MULTI_AUTH_LIST)
    expect(listRaw).toBeDefined()
    const list = JSON.parse(Buffer.from(listRaw, 'base64'))
    // the stale account (whose JWT no longer exists) must be pruned
    expect(list.map(a => a.id)).toEqual([42])
    expect(cookieValue(res.setCookies, auth.MULTI_AUTH_POINTER)).toBe('42')
  })

  test('drops accounts from the list whose JWT cookies are missing entirely', async () => {
    const auth = loadAuth()

    const staleList = b64Encode([{ id: 7, name: 'stale' }, { id: 42, name: 'current' }])
    const req = makeReq({
      [auth.MULTI_AUTH_LIST]: staleList,
      [auth.MULTI_AUTH_POINTER]: '7',
      [auth.MULTI_AUTH_JWT(42)]: 'session-jwt',
      [auth.SESSION_COOKIE]: 'session-jwt'
    })
    const res = makeRes()

    await auth.multiAuthMiddleware(req, res)

    const listRaw = cookieValue(res.setCookies, auth.MULTI_AUTH_LIST)
    expect(listRaw).toBeDefined()
    const list = JSON.parse(Buffer.from(listRaw, 'base64'))
    expect(list.map(a => a.id)).toEqual([42])
  })

  test('does not throw and expires the session cookie when it cannot be decrypted', async () => {
    const auth = loadAuth()

    const req = makeReq({
      // decodeJWT mock (top of file) throws on 'GARBAGE'
      [auth.SESSION_COOKIE]: 'GARBAGE'
    })
    const res = makeRes()

    await expect(auth.multiAuthMiddleware(req, res)).resolves.toBeDefined()

    const sessionClear = res.setCookies.find(c =>
      c.startsWith(`${auth.SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))
    expect(sessionClear).toBeDefined()
  })

  test('does not throw on a corrupt multi-auth list cookie (non-JSON)', async () => {
    const auth = loadAuth()

    const req = makeReq({
      [auth.MULTI_AUTH_LIST]: Buffer.from('not-json').toString('base64'),
      [auth.MULTI_AUTH_POINTER]: '7',
      [auth.SESSION_COOKIE]: 'session-jwt'
    })
    const res = makeRes()

    await expect(auth.multiAuthMiddleware(req, res)).resolves.toBeDefined()

    // reset path expired the corrupt list cookie
    const listClear = res.setCookies.find(c =>
      c.startsWith(`${auth.MULTI_AUTH_LIST}=;`) && c.includes('Max-Age=0'))
    expect(listClear).toBeDefined()
  })

  test('does not throw on a list cookie that decodes to non-array JSON', async () => {
    const auth = loadAuth()

    const req = makeReq({
      [auth.MULTI_AUTH_LIST]: Buffer.from('{}').toString('base64'),
      [auth.MULTI_AUTH_POINTER]: '7',
      [auth.SESSION_COOKIE]: 'session-jwt'
    })
    const res = makeRes()

    await expect(auth.multiAuthMiddleware(req, res)).resolves.toBeDefined()

    // reset path expired the corrupt list cookie
    const listClear = res.setCookies.find(c =>
      c.startsWith(`${auth.MULTI_AUTH_LIST}=;`) && c.includes('Max-Age=0'))
    expect(listClear).toBeDefined()
  })

  test('does not throw and expires an undecryptable session cookie under an anon pointer', async () => {
    const auth = loadAuth()

    const list = Buffer.from(JSON.stringify([{ id: 7, name: 'stale' }])).toString('base64')
    const req = makeReq({
      [auth.MULTI_AUTH_LIST]: list,
      [auth.MULTI_AUTH_POINTER]: auth.MULTI_AUTH_ANON,
      [auth.MULTI_AUTH_JWT(7)]: 'valid-jwt',
      [auth.SESSION_COOKIE]: 'GARBAGE'
    })
    const res = makeRes()

    await expect(auth.multiAuthMiddleware(req, res)).resolves.toBeDefined()

    const sessionClear = res.setCookies.find(c =>
      c.startsWith(`${auth.SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))
    expect(sessionClear).toBeDefined()
  })
})
