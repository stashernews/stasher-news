/* eslint-env jest */
import {
  encryptEmail, decryptEmail, createUnsubscribeToken, verifyUnsubscribeToken
} from '@/lib/emailCrypto'

// 32 bytes of 0x73 ('s'), valid base64 — must decode to exactly 32 bytes.
const KEY = Buffer.alloc(32, 115).toString('base64')

beforeEach(() => { process.env.EMAIL_MASTER_KEY = KEY })
afterAll(() => { delete process.env.EMAIL_MASTER_KEY })

test('round-trips an address', () => {
  const envelope = encryptEmail('alice@example.com')
  expect(decryptEmail(envelope)).toBe('alice@example.com')
})

test('the envelope is versioned and never contains the plaintext', () => {
  const envelope = encryptEmail('alice@example.com')
  expect(envelope.startsWith('v1:')).toBe(true)
  expect(envelope).not.toContain('alice')
  expect(envelope).not.toContain('example.com')
})

test('two encryptions of the same address differ (random IV)', () => {
  expect(encryptEmail('a@b.c')).not.toBe(encryptEmail('a@b.c'))
})

test('throws on tampered ciphertext', () => {
  const envelope = encryptEmail('alice@example.com')
  const parts = envelope.split(':')
  const ct = Buffer.from(parts[3], 'base64')
  ct[0] = ct[0] ^ 0xff
  parts[3] = ct.toString('base64')
  expect(() => decryptEmail(parts.join(':'))).toThrow()
})

test('throws when decrypted under a different key', () => {
  const envelope = encryptEmail('alice@example.com')
  process.env.EMAIL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  expect(() => decryptEmail(envelope)).toThrow()
})

test('fails closed without a key', () => {
  delete process.env.EMAIL_MASTER_KEY
  expect(() => encryptEmail('a@b.c')).toThrow(/EMAIL_MASTER_KEY/)
  const envelope = (() => {
    process.env.EMAIL_MASTER_KEY = KEY
    return encryptEmail('a@b.c')
  })()
  delete process.env.EMAIL_MASTER_KEY
  expect(() => decryptEmail(envelope)).toThrow(/EMAIL_MASTER_KEY/)
})

test('fails closed on a malformed key', () => {
  process.env.EMAIL_MASTER_KEY = 'not-a-32-byte-key'
  expect(() => encryptEmail('a@b.c')).toThrow(/EMAIL_MASTER_KEY/)
})

test('throws on a malformed envelope', () => {
  expect(() => decryptEmail('v1:zzz')).toThrow(/malformed/)
  expect(() => decryptEmail('v2:AAAA:BBBB:CCCC')).toThrow(/malformed/)
})

test('unsubscribe tokens verify only for their own user', () => {
  const token = createUnsubscribeToken(42)
  expect(verifyUnsubscribeToken(42, token)).toBe(true)
  expect(verifyUnsubscribeToken(43, token)).toBe(false)
  expect(verifyUnsubscribeToken(42, 'garbage')).toBe(false)
  expect(verifyUnsubscribeToken(42, undefined)).toBe(false)
})
