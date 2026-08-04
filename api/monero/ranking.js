import { Prisma } from '@prisma/client'
import prisma from '@/api/models'

// Ranking side-effects of an observed Monero tip.
//
// StealthNews tips are observed off-chain by the moneroIndexer (Task 4). When a
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
// Trust-weighting columns (`weightedVotes`, `subWeightedVotes`, `upvotes`,
// `weightedComments`, `credits`) and `lastTipAt` are NOT touched here — see
// task-5-report.md for the noted gap. `ranktop` reads only
// piconeros/commentPiconeros, so ranking stays correct without them.
//
// All deltas bind `piconeros` as BIGINT (piconeros are BigInt; never coerced
// to Number). The whole chain is a single statement inside a ReadCommitted
// transaction (the codebase standard — see api/payIn/index.js + README), using
// the increment-in-place pattern that is correct under ReadCommitted.

// Prisma.raw embeds a controlled '+'/'-' literal (never user input) so the
// ancestor-propagation SQL is written once for both add and subtract paths.
const ADD = Prisma.raw('+')
const SUB = Prisma.raw('-')

function tipDeltaSql (postId, tipperId, piconeros, sign) {
  // Optional per-user attribution CTE. Omitted entirely for anonymous tips so
  // no ItemUserAgg row is created; the rest of the chain still runs.
  const zap = tipperId == null
    ? Prisma.empty
    : Prisma.sql`
        zap AS (
          INSERT INTO "ItemUserAgg" ("userId", "itemId", "tipPiconeros")
          VALUES (${tipperId}::INTEGER, ${postId}::INTEGER, ${piconeros}::BIGINT)
          ON CONFLICT ("itemId", "userId") DO UPDATE
          SET "tipPiconeros" = "ItemUserAgg"."tipPiconeros" + ${piconeros}::BIGINT, updated_at = now()
        ),`

  return Prisma.sql`
    WITH ${zap}
    item_tipped AS (
      UPDATE "Item"
      SET piconeros = "Item".piconeros ${sign} ${piconeros}::BIGINT
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
  // Transaction propagation. When `tx` is supplied the caller OWNS the
  // transaction — run the ranking SQL directly on it and do NOT open an inner
  // $transaction. This lets the moneroIndexer wrap ObservedTip.create and this
  // ranking delta in ONE serializable $transaction so they commit or roll back
  // together: a partial failure (apply throws) can never leave an orphan
  // DETECTED row with unbumped piconeros, which the next poll's P2002 idempotency
  // check would otherwise skip forever. Without `tx` the original standalone
  // behaviour is preserved so every other caller — the Task 5 unit tests, the
  // seedTip test helper, reviveIfReorged — is unchanged.
  const sql = tipDeltaSql(postId, tipperId, piconeros, ADD)
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
