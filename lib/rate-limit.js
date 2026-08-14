// In-memory token bucket. Correct for the current single-app-process
// deployment; if the app ever scales horizontally, move to a shared store
// (redis) — see Plan 3 Batch B notes. Buckets are swept lazily.
const buckets = new Map()

const SWEEP_MS = 60_000
let sweepTimer = null

function ensureSweep () {
  if (sweepTimer || typeof setInterval !== 'function') return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) {
      if (now - b.lastSeen > 10 * SWEEP_MS) buckets.delete(k)
    }
  }, SWEEP_MS)
  if (sweepTimer.unref) sweepTimer.unref()
}

export function rateLimit ({ key, limit, windowMs }) {
  ensureSweep()
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: limit, updatedAt: now, lastSeen: now }
    buckets.set(key, b)
  }
  b.lastSeen = now
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
