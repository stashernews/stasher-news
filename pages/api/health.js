import models from '@/api/models'

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

export default async function handler (req, res) {
  res.setHeader('Cache-Control', 'no-store')

  const db = await checkDb()
  const queue = await checkQueue()

  // lws/monerod reachability is reported null until the healthProbe worker (D4)
  // / metrics gauges (D7) populate them. They run their own compose healthchecks
  // and do not gate this container's health.
  const lws = null
  const monerod = null

  const ok = db
  res.status(ok ? 200 : 503).json({ ok, db, lws, monerod, queue })
}
