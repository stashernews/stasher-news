import { lwsClient } from '@/api/monero/lwsClient'
import {
  REWARDS_POSTING_MAJOR,
  REWARDS_TERRITORY_MAJOR
} from '@/api/monero/feePool'
import { MONERO_POLL_INTERVAL_MS } from '@/lib/constants'

// penaltyIndexer — observes posting/territory fees paid to the platform rewards
// wallet (Phase 3 Task 5 / spec §5.6, §6.2). The rewards wallet is the ONLY
// custodial component; every fee lands on a DEDICATED subaddress (major 1 =
// posting, major 2 = territory) reserved by reserveFeeSubaddress at fee time.
//
// Each poll fetches incremental outputs from lws for the platform_rewards wallet.
// For each output at a fee subaddress, this job:
//   1. finds the pending PayIn that reserved that subaddress,
//   2. idempotently records a FeeObservation (DETECTED), and
//   3. flips the gated Item.feeStatus PENDING_FEE -> FEE_PAID (or
//      Sub.billingStatus PENDING_FEE -> PAID), taking the post/territure live.
// The confirmFinalizer matures FeeObservation DETECTED -> CONFIRMED at
// REQUIRED_CONFIRMATIONS (separate concern, separate job).
//
// PHASE 4 EXTENSION POINT: outputs carrying a payment_id (downvotes) are not fee
// subaddresses and fall through attributeOutput's subaddress branch to the
// payment_id -> DownvotePidMap branch, added in Phase 4 without restructuring.
//
// This module exports TWO things (mirrors worker/moneroIndexer.js /
// worker/confirmFinalizer.js):
//   - runPenaltyIndexerOnce: the testable per-poll core (no pg-boss). Accepts a
//     `txs` override so tests never touch the network.
//   - penaltyIndexer: the pg-boss handler. Fetches txs via lwsClient, runs the
//     core, advances the cursor, and self-requeues.

// One poll. `txs` is normally fetched from lws by the handler; tests pass it
// directly. Returns nothing; effects are the FeeObservation rows + fee flips.
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
  await attributeFeeBySubaddress(models, tx)
  // ── PHASE 4 EXTENSION POINT ──────────────────────────────────────────────
  // Outputs carrying a payment_id (downvotes) are not fee subaddresses and will
  // be attributed here: if (tx.payment_id) await attributeDownvoteByPaymentId(...)
  // ─────────────────────────────────────────────────────────────────────────
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

  await flipPendingToLive(models, payIn)
  return rows[0].id
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
async function flipPendingToLive (models, payIn) {
  if (payIn.payInType === 'ITEM_CREATE') {
    await models.item.updateMany({
      where: { feePayInId: payIn.id, feeStatus: 'PENDING_FEE' },
      data: { feeStatus: 'FEE_PAID' }
    })
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
    where: { label: 'platform_rewards', network: (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase() }
  })
  if (account) {
    const resp = await lwsClient.getAddressTxs(account, account.lastTxId, account.lastBlockHash)
    const txs = (resp && resp.transactions) || []
    // bootstrapping filter: skip confirmed txs already behind the cursor
    const fresh = txs.filter(t => t.height == null || typeof t.id !== 'number' || BigInt(t.id) > account.lastTxId)
    await runPenaltyIndexerOnce({ models, account, txs: fresh })

    let maxId = 0
    for (const t of txs) {
      if (typeof t.id === 'number' && t.id > maxId) maxId = t.id
    }
    if (maxId > 0) {
      await models.moneroAccount.update({ where: { id: account.id }, data: { lastTxId: BigInt(maxId) } })
    }
  }
  await boss.send('penaltyIndexer', {}, { startAfter: MONERO_POLL_INTERVAL_MS })
}
