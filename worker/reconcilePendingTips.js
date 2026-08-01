import { Prisma } from '@prisma/client'
import { lwsClient } from '@/api/monero/lwsClient'
import { applyTipDetected } from '@/api/monero/ranking'
import { RECONCILE_PENDING_AGE_MS, PENDING_EXPIRY_MS } from '@/lib/constants'

// reconcilePendingTips — recover tips stranded in PENDING by a missed 0-conf webhook.
//
// A tip is PENDING from initiateTip until the lws 0-conf callback flips it DETECTED. If
// that callback is lost (app downtime, network), confirmFinalizer will NEVER mature it
// (it only scans DETECTED rows). This job, every RECONCILE_INTERVAL, finds PENDING tips
// older than RECONCILE_PENDING_AGE_MS, re-scans the author account via lws
// get_address_txs, and if the payment_id is on chain, performs the same PENDING->DETECTED
// transition the webhook receiver would have (atomic claim + applyTipDetected). Tips that
// were never paid are expired after PENDING_EXPIRY_MS so the table cannot grow unbounded.
//
// Race safety: a tip could be recovered here AND by a belated webhook at the same instant.
// The recovery uses an atomic conditional UPDATE (... WHERE state = 'PENDING') inside a
// Serializable transaction: exactly one flipper wins (rowCount > 0) and only it applies the
// ranking delta — so the tip is never double-counted. This is the same idempotency contract
// the webhook receiver relies on, made race-proof via the conditional claim.
//
// get_address_txs returns the full history when sinceBlockHash is null, so this re-scan is
// exhaustive for the account (the job is infrequent + state-filtered to PENDING, so the
// cost is bounded by the number of accounts with stranded tips, not all accounts).

const RECONCILE_INTERVAL_SECONDS = 2 * 60 // every 2 min

export async function runReconcilePendingTipsOnce ({
  models, lwsClient: client = lwsClient, apply = applyTipDetected
}) {
  const now = Date.now()
  const reconcileBefore = new Date(now - RECONCILE_PENDING_AGE_MS)
  const expireBefore = new Date(now - PENDING_EXPIRY_MS)

  const eligible = await models.observedTip.findMany({
    where: { state: 'PENDING', detectedAt: { lt: reconcileBefore } }
  })
  if (eligible.length === 0) return { recovered: 0, expired: 0 }

  // Group stranded tips by the author account whose address lws must scan.
  const byAccount = new Map()
  for (const tip of eligible) {
    if (!byAccount.has(tip.recipientAccountId)) byAccount.set(tip.recipientAccountId, [])
    byAccount.get(tip.recipientAccountId).push(tip)
  }
  const accounts = await models.moneroAccount.findMany({
    where: { id: { in: [...byAccount.keys()] } },
    include: { viewKey: true }
  })

  let recovered = 0
  let expired = 0
  for (const account of accounts) {
    const tips = byAccount.get(account.id) || []
    const resp = await client.getAddressTxs(account, 0, null)
    const byPid = new Map()
    for (const tx of (resp.transactions || [])) {
      if (tx.payment_id) byPid.set(String(tx.payment_id).toLowerCase(), tx)
    }
    for (const tip of tips) {
      const tx = byPid.get(String(tip.paymentId).toLowerCase())
      if (tx) {
        const amount = tx.piconeros ?? tip.piconeros
        await models.$transaction(async (txdb) => {
          // Atomic conditional claim: only the first flipper (us or the webhook) wins.
          const claimed = await txdb.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'DETECTED', "txHash" = ${tx.hash},
                height = ${tx.height ?? null}, piconeros = ${amount}, confirmations = 0
            WHERE id = ${tip.id} AND state = 'PENDING'`
          if (claimed > 0) {
            await apply(tip.postId, null, amount, txdb)
            recovered += 1
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } else if (tip.detectedAt < expireBefore) {
        await models.observedTip.updateMany({
          where: { id: tip.id, state: 'PENDING' },
          data: { state: 'EXPIRED' }
        })
        expired += 1
      }
    }
  }
  return { recovered, expired }
}

export async function reconcilePendingTips ({ boss, models }) {
  const out = await runReconcilePendingTipsOnce({ models })
  if (out.recovered || out.expired) {
    console.log(`reconcilePendingTips: recovered ${out.recovered}, expired ${out.expired}`)
  }
  await boss.send('reconcilePendingTips', {}, { startAfter: RECONCILE_INTERVAL_SECONDS })
}
