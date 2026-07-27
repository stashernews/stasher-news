import { lwsClient } from '@/api/monero/lwsClient'
import { applyTipDetected } from '@/api/monero/ranking'
import { MONERO_POLL_INTERVAL_MS } from '@/lib/constants'

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
// This module exports TWO things:
//   - runIndexerOnce: the testable per-poll core (no pg-boss). Takes an
//     injectable lwsClient so tests never touch the network.
//   - moneroIndexer: the pg-boss handler. Calls runIndexerOnce then
//     self-requeues with startAfter = MONERO_POLL_INTERVAL_MS.

// Prisma "unique constraint violated" code. Catching by code (not broadly)
// is what makes the insert idempotent without ever double-bumping msats: a
// P2002 means this exact tip was already recorded, so applyTipDetected must
// NOT run again.
const PRISMA_UNIQUE_VIOLATION = 'P2002'

// One forward poll. For every ACTIVE author account (ownerUserId != null — the
// platform rewards wallet is ownerUserId:null and belongs to penaltyIndexer in
// Phase 4, not this job), fetch incremental txs from lws, map each receive to
// a Post via SubaddressIndex, and idempotently insert an ObservedTip.
//
// tipperId is null in v1: Monero tips are anonymous by default and the indexer
// cannot identify the tipper without a claimed proof, so applyTipDetected
// follows Task 5's anonymous path (Item.msats bump, no ItemUserAgg row).
//
// Cursor (spec §5.5): lws /get_address_txs does NOT return a block hash in its
// response (only heights — see docs/monero-lws-research.md §light_wallet.cpp
// response). We therefore advance lastTxId to the max tx id seen (the primary
// forward cursor; monotonic + lws-defined) and leave lastBlockHash untouched.
// lastBlockHash is the reorg-detection dimension and is owned by Task 6's
// reconciler (it needs a block-hash source lws does not provide here). While
// lastBlockHash is null, lwsClient omits since_tx_block_hash from the request,
// so v1 polling is forward-only — correct for detection; reorgs are Task 6.
export async function runIndexerOnce ({ models, lwsClient: client = lwsClient }) {
  const accounts = await models.moneroAccount.findMany({
    where: { status: 'ACTIVE', ownerUserId: { not: null } },
    include: { viewKey: true }
  })

  for (const account of accounts) {
    const { transactions } = await client.getAddressTxs(account, account.lastTxId, account.lastBlockHash)
    if (!transactions || transactions.length === 0) continue

    for (const tx of transactions) {
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
      // recipientMajor, recipientMinor]). Only a NEW insert fires the ranking
      // hook; a P2002 means the tip is already recorded -> skip the bump.
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
        if (err && err.code === PRISMA_UNIQUE_VIOLATION) continue
        throw err
      }
    }

    // Advance the forward cursor to the highest tx id in this batch. Only do
    // this after the batch is processed without throwing so a mid-batch error
    // leaves the cursor pointing before the unprocessed txs (they will be
    // re-fetched next poll). lastBlockHash is intentionally not advanced —
    // see the cursor note above.
    let maxId = 0
    for (const tx of transactions) {
      if (typeof tx.id === 'number' && tx.id > maxId) maxId = tx.id
    }
    if (maxId > 0) {
      await models.moneroAccount.update({
        where: { id: account.id },
        data: { lastTxId: BigInt(maxId) }
      })
    }
  }
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
