import { Prisma } from '@prisma/client'
import { daemonClient } from '@/api/monero/daemonClient'
import { lwsClient } from '@/api/monero/lwsClient'
import { findRewardsAccount } from './rewardsWalletObserver'
import { driveBountyFunding, recordBountyReceipt } from '@/api/monero/bountyFunding'
import { bountyFeePiconeros } from '@/api/monero/bounties'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { createReorgDetector } from '@/lib/reorgDetector'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { excludeDetectedTipIfSelfSend } from '@/api/monero/selfTip'

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
// Scope: ObservedTip, FeeObservation, ObservedSubFee, AND ObservedDownvote. The
// tip flip is coupled to the author stackedPiconeros denorm (atomic); the fee,
// sub-fee (turf-owner), and downvote flips are ledger-only (their ranking/
// visibility effects already applied at DETECTION).
// Reorg reversal is NOT implemented — deferred as an accepted v1 limitation
// (consistent with the tip flow; a >10-block Monero reorg is negligible).
//
// ObservedBounty is the EXCEPTION to "ledger-only": a bounty funding whose
// webhook N-conf CONFIRMED callback was missed (e.g. the pid-map gate bug behind
// item 2808) must not stay provisional. The finalizer runs driveBountyFunding —
// the SAME ledger effects as the webhook CONFIRMED path (Item -> FUNDED,
// BOUNTY_FEE booked) — so the funding completes even when no callback ever fired.
// It also reconciles lws receipts for still-short DETECTED bounties (and
// backfills a NULL height from lws when every callback was missed). See
// backfillNullBountyHeights.
//
// This module exports FOUR things (mirrors worker/moneroIndexer.js):
//   - runConfirmFinalizerOnce: the testable per-run core (no pg-boss). Takes
//     injectable daemonClient + lwsClient so tests never touch the network.
//   - backfillNullBountyHeights: the lws reconcile helper for still-short
//     DETECTED bounties (receipt folding + NULL-height resolution; exported
//     for unit testing).
//   - backfillNullObservationHeights: the lws height-resolution helper for
//     NULL-height poll-detected DETECTED ObservedDownvote/FeeObservation rows
//     (exported for unit testing).
//   - confirmFinalizer: the pg-boss handler. Runs the core once; recurrence
//     is cron-owned (pgboss.schedule row confirmFinalizer, every 60s).

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

  // PASS 0 (backfill): resolve NULL heights for poll-detected DETECTED rows so
  // the maturity passes below can see them (they filter height NOT NULL).
  const nullHeightDownvotes = await models.observedDownvote.findMany({
    where: { state: 'DETECTED', height: null },
    take: SCAN_BATCH_SIZE
  })
  const nullHeightFees = await models.feeObservation.findMany({
    where: { state: 'DETECTED', height: null },
    take: SCAN_BATCH_SIZE
  })
  if (nullHeightDownvotes.length || nullHeightFees.length) {
    await backfillNullObservationHeights({ models, lws, downvotes: nullHeightDownvotes, fees: nullHeightFees })
  }

  // Mempool tips (height == null) carry no block height to confirm against, so
  // they are excluded here — they become eligible the moment lws reports them
  // confirmed (height set) on a later indexer poll.
  const tips = await models.observedTip.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    // recipientAccount fields feed the confirm-time self-send re-check
    // (excludeDetectedTipIfSelfSend): viewKey/status gate the lws scan,
    // subaddresses feed isSelfSend, id anchors the cursor advance.
    include: {
      post: { select: { userId: true } },
      recipientAccount: { select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } } }
    },
    take: SCAN_BATCH_SIZE
  })

  let confirmed = 0
  for (const tip of tips) {
    const confirmations = chainHeight - tip.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue

    // Self-send re-check before the credit (the 0-conf gap): lws cannot see
    // spent_outputs for the tx while it sat in the mempool, so the detection-
    // time check can have failed open. The tx is mined now (height is set), so
    // the evidence exists — this is the last gate before stackedPiconeros.
    // The webhook N-conf callback races us for the claim and runs the same
    // check, so a wash tip is excluded regardless of which claimer wins. An
    // lws failure skips the tip this run (fail closed on the credit path);
    // recurrence is cron-owned, so the next tick retries.
    let excluded = false
    try {
      excluded = await excludeDetectedTipIfSelfSend({ models, monero: lws, tip, confirmations })
    } catch (err) {
      console.warn(`confirmFinalizer: self-send recheck failed for tip ${tip.id}: ${err && err.message}`)
      continue
    }
    if (excluded) continue

    // Resolve the author via the tipped post. The ObservedTip.postId FK is
    // ON DELETE RESTRICT (non-nullable), so the Item cannot be deleted while
    // the tip exists — post is always present. The guard is defensive only.
    const authorId = tip.post?.userId
    await models.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "ObservedTip"
        SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
        WHERE id = ${tip.id} AND state = 'DETECTED'`
      if (claimed > 0 && authorId != null && tip.recipientAccount?.label !== 'platform_rewards') {
        await tx.user.update({
          where: { id: authorId },
          data: { stackedPiconeros: { increment: tip.piconeros } }
        })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
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

  // ObservedSubFee (turf-owner fee legs): ledger-only maturity, mirroring the
  // FeeObservation pass. The lws webhook N-conf callback is the primary
  // maturer; this is the safety net for missed callbacks (deploy restarts,
  // swept stragglers) — without it a missed callback strands the receipt at
  // DETECTED forever, invisible to revenue notifications/leaderboard/
  // earnedPiconeros (all filter CONFIRMED). Revenue notifications are
  // query-side (the notifications resolver reads CONFIRMED rows) — no effects
  // here. The conditional updateMany (state: 'DETECTED' guard) makes a race
  // with a late webhook CONFIRMED callback a count-0 no-op instead of a
  // confirmedAt overwrite. NULL-height DETECTED rows are the reconcile
  // chain's job, not this pass's.
  const subFees = await models.observedSubFee.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    select: { id: true, height: true },
    take: SCAN_BATCH_SIZE
  })
  let subFeeConfirmed = 0
  for (const subFee of subFees) {
    const confirmations = chainHeight - subFee.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    const res = await models.observedSubFee.updateMany({
      where: { id: subFee.id, state: 'DETECTED' },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
    subFeeConfirmed += res.count
  }
  if (subFeeConfirmed > 0) {
    console.log(`confirmFinalizer: matured ${subFeeConfirmed} ObservedSubFee receipt(s) DETECTED -> CONFIRMED (missed N-conf callback safety net)`)
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
  //   PASS 1 (reconcile): fold lws receipts for every still-short DETECTED
  //     bounty REGARDLESS of height (plus every NULL-height one, for the
  //     height backfill) so a top-up whose callbacks were all lost still
  //     opens the gate.
  //   PASS 2 (fund): run driveBountyFunding for mature DETECTED bounties — the
  //     SAME ledger effects as the webhook CONFIRMED path (Item -> FUNDED,
  //     BOUNTY_FEE booked), not just a row flip. Idempotent vs a late webhook
  //     replay (CONFIRMED state guard + FeeObservation ON CONFLICT) and vs the
  //     webhook itself (Serializable isolation serializes any overlap; a loser
  //     aborts and retries next run).
  const detectedBounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED' },
    include: { post: { select: { bountyPiconeros: true } } },
    take: SCAN_BATCH_SIZE
  })
  if (detectedBounties.length) {
    // Skip fully-covered height-set bounties to bound the lws work — they only
    // await the funding pass below. Shortness is computed the same way the
    // 7-day sweep computes it (fee on the DECLARED amount, one config read).
    const bountyConfig = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    const reconcileBounties = detectedBounties.filter(b =>
      b.height == null || b.piconeros < b.post.bountyPiconeros + bountyFeePiconeros(b.post.bountyPiconeros, bountyConfig))
    if (reconcileBounties.length) {
      await backfillNullBountyHeights({ models, lws, bounties: reconcileBounties })
    }
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

// Fold lws receipts and resolve NULL heights for the still-short DETECTED
// bounties the caller passes (every NULL-height one plus every height-set one
// not yet fully covered). A top-up whose webhook callbacks were ALL lost is
// recorded by nothing else — the observer watches only the rewards wallet and
// reconcilePendingTips is tips-only — so EVERY matching lws tx becomes a
// receipt (idempotent by txHash) and ObservedBounty.piconeros folds to the
// cumulative sum. lws watches the bounty escrow account and reports each
// incoming tx's block height, so a single get_address_txs scan per account
// recovers every stranded bounty on it. Mirrors the reconcilePendingTips
// lws-resolution pattern. The height column is only backfilled here when NULL
// (set to the max matched tx height); the funding decision runs in
// runConfirmFinalizerOnce's funding pass (which re-fetches height-not-null
// rows), so a still-mempool tx (height null on lws too) is left untouched and
// retries next run.
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
      if (!tx.payment_id) continue
      const pid = String(tx.payment_id).toLowerCase()
      if (!byPid.has(pid)) byPid.set(pid, [])
      byPid.get(pid).push(tx)
    }
    for (const bounty of byAccount.get(account.id) || []) {
      const txs = byPid.get(String(bounty.paymentId).toLowerCase()) || []
      let maxHeight = bounty.height
      for (const tx of txs) {
        if (tx.height == null) continue
        await recordBountyReceipt(models, bounty, { txHash: tx.hash, piconeros: tx.piconeros, height: tx.height })
        if (maxHeight == null || tx.height > maxHeight) maxHeight = tx.height
      }
      // Only backfill once lws has a block height; a still-mempool tx (height
      // null) stays NULL and retries next run.
      if (maxHeight != null && bounty.height == null) {
        await models.observedBounty.update({
          where: { id: bounty.id },
          data: { height: maxHeight }
        })
      }
    }
  }
}

// Resolve NULL heights for poll-detected DETECTED rows (ObservedDownvote,
// FeeObservation). The rewardsWalletObserver records these rows the moment lws
// first reports a tx; if that report was a mempool-shaped row (height omitted —
// structurally possible per the lwsClient parser), the maturity passes skip the
// row forever (height: { not: null }) and nothing else backfills it. One
// get_address_txs scan of the platform rewards account resolves every stranded
// row on it, matched by txHash. Still-mempool txs (height null on lws too) are
// left untouched and retry next run. Mirrors backfillNullBountyHeights.
export async function backfillNullObservationHeights ({ models, lws, downvotes, fees }) {
  if (!downvotes.length && !fees.length) return
  const account = await findRewardsAccount(models)
  // Unscannable account (view key wiped / INACTIVE) can't be queried — lws
  // walletLogin would throw and abort the whole run. Skip; retry next run.
  if (!account || !account.viewKey) return
  let resp
  try {
    resp = await lws.getAddressTxs(account, 0, null)
  } catch (err) {
    console.warn(`confirmFinalizer: lws observation height resolve failed for account ${account.id}: ${err && err.message}`)
    return
  }
  const byHash = new Map()
  for (const tx of (resp.transactions || [])) {
    if (tx.hash) byHash.set(String(tx.hash).toLowerCase(), tx)
  }
  for (const dv of downvotes) {
    const tx = byHash.get(String(dv.txHash).toLowerCase())
    if (tx && tx.height != null) {
      await models.observedDownvote.update({
        where: { id: dv.id },
        data: { height: tx.height, confirmations: tx.confirmations ?? 0 }
      })
    }
  }
  for (const fee of fees) {
    const tx = byHash.get(String(fee.txHash).toLowerCase())
    if (tx && tx.height != null) {
      await models.feeObservation.update({
        where: { id: fee.id },
        data: { height: tx.height, confirmations: tx.confirmations ?? 0 }
      })
    }
  }
}

// pg-boss handler. Runs one scan per invocation; recurrence is cron-owned
// (pgboss.schedule row confirmFinalizer, every 60s) — no self-requeue. The
// one-shot seed in worker/index.js only covers an empty queue at boot.
export async function confirmFinalizer ({ models }) {
  // Recurrence is cron-owned (pgboss.schedule row confirmFinalizer); no
  // self-requeue.
  await runConfirmFinalizerOnce({ models })
}
