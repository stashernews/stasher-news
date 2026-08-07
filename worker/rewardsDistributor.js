import { Prisma } from '@prisma/client'
import createPrisma from '@/lib/create-prisma'
import { computeCuratorShares } from './curatorShares'
import { sendPayouts as defaultSendPayouts } from '@/api/monero/rewards'

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
// This module exports TWO things (mirrors worker/penaltyIndexer.js /
// worker/confirmFinalizer.js):
//   - runDistributionOnce: the testable per-run core (no pg-boss).
//   - rewardsDistributor:   the pg-boss handler. Runs the core and self-requeues
//                            weekly.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const WEEK_SECONDS = 7 * 24 * 60 * 60

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
    if (ownsClient) db.$disconnect().catch(console.error)
  }
}

async function distribute (models) {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - WEEK_MS)

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
    // Idempotency: if a distribution already exists whose periodEnd falls inside
    // (or after) this week's window, a run already happened this week — return it
    // verbatim instead of double-distributing.
    const existing = await tx.rewardDistribution.findFirst({
      where: { periodEnd: { gte: periodStart } },
      orderBy: { periodEnd: 'desc' },
      include: { payouts: true }
    })
    if (existing) {
      console.log('rewardsDistributor: distribution already exists for this period; skipping')
      return existing
    }

    // --- Inflow by source (all CONFIRMED, confirmedAt in [periodStart, periodEnd)) ---
    const [downvoteAgg, postingAgg, territoryAgg] = await Promise.all([
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
      })
    ])

    const downvotePiconeros = toBigInt(downvoteAgg._sum.piconeros)
    const postingFeePiconeros = toBigInt(postingAgg._sum.piconeros)
    const territoryFeePiconeros = toBigInt(territoryAgg._sum.piconeros)

    // --- Allocation config (platform singleton row, id=1) ---
    const config = await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

    // Rewards earmark: floor each source's contribution at its allocation %. The
    // remainder (ops share) stays in the rewards wallet and is NOT distributed.
    // BigInt division floors, so each term is rounded down independently.
    const rewardsInflow =
      downvotePiconeros * BigInt(config.downvoteRewardsPct) / 100n +
      postingFeePiconeros * BigInt(config.postingFeeRewardsPct) / 100n +
      territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct) / 100n

    // --- Pool: this week's earmark + the prior period's rollover ---
    const lastDistribution = await tx.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
    const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
    const poolPiconeros = rewardsInflow + rolledOver

    // --- Curator shares (Task 7). Read-only, so it COULD run outside the tx,
    // but passing tx keeps the reads in the same serializable snapshot as the
    // writes below — fully consistent at no extra cost. ---
    const { shares } = await computeCuratorShares(
      periodStart, periodEnd, poolPiconeros,
      { minPayout: toBigInt(config.distributionMinPayoutPiconeros), topN: config.distributionTopN },
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
        payoutCount: payoutRows.length,
        status: 'PENDING'
      }
    })

    if (payoutRows.length > 0) {
      await tx.rewardPayout.createMany({
        data: payoutRows.map(p => ({ ...p, distributionId: distribution.id, state: 'QUEUED' }))
      })
    }

    // The on-chain signing + PENDING -> SENDING -> COMPLETE flip happens AFTER
    // this transaction commits, in finalizeDistribution (Task 9), so a signer
    // failure never rolls back the atomic ledger write above.

    console.log(`rewardsDistributor: pool=${poolPiconeros.toString()} distributed=${distributedPiconeros.toString()} rolledOver=${finalRolledOverPiconeros.toString()} payouts=${payoutRows.length}`)

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
    return
  }

  // Atomic CAS: only the process that flips {PENDING,FAILED} -> SENDING
  // proceeds. The loser's RETURNING is empty and it bails before sendPayouts, so
  // the same QUEUED payouts are never sent twice.
  const flipped = await models.$queryRaw`
    UPDATE "RewardDistribution" SET status = 'SENDING', "startedAt" = NOW()
    WHERE id = ${distribution.id} AND status IN ('PENDING','FAILED') RETURNING id`
  if (!flipped || flipped.length === 0) return

  try {
    await sendPayouts(payouts, { models })
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { status: 'COMPLETE', completedAt: new Date() }
    })
  } catch (err) {
    console.error(`rewardsDistributor: sendPayouts failed for distribution ${distribution.id}: ${err && err.message}`)
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { status: 'FAILED' }
    })
  }
}

// pg-boss handler. Runs the weekly distribution and self-requeues for the next
// week. Mirrors the penaltyIndexer/confirmFinalizer self-requeuing pattern.
export async function rewardsDistributor ({ boss, models }) {
  await runDistributionOnce({ models })
  await boss.send('rewardsDistributor', {}, { startAfter: WEEK_SECONDS })
}
