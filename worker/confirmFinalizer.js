import { daemonClient } from '@/api/monero/daemonClient'
import { CONFIRM_POLL_INTERVAL_MS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { createReorgDetector } from '@/lib/reorgDetector'

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
// Scope: ObservedTip, FeeObservation, AND ObservedDownvote. The tip flip is coupled
// to the author stackedPiconeros denorm (atomic); the fee and downvote flips are
// ledger-only (their ranking/visibility effects already applied at DETECTION).
// Reorg reversal is NOT implemented — deferred as an accepted v1 limitation
// (consistent with the tip flow; a >10-block Monero reorg is negligible).
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

// Per-worker reorg detector (Task D5). Tracks the last chain height seen by
// this job across runs and fires a debounced critical alert on regression.
// Injectable on runConfirmFinalizerOnce so tests never trip the module-level
// baseline (and can assert the wiring directly).
const detectReorg = createReorgDetector()

// One run of the confirmFinalizer. Returns the count of tips flipped to
// CONFIRMED (useful for logs/metrics; not asserted by tests).
export async function runConfirmFinalizerOnce ({ models, daemonClient: client = daemonClient, detectReorg: detect = detectReorg } = {}) {
  const chainHeight = await client.getHeight()
  detect(chainHeight)

  // Mempool tips (height == null) carry no block height to confirm against, so
  // they are excluded here — they become eligible the moment lws reports them
  // confirmed (height set) on a later indexer poll.
  const tips = await models.observedTip.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    include: { post: { select: { userId: true } }, recipientAccount: { select: { label: true } } },
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
      if (authorId != null && tip.recipientAccount?.label !== 'platform_rewards') {
        await tx.user.update({
          where: { id: authorId },
          data: { stackedPiconeros: { increment: tip.piconeros } }
        })
      }
    })
    if (authorId == null) {
      console.warn(`confirmFinalizer: tip ${tip.id} flipped to CONFIRMED but author could not be resolved (post ${tip.postId}); stackedPiconeros NOT bumped`)
    }
    if (authorId != null && tip.recipientAccount?.label === 'platform_rewards') {
      console.log(`confirmFinalizer: tip ${tip.id} flipped to CONFIRMED (rewards-pool recipient); stackedPiconeros not bumped`)
    }
    confirmed += 1
  }

  // Fee observations (rewardsWalletObserver): mature DETECTED fee
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

  // ObservedDownvote (rewardsWalletObserver): mature DETECTED downvotes to
  // CONFIRMED at the same confirmation threshold. The ranking penalty
  // (weightedDownVotes/downPiconeros) was already applied at DETECTION — mirroring
  // how tips apply their effect at DETECTION — so CONFIRMED just finalizes the
  // ledger row. Reorg reversal is deferred (consistent with the tip flow: a
  // >10-block Monero reorg is negligible; consequence is minor ranking drift,
  // not fund loss).
  const downvotes = await models.observedDownvote.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const downvote of downvotes) {
    const confirmations = chainHeight - downvote.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.observedDownvote.update({
      where: { id: downvote.id },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
  }

  // ObservedBounty (A-13): mature DETECTED bounty fundings to CONFIRMED at the
  // same threshold — the backstop for a missed webhook CONFIRMED callback.
  // Unlike the tip/downvote flips, this is LEDGER-ONLY: the funding side
  // effects (Item.bountyStatus -> FUNDED, bountyPiconeros, the BOUNTY_FEE
  // FeeObservation, webhook teardown) ran on the webhook's CONFIRMED path
  // (driveBountyFunding) and are NOT repeated here — the finalizer only
  // matures the ObservedBounty row so the funding cannot stay provisional if
  // the final callback is lost. A fully-missed funding (no DETECTED row) is
  // out of scope here: the 24h BountyPidMap expiry makes stale payment ids
  // unconsumable and the author retries.
  const bounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const bounty of bounties) {
    const confirmations = chainHeight - bounty.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.observedBounty.update({
      where: { id: bounty.id },
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
