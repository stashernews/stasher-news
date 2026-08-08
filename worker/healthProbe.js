import { lwsClient } from '@/api/monero/lwsClient'
import { alert } from '@/lib/alert'
import { setHealthStatus } from '@/lib/healthStatus'
import { logWarn } from '@/lib/logger'
import { moneroLwsUp, moneroMonerodUp, moneroMonerodHeight } from '@/lib/metrics'

// healthProbe (Task D4) — periodic lws + monerod health probe.
//
// A self-requeuing pg-boss job (every HEALTH_PROBE_INTERVAL_SECONDS, default 60s)
// that calls lws getDaemonStatus (the wallet endpoint that proxies monerod),
// classifies the result into lws-reachable / monerod-reachable, publishes the
// snapshot to lib/healthStatus (consumed by /api/health and D7 gauges), and
// fires a debounced critical alert when either service is down or the chain
// height stops advancing.
//
// lws-down vs monerod-down disambiguation: getDaemonStatus traverses lws to
// monerod. A LwsNetworkError/LwsTimeoutError means lws itself is unreachable
// (monerod unknowable); a LwsHttpError means lws responded, so lws is up and the
// daemon it proxies is the failure. These error classes are not exported by
// lwsClient, so they are matched by their stable `.name` (set in lwsClient.js).
// When lws is down we do NOT also alert monerod-down: the daemon's state is
// unknowable through a dead lws, and double-alerting is noise.
//
// Stall detection: a node can report a healthy height while silently frozen
// (e.g. a stuck peer set). We track the last seen height and the first instant
// we saw it; if it is unchanged for MONEROD_STALL_THRESHOLD_MS (default 10 min)
// we alert. The state is process-lifetime (the module loads once per worker) and
// is rebaselined whenever monerod returns from an outage.

const PROBE_INTERVAL_SECONDS = Number(process.env.HEALTH_PROBE_INTERVAL_SECONDS) || 60
const STALL_THRESHOLD_MS = Number(process.env.MONEROD_STALL_THRESHOLD_MS) || 10 * 60 * 1000

let lastHeight = null
let heightFirstSeenAt = null

export function __resetStallState () {
  lastHeight = null
  heightFirstSeenAt = null
}

export async function runHealthProbeOnce ({
  lwsClient: client = lwsClient,
  alert: doAlert = alert,
  setStatus = setHealthStatus,
  now = Date.now,
  stallThresholdMs = STALL_THRESHOLD_MS
} = {}) {
  const ts = now()
  let lwsOk = false
  let monerodOk = false
  let height = 0

  try {
    const daemon = await client.getDaemonStatus()
    lwsOk = true
    height = daemon && typeof daemon.height === 'number' ? daemon.height : 0
    monerodOk = height > 0
  } catch (err) {
    if (err && err.name === 'LwsHttpError') {
      lwsOk = true
    }
    monerodOk = false
    logWarn('healthProbe: daemon_status probe failed', err)
  }

  let stalled = false
  if (monerodOk) {
    if (height === lastHeight) {
      if (heightFirstSeenAt !== null && (ts - heightFirstSeenAt) >= stallThresholdMs) {
        stalled = true
      }
    } else {
      lastHeight = height
      heightFirstSeenAt = ts
    }
  } else {
    lastHeight = null
    heightFirstSeenAt = null
  }

  setStatus({
    lws: lwsOk,
    monerod: monerodOk && !stalled,
    height,
    stalled,
    updatedAt: new Date(ts).toISOString()
  })

  moneroLwsUp.set(lwsOk ? 1 : 0)
  moneroMonerodUp.set(monerodOk && !stalled ? 1 : 0)
  moneroMonerodHeight.set(height || 0)

  if (!lwsOk) {
    doAlert('critical', 'lws down', 'monero-lws wallet endpoint unreachable', { dedupeKey: 'lws-down' })
  }
  if (lwsOk && !monerodOk) {
    doAlert('critical', 'monerod down', 'monerod daemon unreachable via lws daemon_status', { dedupeKey: 'monerod-down' })
  }
  if (stalled) {
    doAlert('critical', 'monerod stalled', `chain height unchanged at ${height} for >= ${Math.round(stallThresholdMs / 1000)}s`, { dedupeKey: 'monerod-stall' })
  }

  return { lwsOk, monerodOk, height, stalled }
}

export async function healthProbe ({ boss }) {
  await runHealthProbeOnce()
  await boss.send('healthProbe', {}, { startAfter: PROBE_INTERVAL_SECONDS })
}
