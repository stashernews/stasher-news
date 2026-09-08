// In-process snapshot of the last monero-lws / monerod probe result, written by
// the healthProbe worker (D4) and read by the worker's own alerting/gauge code.
// This is the "global" store the D4 brief permits: it carries no external
// dependency so the probe result is always available to any in-process consumer
// without a DB round-trip.
//
// NOTE (cross-process bridge): the worker and app run in separate containers,
// so the app process can never see this singleton. The authoritative app-side
// source is the HealthSnapshot DB row instead: worker/healthProbe.js upserts
// row id=1 after every probe and api/monero/rewards.js setBalanceGauge persists
// the rewards wallet balance to the same row, while lib/metrics.js
// collectHealthGauges and /api/health read it back under the staleness window
// (lib/metrics.js HEALTH_STALE_MS). This seam remains what the worker's own
// alerting decisions and worker-process gauges read.

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
