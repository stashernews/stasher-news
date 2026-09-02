import { Prisma } from '@prisma/client'
import prisma from '@/api/models'
import { META_SUB } from '@/lib/constants'

// Ranking side-effects of an observed Monero tip (capped rank terms, spec §4).
//
// In addition to the true totals (`Item.piconeros`, ancestor
// `commentPiconeros`), a detected tip bumps the CAPPED ranking terms the
// `item_ranking` trigger reads:
//   - attributed tipper: factor(age) x min(their cumulative tips, CAP)
//     where factor = FLOOR + (1-FLOOR) x min(1, ageDays/RAMP), frozen at
//     detection time (monotonic — no drift, no recomputation)
//   - anonymous: ANON_FACTOR x min(collective anon total, ANON_CAP) — all anon
//     tips to a post share ONE bucket (Item.anonTipPiconeros)
//   - ancestors get commentTipRankPiconeros += the same capped delta
//
// applyTipDetected RETURNS the applied rank delta so callers persist it on
// ObservedTip.rankPiconeros (exact reorg reversal via reverseTip). upvotes /
// weightedVotes / subWeightedVotes math is unchanged from the uncapped era;
// the trust web already excludes self-acts.
//
// Transaction pattern unchanged: parentId/userId/config reads + one delta
// chain per detection, ReadCommitted-safe increments.

const ADD = Prisma.raw('+')
const SUB = Prisma.raw('-')

// Fallbacks when the PlatformFeeConfig row is absent (fresh DBs). Must match
// the schema defaults exactly.
export const DEFAULT_TIP_RANK_CONFIG = {
  tipRankCapPiconeros: 100_000_000_000n,
  tipRankFactorFloor: 0.7,
  tipRankRampDays: 14,
  anonTipRankCapPiconeros: 100_000_000_000n,
  anonTipRankFactor: 0.7
}

export async function loadTipRankConfig (handle) {
  const row = await handle.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!row) return DEFAULT_TIP_RANK_CONFIG
  return {
    tipRankCapPiconeros: row.tipRankCapPiconeros ?? DEFAULT_TIP_RANK_CONFIG.tipRankCapPiconeros,
    tipRankFactorFloor: row.tipRankFactorFloor ?? DEFAULT_TIP_RANK_CONFIG.tipRankFactorFloor,
    tipRankRampDays: row.tipRankRampDays ?? DEFAULT_TIP_RANK_CONFIG.tipRankRampDays,
    anonTipRankCapPiconeros: row.anonTipRankCapPiconeros ?? DEFAULT_TIP_RANK_CONFIG.anonTipRankCapPiconeros,
    anonTipRankFactor: row.anonTipRankFactor ?? DEFAULT_TIP_RANK_CONFIG.anonTipRankFactor
  }
}

// account-age factor: FLOOR + (1-FLOOR) x min(1, ageDays/RAMP)
function ageFactorSql (cfg) {
  return Prisma.sql`(${cfg.tipRankFactorFloor}::DOUBLE PRECISION + (1.0 - ${cfg.tipRankFactorFloor}::DOUBLE PRECISION)
    * LEAST(1.0, GREATEST(0.0, EXTRACT(EPOCH FROM (now() - u."created_at")) / 86400.0 / ${cfg.tipRankRampDays}::DOUBLE PRECISION)))`
}

function tipDeltaSql (postId, tipperId, piconeros, sign, isComment, cfg) {
  const isAdd = sign === ADD

  // ADD: the attribution upsert. SUB: the exact give-back (decrement the
  // cumulative the ADD upserted so future rank_calc "before" values are exact;
  // GREATEST(...,0) guards pre-migration drift). tipperId == null (anon) has
  // no ItemUserAgg row in either direction.
  const zap = tipperId == null
    ? Prisma.empty
    : isAdd
      ? Prisma.sql`
        zap AS (
          INSERT INTO "ItemUserAgg" ("userId", "itemId", "tipPiconeros")
          VALUES (${tipperId}::INTEGER, ${postId}::INTEGER, ${piconeros}::BIGINT)
          ON CONFLICT ("itemId", "userId") DO UPDATE
          SET "tipPiconeros" = "ItemUserAgg"."tipPiconeros" + ${piconeros}::BIGINT, updated_at = now()
          RETURNING "userId", "tipPiconeros",
            ("tipPiconeros" = ${piconeros}::BIGINT)::INTEGER AS first_vote,
            LOG("tipPiconeros"::FLOAT / GREATEST("tipPiconeros" - ${piconeros}, 1)::FLOAT) AS log_sats
        ),`
      : Prisma.sql`
        zap AS (
          UPDATE "ItemUserAgg"
          SET "tipPiconeros" = GREATEST("ItemUserAgg"."tipPiconeros" - ${piconeros}::BIGINT, 0), updated_at = now()
          WHERE "userId" = ${tipperId}::INTEGER AND "itemId" = ${postId}::INTEGER
          RETURNING "tipPiconeros",
            ("tipPiconeros" = 0)::INTEGER AS last_vote,
            LOG(("tipPiconeros" + ${piconeros}::BIGINT)::FLOAT / GREATEST("tipPiconeros", 1)::FLOAT) AS log_sats
        ),`

  // ---- territory + trust lookup (attributed ADD and SUB — the SUB
  // weightedVotes give-back reads zapper) ----
  const trust = (tipperId == null)
    ? Prisma.empty
    : Prisma.sql`
        territory AS (
          SELECT COALESCE(r."subNames"[1], i."subNames"[1], ${META_SUB}::CITEXT) AS "subName"
          FROM "Item" i
          LEFT JOIN "Item" r ON r.id = i."rootId"
          WHERE i.id = ${postId}::INTEGER
        ),
        zapper AS (
          SELECT
            COALESCE(${isComment ? Prisma.sql`"zapCommentTrust"` : Prisma.sql`"zapPostTrust"`}, 0)::float AS "zapTrust",
            COALESCE(${isComment ? Prisma.sql`"subZapCommentTrust"` : Prisma.sql`"subZapPostTrust"`}, 0)::float AS "subZapTrust"
          FROM territory
          LEFT JOIN "UserSubTrust" ust ON ust."subName" = territory."subName" AND ust."userId" = ${tipperId}::INTEGER
        ),`

  // ---- NEW: the capped rank delta ----
  // ATTRIBUTED tips: rank_calc derives from zap's RETURNING (after =
  // zap.tipPiconeros post-upsert; the factor joins the tipper's User row).
  // The per-(item, user) upsert row-serializes concurrent tips from the same
  // tipper, so the before/after values are exact under concurrency. CTE
  // order: zap BEFORE rank_calc (rank_calc reads zap's RETURNING).
  // ANONYMOUS tips: NO pre-read CTE — see itemTippedAnon below (a pre-read
  // races concurrent anon callbacks past the collective cap).
  const attrRankCalc = (tipperId != null && isAdd)
    ? Prisma.sql`
        rank_calc AS (
          SELECT ROUND((
            (LEAST(z."tipPiconeros", ${cfg.tipRankCapPiconeros}::BIGINT)
             - LEAST(z."tipPiconeros" - ${piconeros}::BIGINT, ${cfg.tipRankCapPiconeros}::BIGINT))::DOUBLE PRECISION
            * ${ageFactorSql(cfg)}
          )::NUMERIC)::BIGINT AS rank_delta
          FROM zap z LEFT JOIN users u ON u.id = z."userId"
        ),`
    : Prisma.empty

  // ---- upvotes / weightedVotes: unchanged semantics ----
  const needZap = tipperId != null
  const upvotesSet = isAdd
    ? (tipperId == null
        ? Prisma.sql`"upvotes" = "Item"."upvotes"`
        : Prisma.sql`"upvotes" = "Item"."upvotes" + zap.first_vote`)
    : (tipperId == null
        ? Prisma.sql`"upvotes" = "Item"."upvotes"`
        : Prisma.sql`"upvotes" = "Item"."upvotes" - zap.last_vote`)

  // anon SUB: give back the collective anon bucket the anon ADD incremented
  const anonBucketSet = (!isAdd && tipperId == null)
    ? Prisma.sql`,
              "anonTipPiconeros" = "Item"."anonTipPiconeros" - ${piconeros}::BIGINT`
    : Prisma.empty
  const weightedSet = needZap
    ? Prisma.sql`,
        "weightedVotes" = "Item"."weightedVotes" ${sign} zapper."zapTrust" * zap.log_sats,
        "subWeightedVotes" = "Item"."subWeightedVotes" ${sign} zapper."subZapTrust" * zap.log_sats`
    : Prisma.empty

  // attributed SUB joins the give-back zap (last_vote, log_sats) and zapper
  // (trust weights) into item_tipped; anon SUB stays standalone. If the
  // ItemUserAgg row is missing (pre-migration drift), zap returns zero rows
  // and the whole attributed SUB no-ops — the same posture as
  // reverseDownvotePenalty; the forward ADD upserts the row, so a legit
  // reversal always finds it.
  const subFrom = (!isAdd && tipperId != null)
    ? Prisma.sql`FROM zap, zapper`
    : Prisma.empty

  // ---- the capped-delta SET terms ----
  // ADD (attributed): live rank_delta from rank_calc. SUB (reorg reversal):
  // the caller's stored per-row delta (ObservedTip.rankPiconeros, fallback
  // raw piconeros). (The anon ADD path never reaches these — it builds its
  // own item_tipped below.)
  const tipRankSet = isAdd
    ? Prisma.sql`"tipRankPiconeros" = "Item"."tipRankPiconeros" ${sign} rank_calc.rank_delta`
    : Prisma.sql`"tipRankPiconeros" = "Item"."tipRankPiconeros" ${sign} ${cfg.rankDelta}::BIGINT`
  const commentTipRankSet = isAdd
    ? Prisma.sql`"commentTipRankPiconeros" = "Item"."commentTipRankPiconeros" ${sign} rank_calc.rank_delta`
    : Prisma.sql`"commentTipRankPiconeros" = "Item"."commentTipRankPiconeros" ${sign} ${cfg.rankDelta}::BIGINT`

  // ---- ANON ADD: bucket + cap math live INLINE in the SET clause ----
  // An increment-in-place expression is evaluated against the row-locked
  // LATEST value: a concurrent anon callback's UPDATE blocks on this row's
  // lock, then re-evaluates (EvalPlanQual) on the committed bucket — the
  // exact guarantee `piconeros = "Item".piconeros + x` already has. A pre-read
  // CTE (snapshot SELECT before the UPDATE) would let two concurrent anon
  // callbacks both see the same not-yet-full bucket and EACH collect up to
  // the full cap — overshooting the collective cap. The applied delta is
  // recovered afterwards from item_tipped's RETURNING (anonRankCalc below).
  const isAnonAdd = isAdd && tipperId == null
  const itemTippedAnon = isAnonAdd
    ? Prisma.sql`
        item_tipped AS (
          UPDATE "Item"
          SET piconeros = "Item".piconeros ${sign} ${piconeros}::BIGINT,
              "anonTipPiconeros" = "Item"."anonTipPiconeros" + ${piconeros}::BIGINT,
              "tipRankPiconeros" = "Item"."tipRankPiconeros" + ROUND((${cfg.anonTipRankFactor}::DOUBLE PRECISION *
                (LEAST("Item"."anonTipPiconeros" + ${piconeros}::BIGINT, ${cfg.anonTipRankCapPiconeros}::BIGINT)
                 - LEAST("Item"."anonTipPiconeros", ${cfg.anonTipRankCapPiconeros}::BIGINT)))::NUMERIC)::BIGINT,
              ${upvotesSet}
          WHERE "Item".id = ${postId}::INTEGER
          RETURNING "Item".*
        ),`
    : Prisma.empty

  // The delta actually applied (for ancestors + applyTipDetected's return
  // value): recomputed from item_tipped's post-update RETURNING —
  // delta = F x (LEAST(new bucket, CAP) - LEAST(new bucket - amt, CAP)).
  // item_tipped RETURNINGs the full row, so the new bucket is t's
  // "anonTipPiconeros". CTE order: item_tipped BEFORE rank_calc (Postgres
  // WITH entries may only reference earlier entries).
  const anonRankCalc = isAnonAdd
    ? Prisma.sql`
        rank_calc AS (
          SELECT ROUND((${cfg.anonTipRankFactor}::DOUBLE PRECISION *
            (LEAST(t."anonTipPiconeros", ${cfg.anonTipRankCapPiconeros}::BIGINT)
             - LEAST(t."anonTipPiconeros" - ${piconeros}::BIGINT, ${cfg.anonTipRankCapPiconeros}::BIGINT)))::NUMERIC)::BIGINT AS rank_delta
          FROM item_tipped t
        ),`
    : Prisma.empty

  // ADD ends with a trailing comma (ancestors follows as a CTE); SUB is the
  // final WITH entry (the bare ancestors UPDATE follows, no comma — the
  // pre-Task-8 shape).
  const itemTipped = isAdd
    ? Prisma.sql`
        item_tipped AS (
          UPDATE "Item"
          SET piconeros = "Item".piconeros ${sign} ${piconeros}::BIGINT,
              ${tipRankSet},
              ${upvotesSet}${weightedSet}
          FROM zap, zapper, rank_calc
          WHERE "Item".id = ${postId}::INTEGER
          RETURNING "Item".*
        ),`
    : Prisma.sql`
        item_tipped AS (
          UPDATE "Item"
          SET piconeros = "Item".piconeros ${sign} ${piconeros}::BIGINT,
              ${tipRankSet},
              ${upvotesSet}${weightedSet}${anonBucketSet}
          ${subFrom}
          WHERE "Item".id = ${postId}::INTEGER
          RETURNING "Item".*
        )`

  // ---- ancestor propagation: true total + capped delta, lock-ordered ----
  // (ADD: rank_calc is joined into the UPDATE FROM — the SET term references
  // rank_calc.rank_delta, which must be in the outer FROM list.)
  const ancestors = isAdd
    ? Prisma.sql`
        ancestors AS (
          UPDATE "Item"
          SET "commentPiconeros" = "Item"."commentPiconeros" ${sign} ${piconeros}::BIGINT,
              ${commentTipRankSet}
          FROM (
            SELECT "Item".id
            FROM "Item", item_tipped, rank_calc
            WHERE "Item".path @> item_tipped.path AND "Item".id <> item_tipped.id
            ORDER BY "Item".id
          ) AS anc, rank_calc
          WHERE "Item".id = anc.id
        )
        SELECT rank_delta FROM rank_calc`
    : Prisma.sql`
        UPDATE "Item"
        SET "commentPiconeros" = "Item"."commentPiconeros" ${sign} ${piconeros}::BIGINT,
            ${commentTipRankSet}
        FROM (
          SELECT "Item".id
          FROM "Item", item_tipped
          WHERE "Item".path @> item_tipped.path AND "Item".id <> item_tipped.id
          ORDER BY "Item".id
        ) AS ancestors
        WHERE "Item".id = ancestors.id`

  // ---- assembly: two CTE orderings ----
  // anon ADD: item_tipped (inline bucket math) BEFORE rank_calc (reads its
  // RETURNING), then ancestors (reads rank_calc) — so the early return is a
  // different WITH list, not just different fragments.
  // attributed ADD: trust, zapper, zap, rank_calc (reads zap), item_tipped
  // (reads zap/zapper/rank_calc), ancestors.
  // SUB: attributed composes trust + zap + item_tipped-with-FROM (the
  // weightedVotes/last_vote give-back); anon SUB stays item_tipped alone.
  if (isAnonAdd) {
    return Prisma.sql`
      WITH ${itemTippedAnon} ${anonRankCalc}
      ${ancestors}`
  }
  return Prisma.sql`
    WITH ${trust}${zap}${attrRankCalc}
    ${itemTipped}
    ${ancestors}`
}

export async function applyTipDetected (postId, tipperId, piconeros, tx) {
  const handle = tx || prisma
  let isComment = false
  if (tipperId != null) {
    // parentId picks zapPostTrust vs zapCommentTrust; userId is the self-tip
    // guard (defense-in-depth — the webhook/reconcile exclusion is primary).
    const q = Prisma.sql`SELECT "parentId", "userId" FROM "Item" WHERE id = ${postId}::INTEGER`
    const rows = tx ? await tx.$queryRaw(q) : await prisma.$queryRaw(q)
    const row = rows[0]
    isComment = row?.parentId != null
    if (row?.userId != null && row.userId === tipperId) return 0n
  }
  const cfg = await loadTipRankConfig(handle)
  const sql = tipDeltaSql(postId, tipperId, piconeros, ADD, isComment, cfg)
  // The chain ends in `SELECT rank_delta` -> $queryRaw. Returns [] when the
  // item vanished mid-flight; treat as 0n.
  const rows = tx
    ? await tx.$queryRaw(sql)
    : await prisma.$transaction(
      t => t.$queryRaw(sql),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 }
    )
  return rows?.[0]?.rank_delta ?? 0n
}

// Inverse for reorg/stale-DETECTED reconciliation, consumed by the
// reverseStaleDetections sweep. rankPiconeros is the delta the detection
// applied (ObservedTip.rankPiconeros) — subtract it EXACTLY; fallback to the
// raw amount only for pre-migration rows where it is null. tipperId selects
// the correct inverse: attributed tips give back one upvote (only when the reversal returns their cumulative to zero) and their
// ItemUserAgg.tipPiconeros; anonymous tips leave upvotes untouched (the ADD
// path never incremented them) and give back the collective anon bucket.
export async function reverseTip (postId, tipperId, piconeros, rankPiconeros = null, tx) {
  // parentId picks zapPostTrust vs zapCommentTrust for the weightedVotes
  // give-back — the same read applyTipDetected does forward. Anon needs no
  // trust lookup.
  let isComment = false
  if (tipperId != null) {
    const q = Prisma.sql`SELECT "parentId" FROM "Item" WHERE id = ${postId}::INTEGER`
    const rows = tx ? await tx.$queryRaw(q) : await prisma.$queryRaw(q)
    isComment = rows?.[0]?.parentId != null
  }
  const cfg = { rankDelta: rankPiconeros ?? piconeros }
  const sql = tipDeltaSql(postId, tipperId, piconeros, SUB, isComment, cfg)
  if (tx) {
    await tx.$executeRaw(sql)
    return
  }
  await prisma.$transaction(
    t => t.$executeRaw(sql),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 }
  )
}
