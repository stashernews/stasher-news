// In-process snapshot of the last monero-lws / monerod probe result, written by
// the healthProbe worker (D4) and read by /api/health (D3) and the future
// Prometheus gauges (D7). This is the "global" store the D4 brief permits: it
// carries no external dependency so the probe result is always available to any
// in-process consumer without a DB round-trip on the hot /api/health path.
//
// NOTE: the worker and app run in separate containers, so the app process's
// view of this singleton is only authoritative once a cross-container bridge
// (D7 scrape topology or a shared row) is wired. Until then this seam is what
// the worker's own alerting decisions and D7 gauges read; /api/health keeps its
// null placeholders (D3, backward-compatible).

let status = { lws: null, monerod: null, height: 0, stalled: false, updatedAt: null }

export function setHealthStatus (next) {
  status = { ...status, ...next }
}

export function getHealthStatus () {
  return { ...status }
}

export function __resetHealthStatus () {
  status = { lws: null, monerod: null, height: 0, stalled: false, updatedAt: null }
}
