/* eslint-env jest */
import { generateTipPaymentId, generateDownvotePaymentId } from '@/api/monero/paymentId'

test('generateTipPaymentId returns a 16-char hex string', () => {
  const pid = generateTipPaymentId(42, 1)
  expect(pid).toMatch(/^[0-9a-f]{16}$/)
})

test('generateTipPaymentId is deterministic for the same (postId, nonce)', () => {
  const a = generateTipPaymentId(42, 1)
  const b = generateTipPaymentId(42, 1)
  expect(a).toBe(b)
})

test('generateTipPaymentId differs for different postId or nonce', () => {
  const a = generateTipPaymentId(42, 1)
  const b = generateTipPaymentId(42, 2)
  const c = generateTipPaymentId(43, 1)
  expect(a).not.toBe(b)
  expect(a).not.toBe(c)
})

test('generateDownvotePaymentId returns a 16-char hex string', () => {
  const pid = generateDownvotePaymentId(42, 1)
  expect(pid).toMatch(/^[0-9a-f]{16}$/)
})

test('generateDownvotePaymentId is deterministic for the same (postId, nonce)', () => {
  const a = generateDownvotePaymentId(42, 1)
  const b = generateDownvotePaymentId(42, 1)
  expect(a).toBe(b)
})

test('generateDownvotePaymentId differs for different postId or nonce', () => {
  const a = generateDownvotePaymentId(42, 1)
  const b = generateDownvotePaymentId(42, 2)
  const c = generateDownvotePaymentId(43, 1)
  expect(a).not.toBe(b)
  expect(a).not.toBe(c)
})

test('generateDownvotePaymentId differs from generateTipPaymentId for the same (postId, nonce)', () => {
  const dv = generateDownvotePaymentId(42, 1)
  const tip = generateTipPaymentId(42, 1)
  expect(dv).not.toBe(tip)
})

describe('mainnet fail-closed on weak default REWARDS_PID_KEY', () => {
  const origKey = process.env.REWARDS_PID_KEY
  const origNet = process.env.MONERO_NETWORK

  afterEach(() => {
    if (origKey === undefined) delete process.env.REWARDS_PID_KEY
    else process.env.REWARDS_PID_KEY = origKey
    if (origNet === undefined) delete process.env.MONERO_NETWORK
    else process.env.MONERO_NETWORK = origNet
  })

  test('mainnet + default key throws for generateTipPaymentId', () => {
    delete process.env.REWARDS_PID_KEY
    process.env.MONERO_NETWORK = 'mainnet'
    expect(() => generateTipPaymentId(42, 1)).toThrow()
  })

  test('mainnet + default key throws for generateDownvotePaymentId (shared chokepoint)', () => {
    delete process.env.REWARDS_PID_KEY
    process.env.MONERO_NETWORK = 'mainnet'
    expect(() => generateDownvotePaymentId(42, 1)).toThrow()
  })

  test('stagenet + default key does NOT throw', () => {
    delete process.env.REWARDS_PID_KEY
    process.env.MONERO_NETWORK = 'stagenet'
    expect(generateTipPaymentId(42, 1)).toMatch(/^[0-9a-f]{16}$/)
  })

  test('mainnet + a real (non-default) key does NOT throw', () => {
    process.env.REWARDS_PID_KEY = 'some-long-random-production-secret-key'
    process.env.MONERO_NETWORK = 'mainnet'
    expect(generateTipPaymentId(42, 1)).toMatch(/^[0-9a-f]{16}$/)
    expect(generateDownvotePaymentId(42, 1)).toMatch(/^[0-9a-f]{16}$/)
  })
})
