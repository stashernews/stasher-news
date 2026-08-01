import { daemonClient } from '@/api/monero/daemonClient'
import { CONFIRM_POLL_INTERVAL_MS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'

// confirmFinalizer — matures provisional tips (Task 7 / spec §5.5, Q5).
//
// moneroIndexer records each observed tip as DETECTED the moment lws first
// reports it (0-conf), and applyTipDetected (Task 5) has ALREADY bumped the
// post's ranking columns at that point — DETECTED credit is provisional. A
// tip becomes final once it is buried under REQUIRED_CONFIRMATIONS (10) blocks
// (spec Q7: Monero reorgs are shallow, so 10 confs is effectively final).
//
// This job is the counterpart that flips the mature ones DETECTED -> CONFIRMED.
// It reads the current chain height from monerod (get_info) ONCE per run (one
// daemon call per run — never per tip), scans DETECTED ObservedTips
// whose height is set (mempool tips have height == null and cannot be
// confirmed yet), and for each mature tip flips state and bumps the author's
// stackedPiconeros lifetime-received denorm (spec Q5: stackedPiconeros = sum
// of CONFIRMED ObservedTip.piconeros, mirroring SN's stackedMsats).
//
// ATOMICITY (deliberate): the state flip and the author denorm bump run in a
// SINGLE Prisma $transaction. Unlike a create+side-effect split (which has a
// known partial-failure hazard elsewhere), the flip+denorm here must never
// diverge — a CONFIRMED tip with an unbumped author (or vice versa) would
// desync the reputation calc. The transaction guarantees they commit together.
//
// Scope: ObservedTip ONLY. ObservedBurn confirmation is the penaltyIndexer's
// domain (Phase 4) and will be added when that lands.
//
// This module exports TWO things (mirrors worker/moneroIndexer.js):
//   - runConfirmFinalizerOnce: the testable per-run core (no pg-boss). Takes
//     an injectable daemonClient so tests never touch the network.
//   - confirmFinalizer: the pg-boss handler. Calls the core then self-requeues
//     with startAfter = CONFIRM_POLL_INTERVAL_MS.

// Bounded batch so the job stays latency-bounded even if a large backlog of
// DETECTED tips accrues (e.g. a long lws outage followed by catch-up). 500 is
// well above any realistic per-block tip volume and leaves headroom; the next
// poll picks up the overflow. Pagination by cursor is unnecessary because the
// query is state-filtered (DETECTED) and DETECTED rows only shrink over time.
const SCAN_BATCH_SIZE = 500

// One run of the confirmFinalizer. Returns the count of tips flipped to
// CONFIRMED (useful for logs/metrics; not asserted by tests).
export async function runConfirmFinalizerOnce ({ models, daemonClient: client = daemonClient }) {
  const chainHeight = await client.getHeight()

  // Mempool tips (height == null) carry no block height to confirm against, so
  // they are excluded here — they become eligible the moment lws reports them
  // confirmed (height set) on a later indexer poll.
  const tips = await models.observedTip.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    include: { post: { select: { userId: true } } },
    take: SCAN_BATCH_SIZE
  })

  let confirmed = 0
  for (const tip of tips) {
    const confirmations = chainHeight - tip.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue

    // Resolve the author via the tipped post. The ObservedTip.postId FK is
    // ON DELETE RESTRICT (non-nullable), so the Item cannot be deleted while
    // the tip exists — post is always present. The guard is defensive only.
    const authorId = tip.post?.userId
    await models.$transaction(async (tx) => {
      await tx.observedTip.update({
        where: { id: tip.id },
        data: {
          state: 'CONFIRMED',
          confirmations,
          confirmedAt: new Date()
        }
      })
      if (authorId != null) {
        await tx.user.update({
          where: { id: authorId },
          data: { stackedPiconeros: { increment: tip.piconeros } }
        })
      }
    })
    if (authorId == null) {
      console.warn(`confirmFinalizer: tip ${tip.id} flipped to CONFIRMED but author could not be resolved (post ${tip.postId}); stackedPiconeros NOT bumped`)
    }
    confirmed += 1
  }

  // Fee observations (penaltyIndexer / Phase 3 Task 5): mature DETECTED fee
  // observations to CONFIRMED at the same confirmation threshold. The gated
  // Item/Sub already went live on DETECTION; CONFIRMED just finalizes the ledger
  // row so Phase 4's rewardsDistributor can sum paid fees per period. The linked
  // PayIn's own state is left untouched (it is the ITEM_CREATE bookkeeping state).
  const fees = await models.feeObservation.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const fee of fees) {
    const confirmations = chainHeight - fee.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.feeObservation.update({
      where: { id: fee.id },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
  }

  return confirmed
}

// pg-boss handler. Runs one scan then self-requeues. The requeue uses the
// codebase's plain boss.send(name, data, { startAfter }) convention (see
// worker/moneroIndexer.js, worker/search.js). The initial seed in
// worker/index.js carries a singletonKey guard so restarts cannot spawn
// duplicate loops; the requeue deliberately omits it (mirrors moneroIndexer).
export async function confirmFinalizer ({ boss, models }) {
  await runConfirmFinalizerOnce({ models })
  await boss.send('confirmFinalizer', {}, { startAfter: CONFIRM_POLL_INTERVAL_MS / 1000 })
}
