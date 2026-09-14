// Shared "what is currently allocated where" computation for the platform
// rewards wallet (MoneroAccount { label: 'platform_rewards' }). ONE source of
// truth for:
//   - the /rewards page's active pool + countdown (api/resolvers/rewards.js),
//   - the transparency page's literal rewards/ops allocation
//     (api/resolvers/rewardsWallet.js),
// so those surfaces can never drift apart.
//
// Rewards allocation = the NEXT distribution's pool: this cycle's
// rewards-earmarked CONFIRMED inflow (split per PlatformFeeConfig, BigInt
// floors per source exactly like worker/rewardsDistributor.js) + the latest
// distribution's rolledOverPiconeros. Before the first distribution the cycle
// window falls back to the trailing 7 days (the same fallback /rewards uses).
//
// Ops allocation = the funds awaiting the ops sweep: the latest distribution's
// opsAvailablePiconeros - opsSweptPiconeros (the exact definition of the
// monero_ops_pending_piconeros metric in lib/metrics.js). Before the first
// distribution nothing has ever been swept, so it is this cycle's ops-earmarked
// inflow (totalInflow - rewardsInflow).
//
// Everything is DB-ledger derived; lws is never consulted. BigInt only.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// Rewards earmark per the PlatformFeeConfig allocation split (spec §6.4):
// downvote 100% / posting 70% / turf 30% / boosts 30% / wallet-less tips 70%.
// Donations go the payer-chosen % to the pool (default 100); bounty rollovers
// (BOUNTY_ROLLOVER) go 100% to the pool; BOUNTY_FEE is 100% ops (booked at
// funding, physically arrives with the rollover) so its pool share is 0.
// BigInt division floors each source independently, matching
// worker/rewardsDistributor.js.
export function rewardsFromInflow (inflow, time, config) {
  const sourceShares = [
    { name: 'downvote', piconeros: toBigInt(inflow.downvote) * BigInt(config.downvoteRewardsPct) / 100n },
    { name: 'posting fee', piconeros: toBigInt(inflow.posting) * BigInt(config.postingFeeRewardsPct) / 100n },
    { name: 'turf fee', piconeros: toBigInt(inflow.territory) * BigInt(config.territoryFeeRewardsPct) / 100n },
    // donations go the payer-chosen % to the pool (default 100); boosts go boostRewardsPct% (default 30)
    { name: 'donations', piconeros: toBigInt(inflow.donate) },
    { name: 'boosts', piconeros: toBigInt(inflow.boost) * BigInt(config.boostRewardsPct) / 100n },
    // wallet-less-author tips (TIP_UNWALLETED) go walletlessTipRewardsPct% to the pool
    { name: 'wallet-less tips', piconeros: toBigInt(inflow.walletlesstip) * BigInt(config.walletlessTipRewardsPct) / 100n },
    // bounty rollovers (BOUNTY_ROLLOVER, escrow -> rewards wallet) go 100% to the pool
    { name: 'bounty rollovers', piconeros: toBigInt(inflow.bountyrollover) },
    // BOUNTY_FEE is 100% ops (booked at funding, rides along the rollover) — pool share 0
    { name: 'bounty fees', piconeros: 0n }
  ]
  const sources = sourceShares.filter(s => s.piconeros > 0n).map(s => ({ name: s.name, value: s.piconeros.toString() }))
  const total = sourceShares.reduce((acc, s) => acc + s.piconeros, 0n)
  return { total, time, sources }
}

// Active (next) distribution pool + the current literal ops allocation.
// Returns:
//   poolPiconeros          — rewards: this cycle's rewards earmark + latest rollover
//   rewardsInflowPiconeros — this cycle's rewards earmark before the rollover
//   totalInflowPiconeros   — this cycle's raw CONFIRMED inflow (all sources)
//   pendingSweepPiconeros  — ops: latest.opsAvailable - latest.opsSwept,
//                            or this cycle's ops inflow before any distribution
//   rolledOverPiconeros    — latest distribution's rolledOver (0n if none)
//   time                   — the next distribution slot, computed in SQL
//   sources                — this cycle's rewards-earmarked sources (for /rewards)
export async function getNextRewardsPool (models) {
  const config = await models.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  const lastDistribution = await models.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
  const periodStart = lastDistribution?.periodEnd ?? new Date(Date.now() - WEEK_MS)
  const [{ downvote, posting, territory, donate, donateRaw, boost, walletlesstip, bountyrollover, bountyfee, time }] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedDownvote" WHERE state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'POSTING' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE') AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS territory,
      COALESCE((SELECT sum("piconeros" * COALESCE("donationRewardsPct", 100) / 100) FROM "FeeObservation" WHERE "feeType" = 'DONATE' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS donate,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'DONATE' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS "donateRaw",
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'BOOST' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS boost,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'TIP_UNWALLETED' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS walletlesstip,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'BOUNTY_ROLLOVER' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS bountyrollover,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation" WHERE "feeType" = 'BOUNTY_FEE' AND state = 'CONFIRMED' AND "confirmedAt" >= ${periodStart}), 0)::bigint AS bountyfee,
      (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 week') AT TIME ZONE 'UTC' AS time`

  const { total, sources } = rewardsFromInflow({ downvote, posting, territory, donate, boost, walletlesstip, bountyrollover, bountyfee }, time, config)
  const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
  // Raw cycle inflow: the DONATE subselect above is scaled to the rewards share
  // (payer-chosen pct), so the raw donation total is fetched separately to keep
  // the ops fallback exact when a donation routed <100% to the pool.
  const totalInflowPiconeros =
    toBigInt(downvote) + toBigInt(posting) + toBigInt(territory) + toBigInt(donateRaw) +
    toBigInt(boost) + toBigInt(walletlesstip) + toBigInt(bountyrollover) + toBigInt(bountyfee)
  const pendingSweepPiconeros = lastDistribution
    ? toBigInt(lastDistribution.opsAvailablePiconeros) - toBigInt(lastDistribution.opsSweptPiconeros)
    : totalInflowPiconeros - total

  return {
    poolPiconeros: total + rolledOver,
    rewardsInflowPiconeros: total,
    totalInflowPiconeros,
    pendingSweepPiconeros,
    rolledOverPiconeros: rolledOver,
    time,
    sources
  }
}
