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
  LOGIN_EMAIL_FROM: 'login@stasher.news',
  IMGPROXY_KEY: '1'.repeat(64),
  IMGPROXY_SALT: '2'.repeat(64),
  OPENSEARCH_PASSWORD: 'real-opensearch-password',
  CAPTURE_MEDIA_TOKEN: 'real-capture-token',
  REWARDS_PID_KEY: 'a-long-random-production-key'
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

test('throws in production when IMGPROXY_KEY equals the committed dev value', () => {
  // read the committed dev value the same way the PROD_MUST_DIFFER mechanism does
  // (the committed lines may be commented out — the placeholder is the guard value)
  const devKey = require('fs').readFileSync('.env.development', 'utf8').match(/^#?\s*IMGPROXY_KEY=(\w+)$/m)[1]
  const env = { ...GOOD, IMGPROXY_KEY: devKey }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/IMGPROXY_KEY/)
})

test('throws in production when IMGPROXY_SALT equals the committed dev value', () => {
  // read the committed dev value the same way the PROD_MUST_DIFFER mechanism does
  const devSalt = require('fs').readFileSync('.env.development', 'utf8').match(/^#?\s*IMGPROXY_SALT=(\w+)$/m)[1]
  const env = { ...GOOD, IMGPROXY_SALT: devSalt }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/IMGPROXY_SALT/)
})

test('throws in production when IMGPROXY_KEY equals the leaked pre-release dev value', () => {
  // the old committed dev values were dropped from .env.development for the
  // public release but live on in git history — a prod boot carrying them
  // must still fail validation
  const env = { ...GOOD, IMGPROXY_KEY: '73b5187ddbc1db70c74164dbcac1f40376413e2c0eedf55b70f10bd7abbe4240' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/IMGPROXY_KEY/)
})

test('throws in production when IMGPROXY_SALT equals the leaked pre-release dev value', () => {
  const env = { ...GOOD, IMGPROXY_SALT: 'd0f1305e990d1c15b03c1989ac6c72f6a1c6d58b0a855894b7844b18f271671c' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/IMGPROXY_SALT/)
})

test('throws in production when CAPTURE_MEDIA_TOKEN equals the committed dev value', () => {
  // read the committed dev value the same way the PROD_MUST_DIFFER mechanism does
  // (\w alone can't match the hyphenated dev value)
  const devToken = require('fs').readFileSync('.env.development', 'utf8').match(/^CAPTURE_MEDIA_TOKEN=([\w-]+)$/m)[1]
  const env = { ...GOOD, CAPTURE_MEDIA_TOKEN: devToken }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/CAPTURE_MEDIA_TOKEN/)
})

test('throws in production when REWARDS_PID_KEY is unset', () => {
  const env = { ...GOOD }
  delete env.REWARDS_PID_KEY
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/REWARDS_PID_KEY/)
})

test('throws in production when REWARDS_PID_KEY is the committed dev default', () => {
  // the committed default lives in api/monero/paymentId.js (DEFAULT_PID_KEY),
  // not in a tracked env file, so assert the literal guard value here
  const env = { ...GOOD, REWARDS_PID_KEY: 'stashernews-dev-pid-key' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/REWARDS_PID_KEY/)
})

test('throws in production when IMGPROXY_SALT is missing entirely', () => {
  const env = { ...GOOD, IMGPROXY_SALT: undefined }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/IMGPROXY_SALT/)
})

test('throws in production when OPENSEARCH_PASSWORD carries the dev marker', () => {
  const env = { ...GOOD, OPENSEARCH_PASSWORD: 'dev-opensearch-admin' }
  expect(() => validateEnv({ env, nodeEnv: 'production' })).toThrow(/OPENSEARCH_PASSWORD/)
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
