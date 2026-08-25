// In-memory token bucket. Correct for the current single-app-process
// deployment; if the app ever scales horizontally, move to a shared store
// (redis) — see Plan 3 Batch B notes. Buckets are swept lazily: each bucket is
// evicted only after its OWN window passes idle (a bucket idle >= its window
// has fully refilled, so eviction is lossless — a fixed 10-minute cap would
// silently reset hour-scale windows like the email identifier cooldowns).
const buckets = new Map()

const SWEEP_MS = 60_000
let sweepTimer = null

function ensureSweep () {
  if (sweepTimer || typeof setInterval !== 'function') return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) {
      if (now > b.expiresAt) buckets.delete(k)
    }
  }, SWEEP_MS)
  if (sweepTimer.unref) sweepTimer.unref()
}

export function rateLimit ({ key, limit, windowMs }) {
  ensureSweep()
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: limit, updatedAt: now }
    buckets.set(key, b)
  }
  b.expiresAt = now + windowMs
  // refill continuously at limit/windowMs tokens per ms
  const refill = ((now - b.updatedAt) / windowMs) * limit
  b.tokens = Math.min(limit, b.tokens + refill)
  b.updatedAt = now
  if (b.tokens >= 1) {
    b.tokens -= 1
    return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 }
  }
  const retryAfterMs = Math.ceil(((1 - b.tokens) * windowMs) / limit)
  return { allowed: false, remaining: 0, retryAfterMs }
}

export function __resetForTests () {
  buckets.clear()
}
