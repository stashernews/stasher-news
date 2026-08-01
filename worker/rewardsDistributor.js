import createPrisma from '@/lib/create-prisma'
import { computeCuratorShares } from './curatorShares'

// rewardsDistributor — StealthNews' weekly rewards-pool distribution job
// (Phase 4 Task 8 / design spec §5, §6.2). Each week it:
//
//   1. tallies CONFIRMED platform-wallet inflow by source (downvote burns +
//      posting/territory fees) for the period;
//   2. applies the PlatformFeeConfig allocation split to get the rewards earmark;
//   3. adds the prior period's rolledOverPiconeros to form the pool;
//   4. calls computeCuratorShares (Task 7) to apportion the pool to the curators
//      (tippers) of the period's top content;
//   5. writes one RewardDistribution row + one QUEUED RewardPayout per curator
//      who has a registered receiving address. Curators with no address are
//      excluded — their share joins the rollover.
//
// The actual on-chain signing/sending is Task 9's hot-wallet signer; until it
// lands, payouts remain QUEUED and the distribution stays PENDING.
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
// omitted. Returns the created (or pre-existing, via idempotency) RewardDistribution
// with its RewardPayout rows included.
export async function runDistributionOnce ({ models } = {}) {
  const ownsClient = !models
  const db = ownsClient ? createPrisma() : models
  try {
    return await distribute(db)
  } finally {
    if (ownsClient) db.$disconnect().catch(console.error)
  }
}

async function distribute (models) {
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - WEEK_MS)

  // Idempotency: if a distribution already exists whose periodEnd falls inside
  // (or after) this week's window, a run already happened this week — return it
  // verbatim instead of double-distributing.
  const existing = await models.rewardDistribution.findFirst({
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
    models.observedBurn.aggregate({
      _sum: { piconeros: true },
      where: { state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
    }),
    models.feeObservation.aggregate({
      _sum: { piconeros: true },
      where: { feeType: 'POSTING', state: 'CONFIRMED', confirmedAt: { gte: periodStart, lt: periodEnd } }
    }),
    models.feeObservation.aggregate({
      _sum: { piconeros: true },
      where: {
        feeType: { in: ['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE'] },
        state: 'CONFIRMED',
        confirmedAt: { gte: periodStart, lt: periodEnd }
      }
    })
  ])

  const downvotePiconeros = toBigInt(downvoteAgg._sum.piconeros)
  const postingFeePiconeros = toBigInt(postingAgg._sum.piconeros)
  const territoryFeePiconeros = toBigInt(territoryAgg._sum.piconeros)

  // --- Allocation config (platform singleton row, id=1) ---
  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

  // Rewards earmark: floor each source's contribution at its allocation %. The
  // remainder (ops share) stays in the rewards wallet and is NOT distributed.
  // BigInt division floors, so each term is rounded down independently.
  const rewardsInflow =
    downvotePiconeros * BigInt(config.downvoteRewardsPct) / 100n +
    postingFeePiconeros * BigInt(config.postingFeeRewardsPct) / 100n +
    territoryFeePiconeros * BigInt(config.territoryFeeRewardsPct) / 100n

  // --- Pool: this week's earmark + the prior period's rollover ---
  const lastDistribution = await models.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
  const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
  const poolPiconeros = rewardsInflow + rolledOver

  // --- Curator shares (Task 7) ---
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, poolPiconeros,
    { minPayout: toBigInt(config.distributionMinPayoutPiconeros), topN: config.distributionTopN },
    models)

  // --- Address filter + payout rows ---
  // A curator is a tipper; they may not have registered a wallet to RECEIVE
  // payouts. Curators with no MoneroAccount(ownerUserId) are excluded — their
  // share rolls over (it stays in poolPiconeros - distributedPiconeros).
  const payoutRows = []
  for (const share of shares) {
    const account = await models.moneroAccount.findFirst({ where: { ownerUserId: share.curatorId } })
    if (!account) continue
    payoutRows.push({
      curatorId: share.curatorId,
      recipientAddress: account.address,
      piconeros: share.sharePiconeros
    })
  }

  // --- Final ledger ---
  // distributedPiconeros is the sum of the CREATED payouts (after address
  // filtering). rolledOverPiconeros is whatever is left — this captures BOTH
  // Task 7's sub-minPayout/topN rollover AND the addressless-curator rollover.
  const distributedPiconeros = payoutRows.reduce((acc, p) => acc + p.piconeros, 0n)
  const finalRolledOverPiconeros = poolPiconeros - distributedPiconeros

  const distribution = await models.rewardDistribution.create({
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
    await models.rewardPayout.createMany({
      data: payoutRows.map(p => ({ ...p, distributionId: distribution.id, state: 'QUEUED' }))
    })
  }

  // Task 9 wires the hot-wallet signer here:
  //   await sendPayouts(payouts)        // from api/monero/rewards.js
  //   then flip this distribution's status PENDING -> SENDING -> COMPLETE.
  // Until Task 9 lands, payouts remain QUEUED.

  console.log(`rewardsDistributor: pool=${poolPiconeros.toString()} distributed=${distributedPiconeros.toString()} rolledOver=${finalRolledOverPiconeros.toString()} payouts=${payoutRows.length}`)

  return await models.rewardDistribution.findUnique({
    where: { id: distribution.id },
    include: { payouts: true }
  })
}

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// pg-boss handler. Runs the weekly distribution and self-requeues for the next
// week. Mirrors the penaltyIndexer/confirmFinalizer self-requeuing pattern.
export async function rewardsDistributor ({ boss, models }) {
  await runDistributionOnce({ models })
  await boss.send('rewardsDistributor', {}, { startAfter: WEEK_SECONDS })
}
