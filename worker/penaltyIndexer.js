import { lwsClient } from '@/api/monero/lwsClient'
import {
  REWARDS_POSTING_MAJOR,
  REWARDS_TERRITORY_MAJOR
} from '@/api/monero/feePool'
import { reverseMapPaymentId } from '@/api/monero/penalty'
import { MONERO_POLL_INTERVAL_MS } from '@/lib/constants'
import { Prisma } from '@prisma/client'

// penaltyIndexer — observes posting/territory fees AND downvote payments paid to
// the platform rewards wallet (Phase 3 Task 5 + Phase 4 Task 4 / spec §3.3, §5.6,
// §6.2). The rewards wallet is the ONLY custodial component; every payment lands
// either on a DEDICATED subaddress (major 1 = posting, major 2 = territory) for
// fees, or on the PRIMARY address (major 0) carrying a payment_id for downvotes.
//
// Each poll fetches incremental outputs from lws for the platform_rewards wallet.
// For each output:
//   - fee subaddress (major 1/2): finds the pending PayIn that reserved that
//     subaddress, idempotently records a FeeObservation (DETECTED), and flips the
//     gated Item.feeStatus PENDING_FEE -> FEE_PAID (or Sub.billingStatus), taking
//     the post/territory live.
//   - primary address + payment_id (Phase 4): reverses the payment_id via the
//     DownvotePidMap, idempotently records an ObservedBurn (DETECTED), and applies
//     the LOG-scaled ranking penalty (weightedDownVotes/downPiconeros) at DETECTION.
// The confirmFinalizer matures FeeObservation/ObservedBurn DETECTED -> CONFIRMED
// at REQUIRED_CONFIRMATIONS (separate concern, separate job). Reorg reversal is
// deferred (accepted v1 limitation — consistent with the tip flow).
//
// This module exports TWO things (mirrors worker/moneroIndexer.js /
// worker/confirmFinalizer.js):
//   - runPenaltyIndexerOnce: the testable per-poll core (no pg-boss). Accepts a
//     `txs` override so tests never touch the network.
//   - penaltyIndexer: the pg-boss handler. Fetches txs via lwsClient, runs the
//     core, advances the cursor, and self-requeues.

// One poll. `txs` is normally fetched from lws by the handler; tests pass it
// directly. Returns nothing; effects are the FeeObservation/ObservedBurn rows +
// fee flips / ranking penalties.
export async function runPenaltyIndexerOnce ({ models, account, txs }) {
  for (const tx of txs || []) {
    await attributeOutput(models, tx, account)
  }
}

// Dispatcher — the single seam Phase 4 extends. The subaddress (fee) branch is
// Phase 3; the payment_id (downvote) branch lands in Phase 4 as a sibling call
// here without changing this dispatcher's callers. Fee subaddresses short-circuit
// inside attributeFeeBySubaddress (the major check), so they never reach a
// payment_id branch.
async function attributeOutput (models, tx, account) {
  if (!account || account.label !== 'platform_rewards') return
  // PHASE 3: attribute posting/territory fees by their receiving subaddress.
  // Short-circuit: a fee subaddress output is never a downvote.
  if (await attributeFeeBySubaddress(models, tx)) return
  // PHASE 4: downvotes arrive on the PRIMARY address (major 0) carrying a
  // decrypted payment_id that encodes (postId, nonce) via the DownvotePidMap.
  if (tx.payment_id) await attributeDownvoteByPaymentId(models, tx)
}

// Attribute an output to a pending fee by its receiving subaddress. Returns the
// FeeObservation id on a fresh attribution, or null if the output is not at a fee
// subaddress / matches no pending PayIn / was already attributed.
async function attributeFeeBySubaddress (models, tx) {
  const major = tx.recipient?.maj_i
  const minor = tx.recipient?.min_i
  if (major !== REWARDS_POSTING_MAJOR && major !== REWARDS_TERRITORY_MAJOR) return null

  const payIn = await models.payIn.findFirst({
    where: { moneroSubaddressMajor: major, moneroSubaddressMinor: minor }
  })
  if (!payIn) return null

  const feeType = feeTypeFor(major, payIn.payInType)

  // Idempotent insert keyed by @@unique([txHash, recipientMajor, recipientMinor]).
  // ON CONFLICT DO NOTHING means a re-poll of the same tx is a no-op. RETURNING
  // gives us the row only on the fresh insert (null on conflict) so the flip runs
  // exactly once.
  const rows = await models.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","recipientMajor","recipientMinor","piconeros","height","state","detectedAt")
    VALUES (${tx.hash}, ${payIn.id}, ${feeType}::"FeeType", ${major}, ${minor}, ${tx.piconeros}, ${tx.height ?? null}, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING
    RETURNING id`
  if (!rows || rows.length === 0) return null

  await flipPendingToLive(models, payIn, tx.piconeros)
  return rows[0].id
}

// Attribute a primary-address output carrying a payment_id to a downvote. Looks
// up the payment_id in the DownvotePidMap reverse map; if found, idempotently
// records an ObservedBurn (DETECTED) and applies the LOG-scaled ranking penalty
// (ported from the legacy downZap.js onPaid SQL to piconeros). The penalty fires
// exactly once per (txHash, paymentId) — the ON CONFLICT DO NOTHING guard returns
// a row only on the fresh insert, so a re-poll never double-penalises.
async function attributeDownvoteByPaymentId (models, tx) {
  const map = await reverseMapPaymentId(tx.payment_id, models)
  if (!map) return

  const rows = await models.$queryRaw`
    INSERT INTO "ObservedBurn" ("txHash","postId","downvoterId","paymentId","piconeros","height","state","detectedAt")
    VALUES (${tx.hash}, ${map.postId}, ${map.userId}::INT, ${tx.payment_id}, ${tx.piconeros}, ${tx.height ?? null}, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","paymentId") DO NOTHING
    RETURNING id`
  if (!rows || rows.length === 0) return

  const item = await models.item.findUnique({ where: { id: map.postId } })
  if (item) {
    try {
      await applyDownvotePenalty(models, item, map.userId, tx.piconeros)
    } catch (err) {
      // Don't crash the indexer on a ranking-CTE failure; the ObservedBurn row
      // already records the burn. (Item columns can be repaired separately.)
      console.error(`penaltyIndexer: ranking penalty failed for post ${map.postId}:`, err?.message || err)
    }
  }

  await models.downvotePidMap.update({ where: { paymentId: tx.payment_id }, data: { consumedAt: new Date() } })
}

// Apply the LOG-scaled ranking penalty to the downvoted item and its ancestors.
// Mirrors the legacy downZap.js onPaid SQL, ported from millisats to piconeros:
// the ItemUserAgg.downvotePiconeros cumulative is cast ::BIGINT (not the legacy
// ::INTEGER) so piconeros-scale amounts never overflow INT4. The LOG ratio gives
// diminishing marginal weight: each additional piconero penalises less than the
// last (standard SN ranking curve). weightedDownVotes uses the downvoter's
// territory trust so a trusted curator's downvote counts more.
async function applyDownvotePenalty (models, item, userId, piconeros) {
  const itemId = item.id
  const isComment = item.parentId != null
  const trustCol = isComment ? Prisma.sql`"zapCommentTrust"` : Prisma.sql`"zapPostTrust"`
  const subTrustCol = isComment ? Prisma.sql`"subZapCommentTrust"` : Prisma.sql`"subZapPostTrust"`

  await models.$executeRaw`
    WITH territory AS (
      SELECT COALESCE(r."subNames"[1], i."subNames"[1], 'meta')::CITEXT as "subName"
      FROM "Item" i
      LEFT JOIN "Item" r ON r.id = i."rootId"
      WHERE i.id = ${itemId}::INTEGER
    ), zapper AS (
      SELECT
        COALESCE(${trustCol}, 0) as "zapTrust",
        COALESCE(${subTrustCol}, 0) as "subZapTrust"
      FROM territory
      LEFT JOIN "UserSubTrust" ust ON ust."subName" = territory."subName"
        AND ust."userId" = ${userId}::INTEGER
    ), zap AS (
      INSERT INTO "ItemUserAgg" ("userId", "itemId", "downvotePiconeros")
      VALUES (${userId}::INTEGER, ${itemId}::INTEGER, ${piconeros}::BIGINT)
      ON CONFLICT ("itemId", "userId") DO UPDATE
      SET "downvotePiconeros" = "ItemUserAgg"."downvotePiconeros" + ${piconeros}::BIGINT, updated_at = now()
      RETURNING LOG("downvotePiconeros"::FLOAT / GREATEST("downvotePiconeros" - ${piconeros}, 1)::FLOAT) AS log_sats
    ), item_downzapped AS (
      UPDATE "Item"
      SET "weightedDownVotes" = "weightedDownVotes" + zapper."zapTrust" * zap.log_sats,
          "subWeightedDownVotes" = "subWeightedDownVotes" + zapper."subZapTrust" * zap.log_sats,
          "downPiconeros" = "downPiconeros" + ${piconeros}::BIGINT
      FROM zap, zapper
      WHERE "Item".id = ${itemId}::INTEGER
      RETURNING "Item".*
    )
    UPDATE "Item"
    SET "commentDownPiconeros" = "commentDownPiconeros" + ${piconeros}::BIGINT
    FROM (
      SELECT "Item".id FROM "Item", item_downzapped
      WHERE "Item".path @> item_downzapped.path AND "Item".id <> item_downzapped.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}

function feeTypeFor (major, payInType) {
  if (major === REWARDS_POSTING_MAJOR) return 'POSTING'
  // territory major: the PayIn's type tells us which territory fee it is
  if (payInType === 'TERRITORY_BILLING') return 'TERRITORY_BILLING'
  if (payInType === 'TERRITORY_UNARCHIVE') return 'TERRITORY_UNARCHIVE'
  return 'TERRITORY_CREATE'
}

// Flip the gated Item/Sub to live. Idempotent: the WHERE on the PENDING state
// means a second call (or a fee already paid by another path) is a no-op.
async function flipPendingToLive (models, payIn, feePiconeros) {
  if (payIn.payInType === 'ITEM_CREATE') {
    // Credit the observed posting fee as the post's non-tip investment so the
    // restored item_net_investment trigger produces netInvestment >= 0.001 XMR
    // (the new posts-filter default). Idempotent: the WHERE PENDING_FEE guard
    // makes re-polls a no-op. The fee NEVER touches Item.piconeros (tip total)
    // or boost (ranking), so tip display and ranktop/ranklit are unaffected.
    await models.$executeRaw`
      UPDATE "Item"
      SET "feeStatus" = 'FEE_PAID',
          "feeInvestmentPiconeros" = GREATEST("feeInvestmentPiconeros", ${feePiconeros}::bigint)
      WHERE "feePayInId" = ${payIn.id} AND "feeStatus" = 'PENDING_FEE'`
  } else if (['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE'].includes(payIn.payInType)) {
    await models.sub.updateMany({
      where: { billingPayInId: payIn.id, billingStatus: 'PENDING_FEE' },
      data: { billingStatus: 'PAID' }
    })
  }
}

// pg-boss handler. Fetches incremental txs for the rewards wallet, runs the
// attribution core, advances the cursor, and self-requeues. The cursor uses the
// same (lastTxId) forward dimension as moneroIndexer; full reorg reconciliation
// for fees is deferred (a reorged fee re-appears in a later poll and the
// idempotent FeeObservation insert handles it; confirmFinalizer gates finality).
export async function penaltyIndexer ({ boss, models }) {
  const account = await models.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network: (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase() },
    include: { viewKey: true }
  })
  if (account) {
    const resp = await lwsClient.getAddressTxs(account, account.lastTxId, account.lastBlockHash)
    const txs = (resp && resp.transactions) || []
    // bootstrapping filter: skip confirmed txs already behind the cursor. null
    // lastTxId = nothing seen yet, so process the whole returned history (this
    // is what lets a brand-new account's FIRST lws tx, which has id 0, through).
    const fresh = txs.filter(t => t.height == null || typeof t.id !== 'number' || account.lastTxId == null || BigInt(t.id) > account.lastTxId)
    await runPenaltyIndexerOnce({ models, account, txs: fresh })

    let maxId = 0
    for (const t of txs) {
      if (typeof t.id === 'number' && t.id > maxId) maxId = t.id
    }
    if (txs.length > 0) {
      await models.moneroAccount.update({ where: { id: account.id }, data: { lastTxId: BigInt(maxId) } })
    }
  }
  await boss.send('penaltyIndexer', {}, { startAfter: MONERO_POLL_INTERVAL_MS / 1000 })
}
