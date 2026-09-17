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
    const distribution = await distribute(db)
    await finalizeDistribution(db, distribution, injectSendPayouts || defaultSendPayouts)
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
    for (const share of shares) {
      const account = await tx.moneroAccount.findFirst({ where: { ownerUserId: share.curatorId } })
      if (!account) continue
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
    // COMPLETE without ever entering SENDING.
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { status: 'COMPLETE', completedAt: new Date() }
    })
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
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { status: 'FAILED' }
      })
      moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
      return
    }
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { status: 'COMPLETE', completedAt: new Date() }
    })
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.COMPLETE)
  } catch (err) {
    logError({ distributionId: distribution.id, err }, 'rewardsDistributor: finalization failed')
    alert('critical', 'rewards distribution finalization failed',
      `distribution ${distribution.id}: ${err?.message || err}`,
      { dedupeKey: `dist-${distribution.id}-failed` })
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { status: 'FAILED' }
    })
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
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
