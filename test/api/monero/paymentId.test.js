/* eslint-env jest */
import { generateTipPaymentId, generateDownvotePaymentId, generateBountyPaymentId, generateSubFeePaymentId } from '@/api/monero/paymentId'

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

describe('fail-closed on weak default REWARDS_PID_KEY (mainnet or production)', () => {
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

  test('production fails closed on the default key (any network)', () => {
    const origNodeEnv = process.env.NODE_ENV
    const origNetwork = process.env.MONERO_NETWORK
    delete process.env.REWARDS_PID_KEY
    process.env.NODE_ENV = 'production'
    process.env.MONERO_NETWORK = 'stagenet'
    try {
      expect(() => generateTipPaymentId(1, 1)).toThrow(/REWARDS_PID_KEY/)
    } finally {
      process.env.NODE_ENV = origNodeEnv
      process.env.MONERO_NETWORK = origNetwork
    }
  })

  test('production accepts a non-default key', () => {
    const orig = { NODE_ENV: process.env.NODE_ENV, REWARDS_PID_KEY: process.env.REWARDS_PID_KEY }
    process.env.NODE_ENV = 'production'
    process.env.REWARDS_PID_KEY = 'a-long-random-production-key'
    try {
      expect(generateTipPaymentId(1, 1)).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      process.env.NODE_ENV = orig.NODE_ENV
      process.env.REWARDS_PID_KEY = orig.REWARDS_PID_KEY
    }
  })
})

describe('generateSubFeePaymentId', () => {
  it('is deterministic for a given (seed, nonce)', () => {
    expect(generateSubFeePaymentId('seed-1', 123))
      .toBe(generateSubFeePaymentId('seed-1', 123))
  })
  it('differs across seeds and nonces', () => {
    expect(generateSubFeePaymentId('seed-1', 123)).not.toBe(generateSubFeePaymentId('seed-2', 123))
    expect(generateSubFeePaymentId('seed-1', 123)).not.toBe(generateSubFeePaymentId('seed-1', 124))
  })
  it('is 16 hex chars', () => {
    expect(generateSubFeePaymentId('s', 1)).toMatch(/^[0-9a-f]{16}$/)
  })
  it('never collides with tip/dv/bn namespaces for the same inputs', () => {
    for (let i = 0; i < 100; i++) {
      const fee = generateSubFeePaymentId('x', i)
      expect(fee).not.toBe(generateTipPaymentId('x', i))
      expect(fee).not.toBe(generateDownvotePaymentId('x', i))
      expect(fee).not.toBe(generateBountyPaymentId('x', i))
    }
  })
})
