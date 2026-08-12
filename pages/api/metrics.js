import models from '@/api/models'
import { register, collectDBBackedMetrics, collectHealthGauges } from '@/lib/metrics'
import { safeEqual } from '@/lib/domains/auth'

// Prometheus scrape endpoint (Task D7).
//
// Token-gated: if METRICS_TOKEN is set, the scrape must carry ?token=<value>
// matching it or the endpoint returns 401. When METRICS_TOKEN is unset the
// endpoint is open (dev convenience) — production MUST either set METRICS_TOKEN
// or restrict the endpoint at the network/reverse-proxy layer (e.g. allow only
// the Prometheus server's IP). The exposition contains only metric names +
// aggregate counts (no secrets, no PII, no user data), but on a privacy-focused
// Monero platform even aggregate counts (treasury balance, pending-tip counts,
// distribution status) are an avoidable info leak, so gate it in prod. See
// docs/ops/mainnet-launch.md and docs/ops/security-review.md.
//
// On every GET it refreshes the DB-backed gauges (pending tips, latest
// distribution status, pg-boss failed count, ops earmark) and the in-process
// health gauges, then returns the registry in Prometheus exposition format.

export default async function handler (req, res) {
  if (req.method !== 'GET') {
    res.status(405).end()
    return
  }
  const expectedToken = process.env.METRICS_TOKEN
  if (!expectedToken) {
    if (process.env.NODE_ENV === 'production') return res.status(401).end()
    // dev convenience: open
  } else if (!safeEqual(req.query.token, expectedToken)) {
    res.status(401).end()
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
