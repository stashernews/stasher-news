import { Prisma } from '@prisma/client'
import createPrisma from '@/lib/create-prisma'
import { computeCuratorShares, effectiveTrustWeightFloor } from './curatorShares'
import { sendPayouts as defaultSendPayouts } from '@/api/monero/rewards'
import logger, { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { moneroDistributionStatus } from '@/lib/metrics'

// rewardsDistributor — StasherNews' weekly rewards-pool distribution job
// (Phase 4 Task 8 / design spec §5, §6.2). Each week it:
//
//   1. tallies CONFIRMED platform-wallet inflow by source (downvotes +
//      posting/territory fees) for the period;
//   2. applies the PlatformFeeConfig allocation split to get the rewards earmark;
//   3. adds the prior period's rolledOverPiconeros to form the pool;
//   4. calls computeCuratorShares (Task 7) to apportion the pool to the curators
//      (tippers) of the period's top content;
//   5. writes one RewardDistribution row + one QUEUED RewardPayout per curator
//      who has a registered receiving address. Curators with no address are
//      excluded — their share joins the rollover.
//
// The actual on-chain signing/sending is Task 9's hot-wallet signer
// (api/monero/rewards.js): after the ledger transaction below commits a PENDING
// distribution + QUEUED payouts, finalizeDistribution drives the signer and
// flips the distribution PENDING -> SENDING -> COMPLETE (payouts QUEUED -> SENT).
//
// This module exports TWO things (mirrors worker/rewardsWalletObserver.js /
// worker/confirmFinalizer.js):
//   - runDistributionOnce: the testable per-run core (no pg-boss).
//   - rewardsDistributor:   the pg-boss handler. Runs the core once per scheduled
//                            weekly run (pgboss.schedule cron, Monday 00:00 UTC).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Scheduling-jitter grace for the weekly idempotency guard. Consecutive runs
// land L ms after Monday 00:00 UTC (pg-boss pickup latency, observed ~4s);
// with zero slack, L1 >= L2 puts last week's periodEnd at/inside this week's
// periodStart and the run silently skips. 1h is ~900x that margin and keeps
// every same-week re-run (cron + manual `sndev monero distribute`, FAILED
// re-drives) inside the skip window for 6d23h of the week.
const IDEMPOTENCY_GRACE_MS = 60 * 60 * 1000

const DISTRIBUTION_STATUS_GAUGE = { PENDING: 0, SENDING: 1, COMPLETE: 2, FAILED: 3 }

// One weekly distribution. The testable core: no pg-boss, no network. Accepts
// the Prisma client (so tests pass their own); creates a throwaway client if
// omitted. `sendPayouts` is injectable so tests drive the signer with a stub
// (no real keys/wallet); production leaves it unset and uses the real signer.
// Returns the created (or pre-existing, via idempotency) RewardDistribution
// with its RewardPayout rows included (post-send state).
export async function runDistributionOnce ({ models, sendPayouts: injectSendPayouts } = {}) {
  const ownsClient = !models
  const db = ownsClient ? createPrisma() : models
  try {
    const sendPayouts = injectSendPayouts || defaultSendPayouts
    // R02: recover distributions stranded in SENDING by a dead process BEFORE
    // this run's own work, so their QUEUED payouts are re-driven.
    await recoverStaleDistributions(db, { sendPayouts })
    await warnUndeliveredDistributions(db)
    const distribution = await distribute(db)
    await finalizeDistribution(db, distribution, sendPayouts)
    return await db.rewardDistribution.findUnique({
      where: { id: distribution.id },
      include: { payouts: true }
    })
  } finally {
    if (ownsClient) db.$disconnect().catch(logError)
  }
}

async function distribute (models) {
  const periodEnd = new Date()
  // Run-time-anchored window, used ONLY by the idempotency guard below. It must
  // stay run-time anchored: the inflow window (periodStart) starts at the last
  // distribution's periodEnd, so feeding periodStart to the guard would put the
  // previous row's periodEnd at/below the window start and a same-week re-run
  // would double-distribute instead of skipping.
  const runWindowStart = new Date(periodEnd.getTime() - WEEK_MS)

  // The whole ledger write is atomic: the idempotency check, the read-only
  // inflow/share computations, the RewardDistribution create, and the
  // RewardPayout createMany all run inside ONE serializable transaction so they
  // commit or roll back together. This mirrors the codebase's wallet-safety
  // convention (api/payIn/index.js `begin`; worker/moneroIndexer.js) and closes
  // two hazards the sequential-await form would have:
  //   - crash window: a process death between the distribution create and the
  //     payout createMany can no longer leave a PENDING RewardDistribution with
  //     payoutCount > 0 but zero RewardPayout rows;
  //   - race window: a concurrent run (a manual `sndev monero distribute`
  //     racing a scheduled cron fire) that both pass the findFirst can no longer
  //     both create — under Serializable the loser aborts, then either no-ops
  //     (finds the existing distribution on retry) or errors cleanly. No partial
  //     write is ever visible.
  return await models.$transaction(async (tx) => {
    // Idempotency: if a distribution already exists whose periodEnd falls
    // inside (or after) this week's window — minus a scheduling-jitter grace —
    // a run already happened this week; return it verbatim instead of
    // double-distributing. The grace absorbs pg-boss pickup latency: weekly
    // runs fire L1/L2 ms after Monday 00:00 UTC, and comparing with zero
    // slack made last week's periodEnd (L1) collide with this week's
    // periodStart (L2) whenever L1 >= L2, silently skipping the run. The
    // resumability path is preserved: a FAILED distribution re-driven later
    // the same week is still found here and re-finalized.
    const existing = await tx.rewardDistribution.findFirst({
      where: { periodEnd: { gte: new Date(runWindowStart.getTime() + IDEMPOTENCY_GRACE_MS) } },
      orderBy: { periodEnd: 'desc' },
      include: { payouts: true }
    })
    if (existing) {
      logInfo('rewardsDistributor: distribution already exists for this period; skipping')
      return existing
    }

    // Inflow window: contiguous with the previous distribution — start exactly
    // where it ended. A late run (cron delay/outage) must absorb its gap window
    // rather than drop it, and a run inside the jitter grace must not overlap
    // the previous window (double-allocation). Before the first distribution,
    // fall back to the trailing 7 days (matching lib/rewardsPool.js's open-cycle
    // fallback). Read inside the transaction: it also yields the rollover input.
    const lastDistribution = await tx.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
    const periodStart = lastDistribution?.periodEnd ?? runWindowStart

    // --- Inflow by source (all CONFIRMED, confirmedAt in [periodStart, periodEnd)) ---
    const [downvoteAgg, postingAgg, territoryAgg, donateRows, boostAgg, walletlessTipAgg, bountyRolloverAgg, bountyFeeAgg] = await Promise.all([
      tx.observedDownvote.aggregate({
        _sum: { piconeros: true },
        where: { state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { feeType: 'POSTING', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: {
          feeType: { in: ['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE'] },
          state: 'CONFIRMED',
          confirmedAt: { gte: periodStart, lt: periodEnd }
        }
      }),
      tx.feeObservation.findMany({
        where: { feeType: 'DONATE', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } },
        select: { piconeros: true, donationRewardsPct: true }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { feeType: 'BOOST', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { feeType: 'TIP_UNWALLETED', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { feeType: 'BOUNTY_ROLLOVER', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      }),
      tx.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { feeType: 'BOUNTY_FEE', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
      })
    ])

    const downvotePiconeros = toBigInt(downvoteAgg._sum.piconeros)
    const postingFeePiconeros = toBigInt(postingAgg._sum.piconeros)
    const territoryFeePiconeros = toBigInt(territoryAgg._sum.piconeros)
    // DONATE rows are fetched individually: each donation carries its own
    // donationRewardsPct (payer choice, default 100 -> pool).
    const donatePiconeros = donateRows.reduce((acc, r) => acc + toBigInt(r.piconeros), 0n)
    const donateRewardsPiconeros = donateRows.reduce(
      (acc, r) => acc + toBigInt(r.piconeros) * BigInt(r.donationRewardsPct ?? 100) / 100n, 0n)
    const boostPiconeros = toBigInt(boostAgg._sum.piconeros)
    const walletlessTipPiconeros = toBigInt(walletlessTipAgg._sum.piconeros)
    const bountyRolloverPiconeros = toBigInt(bountyRolloverAgg._sum.piconeros)
    const bountyFeePiconeros = toBigInt(bountyFeeAgg._sum.piconeros)

    // --- Allocation config (platform singleton row, id=1) ---
    const config = await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

    // Rewards earmark: floor each source's contribution at its allocation %. The
    // remainder (ops share) stays in the rewards wallet and is NOT distributed.
    // BigInt division floors, so each term is rounded down independently.
    // DONATE goes donationRewardsPct% to the pool (payer choice, default 100);
    // BOOST goes boostRewardsPct% (default 30) with the rest to ops;
    // wallet-less-author tips go walletlessTipRewardsPct% (default 70);
    // BOUNTY_ROLLOVER goes 100% to the pool (the escrow's bounty portion
    // physically arrived at the rewards wallet; the fee was booked at funding
    // as BOUNTY_FEE, 100% ops). The rest is the ops share.
    const rewardsInflow =
      downvotePiconeros * BigInt(config.downvoteRewardsPct) / 100n +
      postingFeePiconeros * BigInt(config.postingFeeRewardsPct) / 100n +
      territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct) / 100n +
      donateRewardsPiconeros +
      boostPiconeros * BigInt(config.boostRewardsPct) / 100n +
      walletlessTipPiconeros * BigInt(config.walletlessTipRewardsPct) / 100n +
      bountyRolloverPiconeros

    // BOUNTY_FEE counts toward totalInflow (it physically arrived at the
    // rewards wallet via the rollover) but 0% toward rewards — it was booked
    // 100% ops at funding confirmation, so opsInflow absorbs all of it.
    const totalInflow =
      downvotePiconeros +
      postingFeePiconeros +
      territoryFeePiconeros +
      donatePiconeros +
      boostPiconeros +
      walletlessTipPiconeros +
      bountyRolloverPiconeros +
      bountyFeePiconeros
    const opsInflow = totalInflow - rewardsInflow

    // --- Pool: this week's earmark + the prior period's rollover ---
    const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
    const poolPiconeros = rewardsInflow + rolledOver

    // Ops earmark rollover: prior period's unswept ops carried in. opsSwept is
    // populated by the ops-sweep job (B-sweep); until then it stays 0, so the
    // full prior opsAvailable rolls forward each week.
    const opsRolledOver = toBigInt(lastDistribution?.opsAvailablePiconeros) - toBigInt(lastDistribution?.opsSweptPiconeros)
    const opsAvailable = opsInflow + opsRolledOver

    // --- Curator trust weighting (#6): config floor + staleness fail-safe.
    // Weighting keys off the nightly trust walk's DEDICATED heartbeat
    // (HealthSnapshot.trustCompletedAt, written only after a fully-successful
    // run). max(UserSubTrust.updated_at) was rejected: territory create/
    // unarchive also write fresh rows, so a territory event inside the window
    // would mask a broken walk. Heartbeat missing/stale (> TRUST_STALENESS_MS)
    // or trust table empty => force 1.0 (weighting disabled) so a broken walk
    // can never slash payouts. ---
    const configTrustFloor = config.curatorTrustWeightFloor ?? 1.0
    const heartbeat = await tx.healthSnapshot.findUnique({ where: { id: 1 }, select: { trustCompletedAt: true } })
    const trustRows = await tx.userSubTrust.count()
    const trustWeightFloor = trustRows > 0
      ? effectiveTrustWeightFloor(configTrustFloor, heartbeat?.trustCompletedAt ?? null)
      : 1.0
    if (trustWeightFloor !== configTrustFloor) {
      logError('rewardsDistributor: trust walk stale or missing (heartbeat) — curator trust weighting disabled for this run')
    }

    // --- Curator shares (Task 7). Read-only, so it COULD run outside the tx,
    // but passing tx keeps the reads in the same serializable snapshot as the
    // writes below — fully consistent at no extra cost. ---
    const { shares } = await computeCuratorShares(
      periodStart, periodEnd, poolPiconeros,
      { minPayout: toBigInt(config.distributionMinPayoutPiconeros), topN: config.distributionTopN, trustWeightFloor },
      tx)

    // --- Address filter + payout rows ---
    // A curator is a tipper; they may not have registered a wallet to RECEIVE
    // payouts. Curators with no MoneroAccount(ownerUserId) are excluded — their
    // share rolls over (it stays in poolPiconeros - distributedPiconeros).
    const payoutRows = []
    const paidCuratorIds = new Set()
    for (const share of shares) {
      const account = await tx.moneroAccount.findFirst({ where: { ownerUserId: share.curatorId } })
      if (!account) continue
      paidCuratorIds.add(share.curatorId)
      payoutRows.push({
        curatorId: share.curatorId,
        recipientAddress: account.address,
        piconeros: share.sharePiconeros
      })
    }

    // --- Referral shares (A-09, forever-only) ---
    // For every paid curator with a referrer, the referrer earns 10% of that
    // curator's share IN ADDITION (paid from the pool, upstream FOREVER_REFERRAL
    // semantics). Referral payouts are aggregated per referrer. A referrer without
    // a MoneroAccount is skipped (their cut rolls over — mirroring address-less
    // curators). The total of curator + referral payouts is capped at the pool so
    // rolledOverPiconeros never goes negative.
    const curatorTotal = payoutRows.reduce((acc, p) => acc + p.piconeros, 0n)
    let referralBudget = poolPiconeros - curatorTotal

    const referralByReferrer = new Map() // referrerId -> { piconeros }
    for (const share of shares) {
      if (share.sharePiconeros <= 0n) continue
      // R04: referral payouts are earned on PAID curator shares only. A
      // wallet-less curator's share rolls over — 10% of money that was never
      // paid must not leak to their referrer.
      if (!paidCuratorIds.has(share.curatorId)) continue
      const curator = await tx.user.findUnique({
        where: { id: share.curatorId },
        select: { referrerId: true }
      })
      if (!curator?.referrerId) continue
      const referralPiconeros = share.sharePiconeros / 10n
      if (referralPiconeros <= 0n) continue
      const entry = referralByReferrer.get(curator.referrerId) || { piconeros: 0n }
      entry.piconeros += referralPiconeros
      referralByReferrer.set(curator.referrerId, entry)
    }

    // Referral payout rows are role-tagged here so the Earn loops below can tell
    // them apart from curator payout rows. A referrer who is ALSO a paid curator
    // contributes BOTH row kinds (same curatorId) — without the tag, the curator
    // loop re-emits the referrer's TIP_* earns and the referral loop emits a
    // FOREVER_REFERRAL row for the referrer's own curator share.
    const referralPayoutRows = new Set()
    for (const [referrerId, entry] of referralByReferrer) {
      if (referralBudget <= 0n) break
      const referrerAccount = await tx.moneroAccount.findFirst({ where: { ownerUserId: referrerId } })
      if (!referrerAccount) continue
      const piconeros = entry.piconeros < referralBudget ? entry.piconeros : referralBudget
      const row = { curatorId: referrerId, recipientAddress: referrerAccount.address, piconeros }
      payoutRows.push(row)
      referralPayoutRows.add(row)
      referralBudget -= piconeros
    }

    // --- Final ledger (atomic with the payout createMany below) ---
    // distributedPiconeros is the sum of the CREATED payouts (after address
    // filtering). rolledOverPiconeros is whatever is left — this captures BOTH
    // Task 7's sub-minPayout/topN rollover AND the addressless-curator rollover.
    const distributedPiconeros = payoutRows.reduce((acc, p) => acc + p.piconeros, 0n)
    const finalRolledOverPiconeros = poolPiconeros - distributedPiconeros

    const distribution = await tx.rewardDistribution.create({
      data: {
        periodStart,
        periodEnd,
        poolPiconeros,
        distributedPiconeros,
        rolledOverPiconeros: finalRolledOverPiconeros,
        opsInflowPiconeros: opsInflow,
        opsRolledOverPiconeros: opsRolledOver,
        opsAvailablePiconeros: opsAvailable,
        payoutCount: payoutRows.length,
        status: 'PENDING'
      }
    })

    if (payoutRows.length > 0) {
      await tx.rewardPayout.createMany({
        data: payoutRows.map(p => ({ ...p, distributionId: distribution.id, state: 'QUEUED' }))
      })
      // Write per-(curator, type) Earn rows for every paid curator — SN-parity
      // trophy list + exact "you earned X (Y%)" (sum(Earn) === distributedPiconeros).
      // typeId null = no item links (matches upstream). createdAt = periodEnd so
      // the meRewards day bucket + the in-app Earn notification date land on the
      // distribution day. Address-less curators get no rows (their share rolled
      // over; notifying "you stashed" for unreceived funds would be a lie).
      const earnRows = []
      for (const p of payoutRows) {
        // Referral rows emit only their FOREVER_REFERRAL Earn row below, never
        // curator-type rows — even when the referrer is ALSO a paid curator
        // (shares.find would otherwise succeed and re-emit the referrer's earns).
        if (referralPayoutRows.has(p)) continue
        const share = shares.find(s => s.curatorId === p.curatorId)
        for (const e of share?.earns ?? []) {
          earnRows.push({
            userId: p.curatorId,
            piconeros: e.piconeros,
            type: e.type,
            rank: e.rank,
            typeId: null,
            distributionId: distribution.id,
            createdAt: periodEnd
          })
        }
      }
      // FOREVER_REFERRAL Earn rows: one per referrer (only actual referral
      // payout rows — the role tag, not the curatorId, decides), rank/typeId
      // null (upstream parity). These are what the ReferralReward notification
      // and the /referrals page read.
      for (const p of payoutRows) {
        if (!referralPayoutRows.has(p)) continue
        earnRows.push({
          userId: p.curatorId,
          piconeros: p.piconeros,
          type: 'FOREVER_REFERRAL',
          rank: null,
          typeId: null,
          distributionId: distribution.id,
          createdAt: periodEnd
        })
      }
      await tx.earn.createMany({ data: earnRows })
    }

    // The on-chain signing + PENDING -> SENDING -> COMPLETE flip happens AFTER
    // this transaction commits, in finalizeDistribution (Task 9), so a signer
    // failure never rolls back the atomic ledger write above.

    logger.info({
      pool: poolPiconeros.toString(),
      distributed: distributedPiconeros.toString(),
      rolledOver: finalRolledOverPiconeros.toString(),
      opsAvailable: opsAvailable.toString(),
      payouts: payoutRows.length
    }, 'rewardsDistributor: distribution complete')

    return await tx.rewardDistribution.findUnique({
      where: { id: distribution.id },
      include: { payouts: true }
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 })
}

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// R03: FAILED payouts strand their funds (counted as distributed, excluded from
// rollover, re-entered only by manual reconciliation). Called at every
// transition to COMPLETE so the terminal state can never read clean while
// FAILED payouts exist. Logs + alerts only: no DB work, never throws.
function warnPayoutsStranded (distribution, payouts) {
  const failedPayouts = payouts.filter(p => p.state === 'FAILED')
  if (failedPayouts.length === 0) return
  const strandedPiconeros = failedPayouts.reduce((acc, p) => acc + p.piconeros, 0n)
  const ids = failedPayouts.map(p => p.id).join(', ')
  logError({ distributionId: distribution.id, failedCount: failedPayouts.length, strandedPiconeros: strandedPiconeros.toString() }, 'rewardsDistributor: CRITICAL — distribution completing with FAILED payouts (funds stranded)')
  alert('critical', 'rewards distribution completed with FAILED payouts — manual re-entry required',
    `distribution ${distribution.id} flips COMPLETE with ${failedPayouts.length} FAILED payout(s) [${ids}], ${strandedPiconeros.toString()} piconeros stranded (counted as distributed, excluded from rollover). ` +
    `Recover them with the requeue tool: sndev monero requeue ${distribution.id} --confirm (dev) or the loader-wrapped scripts/requeue-failed-payouts.js (VPS).`,
    { dedupeKey: `dist-${distribution.id}-complete-with-failures` })
}

// Task 9: drive the hot-wallet signer after the ledger transaction commits a
// PENDING distribution + its QUEUED payouts, and flip the distribution's status.
//
//   - Atomic {PENDING,FAILED} -> SENDING: the flip is a compare-and-set
//     (`UPDATE ... WHERE status IN ('PENDING','FAILED') RETURNING id`). A manual
//     `sndev monero distribute` racing the weekly cron can't both win the flip
//     and both call the signer on the same QUEUED rows — the loser's UPDATE
//     matches zero rows and it bails before sending. No double-send.
//   - Resumable after failure: a FAILED distribution that still has QUEUED
//     payouts is re-driven on the next run. sendPayouts is idempotent on QUEUED
//     rows (it filters `state === 'QUEUED'`, so already-SENT payouts are
//     skipped), so resuming never double-pays. (FAILED is in the CAS set above
//     for exactly this reason.)
//   - Nothing left to send: an empty week (0 payouts), or a row whose payouts
//     are all already SENT, reconciles straight to COMPLETE without entering
//     SENDING.
//   - SENDING / COMPLETE: a no-op for this call (another process is mid-send, or
//     the run already finished).
//   - Catastrophic signer failure: flip to FAILED. QUEUED payouts are untouched
//     (funds never left the wallet), so the next run resumes as above.
//   - Incomplete send summary: if sendPayouts reports any skipped or failed
//     payouts (skipped > 0 || failed > 0), the distribution is marked FAILED
//     (resumable) with a CRITICAL alert — it never reaches COMPLETE until every
//     payout is SENT. The ops-earmark sweep is deliberately NOT part of this
//     function (2026-09-14 decoupling): the handler enqueues worker/opsSweep.js
//     as a delayed one-shot after COMPLETE, so a sweep problem can never affect
//     distribution status.
//   - Unpersisted relays: a payout relayed on-chain whose DB persist failed
//     twice counts as `unpersisted` — same FAILED (resumable) path; the next
//     run's wallet-history reconciliation flips it SENT without re-sending
//     (never a silent COMPLETE, never a double pay).
export async function finalizeDistribution (models, distribution, sendPayouts) {
  // SENDING = another process is mid-send; COMPLETE = already done. Nothing for
  // this call to drive. (PENDING and FAILED fall through — FAILED is resumable
  // if it still has QUEUED payouts.)
  if (distribution.status === 'SENDING' || distribution.status === 'COMPLETE') return distribution

  const payouts = distribution.payouts || []
  const hasQueued = payouts.some(p => p.state === 'QUEUED')

  if (!hasQueued) {
    // Nothing to send — covers the 0-payout week AND a row whose payouts are all
    // already SENT (e.g. a FAILED run since delivered). Reconcile straight to
    // COMPLETE without ever entering SENDING. R03: the stranded-FAILED alert
    // fires first so the terminal flip can never silently mask them.
    warnPayoutsStranded(distribution, payouts)
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'COMPLETE', "completedAt" = NOW()
      WHERE id = ${distribution.id} AND status IN ('PENDING','FAILED') RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.COMPLETE)
    return
  }

  // Atomic CAS: only the process that flips {PENDING,FAILED} -> SENDING
  // proceeds. The loser's RETURNING is empty and it bails before sendPayouts, so
  // the same QUEUED payouts are never sent twice.
  const flipped = await models.$queryRaw`
    UPDATE "RewardDistribution" SET status = 'SENDING', "startedAt" = NOW()
    WHERE id = ${distribution.id} AND status IN ('PENDING','FAILED') RETURNING id`
  if (!flipped || flipped.length === 0) return
  moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.SENDING)

  try {
    const sendSummary = await sendPayouts(payouts, { models })
    if (sendSummary && (sendSummary.skipped > 0 || sendSummary.failed > 0 || (sendSummary.unpersisted || 0) > 0)) {
      logError({ distributionId: distribution.id, ...sendSummary }, 'rewardsDistributor: CRITICAL — payouts not fully sent; distribution FAILED (resumable)')
      alert('critical', 'rewards distribution send incomplete',
        `distribution ${distribution.id}: sent ${sendSummary.sent}, skipped ${sendSummary.skipped}, failed ${sendSummary.failed}, unpersisted ${sendSummary.unpersisted ?? 0}; marked FAILED (resumable) — payouts remain QUEUED` +
        ((sendSummary.unpersisted || 0) > 0 ? '. WARNING: unpersisted payouts WERE relayed on-chain; the next run reconciles them from wallet history — do NOT manually re-send them.' : ''),
        { dedupeKey: `dist-${distribution.id}-send-incomplete` })
      // Conditional on SENDING closes the ordinary races (e.g. a stale sender
      // whose row was watchdog-recovered and re-driven, R02, must not clobber
      // the newer owner's state). A sender genuinely alive beyond the stale
      // timeout is the documented, accepted tail.
      await models.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED'
        WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
      moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
      return
    }
    // R03: a mixed FAILED+QUEUED distribution must not flip COMPLETE silently
    // over stranded funds — warn before the success-path terminal write too.
    warnPayoutsStranded(distribution, payouts)
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'COMPLETE', "completedAt" = NOW()
      WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.COMPLETE)
  } catch (err) {
    logError({ distributionId: distribution.id, err }, 'rewardsDistributor: finalization failed')
    alert('critical', 'rewards distribution finalization failed',
      `distribution ${distribution.id}: ${err?.message || err}`,
      { dedupeKey: `dist-${distribution.id}-failed` })
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'FAILED'
      WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
  }
}

// Recovery re-entry for stranded payouts (2026-09-28 incident): a terminal
// FAILED payout with NULL txHash provably never moved money (FAILED is only
// written in relayBucketTx's createTx catch, where no tx exists), but nothing
// re-drives it — finalizeDistribution resumes only QUEUED rows and the weekly
// idempotency window stops returning the distribution after ~7d. This is the
// "manual re-entry" tool the R03 alert always referenced.
//
// Modes:
//   dry-run (default): report candidates, mutate nothing.
//   confirm: flip {FAILED, txHash IS NULL} -> QUEUED inside ONE Serializable
//     transaction that also re-reads status (refuse SENDING — a live sender
//     may be mid-send; the tx isolation closes the read-then-write race) and
//     un-masks COMPLETE -> FAILED (clearing completedAt) so finalize's CAS
//     accepts it. FAILED rows WITH a txHash are refused — they may have been
//     relayed; wallet-history reconciliation owns them (requeue = double pay).
//     Earn rows are NEVER touched: they were written at distribution time and
//     a recovery must not duplicate them.
//   drive (confirm + send, when >=1 row actually flipped OR the distribution
//     still holds QUEUED payouts — the classification-change stranding shape):
//     re-fetch and call finalizeDistribution with the real signer — the exact cron path
//     (CAS-protected against concurrent senders, wallet-history
//     reconciliation, idempotent on QUEUED). NEVER drive a no-op: finalize's
//     !hasQueued branch would mask the distribution COMPLETE over stranded
//     rows. A drive crash mid-send is self-healing: the R02 watchdog fails
//     the SENDING row after 24h and the next run re-drives.
export async function requeueFailedPayouts (models, distributionId, { confirm = false, send = true, sendPayouts: injectSendPayouts } = {}) {
  const distribution = await models.rewardDistribution.findUnique({
    where: { id: distributionId },
    include: { payouts: true }
  })
  if (!distribution) throw new Error(`distribution ${distributionId} not found`)

  const candidates = distribution.payouts.filter(p => p.state === 'FAILED' && p.txHash === null)
  const refusedWithTxHash = distribution.payouts.filter(p => p.state === 'FAILED' && p.txHash !== null).map(p => p.id)
  const queuedCount = distribution.payouts.filter(p => p.state === 'QUEUED').length
  const candidatePiconeros = candidates.reduce((acc, p) => acc + p.piconeros, 0n)
  const summary = {
    distributionId,
    status: distribution.status,
    candidates: candidates.map(p => ({ id: p.id, curatorId: p.curatorId, recipientAddress: p.recipientAddress, piconeros: p.piconeros })),
    candidatePiconeros,
    refusedWithTxHash,
    queuedCount,
    requeued: 0,
    drove: false,
    finalStatus: distribution.status
  }
  // Proceed when there are FAILED rows to requeue OR QUEUED payout(s) to deliver (the classification-change stranding shape): confirm-mode drives finalize for QUEUED rows — safe because finalize's masking !hasQueued branch cannot fire while QUEUED rows exist, its CAS loses to any live sender, and wallet-history reconciliation covers secretly-relayed rows.
  if (!confirm || (candidates.length === 0 && queuedCount === 0)) return summary

  const txResult = await models.$transaction(async (tx) => {
    const fresh = await tx.rewardDistribution.findUnique({ where: { id: distributionId }, select: { status: true } })
    if (!fresh || fresh.status === 'SENDING') {
      throw new Error(`distribution ${distributionId} is ${fresh ? fresh.status : 'missing'} — refusing to requeue (a sender may be live; retry after it settles)`)
    }
    // The WHERE re-filters at write time: anything that changed since the
    // summary read (row SENT, hash appeared) is excluded atomically.
    const res = await tx.rewardPayout.updateMany({
      where: { distributionId, state: 'FAILED', txHash: null },
      data: { state: 'QUEUED' }
    })
    let unmasked = false
    if ((res.count > 0 || queuedCount > 0) && fresh.status === 'COMPLETE') {
      // Un-mask: a prior !hasQueued finalize flipped it COMPLETE over stranded
      // rows; finalizeDistribution's CAS only accepts {PENDING, FAILED}.
      await tx.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED', "completedAt" = NULL
        WHERE id = ${distributionId} AND status = 'COMPLETE' RETURNING id`
      unmasked = true
    }
    return { requeued: res.count, unmasked }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 })

  summary.requeued = txResult.requeued
  if (txResult.unmasked) {
    summary.status = 'FAILED'
    summary.finalStatus = 'FAILED'
  }
  if (txResult.requeued === 0 && queuedCount === 0) return summary
  if (txResult.requeued > 0) {
    logInfo({ distributionId, requeued: txResult.requeued, piconeros: candidatePiconeros.toString() }, 'rewardsDistributor: requeued stranded FAILED payouts (pre-relay, provably unsent)')
    alert('warn', 'rewards payouts requeued for delivery',
      `operator requeued ${txResult.requeued} stranded FAILED payout(s) of distribution ${distributionId} (${candidatePiconeros.toString()} piconeros) to QUEUED${send ? '; delivery is being driven now' : ' (ledger-only, --no-send)'}.`,
      { dedupeKey: `dist-${distributionId}-requeued` })
  }

  if (send) {
    const signer = injectSendPayouts || defaultSendPayouts
    const fresh = await models.rewardDistribution.findUnique({ where: { id: distributionId }, include: { payouts: true } })
    await finalizeDistribution(models, fresh, signer)
    summary.drove = true
    const after = await models.rewardDistribution.findUnique({ where: { id: distributionId } })
    summary.finalStatus = after?.status ?? null
  }
  return summary
}

// Safety net (2026-09-28 incident): payouts strand invisibly once their
// distribution leaves the weekly idempotency window (~7d) — QUEUED rows are
// never re-driven (no cron path owns out-of-window distributions) and
// terminal FAILED rows are alerted once at failure, then never again. This
// read-only check runs at the top of every distribution run and nags until a
// human recovers them with requeueFailedPayouts. Best-effort by design: a
// check failure must never break the distribution itself. 8d = the 7d window
// + 1h grace + slack, so nothing the current run's idempotency guard still
// owns is flagged. Dev caveat: real-DB test residue can trigger this until
// ./scripts/clean-rewards-test-residue.sh runs.
export async function warnUndeliveredDistributions (models) {
  try {
    const cutoff = new Date(Date.now() - (WEEK_MS + DAY_MS))
    const stranded = await models.rewardDistribution.findMany({
      where: {
        periodEnd: { lt: cutoff },
        payouts: { some: { OR: [{ state: 'QUEUED' }, { state: 'FAILED', txHash: null }] } }
      },
      include: { payouts: true },
      orderBy: { id: 'asc' }
    })
    for (const dist of stranded) {
      const rows = dist.payouts.filter(p => p.state === 'QUEUED' || (p.state === 'FAILED' && p.txHash === null))
      const piconeros = rows.reduce((acc, p) => acc + p.piconeros, 0n)
      logError({ distributionId: dist.id, undeliveredCount: rows.length, piconeros: piconeros.toString() }, 'rewardsDistributor: CRITICAL — undelivered payouts stranded outside the weekly window')
      alert('critical', 'rewards payouts undelivered (stranded)',
        `distribution ${dist.id} (period ${dist.periodStart?.toISOString()} -> ${dist.periodEnd?.toISOString()}) holds ${rows.length} undelivered payout(s) [${rows.map(p => p.id).join(', ')}], ${piconeros.toString()} piconeros — QUEUED rows are never re-driven automatically and FAILED rows need re-entry. Recover with: sndev monero requeue ${dist.id} --confirm (dev) or the loader-wrapped scripts/requeue-failed-payouts.js (VPS).`,
        { dedupeKey: `dist-${dist.id}-undelivered` })
    }
  } catch (err) {
    logError({ err }, 'rewardsDistributor: undelivered-payouts check failed (non-fatal)')
  }
}

// R02: how long a distribution may stay SENDING before the watchdog declares
// it stranded. Worst-case genuine send = singleton wallet open (restore-height
// sync dominates — minutes to low hours) + per-run incremental syncs + <=6
// bucket create/relay cycles + row persists. 24h is ~10-100x that margin; it
// is the ONLY bound against flipping a genuinely-live sender (which would let
// a second sendPayouts double-pay), so never configure it within an order of
// magnitude of a plausible send duration.
const REWARDS_SENDING_STALE_HOURS = Number(process.env.REWARDS_SENDING_STALE_HOURS) || 24

// R02 watchdog: a process death between the SENDING CAS and the terminal
// write (OOM, deploy restart, host crash) strands the row forever — the weekly
// run early-returns on SENDING, the CLI takes the same path, and opsSweep
// skips it. Flip stale rows to FAILED (the finalize CAS resumes FAILED) and
// re-drive them immediately: sendPayouts re-sends only QUEUED rows and its
// wallet-history reconciliation (reconcileUnpersistedPayouts) absorbs
// relayed-but-unpersisted rows from the dead process without re-sending.
// Runs at the top of runDistributionOnce (weekly cron + manual/CLI runs); no
// self-requeue, no new schedule row.
export async function recoverStaleDistributions (models, { sendPayouts, staleHours = REWARDS_SENDING_STALE_HOURS } = {}) {
  const staleBefore = new Date(Date.now() - staleHours * 60 * 60 * 1000)
  const stale = await models.rewardDistribution.findMany({
    where: { status: 'SENDING', startedAt: { lt: staleBefore } },
    orderBy: { id: 'asc' }
  })
  for (const dist of stale) {
    try {
      // The staleness predicate is part of the CAS, not just the read above:
      // two overlapping runs can both read this stale row, run A's re-drive
      // gives it a fresh SENDING + startedAt (TOCTOU), and run B's CAS — issued
      // from its earlier read — must not flip that newer owner back to FAILED
      // and re-drive the same QUEUED rows (double pay).
      const flipped = await models.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED'
        WHERE id = ${dist.id} AND status = 'SENDING' AND "startedAt" < ${staleBefore} RETURNING id`
      if (!flipped || flipped.length === 0) continue // state moved underneath us
      moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
      logError({ distributionId: dist.id, startedAt: dist.startedAt }, 'rewardsDistributor: CRITICAL — distribution stuck SENDING; watchdog failed it, re-driving now')
      alert('critical', 'rewards distribution stuck SENDING — watchdog failed it',
        `distribution ${dist.id} has been SENDING since ${dist.startedAt?.toISOString()} (> ${staleHours}h). The watchdog flipped it FAILED and is re-driving the send now. If some payouts were already relayed before the crash, wallet-history reconciliation prevents a double pay.`,
        { dedupeKey: `dist-${dist.id}-stale-sending` })
      const fresh = await models.rewardDistribution.findUnique({ where: { id: dist.id }, include: { payouts: true } })
      await finalizeDistribution(models, fresh, sendPayouts || defaultSendPayouts)
    } catch (err) {
      logError({ distributionId: dist.id, err }, 'rewardsDistributor: stale-SENDING recovery failed')
      alert('critical', 'rewards stale-SENDING recovery failed',
        `distribution ${dist.id}: recovery threw ${err?.message || err}; the row stays FAILED-resumable and the next run retries`,
        { dedupeKey: `dist-${dist.id}-stale-recovery-failed` })
    }
  }
}

// Delay between the payout run and the ops sweep. The payout tx's change is
// 10-block locked (~20 min at Monero's 2-min block target) and the shared
// wallet is mid-churn right after a send — the exact window that made the
// inline sweep throw wallet2 "tx not possible" on 2026-09-14 and fail a
// fully-paid distribution. One hour clears the lock with wide margin.
export const OPS_SWEEP_DELAY_SECONDS = 60 * 60

// Enqueue the one-shot delayed sweep for a settled distribution. No retryLimit:
// a thrown sweep error is almost always pre-relay, and re-driving after a
// partial relay would over-target without cumulative opsSwept accounting — the
// weekly distribution re-enqueues (rollover) instead. singletonKey collapses
// duplicate enqueues of the same row (idempotent across same-week reruns).
export async function enqueueOpsSweep (boss, distribution) {
  if (!boss || distribution?.status !== 'COMPLETE') return
  await boss.send('opsSweep', { distributionId: distribution.id }, {
    startAfter: OPS_SWEEP_DELAY_SECONDS,
    singletonKey: `opsSweep-${distribution.id}`
  })
}

// pg-boss handler. Runs one weekly distribution. Recurring scheduling is owned
// by the pgboss.schedule row (cron 0 0 * * 1 UTC, added by migration
// 20260807160000_schedule_rewards_distributor), NOT a relative self-requeue — so
// runs land on the same Monday 00:00 UTC the rewards resolver counts down to
// (api/resolvers/rewards.js). `sndev monero distribute` calls runDistributionOnce
// directly for out-of-band runs. When the run settles COMPLETE, the handler
// also enqueues the ops-earmark sweep as a 1h-delayed one-shot (see
// enqueueOpsSweep) — the sweep is never part of the payout run itself.
export async function rewardsDistributor ({ models, boss } = {}) {
  const distribution = await runDistributionOnce({ models })
  await enqueueOpsSweep(boss, distribution)
}
