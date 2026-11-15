/* eslint-env jest */
import { createHash } from 'node:crypto'
import http from 'node:http'
import NextAuth from 'next-auth'
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver'
import nextAuthHandler, { getAuthOptions } from '../../pages/api/auth/[...nextauth]'
import { isOnionOriginUrl, mirrorAuthCallbackUrl, mirrorAuthRedirectRes } from '@/lib/safe-url'

// Same api/models mock pattern as test/api/gate.test.js: build NextAuth
// options without touching Prisma (or needing DATABASE_URL at import time).
jest.mock(`${process.cwd()}/api/models`, () => ({ __esModule: true, default: {} }))

// @auth/prisma-adapter conditionally omits model-backed methods when the
// client lacks models, so the {} mock above would trip next-auth's
// email-provider adapter assertion (createVerificationToken). Supply the one
// asserted method that getAuthOptions does not already override.
jest.mock('@auth/prisma-adapter', () => ({
  __esModule: true,
  PrismaAdapter: () => ({ createVerificationToken: async () => null })
}))

// Domain lookups are DB-backed; the redirect callback's fallback path only
// needs "no custom domain" (null), which the real fetcher also produces on
// error. Mock for determinism.
jest.mock(`${process.cwd()}/lib/domains`, () => ({
  __esModule: true,
  getDomainMapping: async () => null,
  getDomainBranding: async () => null
}))

// mdast's toolchain is ESM-only and cannot load in jest's CJS sandbox; the
// user-resolver suites mock the first-party lexical seam for the same reason
// (see test/api/resolvers/user-auth-methods.test.js). The redirect callback
// never parses markdown, so a stub is safe.
jest.mock(`${process.cwd()}/lib/lexical/server/mentions`, () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))

// The payIn barrel instantiates its Prisma client at module load (and drags
// the item-type graph with it); the user-resolver suites mock it wholesale
// for the same reason (see test/api/monero/topSubsRevenue.test.js).
jest.mock(`${process.cwd()}/api/payIn`, () => ({
  __esModule: true,
  default: {}
}))

// components/editor (via the item resolvers) pulls Lexical and its
// ESM-only deps (github-slugger et al.); same wholesale mock as
// test/api/monero/topSubsRevenue.test.js.
jest.mock(`${process.cwd()}/components/editor`, () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

// lib/lexical/server/html builds Lexical nodes (whose graph needs ESM-only
// deps like github-slugger); same mock as test/api/monero/topSubsRevenue.test.js.
jest.mock(`${process.cwd()}/lib/lexical/server/html`, () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const ONION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion'
const EVIL = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion'
const CANONICAL = 'https://stasher.news'

// The onion mirror serves this same app behind http://<ONION_HOST>, while
// NEXTAUTH_URL pins the canonical clearnet origin. next-auth v4 resolves
// every login callbackUrl through the app's redirect callback ({url, baseUrl},
// no request object), so without an explicit allowlist a successful mirror
// login is rewritten to clearnet — where the host-scoped session cookie the
// mirror just issued does not apply. The allowlist trust root is deployment
// config (ONION_HOST, gated by the onion overlay), never user input.

let redirect

beforeAll(() => {
  process.env.NEXTAUTH_SECRET ??= 'x'.repeat(32)
  process.env.NEXT_PUBLIC_URL = CANONICAL
  redirect = getAuthOptions({ headers: {} }, {}).callbacks.redirect
})

describe('auth redirect callback onion allowlist', () => {
  afterEach(() => {
    delete process.env.ONION_HOST
  })

  test('keeps a mirror-origin callback on the mirror', async () => {
    process.env.ONION_HOST = ONION
    const url = `http://${ONION}/`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(url)
  })

  test('keeps deep mirror paths and queries intact', async () => {
    process.env.ONION_HOST = ONION
    const url = `http://${ONION}/rewards?x=1`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(url)
  })

  test('rejects a lookalike onion host', async () => {
    process.env.ONION_HOST = ONION
    const url = `http://${EVIL}/`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(CANONICAL)
  })

  test('rejects https even for the configured mirror', async () => {
    process.env.ONION_HOST = ONION
    const url = `https://${ONION}/`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(CANONICAL)
  })

  test('rejects a port-suffixed impersonation', async () => {
    process.env.ONION_HOST = ONION
    const url = `http://${ONION}:8080/`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(CANONICAL)
  })

  test('allows nothing when ONION_HOST is unset', async () => {
    const url = `http://${ONION}/`
    await expect(redirect({ url, baseUrl: CANONICAL })).resolves.toBe(CANONICAL)
  })

  test('relative callbacks still resolve against the canonical origin', async () => {
    process.env.ONION_HOST = ONION
    await expect(redirect({ url: '/x', baseUrl: CANONICAL })).resolves.toBe(`${CANONICAL}/x`)
  })
})

describe('isOnionOriginUrl', () => {
  test('true only for an exact plain-http host match', () => {
    expect(isOnionOriginUrl(`http://${ONION}/a`, ONION)).toBe(true)
    expect(isOnionOriginUrl(`http://${ONION.toUpperCase()}/`, ONION)).toBe(true)
    expect(isOnionOriginUrl(`https://${ONION}/`, ONION)).toBe(false)
    expect(isOnionOriginUrl(`http://${EVIL}/`, ONION)).toBe(false)
    expect(isOnionOriginUrl(`http://${ONION}:8080/`, ONION)).toBe(false)
    expect(isOnionOriginUrl('http://example.com/', ONION)).toBe(false)
    expect(isOnionOriginUrl('/relative', ONION)).toBe(false)
    expect(isOnionOriginUrl('not a url', ONION)).toBe(false)
  })

  test('false without a configured mirror', () => {
    expect(isOnionOriginUrl(`http://${ONION}/`, undefined)).toBe(false)
    expect(isOnionOriginUrl(`http://${ONION}/`, '')).toBe(false)
    expect(isOnionOriginUrl(`http://${ONION}/`, '   ')).toBe(false)
  })

  test('false when the configured value is not a v3 onion address', () => {
    // an operator typo must fail closed: a clearnet host in ONION_HOST must
    // not allowlist that host's plain-http origin
    expect(isOnionOriginUrl('http://example.com/', 'example.com')).toBe(false)
    expect(isOnionOriginUrl('http://stasher.news/', 'stasher.news')).toBe(false)
    expect(isOnionOriginUrl(`http://${ONION.slice(0, 10)}.onion/`, `${ONION.slice(0, 10)}.onion`)).toBe(false)
  })
})

describe('mirrorAuthCallbackUrl', () => {
  const onionLoc = { hostname: ONION, origin: `http://${ONION}` }
  const clearnetLoc = { hostname: 'stasher.news', origin: CANONICAL }

  test('absolutizes a relative path against the mirror origin', () => {
    expect(mirrorAuthCallbackUrl('/', onionLoc)).toBe(`http://${ONION}/`)
    expect(mirrorAuthCallbackUrl('/rewards', onionLoc)).toBe(`http://${ONION}/rewards`)
  })

  test('treats a missing callbackUrl as the mirror root', () => {
    expect(mirrorAuthCallbackUrl(undefined, onionLoc)).toBe(`http://${ONION}/`)
  })

  test('leaves already-absolute URLs untouched (idempotent)', () => {
    const abs = `http://${ONION}/x`
    expect(mirrorAuthCallbackUrl(abs, onionLoc)).toBe(abs)
  })

  test('is a no-op off the mirror', () => {
    expect(mirrorAuthCallbackUrl('/x', clearnetLoc)).toBe('/x')
    expect(mirrorAuthCallbackUrl(undefined, clearnetLoc)).toBe(undefined)
  })

  test('is a no-op without a location (SSR)', () => {
    expect(mirrorAuthCallbackUrl('/x', null)).toBe('/x')
  })
})

// next-auth v4 pins its internal URL to NEXTAUTH_URL for every request, so
// every redirect it emits on mirror traffic is clearnet-shaped: the post-send
// verify-request hop (which bounced the visitor to clearnet /email, where the
// origin-scoped sessionStorage leaves the magic-code form permanently
// disabled), the CSRF and error bounces, and the post-login redirect. All of
// them leave the handler through exactly two doors — the Location header or
// the JSON {url} body — so the app rewrites the canonical origin to the
// mirror origin there, for requests that verifiably arrived on the mirror.
describe('mirrorAuthRedirectRes', () => {
  const onionReq = { headers: { host: ONION, 'x-forwarded-proto': 'http' } }
  const clearnetReq = { headers: { host: 'stasher.news', 'x-forwarded-proto': 'https' } }

  const makeRes = () => {
    const res = {
      headers: new Map(),
      setCookies: [],
      body: undefined,
      setHeader (name, value) { res.headers.set(String(name).toLowerCase(), value); return res },
      appendHeader (name, value) { res.setCookies.push([name, value]); return res },
      json (body) { res.body = body; return res }
    }
    return res
  }

  beforeEach(() => {
    process.env.NEXTAUTH_URL = CANONICAL
    process.env.ONION_HOST = ONION
  })

  afterEach(() => {
    delete process.env.NEXTAUTH_URL
    delete process.env.ONION_HOST
  })

  test('rewrites a canonical Location to the mirror origin, path and query intact', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.setHeader('Location', `${CANONICAL}/api/auth/verify-request?provider=email&type=email`)
    expect(res.headers.get('location')).toBe(`http://${ONION}/api/auth/verify-request?provider=email&type=email`)
  })

  test('rewrites the url field of JSON redirect bodies', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.json({ url: `${CANONICAL}/api/auth/signin?csrf=true` })
    expect(res.body.url).toBe(`http://${ONION}/api/auth/signin?csrf=true`)
  })

  test('leaves JSON bodies without a url field alone', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.json({ csrfToken: 'abc' })
    expect(res.body).toEqual({ csrfToken: 'abc' })
  })

  test('passes relative Locations through unchanged', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.setHeader('Location', '/email')
    expect(res.headers.get('location')).toBe('/email')
  })

  test('passes foreign-origin Locations through unchanged', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    const githubUrl = 'https://github.com/login/oauth/authorize?client_id=x'
    wrapped.setHeader('Location', githubUrl)
    expect(res.headers.get('location')).toBe(githubUrl)
  })

  test('rejects a canonical-host lookalike origin', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.setHeader('Location', 'https://stasher.news.evil.com/api/auth/signin?csrf=true')
    expect(res.headers.get('location')).toBe('https://stasher.news.evil.com/api/auth/signin?csrf=true')
  })

  test('passes non-Location headers through untouched', () => {
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.setHeader('Content-Type', 'application/json')
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  test('cookie writes on the underlying response still land while Locations are rewritten', () => {
    // the auth callbacks hold the real res (Set-Cookie appends) while
    // next-auth writes the redirect through the wrapper — both must stick
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(onionReq, res)
    wrapped.setHeader('Location', `${CANONICAL}/email`)
    res.appendHeader('Set-Cookie', 'next-auth.session-token=jwt; Path=/')
    expect(res.headers.get('location')).toBe(`http://${ONION}/email`)
    expect(res.setCookies).toEqual([['Set-Cookie', 'next-auth.session-token=jwt; Path=/']])
  })

  test('returns the response unchanged off the mirror', () => {
    const res = makeRes()
    expect(mirrorAuthRedirectRes(clearnetReq, res)).toBe(res)
  })

  test('returns the response unchanged when ONION_HOST is unset', () => {
    delete process.env.ONION_HOST
    const res = makeRes()
    expect(mirrorAuthRedirectRes(onionReq, res)).toBe(res)
  })

  test('returns the response unchanged when ONION_HOST is not a v3 onion address', () => {
    process.env.ONION_HOST = 'stasher.news'
    const res = makeRes()
    expect(mirrorAuthRedirectRes(onionReq, res)).toBe(res)
  })

  test('does not activate on a request that only spoofs the Host header', () => {
    // an attacker on clearnet cannot flip rewriting on for a non-mirror
    // request: the forwarded host disagrees with the configured mirror
    const req = { headers: { host: ONION, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }
    const res = makeRes()
    expect(mirrorAuthRedirectRes(req, res)).toBe(res)
  })

  test('honors x-forwarded-host when the proxy forwards the real mirror host', () => {
    const req = { headers: { host: 'internal-app:3000', 'x-forwarded-host': ONION, 'x-forwarded-proto': 'http' } }
    const res = makeRes()
    const wrapped = mirrorAuthRedirectRes(req, res)
    wrapped.setHeader('Location', `${CANONICAL}/api/auth/verify-request`)
    expect(res.headers.get('location')).toBe(`http://${ONION}/api/auth/verify-request`)
  })
})

// Exercise the real auth handler's JSON responses. HTTP redirect chaining
// additionally needs a real ServerResponse, covered in the next describe.
describe('next-auth handler integration: auth redirects stay on the mirror', () => {
  const makeHandlerRes = () => {
    const res = {
      statusCode: 200,
      headers: new Map(),
      body: undefined,
      getHeader (name) { return res.headers.get(String(name).toLowerCase()) },
      setHeader (name, value) { res.headers.set(String(name).toLowerCase(), value); return res },
      status (code) { res.statusCode = code; return res },
      json (body) { res.body = body; return res },
      send (body) { res.body = body; return res },
      end () { return res }
    }
    return res
  }

  const onionPost = (body, cookies = {}) => ({
    method: 'POST',
    query: { nextauth: ['signin', 'email'] },
    body,
    cookies,
    headers: { host: ONION, 'x-forwarded-proto': 'http' }
  })

  beforeEach(() => {
    process.env.NEXTAUTH_URL = CANONICAL
    process.env.ONION_HOST = ONION
    process.env.LOGIN_EMAIL_SERVER = 'smtp://test:test@localhost:1025'
    process.env.LOGIN_EMAIL_FROM = 'login@stasher.news'
  })

  afterEach(() => {
    delete process.env.NEXTAUTH_URL
    delete process.env.ONION_HOST
    delete process.env.LOGIN_EMAIL_SERVER
    delete process.env.LOGIN_EMAIL_FROM
  })

  test('an email signin that fails CSRF reports a mirror url, not clearnet', async () => {
    // the observed mirror failure shape: a valid cookie jar whose CSRF token
    // cannot be verified against the Secure-attributed __Host- cookie over
    // plain http — the bounce must at least stay in-circuit
    const res = makeHandlerRes()
    const req = onionPost({ email: 'user@example.com', csrfToken: 'deadbeef', json: 'true' }, {})
    await nextAuthHandler(req, res)
    expect(res.body.url).toBe(`http://${ONION}/api/auth/signin?csrf=true`)
  })

  test('an email signin that fails validation reports a mirror url, not clearnet', async () => {
    // CSRF passes (Tor-Browser-class jar), but the address is malformed:
    // next-auth bounces to its error page — that bounce must stay in-circuit
    const csrfToken = 'f'.repeat(64)
    const csrfHash = createHash('sha256')
      .update(`${csrfToken}${process.env.NEXTAUTH_SECRET}`)
      .digest('hex')
    const res = makeHandlerRes()
    const req = onionPost(
      { email: 'not-an-email', csrfToken, callbackUrl: `http://${ONION}/`, json: 'true' },
      { '__Host-next-auth.csrf-token': `${csrfToken}|${csrfHash}` }
    )
    await nextAuthHandler(req, res)
    expect(res.body.url).toBe(`http://${ONION}/api/auth/error?error=EmailSignin`)
  })
})

// Real HTTP responses are essential: Next.js's status/json helpers close over
// the original ServerResponse, so prototype-based doubles miss chaining bugs.
describe('onion auth over HTTP through the Next.js API resolver', () => {
  let server
  let port
  let savedToken
  let sentCode
  let failDelivery = false
  const email = 'fixture@example.com'
  const token = 'abc123'
  const user = { id: '1', name: 'Fixture', email, emailVerified: new Date() }
  const previousEnv = {}

  beforeAll(async () => {
    for (const key of ['NEXTAUTH_URL', 'ONION_HOST', 'LOGIN_EMAIL_SERVER', 'LOGIN_EMAIL_FROM']) {
      previousEnv[key] = process.env[key]
    }
    process.env.NEXTAUTH_URL = CANONICAL
    process.env.ONION_HOST = ONION
    process.env.LOGIN_EMAIL_SERVER = 'smtp://localhost:1025'
    process.env.LOGIN_EMAIL_FROM = email
    server = http.createServer((req, res) => {
      const url = new URL(req.url, CANONICAL)
      const query = { ...Object.fromEntries(url.searchParams), nextauth: url.pathname.split('/').slice(3) }
      const handler = async (req, res) => {
        if (url.pathname === '/chain') {
          const response = mirrorAuthRedirectRes(req, res)
          response.status(302).setHeader('Location', `${CANONICAL}/target?q=1#section`)
          response.appendHeader('Set-Cookie', 'fixture=dummy; Path=/; HttpOnly')
          response.end()
          return
        }
        if (!url.pathname.startsWith('/fixture/')) {
          await nextAuthHandler(req, res)
          return
        }
        // Keep the app's redirect rules and installed auth/HTTP machinery;
        // replace only database, email and account-cookie side effects.
        req.query.nextauth = url.pathname.split('/').slice(2)
        const options = getAuthOptions(req, res)
        options.adapter = {
          createVerificationToken: async value => { savedToken = value; return value },
          useVerificationToken: async ({ token }) => {
            if (savedToken?.token !== token) return null
            const value = savedToken
            savedToken = null
            return value
          },
          getUserByEmail: async () => user,
          updateUser: async () => user
        }
        const provider = options.providers.find(provider => provider.id === 'email')
        provider.options.generateVerificationToken = () => token
        provider.options.sendVerificationRequest = async ({ token }) => {
          if (failDelivery) throw new Error('fixture email delivery failure')
          sentCode = token
        }
        options.callbacks.jwt = async ({ token }) => token
        await NextAuth(req, mirrorAuthRedirectRes(req, res), options)
      }
      apiResolver(req, res, query, handler, {}, false, false, '/api/auth/[...nextauth]')
        .catch(() => { res.statusCode = 500; res.end() })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const request = (path, { host = ONION, body, cookie } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: body ? 'POST' : 'GET',
      headers: {
        host,
        'x-forwarded-proto': host === ONION ? 'http' : 'https',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(cookie ? { cookie } : {})
      }
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('local HTTP fixture timed out')))
    req.on('error', reject)
    req.end(body?.toString())
  })

  const submitEmail = async () => {
    const csrf = await request('/api/auth/csrf')
    const csrfToken = JSON.parse(csrf.body).csrfToken
    const cookie = csrf.headers['set-cookie'].map(value => value.split(';')[0]).join('; ')
    const result = await request('/fixture/signin/email', {
      cookie,
      body: new URLSearchParams({ csrfToken, email, callbackUrl: '/target', json: 'true' })
    })
    expect(result.status).toBe(200)
    return result
  }

  test('status chaining rewrites Location and preserves status and cookie writes', async () => {
    const result = await request('/chain')
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(`http://${ONION}/target?q=1#section`)
    expect(result.headers['set-cookie']).toEqual(['fixture=dummy; Path=/; HttpOnly'])
  })

  test('the real email error redirect chain stays on onion', async () => {
    const result = await request('/api/auth/error?error=EmailSignin')
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(`http://${ONION}/api/auth/signin?error=EmailSignin`)
    const next = await request(new URL(result.headers.location).pathname + new URL(result.headers.location).search)
    expect(next.status).toBe(302)
    expect(next.headers.location).toMatch(/^\/login\?/)
  })

  test('successful send and code verification stay on onion and emit a protected session', async () => {
    const sent = await submitEmail()
    expect(sentCode).toBe(token)
    expect(JSON.parse(sent.body).url).toBe(`http://${ONION}/api/auth/verify-request?provider=email&type=email`)
    const verification = await request(new URL(JSON.parse(sent.body).url).pathname)
    expect(verification.status).toBe(302)
    expect(verification.headers.location).toBe('/email')
    const result = await request('/fixture/callback/email?' + new URLSearchParams({
      email, token, callbackUrl: `${CANONICAL}/target`
    }))
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(`http://${ONION}/target`)
    expect(result.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Secure-next-auth\.session-token=.+;.*HttpOnly; Secure; SameSite=Lax/)
    ]))
  })

  test('wrong-code redirects and the final error page stay on onion', async () => {
    await submitEmail()
    const result = await request('/fixture/callback/email?' + new URLSearchParams({ email, token: 'wrong1' }))
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(`http://${ONION}/api/auth/error?error=Verification`)
    const next = await request('/api/auth/error?error=Verification')
    expect(next.status).toBe(302)
    expect(next.headers.location).toBe('/auth/error?error=Verification')
  })

  test('a delivery failure returns an onion JSON target and onion HTTP redirects', async () => {
    failDelivery = true
    try {
      const sent = await submitEmail()
      expect(JSON.parse(sent.body).url).toBe(`http://${ONION}/api/auth/error?error=EmailSignin`)
      const error = await request('/api/auth/error?error=EmailSignin')
      expect(error.status).toBe(302)
      expect(error.headers.location).toBe(`http://${ONION}/api/auth/signin?error=EmailSignin`)
      const login = await request('/api/auth/signin?error=EmailSignin')
      expect(login.headers.location).toMatch(/^\/login\?/)
    } finally {
      failDelivery = false
    }
  })

  test('clearnet error redirects keep their canonical origin', async () => {
    const result = await request('/api/auth/error?error=EmailSignin', { host: 'stasher.news' })
    expect(result.status).toBe(302)
    expect(result.headers.location).toBe(`${CANONICAL}/api/auth/signin?error=EmailSignin`)
  })
})
