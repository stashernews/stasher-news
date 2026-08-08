import { alert } from '@/lib/alert'

// createReorgDetector (Task D5) — a stateful, per-worker chain-height
// regression detector. Each worker that polls the chain height keeps its OWN
// detector instance so their different polling cadences don't cross-contaminate
// each other's baseline.
//
// The first observation establishes the baseline (no comparison). Every later
// observation is compared to the last seen height; a regression
// (observed < last) flags a reorg and fires a single debounced `critical`
// alert. The `dedupeKey: 'reorg'` caps volume: lib/alert.js suppresses repeats
// within its TTL (5 min), so a sustained reorg produces one page, not one per
// poll. Non-number heights (null/undefined from a failed probe) are ignored and
// do NOT reset the baseline, so a transient daemon hiccup is never misread as a
// reorg nor as a fresh baseline.
//
// This is DETECTION + ALERT ONLY (decision #4): ranking/ledger reversal stays
// deferred — `reverseTip` at api/monero/ranking.js:158 remains dead code. The
// returned `{ reorg, fromHeight, toHeight }` lets future callers react (e.g. a
// D7 `monero_reorgs_total` counter or a post-v1 reconcileReorg worker).
export function createReorgDetector ({ alert: doAlert = alert } = {}) {
  let lastHeight = null
  return function detectReorg (height) {
    const fromHeight = lastHeight
    const toHeight = height
    const reorg = lastHeight !== null && typeof height === 'number' && height < lastHeight
    if (reorg) {
      doAlert(
        'critical',
        'monero reorg detected',
        `chain height regressed ${lastHeight} -> ${height}`,
        { dedupeKey: 'reorg' }
      )
    }
    if (typeof height === 'number') lastHeight = height
    return { reorg, fromHeight, toHeight }
  }
}
