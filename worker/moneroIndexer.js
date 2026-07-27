import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { applyTipDetected, reverseTip } from '@/api/monero/ranking'
import { MONERO_POLL_INTERVAL_MS, REORG_GRACE_BLOCKS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'

// moneroIndexer — the heart of off-chain tip attribution (Task 4 / spec §2.6).
//
// Every MONERO_POLL_INTERVAL_MS this job polls monero-lws for each ACTIVE
// author MoneroAccount: "any new incoming outputs since my last cursor?" Each
// output is mapped to a Post via the SubaddressIndex pool and recorded as an
// ObservedTip (state DETECTED). Tips are 100% P2P — this job only OBSERVES,
// it never custodies funds. The view key is decrypted in-process by lwsClient
// (Task 3) from the MoneroViewKey envelope (Task 2); it never touches disk or
// logs in plaintext.
//
// REORG RECONCILIATION (Task 6 / spec §5.5): lws signals a reorg to a REST
// poller by REPLAYING history behind the forward cursor — if the stored
// since_tx_block_hash was invalidated, the response includes confirmed txs with
// id <= account.lastTxId instead of only newer ones (docs/monero-lws-research.md
// §8 lines 749-754; spec §5.5 line 752). When that replay is detected, every
// DETECTED ObservedTip on the account that is ABSENT from the replay and older
// than REORG_GRACE_BLOCKS is flipped to REORGED and its ranking delta is
// reversed via reverseTip (Task 5). Tips at >= REQUIRED_CONFIRMATIONS are final
// and never reverted. A REORGED tip that reappears in a later poll is revived
// to DETECTED and re-bumped (the @@unique collision flips the existing row
// rather than creating a second one).
//
// This module exports TWO things:
//   - runIndexerOnce: the testable per-poll core (no pg-boss). Takes injectable
//     lwsClient + daemonClient so tests never touch the network.
//   - moneroIndexer: the pg-boss handler. Calls runIndexerOnce then
//     self-requeues with startAfter = MONERO_POLL_INTERVAL_MS.

// Prisma "unique constraint violated" code. Catching by code (not broadly)
// is what makes the insert idempotent without ever double-bumping msats: a
// P2002 means this exact tip was already recorded. If the existing row is
// REORGED, the tip reappeared after a reorg and is revived (delta re-applied);
// otherwise the duplicate is a true no-op.
const PRISMA_UNIQUE_VIOLATION = 'P2002'

// Reorg/replay detection (spec §5.5). In forward mode every returned tx has
// id > lastTxId; a CONFIRMED tx (height present) with id <= lastTxId means lws
// rewound the cursor — i.e. the stored since_tx_block_hash was invalidated.
// Mempool txs (height null) are excluded: they carry no block-id semantics and
// a mempool id of 0 would otherwise false-trigger. Only meaningful once the
// account is in reorg-safe cursor mode (lastBlockHash set); until then the
// account is bootstrapping forward-only.
function isReorgReplay (txs, lastTxId) {
  const cursor = BigInt(lastTxId)
  for (const t of txs) {
    if (t.height != null && typeof t.id === 'number' && BigInt(t.id) <= cursor) return true
  }
  return false
}

// Reconcile a reorg replay for one account (spec §5.5 point 3). For every
// DETECTED ObservedTip on the account whose txHash is NOT in the replayed
// response: if it is buried deep enough to be final (>= REQUIRED_CONFIRMATIONS)
// leave it untouched; otherwise, if it is older than REORG_GRACE_BLOCKS behind
// the chain tip, mark it REORGED and reverse the ranking delta. Mempool tips
// (height null) are skipped — they have no block height to reconcile against.
async function reconcileReorg ({ models, account, txs, chainHeight }) {
  const presentHashes = new Set(txs.map(t => t.hash))
  const detected = await models.observedTip.findMany({
    where: { recipientAccountId: account.id, state: 'DETECTED' }
  })
  for (const tip of detected) {
    if (presentHashes.has(tip.txHash)) continue
    if (tip.height == null) continue
    const confirmations = chainHeight - tip.height + 1
    if (confirmations >= REQUIRED_CONFIRMATIONS) continue
    if (tip.height < chainHeight - REORG_GRACE_BLOCKS) {
      await models.observedTip.update({ where: { id: tip.id }, data: { state: 'REORGED' } })
      await reverseTip(tip.postId, tip.piconeros)
    }
  }
}

// One forward poll. For every ACTIVE author account (ownerUserId != null — the
// platform rewards wallet is ownerUserId:null and belongs to penaltyIndexer in
// Phase 4, not this job), fetch incremental txs from lws, detect+reconcile any
// reorg replay, map each receive to a Post via SubaddressIndex, and idempotently
// insert an ObservedTip (reviving REORGED rows that reappear).
//
// tipperId is null in v1: Monero tips are anonymous by default and the indexer
// cannot identify the tipper without a claimed proof, so applyTipDetected
// follows Task 5's anonymous path (Item.msats bump, no ItemUserAgg row).
//
// Cursor (spec §5.5): lws /get_address_txs returns no block hash, so the
// reorg-cursor's since_tx_block_hash is sourced from monerod via
// daemonClient.getBlockHashByHeight (the highest-height confirmed tx in the
// batch). lastTxId advances to the highest tx id seen. During a replay the
// cursor may shift backward — that is correct and expected.
export async function runIndexerOnce ({ models, lwsClient: client = lwsClient, daemonClient: dClient = daemonClient }) {
  const accounts = await models.moneroAccount.findMany({
    where: { status: 'ACTIVE', ownerUserId: { not: null } },
    include: { viewKey: true }
  })

  for (const account of accounts) {
    const resp = await client.getAddressTxs(account, account.lastTxId, account.lastBlockHash)
    const txs = resp.transactions || []
    const chainHeight = resp.blockchain_height || 0
    if (txs.length === 0) continue

    // Reorg reconciliation: only when lws replayed history behind the cursor.
    if (account.lastBlockHash && isReorgReplay(txs, account.lastTxId)) {
      await reconcileReorg({ models, account, txs, chainHeight })
    }

    for (const tx of txs) {
      // Map the receiving subaddress -> the Post it is assigned to. A missing
      // row or an unassigned subaddress means this output is not a tip to a
      // known post (payment-id mode, or a subaddress not yet bound) -> skip.
      if (!tx.recipient) continue
      const sub = await models.subaddressIndex.findUnique({
        where: {
          accountId_majorIndex_minorIndex: {
            accountId: account.id,
            majorIndex: tx.recipient.maj_i,
            minorIndex: tx.recipient.min_i
          }
        }
      })
      if (!sub || sub.assignedPostId == null) continue

      // Idempotent insert keyed by @@unique([txHash, recipientAccountId,
      // recipientMajor, recipientMinor]). A NEW insert fires the ranking hook.
      // A P2002 on a REORGED row means the tip reappeared after a reorg: revive
      // it to DETECTED and re-apply the delta (reverseTip already subtracted
      // it). A P2002 on a DETECTED/CONFIRMED row is a true duplicate -> skip.
      try {
        await models.observedTip.create({
          data: {
            txHash: tx.hash,
            postId: sub.assignedPostId,
            tipperId: null,
            recipientAccountId: account.id,
            recipientMajor: tx.recipient.maj_i,
            recipientMinor: tx.recipient.min_i,
            paymentId: tx.payment_id ?? null,
            piconeros: tx.piconeros,
            height: tx.height ?? null,
            state: 'DETECTED',
            proofType: 'INDEXED'
          }
        })
        await applyTipDetected(sub.assignedPostId, null, tx.piconeros)
      } catch (err) {
        if (err && err.code === PRISMA_UNIQUE_VIOLATION) {
          await reviveIfReorged({ models, account, tx, postId: sub.assignedPostId })
          continue
        }
        throw err
      }
    }

    // Advance the cursor after the batch is processed without throwing so a
    // mid-batch error leaves the cursor pointing before the unprocessed txs.
    // lastTxId (forward) advances to the highest tx id. lastBlockHash (reorg
    // dimension) is sourced from the highest-height CONFIRMED tx via monerod;
    // mempool-only batches leave it unchanged. A daemon failure is logged but
    // does NOT abort the loop — lastTxId still advances and the next poll
    // retries the block-hash fetch (the indexer poll loop is the retry).
    let maxId = 0
    let maxConfirmedHeight = null
    for (const tx of txs) {
      if (typeof tx.id === 'number' && tx.id > maxId) maxId = tx.id
      if (tx.height != null && (maxConfirmedHeight === null || tx.height > maxConfirmedHeight)) {
        maxConfirmedHeight = tx.height
      }
    }
    const data = {}
    if (maxId > 0) data.lastTxId = BigInt(maxId)
    if (maxConfirmedHeight !== null) {
      try {
        data.lastBlockHash = await dClient.getBlockHashByHeight(maxConfirmedHeight)
      } catch (err) {
        console.error(`moneroIndexer: block-hash fetch failed for account ${account.id} at height ${maxConfirmedHeight}: ${err && err.message}`)
      }
    }
    if (maxId > 0 || maxConfirmedHeight !== null) {
      await models.moneroAccount.update({ where: { id: account.id }, data })
    }
  }
}

// On a P2002 (the @@unique key already exists), revive the row iff it is
// REORGED — the tip reappeared on the new chain after a reorg. Flips state back
// to DETECTED and re-applies the ranking delta that reverseTip subtracted.
// DETECTED/CONFIRMED rows are true duplicates and left alone. A Monero tx hash
// binds the full tx, so a reappeared tx has identical outputs/amount; we still
// refresh height/piconeros from the fresh response for correctness.
async function reviveIfReorged ({ models, account, tx, postId }) {
  const existing = await models.observedTip.findFirst({
    where: {
      txHash: tx.hash,
      recipientAccountId: account.id,
      recipientMajor: tx.recipient.maj_i,
      recipientMinor: tx.recipient.min_i
    }
  })
  if (!existing || existing.state !== 'REORGED') return
  await models.observedTip.update({
    where: { id: existing.id },
    data: { state: 'DETECTED', height: tx.height ?? null, piconeros: tx.piconeros }
  })
  await applyTipDetected(postId, null, tx.piconeros)
}

// pg-boss handler. Runs one forward poll then self-requeues. The requeue uses
// the codebase's plain boss.send(name, data, { startAfter }) convention (see
// worker/search.js, worker/territory.js, worker/domainVerification.js). The
// initial seed in worker/index.js carries a singletonKey so restarts cannot
// spawn duplicate loops; the requeue deliberately omits it because the running
// job is still active at requeue time and a singleton guard would drop it.
export async function moneroIndexer ({ boss, models }) {
  await runIndexerOnce({ models })
  await boss.send('moneroIndexer', {}, { startAfter: MONERO_POLL_INTERVAL_MS })
}
