import models from '@/api/models'
import { register, collectDBBackedMetrics, collectHealthGauges } from '@/lib/metrics'

// Prometheus scrape endpoint (Task D7).
//
// Unauthenticated: the exposition contains only metric names + aggregate
// counts (no secrets, no PII, no user data). In production this endpoint MUST
// sit behind a private network or a reverse-proxy scrape allowlist (e.g.
// allow only the Prometheus server's IP) — it is intentionally NOT gated by
// auth so a scrape can run without credentials.
//
// On every GET it refreshes the DB-backed gauges (pending tips, latest
// distribution status, pg-boss failed count, ops earmark) and the in-process
// health gauges, then returns the registry in Prometheus exposition format.

export default async function handler (req, res) {
  if (req.method !== 'GET') {
    res.status(405).end()
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    await collectDBBackedMetrics(models)
  } catch { /* retain stale values; never 500 the scrape */ }
  collectHealthGauges()
  res.setHeader('Content-Type', register.contentType)
  res.status(200).end(await register.metrics())
}
