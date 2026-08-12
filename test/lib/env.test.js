/* eslint-env jest */
import { validateEnv } from '@/lib/env'

const GOOD = {
  DATABASE_URL: 'postgres://u:p@h:5432/db',
  NEXTAUTH_SECRET: 'real-secret-value',
  JWT_SIGNING_PRIVATE_KEY: 'real-key',
  EMAIL_SALT: 'real-salt',
  VIEWKEY_MASTER_KEY: 'a2V5AAAAAAAAAAAAAAAAAAAAAA==',
  LWS_WEBHOOK_TOKEN: 'real-token',
  MONERO_LWS_ADMIN_AUTH: 'real-admin-key'
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

test('does not throw in non-production even with insecure defaults', () => {
  expect(() => validateEnv({ env: {}, nodeEnv: 'development' })).not.toThrow()
})
