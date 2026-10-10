import models from '@/api/models'
import { evaluateDeadman, deadmanAlerts } from '@/lib/deadman'
import { HEALTH_STALE_MS, NEWSLETTER_STALE_MS } from '@/lib/metrics'

async function checkDb () {
  try {
    await models.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

async function checkQueue () {
  try {
    const [row] = await models.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE state IN ('created', 'active'))::int AS pending,
        MIN(createdon) FILTER (WHERE state IN ('created', 'active')) AS "oldestPending"
      FROM pgboss.job`
    return {
      failed: row?.failed ?? 0,
      pending: row?.pending ?? 0,
      oldestPending: row?.oldestPending ? new Date(row.oldestPending).toISOString() : null
    }
  } catch {
    return null
  }
}

// Dead-man checks (worker heartbeat + nightly backup silence). The compose
// healthcheck polls this endpoint every 10s; the pgboss scan is throttled to
// once per minute. Results are additive JSON fields + alerts — they never
// affect `ok` (a dead worker must not restart the app container) and a failure
// here must never break the healthcheck itself.
export const DEADMAN_MIN_INTERVAL_MS = 60_000
let lastDeadmanCheck = 0
export function __resetDeadmanThrottle () {
  lastDeadmanCheck = 0
}

// lws/monerod reachability is read from the HealthSnapshot bridge row that the
// healthProbe worker upserts every 60s cycle: populated booleans when the row
// is fresh, null when the row is missing/stale (the original "probe unseen"
// semantics — worker liveness itself remains deadman's job) or when the read
// fails. They run their own compose healthchecks and do not gate this
// container's health.
async function checkMoneroServices () {
  try {
    const row = await models.healthSnapshot.findUnique({ where: { id: 1 } })
    if (!row || Date.now() - new Date(row.updatedAt).getTime() >= HEALTH_STALE_MS) {
      return { lws: null, monerod: null }
    }
    return { lws: row.lws ?? null, monerod: row.monerod ?? null }
  } catch {
    return { lws: null, monerod: null }
  }
}

// Newsletter config/send state from the HealthSnapshot bridge row the
// newsletterSync worker upserts. Freshness gates on newsletterSyncedAt (NOT
// the shared updatedAt, which healthProbe bumps every minute). Additive and
// non-gating (like lws/monerod): null when not-yet/stale — "not known", never
// a healthcheck kill. lastSentAt is a recorded fact and survives staleness.
async function checkNewsletter () {
  try {
    const row = await models.healthSnapshot.findUnique({ where: { id: 1 } })
    const lastSentAt = row?.newsletterLastSentAt ? new Date(row.newsletterLastSentAt).toISOString() : null
    const fresh = row?.newsletterSyncedAt && (Date.now() - new Date(row.newsletterSyncedAt).getTime()) < NEWSLETTER_STALE_MS
    if (!row || !fresh) return { configured: null, contactsActive: null, lastSentAt }
    return {
      configured: row.newsletterConfigured ?? null,
      contactsActive: row.newsletterContactsActive ?? null,
      lastSentAt
    }
  } catch {
    return { configured: null, contactsActive: null, lastSentAt: null }
  }
}

async function checkDeadman (now = Date.now()) {
  if (now - lastDeadmanCheck < DEADMAN_MIN_INTERVAL_MS) return null
  lastDeadmanCheck = now
  try {
    // UNION pgboss.archive: pg-boss archives completed jobs out of pgboss.job
    // after ~12h (default archiveCompletedAfterSeconds; archive rows persist
    // 7d). dbBackup completes once daily — without the archive table its
    // completed row vanishes from pgboss.job long before the 26h threshold,
    // backupLastCompletedAt goes null, and "null is never stale" silently
    // disarms the backup deadman. Same columns exist in both tables.
    const rows = await models.$queryRaw`
      SELECT name, MAX(completedon) AS "lastCompletedAt"
      FROM (
        SELECT name, completedon FROM pgboss.job
        WHERE name IN ('healthProbe', 'dbBackup') AND state = 'completed'
        UNION ALL
        SELECT name, completedon FROM pgboss.archive
        WHERE name IN ('healthProbe', 'dbBackup') AND state = 'completed'
      ) t
      GROUP BY name`
    const byName = Object.fromEntries(rows.map(r => [r.name, r.lastCompletedAt ? new Date(r.lastCompletedAt) : null]))
    const workerLastCompletedAt = byName.healthProbe ?? null
    const backupLastCompletedAt = byName.dbBackup ?? null
    const { workerStale, backupStale } = evaluateDeadman({ workerLastCompletedAt, backupLastCompletedAt, now })
    deadmanAlerts({ workerStale, backupStale, workerLastCompletedAt, backupLastCompletedAt })
    return { workerLastCompletedAt, backupLastCompletedAt, workerStale, backupStale }
  } catch {
    return null
  }
}

export default async function handler (req, res) {
  res.setHeader('Cache-Control', 'no-store')

  const db = await checkDb()
  const queue = await checkQueue()
  const deadman = await checkDeadman()
  const { lws, monerod } = await checkMoneroServices()
  const newsletter = await checkNewsletter()

  const ok = db
  res.status(ok ? 200 : 503).json({ ok, db, lws, monerod, newsletter, queue, deadman })
}
