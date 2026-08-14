/* eslint-env jest */
import { validateEnv, assertExplicitNodeEnv } from '@/lib/env'

const GOOD = {
  DATABASE_URL: 'postgres://u:p@h:5432/db',
  NEXTAUTH_SECRET: 'real-secret-value',
  JWT_SIGNING_PRIVATE_KEY: 'real-key',
  EMAIL_SALT: 'real-salt',
  VIEWKEY_MASTER_KEY: 'a2V5AAAAAAAAAAAAAAAAAAAAAA==',
  LWS_WEBHOOK_TOKEN: 'real-token',
  MONERO_LWS_ADMIN_AUTH: 'real-admin-key',
  NEXTAUTH_URL: 'https://stasher.news',
  NEXT_PUBLIC_URL: 'https://stasher.news',
  LOGIN_EMAIL_SERVER: 'smtps://resend:real-key@smtp.resend.com:465',
  LOGIN_EMAIL_FROM: 'login@stasher.news'
}

test('passes in production when all required vars are set', () => {
  expect(() => validateEnv({ env: GOOD, nodeEnv: 'production' })).not.toThrow()
})

test('throws in production when a required var is missing', () => {
  const env = { ...GOOD, NEXTAUTH_SECRET: '' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/NEXTAUTH_SECRET/)
})

test('throws in production when a required var is the insecure default "changeme"', () => {
  const env = { ...GOOD, EMAIL_SALT: 'changeme' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/EMAIL_SALT/)
})

test('throws in production when DATABASE_URL embeds "changeme" as the password', () => {
  const env = { ...GOOD, DATABASE_URL: 'postgresql://sn:changeme@db:5432/x?schema=public' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/DATABASE_URL/)
})

test('throws in production when NEXTAUTH_URL points at localhost', () => {
  const env = { ...GOOD, NEXTAUTH_URL: 'http://localhost:3000/api/auth' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/NEXTAUTH_URL/)
})

test('throws in production when LOGIN_EMAIL_SERVER targets mailhog', () => {
  const env = { ...GOOD, LOGIN_EMAIL_SERVER: 'smtp://mailhog:1025' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/LOGIN_EMAIL_SERVER/)
})

test('throws in production when LOGIN_EMAIL_FROM is the dev sender', () => {
  const env = { ...GOOD, LOGIN_EMAIL_FROM: 'sndev@mailhog.dev' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/LOGIN_EMAIL_FROM/)
})

test('throws in production when NEXT_PUBLIC_URL points at localhost', () => {
  const env = { ...GOOD, NEXT_PUBLIC_URL: 'http://localhost:3000' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/NEXT_PUBLIC_URL/)
})

test('does not throw in non-production even with insecure defaults', () => {
  expect(() => validateEnv({ env: {}, nodeEnv: 'development' })).not.toThrow()
})

describe('assertExplicitNodeEnv', () => {
  it('accepts explicit development, test, production', () => {
    expect(() => assertExplicitNodeEnv({ nodeEnv: 'development' })).not.toThrow()
    expect(() => assertExplicitNodeEnv({ nodeEnv: 'test' })).not.toThrow()
    expect(() => assertExplicitNodeEnv({ nodeEnv: 'production' })).not.toThrow()
  })

  it('rejects unset NODE_ENV', () => {
    // brief passed { nodeEnv: undefined }, but the destructuring default then
    // substitutes the ambient process.env.NODE_ENV (a recognized value under
    // jest), so the rejection can never fire. Simulate the real no-arg call
    // path (how worker/index.js invokes it) with NODE_ENV actually unset.
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      expect(() => assertExplicitNodeEnv())
        .toThrow(/NODE_ENV must be explicitly set/)
    } finally {
      process.env.NODE_ENV = saved
    }
  })

  it('rejects unrecognized values like "staging"', () => {
    expect(() => assertExplicitNodeEnv({ nodeEnv: 'staging' }))
      .toThrow(/NODE_ENV must be explicitly set/)
  })
})
