import models from '@/api/models'
import { register, collectDBBackedMetrics, collectHealthGauges } from '@/lib/metrics'
import { safeEqual } from '@/lib/domains/auth'

// Prometheus scrape endpoint (Task D7).
//
// Token-gated and FAILS CLOSED in production (Task C4): in production the
// endpoint returns 401 when METRICS_TOKEN is unset (defense in depth), so an
// operator can never accidentally expose the scrape by forgetting to set the
// token. In non-production (dev convenience) the endpoint is open when
// METRICS_TOKEN is unset. When METRICS_TOKEN is set (any environment) the
// scrape must carry ?token=<value> matching it via timing-safe compare or the
// endpoint returns 401. The exposition contains only metric names +
// aggregate counts (no secrets, no PII, no user data), but on a privacy-focused
// Monero platform even aggregate counts (treasury balance, pending-tip counts,
// distribution status) are an avoidable info leak, so gate it in prod. See
// the internal ops docs (mainnet launch, security review).
//
// On every GET it refreshes the DB-backed gauges (pending tips, latest
// distribution status, pg-boss failed count, ops earmark) and the
// HealthSnapshot-backed health gauges (lws/monerod/height + rewards wallet
// balance, written by the worker process into row id=1), then returns the
// registry in Prometheus exposition format.

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
    await collectHealthGauges(models)
  } catch { /* retain stale values; never 500 the scrape */ }
  res.setHeader('Content-Type', register.contentType)
  res.status(200).end(await register.metrics())
}
