/* eslint-env jest */
// lib/auth imports next-auth/jwt (ESM-only under jest CJS require) so mock it
// at the module boundary, same pattern as test/lib/invite-gate.test.js
jest.mock('next-auth/jwt', () => ({ encode: jest.fn(), decode: jest.fn() }))

describe('cookie names (secureCookie)', () => {
  const loadAuth = () => {
    jest.resetModules()
    return require(`${process.cwd()}/lib/auth`)
  }

  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test.each([
    { desc: 'https NEXTAUTH_URL with dev NODE_ENV (VPS: dev server behind TLS)', env: { NEXTAUTH_URL: 'https://stasher.news', NODE_ENV: 'development' }, secure: true },
    { desc: 'https NEXTAUTH_URL with prod NODE_ENV (production build)', env: { NEXTAUTH_URL: 'https://stasher.news', NODE_ENV: 'production' }, secure: true },
    { desc: 'http NEXTAUTH_URL localhost dev', env: { NEXTAUTH_URL: 'http://localhost:3000', NODE_ENV: 'development' }, secure: false },
    { desc: 'no NEXTAUTH_URL, https NEXT_PUBLIC_URL fallback (client bundle)', env: { NEXTAUTH_URL: undefined, NEXT_PUBLIC_URL: 'https://stasher.news', NODE_ENV: 'development' }, secure: true },
    { desc: 'no NEXTAUTH_URL, http NEXT_PUBLIC_URL fallback', env: { NEXTAUTH_URL: undefined, NEXT_PUBLIC_URL: 'http://localhost:3000', NODE_ENV: 'production' }, secure: false }
  ])('uses $desc -> secure=$secure', ({ env, secure }) => {
    for (const key of ['NEXTAUTH_URL', 'NEXT_PUBLIC_URL', 'NODE_ENV']) {
      if (env[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = env[key]
      }
    }

    const auth = loadAuth()
    const prefix = secure ? '__Secure-' : ''

    expect(auth.SESSION_COOKIE).toBe(`${prefix}next-auth.session-token`)
    expect(auth.MULTI_AUTH_LIST).toBe(`${prefix}multi_auth`)
    expect(auth.MULTI_AUTH_POINTER).toBe(`${prefix}multi_auth.user-id`)
    expect(auth.MULTI_AUTH_JWT(42)).toBe(`${prefix}multi_auth.42`)
  })

  test('matches the name next-auth itself would use on an https site', () => {
    // next-auth picks its session cookie name via NEXTAUTH_URL.startsWith('https://')
    process.env.NEXTAUTH_URL = 'https://stasher.news'
    process.env.NODE_ENV = 'development'

    const auth = loadAuth()
    expect(auth.SESSION_COOKIE).toBe('__Secure-next-auth.session-token')
  })
})
