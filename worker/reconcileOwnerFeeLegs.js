import { lwsClient } from '@/api/monero/lwsClient'
import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'
import { isSelfSend } from '@/api/monero/selfTip'
import { alert } from '@/lib/alert'

// Cron-owned backstop for owner-routed fee legs (the eighth money-observation
// chain). The lws tx-confirmation webhook is primary; this chain self-heals:
//   - a missed 0-conf callback (deploy restart across the confirmation
//     window): re-observes receipts via lws and re-runs the cumulative gate,
//     flipping PENDING_FEE items before abandonFeeItems strikes at 1 day;
//   - a missed N-conf callback: backfills the receipt + height (always at
//     confirmations 0 — never fabricated; the confirmFinalizer ObservedSubFee
//     pass matures height-bearing DETECTED rows with exact counts).
// Never self-requeues — a failed run heals at the next hourly cron tick.
export async function runReconcileOwnerFeeLegsOnce ({ models, monero = lwsClient }) {
  // Active legs = map rows still holding an lws webhook (unexpired) whose
  // PayIn still exists. NO payInState filter: fee payIns are created PAID by
  // design (piconeros=0 — the fee-gated Item/Sub lives on Item.feeStatus, not
  // the PayIn; see api/payIn/types/itemCreate.js getInitial). The earlier
  // `payInState: 'PENDING_PAYMENT'` filter could never match, so this backstop
  // never scanned a single leg (2026-09-19 fix). Re-scanning settled legs is
  // harmless: applySubFeeReceipt's insert/CAS are idempotent and
  // flipPendingToLive is guarded by WHERE feeStatus = 'PENDING_FEE'.
  const maps = await models.subFeePidMap.findMany({
    where: { webhookEventId: { not: null }, expiresAt: { gt: new Date() } }
  })
  if (maps.length === 0) return { legs: 0, replayed: 0, flipped: 0 }

  const payIns = await models.payIn.findMany({
    where: { moneroPaymentId: { in: maps.map(m => m.paymentId) } }
  })
  const byPid = new Map(payIns.map(p => [p.moneroPaymentId, p]))
  const legs = maps.filter(m => byPid.has(m.paymentId))
  if (legs.length === 0) return { legs: 0, replayed: 0, flipped: 0 }

  // Group by owner account; one full-history scan per owner per run (owner
  // accounts are low-history; the tip webhook cursor optimization does not
  // apply here — this is an hourly backstop over few legs).
  const byOwner = new Map()
  for (const leg of legs) {
    if (!byOwner.has(leg.ownerUserId)) byOwner.set(leg.ownerUserId, [])
    byOwner.get(leg.ownerUserId).push(leg)
  }

  let replayed = 0
  for (const [ownerUserId, ownerLegs] of byOwner) {
    const account = await models.moneroAccount.findFirst({
      where: { ownerUserId, status: 'ACTIVE' },
      include: { viewKey: true, subaddresses: true }
    })
    if (!account?.viewKey) continue // unscanable: webhook remains primary
    let txs
    try {
      txs = (await monero.getAddressTxs(account, 0, null)).transactions || []
    } catch (err) {
      console.warn(`reconcileOwnerFeeLegs: lws scan failed for owner ${ownerUserId}: ${err?.message || err}`)
      continue
    }
    const pidSet = new Set(ownerLegs.map(l => String(l.paymentId).toLowerCase()))
    for (const tx of txs) {
      if (!tx.payment_id || !pidSet.has(String(tx.payment_id).toLowerCase())) continue
      // SELF-PAYMENT BAN (2026-09-19 incident): when the payer shares the owner
      // account, lws's per-tx total_received folds in the sender's change
      // (inputs - fee) and is NOT the leg amount — no amount from a self-send
      // is credible here, so the tx is never replayed. Same EXACT (maj,min)
      // sender match as the webhook's isSelfSend (review follow-up: the old
      // coarse `spent_outputs.length > 0` test treated lws's documented
      // misattributed foreign spends (observed 2026-08-10) as self-sends,
      // stranding a genuine fee behind an unreclaimable EXCLUDED row; the
      // exact match only refuses true own-subaddress senders). Any provisional
      // row a 0-conf callback seeded is EXCLUDED so the display can never show
      // the change as received; the webhook's isSelfSend refusal is the
      // primary and keeps such rows from ever gaining a height (the applier's
      // CAS is state-gated to DETECTED).
      if (isSelfSend(account, tx)) {
        const excluded = await models.$executeRaw`
          UPDATE "ObservedSubFee" SET state = 'EXCLUDED'::"ObservedState"
          WHERE "tx_hash" = ${tx.hash} AND "payment_id" = ${tx.payment_id} AND height IS NULL`
        if (excluded > 0) {
          alert('warn', 'owner-fee self-payment refused',
            `fee leg ${tx.payment_id} tx ${tx.hash}: payer shares the owner account (change-inflated); provisional receipt excluded by the backstop`,
            { dedupeKey: `subfee-selfpay-${tx.payment_id}-${String(tx.hash).toLowerCase()}` })
        }
        continue
      }
      // Replay through the shared applier — idempotent by construction (one
      // ObservedSubFee row per (txHash, paymentId), ON CONFLICT DO NOTHING),
      // so an hourly rescan of an already-replayed receipt is a no-op.
      await applySubFeeReceipt(models, {
        feePayIn: byPid.get(tx.payment_id) ?? null,
        paymentId: tx.payment_id,
        txHash: tx.hash,
        piconeros: tx.piconeros,
        height: tx.height ?? null,
        confirmations: 0 // never fabricated — confirmFinalizer matures height-bearing rows
      })
      replayed += 1
    }
  }
  return { legs: legs.length, replayed, flipped: replayed }
}

export async function reconcileOwnerFeeLegs ({ models }) {
  const out = await runReconcileOwnerFeeLegsOnce({ models })
  if (out.replayed > 0) {
    console.log(`reconcileOwnerFeeLegs: ${out.legs} active leg(s) scanned, ${out.replayed} receipt(s) replayed through the cumulative gate`)
  }
  return out
}
