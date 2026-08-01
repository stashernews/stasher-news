import createPrisma from '@/lib/create-prisma'

// computeCuratorShares — the share-computation core of StealthNews' weekly
// rewardsDistributor (Phase 4 Task 7 / design spec §5). It ports Stacker.news'
// worker/earn.js reward CTE verbatim, changing ONLY the input source: confirmed
// ObservedTip rows (P2P Monero tips) replace the legacy PayIn ZAP records, and
// the pool unit is piconeros (1e-12 XMR) rather than msats.
//
// What was dropped vs earn.js (per the design spec):
//   - the ITEM_CREATE PayIn LATERAL join + America/Chicago day filter -> a direct
//     Item.createdAt range filter [periodStart, periodEnd);
//   - the HANDICAP_IDS / HANDICAP_ZAP_MULT (SN-specific user ids; every curator
//     gets multiplier 1 here);
//   - the EACH_ITEM_PORTION (item-author) UNION branch (SN sets it to 0 — dead
//     code; StealthNews rewards curators only);
//   - the entire referral machinery (OneDayReferral / foreverReferrerId).
//
// What was kept: NTILE(100) percentile cutoff, the "islands" contiguous-zap
// dedupe, the power(sum, 0.25) quad-root diminishing returns, the
// 1/LN(rank + e - 1) early-tipper boost, the per-partition (post vs comment)
// normalization split by EACH_ZAP_PORTION, and the per-user total_proportion roll-up.
//
// This module is PURE: it computes shares and returns them. It touches no wallet,
// creates no rows, and wires no job (Task 8's rewardsDistributor calls this and
// performs the on-chain payouts).

// --- Constants (mirror earn.js, adapted to piconeros) ---

// Only items in the top PERCENTILE_CUTOFF percentiles (by weightedVotes -
// weightedDownVotes) earn rewards for their curators. Same value as earn.js.
const PERCENTILE_CUTOFF = 50

// Each recipient class (post-curator vs comment-curator) is allocated
// 1/EACH_ZAP_PORTION of its partition's proportion. 2.0 => posts and comments
// each carry half the total curator weight (an even split). Same value as earn.js.
const EACH_ZAP_PORTION = 2.0

// Dust floor: an island of tips must total more than this many piconeros to count
// toward curator rewards. Set to the protocol minimum tip (1e8 piconeros =
// 0.0001 XMR) — tips at or below this don't exist on the wire anyway, so this is
// belt-and-braces against rounding/indexer artefacts. This is the ONE place the
// piconeros unit is load-bearing: the power(sum, 0.25) quad-root uses the raw
// piconeros magnitude, but since the final share is normalized
// (proportion / sum(proportion)), any constant divisor on the amount would
// cancel — so only this HAVING dust filter is unit-sensitive.
const ZAP_THRESHOLD_PICONEROS = 100_000_000n

/**
 * Compute curator reward shares for a period.
 *
 * @param {Date} periodStart - inclusive start of the reward window.
 * @param {Date} periodEnd   - exclusive end of the reward window.
 * @param {bigint} poolPiconeros - total piconeros to distribute this period.
 * @param {{ minPayout?: bigint, topN?: number }} [opts]
 *   - minPayout: shares below this are excluded and roll over (NOT redistributed).
 *   - topN: cap on the number of recipients (highest proportion first).
 * @param {object} [models] - Prisma client. A throwaway client is created if
 *   omitted (and disconnected after the query).
 * @returns {Promise<{ shares: Array<{ curatorId: number, sharePiconeros: bigint }>, distributedPiconeros: bigint, rolledOverPiconeros: bigint }>}
 */
export async function computeCuratorShares (periodStart, periodEnd, poolPiconeros, { minPayout = 0n, topN = 100 } = {}, models) {
  const ownsClient = !models
  const db = ownsClient ? createPrisma() : models
  try {
    return await compute(db, periodStart, periodEnd, poolPiconeros, minPayout, topN)
  } finally {
    if (ownsClient) db.$disconnect().catch(console.error)
  }
}

async function compute (models, periodStart, periodEnd, poolPiconeros, minPayout, topN) {
  // Per-curator raw proportions from the ported CTE. Each row is
  // { curatorId: number, total_proportion: number }.
  const prospects = await models.$queryRaw`
    WITH reward_proportions AS (
      WITH item_proportions AS (
        SELECT *,
          CASE WHEN "parentId" IS NULL THEN 'POST' ELSE 'COMMENT' END AS type,
          CASE WHEN "weightedVotes" > 0
            THEN "weightedVotes" / (sum("weightedVotes") OVER (PARTITION BY "parentId" IS NULL))
            ELSE 0 END AS proportion
        FROM (
          SELECT *,
            NTILE(100) OVER (PARTITION BY "parentId" IS NULL ORDER BY ("weightedVotes" - "weightedDownVotes") DESC) AS percentile,
            ROW_NUMBER() OVER (PARTITION BY "parentId" IS NULL ORDER BY ("weightedVotes" - "weightedDownVotes") DESC) AS rank
          FROM "Item"
          WHERE "Item"."created_at" >= ${periodStart}
            AND "Item"."created_at" < ${periodEnd}
            AND "weightedVotes" > 0
            AND "deletedAt" IS NULL
            AND NOT bio
        ) x
        WHERE x.percentile <= ${PERCENTILE_CUTOFF}
      ),
      -- gather the confirmed Monero tips on those top items, with the "islands"
      -- trick: the difference of two ROW_NUMBER()s gives a stable group id for
      -- each contiguous run of tips from the same user on the same item, so a
      -- burst of successive tips is collapsed before the quad-root (preventing
      -- disproportionate reward for splitting a tip into many pieces).
      item_zapper_islands AS (
        SELECT "ObservedTip"."tipperId" AS "userId",
          item_proportions.id,
          item_proportions.proportion,
          item_proportions."parentId",
          "ObservedTip"."piconeros" AS zapped_piconeros,
          "ObservedTip"."confirmedAt" AS acted_at,
          ROW_NUMBER() OVER (PARTITION BY item_proportions.id ORDER BY "ObservedTip"."confirmedAt" ASC)
            - ROW_NUMBER() OVER (PARTITION BY item_proportions.id, "ObservedTip"."tipperId" ORDER BY "ObservedTip"."confirmedAt" ASC) AS island
        FROM item_proportions
        JOIN "ObservedTip" ON "ObservedTip"."postId" = item_proportions.id
          AND "ObservedTip"."state" = 'CONFIRMED'
          AND "ObservedTip"."confirmedAt" >= ${periodStart}
          AND "ObservedTip"."confirmedAt" < ${periodEnd}
          AND "ObservedTip"."tipperId" IS NOT NULL
      ),
      -- one row per (user, item, island): quad-root of the tipped piconeros.
      -- power(sum, 0.25) gives diminishing returns (each additional piconero
      -- rewards less than the last). The legacy /1000 (msats->sats) is dropped:
      -- it was a constant divisor that cancels under the final normalization.
      item_zappers AS (
        SELECT "userId",
          item_zapper_islands.id,
          item_zapper_islands.proportion,
          item_zapper_islands."parentId",
          GREATEST(power(sum(zapped_piconeros)::float, 0.25), 0) AS zapped,
          min(acted_at) AS acted_at
        FROM item_zapper_islands
        GROUP BY "userId", item_zapper_islands.id, item_zapper_islands.proportion, item_zapper_islands."parentId", island
        HAVING sum(zapped_piconeros) > ${ZAP_THRESHOLD_PICONEROS}
      ),
      -- the relative contribution of each curator to the post/comment:
      --   early component  = 1/LN(rank + e - 1)   (earlier tippers win)
      --   tipped component = their share of the item's total tipped weight
      --   item component   = the item's share of the period's vote weight
      item_zapper_ratios AS (
        SELECT "userId",
          sum((2 * early_multiplier + 1) * zapped_proportion * proportion) AS item_zapper_proportion,
          "parentId" IS NULL AS "isPost"
        FROM (
          SELECT *,
            1.0 / LN(ROW_NUMBER() OVER (PARTITION BY item_zappers.id ORDER BY acted_at ASC) + EXP(1.0) - 1) AS early_multiplier,
            zapped::float / (sum(zapped) OVER (PARTITION BY item_zappers.id)) AS zapped_proportion
          FROM item_zappers
          WHERE zapped > 0
        ) u
        JOIN users ON "userId" = users.id
        GROUP BY "userId", "parentId" IS NULL
      )
      -- normalize within the post/comment partition, then split each partition's
      -- weight by EACH_ZAP_PORTION (2.0 => posts and comments each get half).
      SELECT "userId",
        item_zapper_proportion / (sum(item_zapper_proportion) OVER (PARTITION BY "isPost")) / ${EACH_ZAP_PORTION} AS "typeProportion"
      FROM item_zapper_ratios
      WHERE item_zapper_proportion > 0
        AND ${EACH_ZAP_PORTION} > 0
    )
    -- roll every curator's per-item proportions up into one total.
    SELECT "userId" AS "curatorId", sum("typeProportion") AS "total_proportion"
    FROM reward_proportions
    GROUP BY "userId"`

  // --- JS post-processing: normalize to piconeros, cap, and floor the dust. ---

  const rows = prospects.map(r => ({
    curatorId: Number(r.curatorId),
    totalProportion: Number(r.total_proportion)
  }))

  const sumProportion = rows.reduce((acc, r) => acc + r.totalProportion, 0)
  if (!rows.length || sumProportion <= 0 || poolPiconeros <= 0n) {
    return { shares: [], distributedPiconeros: 0n, rolledOverPiconeros: poolPiconeros }
  }

  // floor(prop_i / sum(prop) * pool). NOTE: Number(pool) is exact for pools up to
  // ~9e15 piconeros (2^53), which is ~9000 XMR/week — far beyond any realistic v1
  // pool. The brief mandates this floor-and-normalize in JS.
  const poolNum = Number(poolPiconeros)
  let ranked = rows
    .map(r => ({
      curatorId: r.curatorId,
      totalProportion: r.totalProportion,
      sharePiconeros: BigInt(Math.floor(r.totalProportion / sumProportion * poolNum))
    }))
    // topN: keep only the highest-proportion curators.
    .sort((a, b) => b.totalProportion - a.totalProportion)
  if (ranked.length > topN) ranked = ranked.slice(0, topN)

  // minPayout: exclude sub-min shares. Their piconeros are NOT redistributed —
  // they roll over to next period's pool (handled by the caller).
  const minBig = BigInt(minPayout)
  const shares = ranked
    .filter(s => s.sharePiconeros >= minBig)
    .map(s => ({ curatorId: s.curatorId, sharePiconeros: s.sharePiconeros }))

  const distributedPiconeros = shares.reduce((acc, s) => acc + s.sharePiconeros, 0n)
  const rolledOverPiconeros = poolPiconeros - distributedPiconeros

  return { shares, distributedPiconeros, rolledOverPiconeros }
}
