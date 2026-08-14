/* eslint-env jest */
import { rateLimit, __resetForTests } from '@/lib/rate-limit'

beforeEach(() => __resetForTests())

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
