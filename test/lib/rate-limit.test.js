/* eslint-env jest */
import { rateLimit, __resetForTests } from '@/lib/rate-limit'

beforeEach(() => __resetForTests())

// Must stay FIRST in this file: the module's sweep interval is created on the
// first rateLimit call and binds to whichever timer implementation is active
// then, so these fake-timer tests have to run before any real-timer test.
describe('bucket eviction tracks its own window (hour-scale windows survive the sweep)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    __resetForTests()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('an hour-scale bucket is not swept after 10 idle minutes and keeps its debt', () => {
    const hit = () => rateLimit({ key: 'slow', limit: 5, windowMs: 60 * 60_000 })
    for (let i = 0; i < 5; i++) expect(hit().allowed).toBe(true)
    // 10 idle minutes would evict the bucket under a fixed 10-minute sweep,
    // silently resetting an hour-scale window (email identifier cooldowns, the
    // anonymous hourly posting limit) — eviction must wait out the window
    jest.advanceTimersByTime(10 * 60_000 + 65_000)
    // refilled 665s/3600s * 5 ~= 0.92 tokens < 1: the debt is remembered
    expect(hit().allowed).toBe(false)
  })
})

describe('rateLimit token bucket', () => {
  it('allows up to limit requests in the window', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit({ key: 'k', limit: 5, windowMs: 10_000 }).allowed).toBe(true)
    }
  })

  it('blocks the 6th request and reports retryAfterMs', () => {
    for (let i = 0; i < 5; i++) rateLimit({ key: 'k2', limit: 5, windowMs: 10_000 })
    const res = rateLimit({ key: 'k2', limit: 5, windowMs: 10_000 })
    expect(res.allowed).toBe(false)
    expect(res.retryAfterMs).toBeGreaterThan(0)
    expect(res.retryAfterMs).toBeLessThanOrEqual(10_000)
  })

  it('tracks keys independently', () => {
    for (let i = 0; i < 5; i++) rateLimit({ key: 'a', limit: 5, windowMs: 10_000 })
    expect(rateLimit({ key: 'b', limit: 5, windowMs: 10_000 }).allowed).toBe(true)
  })
})
