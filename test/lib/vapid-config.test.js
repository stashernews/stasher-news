/* eslint-env jest */
import { getPushConfigError } from '@/lib/vapid-config'

// real pair generated with `npx web-push generate-vapid-keys` (2026-08-17);
// used here only as a well-formed fixture, never as deployment keys
const VALID_PUBKEY = 'BK9Zi9XzzIHsN1kD93h31ifevXxVa_-_qSekZXA5tvYB4xdr2S6XuT8nKdM-dImAqjrWWZfSAT1f6mheAzxALxs'
// 55 chars -> decodes to 41 bytes, fails the 65-byte check
const TRUNCATED_PUBKEY = 'BK9Zi9XzzIHsN1kD93h31ifevXxVa_-_qSekZXA5tvYB4xdr2'

afterEach(() => {
  delete process.env.NEXT_PUBLIC_VAPID_PUBKEY
})

test('returns an error when the key is unset', () => {
  delete process.env.NEXT_PUBLIC_VAPID_PUBKEY
  expect(getPushConfigError()).toMatch(/not configured/)
})

test('returns an error when the key is an empty string', () => {
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = ''
  expect(getPushConfigError()).toMatch(/not configured/)
})

test('returns null for a well-formed 65-byte VAPID public key', () => {
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = VALID_PUBKEY
  expect(getPushConfigError()).toBeNull()
})

test('returns an error for a truncated key', () => {
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = TRUNCATED_PUBKEY
  expect(getPushConfigError()).toMatch(/invalid/)
})

test('returns an error for non-base64url input', () => {
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = '!!!not-base64url!!!'
  expect(getPushConfigError()).toMatch(/invalid/)
})
