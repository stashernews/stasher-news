import { Prisma } from '@prisma/client'
import { daemonClient } from '@/api/monero/daemonClient'
import { lwsClient } from '@/api/monero/lwsClient'
import { driveBountyFunding } from '@/api/monero/bountyFunding'
import { CONFIRM_POLL_INTERVAL_MS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { createReorgDetector } from '@/lib/reorgDetector'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'

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
// ObservedBounty is the EXCEPTION to "ledger-only": a bounty funding whose
// webhook N-conf CONFIRMED callback was missed (e.g. the pid-map gate bug behind
// item 2808) must not stay provisional. The finalizer runs driveBountyFunding —
// the SAME ledger effects as the webhook CONFIRMED path (Item -> FUNDED,
// BOUNTY_FEE booked) — so the funding completes even when no callback ever fired.
// It also backfills a NULL height (0-conf detection with all later callbacks
// missed) by resolving the tx height from lws. See backfillNullBountyHeights.
//
// This module exports THREE things (mirrors worker/moneroIndexer.js):
//   - runConfirmFinalizerOnce: the testable per-run core (no pg-boss). Takes
//     injectable daemonClient + lwsClient so tests never touch the network.
//   - backfillNullBountyHeights: the lws height-resolution helper for NULL-height
//     DETECTED bounties (exported for unit testing).
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
export async function runConfirmFinalizerOnce ({ models, daemonClient: client = daemonClient, detectReorg: detect = detectReorg, lwsClient: lws = lwsClient } = {}) {
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
    if (authorId != null && tip.recipientAccount?.label !== 'platform_rewards') {
      try {
        await maybeGrantVerifiedBadge(models, authorId)
      } catch (err) {
        console.error('verified badge check failed (confirmFinalizer):', err)
      }
    }
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

  // ObservedBounty (A-13) — TRUE backstop for a missed webhook CONFIRMED
  // callback. The pid-map gate bug (item 2808) stranded the first real funding
  // at DETECTED: the 0-conf callback consumed the pid map, so every later
  // callback (including the N-conf CONFIRMED one that runs driveBountyFunding)
  // was a 200 no-op, and height was never backfilled (NULL at 0-conf). Two
  // passes close both gaps so the funding cannot stay provisional:
  //   PASS 1 (backfill): resolve a NULL height from lws (which watches the
  //     escrow account) so the funding pass can see the tx.
  //   PASS 2 (fund): run driveBountyFunding for mature DETECTED bounties — the
  //     SAME ledger effects as the webhook CONFIRMED path (Item -> FUNDED,
  //     BOUNTY_FEE booked), not just a row flip. Idempotent vs a late webhook
  //     replay (CONFIRMED state guard + FeeObservation ON CONFLICT) and vs the
  //     webhook itself (Serializable isolation serializes any overlap; a loser
  //     aborts and retries next run).
  const nullHeightBounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED', height: null },
    take: SCAN_BATCH_SIZE
  })
  if (nullHeightBounties.length) {
    await backfillNullBountyHeights({ models, lws, bounties: nullHeightBounties })
  }

  const bounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const bounty of bounties) {
    const confirmations = chainHeight - bounty.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.$transaction(async (tx) => {
      await driveBountyFunding(tx, bounty, {
        txHash: bounty.txHash, height: bounty.height, confirmations, piconeros: bounty.piconeros
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  return confirmed
}

// Resolve NULL heights for DETECTED bounties whose N-conf webhook CONFIRMED
// callback was missed (a 0-conf detection records height = NULL; if every later
// callback was a 200 no-op, no callback ever set it). lws watches the bounty
// escrow account and reports each incoming tx's block height, so a single
// get_address_txs scan per account recovers every stranded bounty on it.
// Mirrors the reconcilePendingTips lws-resolution pattern. Only the height is
// backfilled here; the funding decision runs in runConfirmFinalizerOnce's funding
// pass (which re-fetches height-not-null rows), so a still-mempool tx (height
// null on lws too) is left untouched and retries next run.
export async function backfillNullBountyHeights ({ models, lws, bounties }) {
  if (!bounties.length) return
  // Group by escrow account for one lws scan per account.
  const byAccount = new Map()
  for (const b of bounties) {
    if (!byAccount.has(b.recipientAccountId)) byAccount.set(b.recipientAccountId, [])
    byAccount.get(b.recipientAccountId).push(b)
  }
  const accounts = await models.moneroAccount.findMany({
    where: { id: { in: [...byAccount.keys()] } },
    include: { viewKey: true }
  })
  for (const account of accounts) {
    // Unscannable accounts (view key wiped / INACTIVE) can't be queried — lws
    // walletLogin would throw and abort the whole run. Skip; retry next run
    // (same guard as reconcilePendingTips).
    if (!account.viewKey || account.status !== 'ACTIVE') continue
    let resp
    try {
      resp = await lws.getAddressTxs(account, 0, null)
    } catch (err) {
      console.warn(`confirmFinalizer: lws bounty height resolve failed for account ${account.id}: ${err && err.message}`)
      continue
    }
    const byPid = new Map()
    for (const tx of (resp.transactions || [])) {
      if (tx.payment_id) byPid.set(String(tx.payment_id).toLowerCase(), tx)
    }
    for (const bounty of byAccount.get(account.id) || []) {
      const tx = byPid.get(String(bounty.paymentId).toLowerCase())
      // Only backfill once lws has a block height; a still-mempool tx (height
      // null) stays NULL and retries next run.
      if (tx && tx.height != null) {
        await models.observedBounty.update({
          where: { id: bounty.id },
          data: { height: tx.height, confirmations: tx.confirmations ?? 0 }
        })
      }
    }
  }
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
