import { Prisma } from '@prisma/client'
import prisma from '@/api/models'

// Ranking side-effects of an observed Monero tip.
//
// StasherNews tips are observed off-chain by the moneroIndexer (Task 4). When a
// tip is DETECTED this hook bumps the tipped Item's `piconeros` and propagates
// `commentPiconeros` to ancestors so the retained `item_ranking` BEFORE UPDATE
// trigger recomputes `ranktop`/`ranklit` — exactly the ranking path SN's
// custodial `onPaid` followed (`api/payIn/types/zap.js`), scoped to what the
// ranking trigger and the trust web actually read.
//
// Scope (deliberate, per the Task 5 plan):
//   - `Item.piconeros += piconeros`
//   - `ItemUserAgg (itemId, userId).tipPiconeros += piconeros` (only when
//     tipperId is present — anonymous tips still rank but skip the per-user
//     attribution since `ItemUserAgg.userId` is non-nullable)
//   - ancestor `Item.commentPiconeros += piconeros` (path-based, ORDER BY id for
//     consistent lock ordering — deadlock safety per api/payIn/README.md)
//
// Trust-weighting columns: on a DETECTED tip with a known tipper this bumps
// `weightedVotes`/`subWeightedVotes` by zapTrust × LOG(tipPiconeros) — the exact
// upstream zap.js math (mirrors worker/rewardsWalletObserver's downvote path) —
// consuming UserSubTrust from the nightly trust worker, plus `upvotes` (the
// distinct-tipper count). `weightedComments`, `credits`, and `lastTipAt` are
// still not touched. `ranktop` reads only piconeros/commentPiconeros, so ranking
// stays correct independent of weightedVotes; weightedVotes feeds the weekly
// curator rewards distributor (worker/curatorShares.js).
//
// All deltas bind `piconeros` as BIGINT (piconeros are BigInt; never coerced
// to Number). The whole chain is a single statement inside a ReadCommitted
// transaction (the codebase standard — see api/payIn/index.js + README), using
// the increment-in-place pattern that is correct under ReadCommitted.

// Prisma.raw embeds a controlled '+'/'-' literal (never user input) so the
// ancestor-propagation SQL is written once for both add and subtract paths.
const ADD = Prisma.raw('+')
const SUB = Prisma.raw('-')

function tipDeltaSql (postId, tipperId, piconeros, sign, isComment) {
  // Optional per-user attribution CTE. Omitted entirely for anonymous tips so
  // no ItemUserAgg row is created; the rest of the chain still runs. The
  // RETURNING first_vote is 1 when this is the tipper's FIRST tip on the post
  // (tipPiconeros was 0 before this upsert) and 0 on repeat tips — mirroring the
  // legacy zap.js `upvotes += first_vote` distinct-tipper count. log_sats is the
  // diminishing-marginal-weight LOG term (mirrors worker/rewardsWalletObserver's
  // downvote path + upstream zap.js) that scales the tipper's territory trust
  // into weightedVotes/subWeightedVotes below.
  const isAdd = sign === ADD
  const zap = tipperId == null
    ? Prisma.empty
    : Prisma.sql`
        zap AS (
          INSERT INTO "ItemUserAgg" ("userId", "itemId", "tipPiconeros")
          VALUES (${tipperId}::INTEGER, ${postId}::INTEGER, ${piconeros}::BIGINT)
          ON CONFLICT ("itemId", "userId") DO UPDATE
          SET "tipPiconeros" = "ItemUserAgg"."tipPiconeros" + ${piconeros}::BIGINT, updated_at = now()
          RETURNING ("tipPiconeros" = ${piconeros}::BIGINT)::INTEGER AS first_vote,
            LOG("tipPiconeros"::FLOAT / GREATEST("tipPiconeros" - ${piconeros}, 1)::FLOAT) AS log_sats
        ),`

  // Territory + trust lookup, only for attributed tips (the weightedVotes bump
  // needs per-user trust). Mirrors worker/rewardsWalletObserver's
  // applyDownvotePenalty: resolve the item's first sub via COALESCE on the root
  // then the item itself (default 'meta'), then left-join UserSubTrust to read
  // the tipper's zapPost/zapComment trust for that territory. Anonymous tips
  // (no tipperId) and reversals (reverseTip passes null) skip this entirely.
  const trust = tipperId == null
    ? Prisma.empty
    : Prisma.sql`
        territory AS (
          SELECT COALESCE(r."subNames"[1], i."subNames"[1], 'meta')::CITEXT AS "subName"
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

  // upvotes is the # of distinct tippers. A detected tip bumps it once per tipper
  // via first_vote; anonymous tips have no per-user attribution so leave it
  // unchanged. Reversal (reorg rollback) decrements by one. When the zap CTE is
  // present it must be named in FROM for its columns to be referenceable.
  const needZap = isAdd && tipperId != null
  const upvotesSet = isAdd
    ? (tipperId == null
        ? Prisma.sql`"upvotes" = "Item"."upvotes"`
        : Prisma.sql`"upvotes" = "Item"."upvotes" + zap.first_vote`)
    : Prisma.sql`"upvotes" = "Item"."upvotes" - 1`
  // Trust-weighted vote terms (ADD path + attributed tip only). Reversal does
  // NOT touch weightedVotes — upstream has no zap reversal; the bounded reorg
  // drift on the score column is accepted for v1.
  const weightedSet = needZap
    ? Prisma.sql`,
        "weightedVotes" = "Item"."weightedVotes" + zapper."zapTrust" * zap.log_sats,
        "subWeightedVotes" = "Item"."subWeightedVotes" + zapper."subZapTrust" * zap.log_sats`
    : Prisma.empty
  const fromZap = needZap ? Prisma.sql`FROM zap, zapper` : Prisma.empty

  return Prisma.sql`
    WITH ${trust}${zap}
    item_tipped AS (
      UPDATE "Item"
      SET piconeros = "Item".piconeros ${sign} ${piconeros}::BIGINT,
          ${upvotesSet}${weightedSet}
      ${fromZap}
      WHERE "Item".id = ${postId}::INTEGER
      RETURNING "Item".*
    )
    UPDATE "Item"
    SET "commentPiconeros" = "Item"."commentPiconeros" ${sign} ${piconeros}::BIGINT
    FROM (
      SELECT "Item".id
      FROM "Item", item_tipped
      WHERE "Item".path @> item_tipped.path AND "Item".id <> item_tipped.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}

export async function applyTipDetected (postId, tipperId, piconeros, tx) {
  // Derive isComment for the trust-weight lookup (zapPostTrust vs
  // zapCommentTrust). The webhook receiver passes (postId, tipperId, piconeros,
  // tx) and does not have the Item object, so the single indexed-PK parentId
  // select here is the mandated placement. Anonymous tips skip the trust bump
  // entirely (no per-user attribution) so no lookup is needed. parentId is
  // immutable so reading it on the caller's tx (or prisma, standalone) is safe.
  let isComment = false
  if (tipperId != null) {
    const q = Prisma.sql`SELECT "parentId" FROM "Item" WHERE id = ${postId}::INTEGER`
    const rows = tx ? await tx.$queryRaw(q) : await prisma.$queryRaw(q)
    isComment = rows[0]?.parentId != null
  }
  const sql = tipDeltaSql(postId, tipperId, piconeros, ADD, isComment)
  if (tx) {
    await tx.$executeRaw(sql)
    return
  }
  await prisma.$transaction(
    t => t.$executeRaw(sql),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 }
  )
}

// Inverse of applyTipDetected for reorg reconciliation (Task 6). Reverses the
// ranking-relevant deltas only (Item.piconeros + ancestor commentPiconeros) so the
// trigger recomputes ranktop/ranklit downward. It does NOT reverse
// ItemUserAgg.tipPiconeros because the signature carries no tipperId — see
// task-5-report.md for the design decision; Task 6 can pass the tipperId if it
// needs precise per-user reversal.
export async function reverseTip (postId, piconeros, tx) {
  // Transaction propagation mirrors applyTipDetected (above). When `tx` is
  // supplied the caller OWNS the transaction — run the ranking SQL directly on
  // it and do NOT open an inner $transaction. This lets reconcileReorg wrap the
  // ObservedTip.update (state=REORGED) and this reversal in ONE serializable
  // $transaction so they commit or roll back together: a partial failure
  // (reverseTip throws after the state flip committed) can never leave a REORGED
  // row with piconeros still bumped — the over-credit window the Task 6 review
  // flagged. Without `tx` the original standalone behaviour is preserved so
  // every other caller — the Task 5 unit tests, the seedTip test helper — is
  // unchanged. The SQL/tipDeltaSql helper is untouched.
  const sql = tipDeltaSql(postId, null, piconeros, SUB)
  if (tx) {
    await tx.$executeRaw(sql)
    return
  }
  await prisma.$transaction(
    t => t.$executeRaw(sql),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 }
  )
}
