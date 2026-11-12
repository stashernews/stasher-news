/* eslint-env jest */
import { getAuthOptions } from '../../pages/api/auth/[...nextauth]'
import { isOnionOriginUrl, mirrorAuthCallbackUrl } from '@/lib/safe-url'

// Same api/models mock pattern as test/api/gate.test.js: build NextAuth
// options without touching Prisma (or needing DATABASE_URL at import time).
jest.mock(`${process.cwd()}/api/models`, () => ({ __esModule: true, default: {} }))

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
