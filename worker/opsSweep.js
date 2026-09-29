import { sweepOpsEarmark as defaultSweepOpsEarmark } from '@/api/monero/rewards'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { signerEnabled, signerDisabledNag } from '@/api/monero/signerWallet'

// opsSweep — one-shot delayed cold-storage sweep of the rewards-wallet ops
// earmark (2026-09-14 A′ decoupling).
//
// Enqueued by the rewardsDistributor handler with startAfter = 1h once the
// distribution is COMPLETE. The sweep used to run inline seconds after the
// payout tx relayed, when the change is 10-block locked and the wallet is
// mid-churn; a sweep error then marked the already-paid distribution FAILED
// with no retry path. A sweep outcome now never touches distribution status.
//
// Guards (user funds first): never sweep while the latest distribution is
// SENDING or has any payout that is not SENT/CONFIRMED. The pending ops earmark rolls
// forward via opsRolledOverPiconeros, so a skipped tick costs nothing and the
// next weekly distribution re-enqueues.
//
// Exports (mirrors worker/rewardsDistributor.js):
//   - runOpsSweepOnce: the testable core (no pg-boss, injectable sweep).
//   - opsSweep: the pg-boss handler.

export async function runOpsSweepOnce ({ models, distributionId, sweepOpsEarmark: injectSweep } = {}) {
  const sweep = injectSweep || defaultSweepOpsEarmark

  const distribution = await models.rewardDistribution.findFirst({
    orderBy: { periodEnd: 'desc' },
    include: { payouts: { select: { state: true } } }
  })
  if (!distribution) {
    logInfo('opsSweep: no distribution yet; nothing to sweep')
    return { state: 'NO_DISTRIBUTION' }
  }
  if (distributionId != null && distribution.id !== distributionId) {
    // The follow-up's row is no longer latest: its unswept remainder has been
    // rolled into the newer row's opsAvailable, so sweeping this row now would
    // double-count. The newer row's own follow-up owns the sweep.
    logInfo({ distributionId, latestId: distribution.id }, 'opsSweep: follow-up is stale (earmark rolled forward); skipping')
    return { state: 'STALE_DISTRIBUTION' }
  }
  if (distribution.status === 'SENDING') {
    logInfo({ distributionId: distribution.id }, 'opsSweep: distribution is SENDING; skipping this tick')
    return { state: 'SKIPPED_IN_FLIGHT' }
  }
  // SENT is the settled state today; CONFIRMED is accepted so a future payout
  // maturation step (PayoutState.CONFIRMED exists but is never set) cannot
  // silently block every sweep.
  if ((distribution.payouts || []).some(p => !['SENT', 'CONFIRMED'].includes(p.state))) {
    logInfo({ distributionId: distribution.id }, 'opsSweep: payouts not all SENT/CONFIRMED; skipping (user funds first)')
    return { state: 'SKIPPED_PAYOUTS_PENDING' }
  }

  const result = await sweep({ distribution, models })
  if (result.state === 'FAILED') {
    logError({ distributionId: distribution.id }, 'opsSweep: CRITICAL — ops sweep FAILED (rolls into the next period)')
    alert('critical', 'rewards ops sweep failed',
      `distribution ${distribution.id}: ops sweep FAILED; the earmark rolls into the next period and the next weekly distribution re-enqueues the sweep`,
      { dedupeKey: `dist-${distribution.id}-sweep-failed` })
  } else {
    logInfo({ distributionId: distribution.id, state: result.state, swept: result.swept ? result.swept.toString() : '0' }, 'opsSweep: sweep result')
  }
  return result
}

export async function opsSweep ({ data, models, sweepOpsEarmark } = {}) {
  if (!signerEnabled()) return signerDisabledNag('opsSweep')
  // pg-boss delivers the send() payload under job.data (jobWrapper spreads the
  // raw job), so distributionId MUST be read from data — reading it top-level
  // leaves the stale-follow-up guard permanently inert.
  return await runOpsSweepOnce({ models, distributionId: data?.distributionId, sweepOpsEarmark })
}
