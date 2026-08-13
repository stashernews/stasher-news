/* eslint-env jest */
import { validateEnv } from '@/lib/env'

const GOOD = {
  DATABASE_URL: 'postgres://u:p@h:5432/db',
  NEXTAUTH_SECRET: 'real-secret-value',
  JWT_SIGNING_PRIVATE_KEY: 'real-key',
  EMAIL_SALT: 'real-salt',
  VIEWKEY_MASTER_KEY: 'a2V5AAAAAAAAAAAAAAAAAAAAAA==',
  LWS_WEBHOOK_TOKEN: 'real-token',
  MONERO_LWS_ADMIN_AUTH: 'real-admin-key',
  NEXTAUTH_URL: 'https://stasher.news',
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

test('does not throw in non-production even with insecure defaults', () => {
  expect(() => validateEnv({ env: {}, nodeEnv: 'development' })).not.toThrow()
})
