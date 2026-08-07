/* eslint-env jest */
import { makeDownvoteAddress, reverseMapPaymentId } from '@/api/monero/downvote'
import { generateDownvotePaymentId, generateTipPaymentId } from '@/api/monero/paymentId'

// Stagenet primary address reused from integratedAddress.test.js so generated
// integrated addresses share its shape (106 chars, stagenet-integrated prefix).
const STAGENET_PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const ORIG_ADDR = process.env.PLATFORM_REWARDS_ADDRESS
beforeEach(() => {
  process.env.PLATFORM_REWARDS_ADDRESS = STAGENET_PRIMARY
})
afterEach(() => {
  if (ORIG_ADDR === undefined) delete process.env.PLATFORM_REWARDS_ADDRESS
  else process.env.PLATFORM_REWARDS_ADDRESS = ORIG_ADDR
})

// Group A — makeDownvoteAddress (pure, no DB)

test('makeDownvoteAddress returns a 16-hex-char paymentId and a 106-char integrated address', () => {
  const { integratedAddress, paymentId } = makeDownvoteAddress(42, 1)
  expect(paymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(integratedAddress).toMatch(/^5/) // stagenet integrated prefix
  expect(integratedAddress).toHaveLength(106)
})

test('makeDownvoteAddress is deterministic for the same (postId, nonce)', () => {
  const a = makeDownvoteAddress(42, 1)
  const b = makeDownvoteAddress(42, 1)
  expect(a.paymentId).toBe(b.paymentId)
  expect(a.integratedAddress).toBe(b.integratedAddress)
})

test('makeDownvoteAddress differs for different postId or nonce', () => {
  const a = makeDownvoteAddress(42, 1)
  const b = makeDownvoteAddress(42, 2)
  const c = makeDownvoteAddress(43, 1)
  expect(a.paymentId).not.toBe(b.paymentId)
  expect(a.paymentId).not.toBe(c.paymentId)
})

test('the downvote paymentId differs from the tip paymentId for the same (postId, nonce)', () => {
  expect(generateDownvotePaymentId(42, 1)).not.toBe(generateTipPaymentId(42, 1))
})

test('makeDownvoteAddress throws when PLATFORM_REWARDS_ADDRESS is unset', () => {
  delete process.env.PLATFORM_REWARDS_ADDRESS
  expect(() => makeDownvoteAddress(42, 1)).toThrow()
})

// Group B — reverseMapPaymentId (DB lookup via stubbed models)

test('reverseMapPaymentId returns the seeded row for a known paymentId', async () => {
  const paymentId = 'abcdef0123456789'
  const seeded = {
    paymentId,
    postId: 42,
    nonce: 1,
    userId: 7,
    expiresAt: new Date('2026-12-31'),
    consumedAt: null
  }
  const models = {
    downvotePidMap: {
      findUnique: async ({ where }) => where.paymentId === paymentId ? seeded : null
    }
  }
  const row = await reverseMapPaymentId(paymentId, models)
  expect(row).toEqual(seeded)
})

test('reverseMapPaymentId returns null for an unknown paymentId', async () => {
  const models = {
    downvotePidMap: {
      findUnique: async () => null
    }
  }
  const row = await reverseMapPaymentId('0000000000000000', models)
  expect(row).toBeNull()
})
