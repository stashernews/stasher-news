import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { BOSS_RETRY } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { setHealthStatus } from '@/lib/healthStatus'
import { logError, logWarn } from '@/lib/logger'
import { moneroLwsUp, moneroMonerodUp, moneroMonerodHeight } from '@/lib/metrics'

// healthProbe (Task D4) — periodic lws + monerod health probe.
//
// A self-requeuing pg-boss job (every HEALTH_PROBE_INTERVAL_SECONDS, default 60s)
// that probes the two services INDEPENDENTLY — lws via the admin /list_accounts
// endpoint and monerod directly via JSON-RPC get_info (api/monero/daemonClient,
// the same proven path confirmFinalizer and bounties use) — publishes the
// snapshot to lib/healthStatus (consumed by /api/health and the D7 gauges), and
// fires a debounced critical alert when either service is down or the chain
// height stops advancing.
//
// The probes are independent because lws does NOT proxy monerod state in the
// deployed build: GET /daemon_status returns 404 (see
// docs/ops/healthprobe-lws-404-finding.md). Each service's reachability is
// therefore observed directly, and each failure alerts independently — no
// "monerod unknowable through a dead lws" suppression is needed.
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
  daemonClient: monerod = daemonClient,
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
    await client.listAccounts()
    lwsOk = true
  } catch (err) {
    logWarn('healthProbe: lws probe failed', err)
  }

  try {
    height = await monerod.getHeight()
    monerodOk = height > 0
  } catch (err) {
    logWarn('healthProbe: monerod probe failed', err)
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
  if (!monerodOk) {
    doAlert('critical', 'monerod down', 'monerod daemon unreachable (get_info probe failed)', { dedupeKey: 'monerod-down' })
  }
  if (stalled) {
    doAlert('critical', 'monerod stalled', `chain height unchanged at ${height} for >= ${Math.round(stallThresholdMs / 1000)}s`, { dedupeKey: 'monerod-stall' })
  }

  return { lwsOk, monerodOk, height, stalled }
}

export async function healthProbe ({ boss }) {
  // Run first, requeue only on success: a requeue sent from a FAILED run
  // forks the chain (pg-boss retries this same job, whose success sends
  // another requeue). On a run error just rethrow — the retry re-executes
  // the whole handler, which re-sends on eventual success.
  await runHealthProbeOnce()
  try {
    await boss.send('healthProbe', {}, { ...BOSS_RETRY, startAfter: PROBE_INTERVAL_SECONDS })
  } catch (e) {
    logError('healthProbe requeue send failed', e)
    alert('critical', 'healthProbe requeue failed', String(e), { dedupeKey: 'healthProbe-requeue' })
    throw e // rethrow so pg-boss retries THIS run and the chain survives
  }
}
