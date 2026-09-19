import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { applyBoostDetected, flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { alert } from '@/lib/alert'

// Shared owner-fee receipt applier — the SINGLE implementation of fee-leg
// observation effects. Called by (a) the lws tx-confirmation webhook
// (pages/api/monero/webhook.js, primary) and (b) the reconcileOwnerFeeLegs
// cron backstop (missed-callback self-heal). Idempotent by construction:
// one receipt row per (txHash, paymentId); the row is inserted PROVISIONALLY
// (height NULL) and a chain-verified sight claims its block height through the
// atomic NULL->height CAS. The CAS is the exactly-once transition signal — a
// replay of an already-height receipt matches zero rows, so the boost bump and
// the live flip can never re-fire (unlike RETURNING/xmax freshness inference,
// which cannot distinguish a backfill from a same-height replay). The live flip
// gates on the COUNT-ELIGIBLE (height non-null) cumulative only: a provisional
// daemon-verified 0-conf receipt (amount is a callback claim, not a proven
// RingCT amount) is DISPLAY-ONLY. feePayIn may be null (late-payment callers):
// the receipt is still inserted with a null payInId, the gate/flip is skipped,
// and N-conf maturity still applies.
export async function applySubFeeReceipt (models, { feePayIn, paymentId, txHash, piconeros, height, confirmations }) {
  // Provisional insert (height NULL): a daemon-verified 0-conf receipt is
  // display-only until the CAS below claims the block height. The bare
  // ON CONFLICT DO NOTHING covers the (txHash, paymentId) unique AND the global
  // txHash unique (one tx = one pid = one leg, the storage-layer backstop
  // against cross-leg re-attribution).
  await models.$queryRaw`
    INSERT INTO "ObservedSubFee" ("tx_hash","payment_id","pay_in_id","subName","owner_user_id","piconeros","height","confirmations","state","detected_at")
    SELECT ${txHash}, ${paymentId}, ${feePayIn?.id ?? null}, m."subName", m."owner_user_id", ${piconeros}, NULL, 0, 'DETECTED'::"ObservedState", NOW()
    FROM "SubFeePidMap" m WHERE m."payment_id" = ${paymentId}
    ON CONFLICT DO NOTHING`
  let transitioned = false
  if (height != null) {
    // Read the provisional amount so a divergence between the callback claim
    // and the chain-verified amount is surfaced. Only the CAS changes it, and
    // a racing claimer turns our CAS into a 0-row no-op. The state guard keeps
    // a refused self-send row (EXCLUDED by the webhook's ban) unclaimable
    // forever — height IS NULL alone would let a replayed receipt claim it.
    const prior = await models.$queryRaw`
      SELECT piconeros FROM "ObservedSubFee"
      WHERE "tx_hash" = ${txHash} AND "payment_id" = ${paymentId} AND height IS NULL
      LIMIT 1`
    const previousPiconeros = prior?.[0]?.piconeros ?? null
    const claimed = await models.$queryRaw`
      UPDATE "ObservedSubFee"
      SET height = ${height}, piconeros = ${piconeros}, confirmations = ${confirmations}
      WHERE "tx_hash" = ${txHash} AND "payment_id" = ${paymentId} AND height IS NULL
        AND state = 'DETECTED'::"ObservedState"
      RETURNING id`
    transitioned = claimed.length > 0
    if (transitioned && previousPiconeros != null && previousPiconeros !== piconeros) {
      alert('warn', 'owner-fee receipt amount corrected at height transition',
        `fee leg ${paymentId} tx ${txHash}: verified at ${piconeros} piconeros vs provisional ${previousPiconeros} piconeros; counted amount corrected`,
        { dedupeKey: `subfee-receipt-corrected-${txHash}-${paymentId}` })
    }
  }

  // Owner-routed boost: a value effect, so it fires on the exactly-once CAS
  // transition only — never on the provisional insert and never on a replay.
  if (transitioned && feePayIn?.payInType === 'BOOST') {
    try {
      await applyBoostDetected(models, feePayIn, piconeros)
    } catch (err) {
      console.error(`subFeeObservation: owner-fee boost bump failed for payIn ${feePayIn.id}:`, err?.message || err)
    }
  }

  // Cumulative amount gate (underpayment top-up support) over COUNT-ELIGIBLE
  // receipts only — a provisional claim must never open the live flip.
  const expected = feePayIn?.moneroUri ? moneroUriAmountPiconeros(feePayIn.moneroUri) : null
  const counted = await models.observedSubFee.aggregate({
    _sum: { piconeros: true },
    where: { payInId: feePayIn?.id ?? -1, height: { not: null }, state: { in: ['DETECTED', 'CONFIRMED'] } }
  })
  const cumulative = counted._sum.piconeros ?? 0n
  if (feePayIn && cumulative > 0n && (expected === null || cumulative >= expected)) {
    await flipPendingToLive(models, feePayIn, cumulative)
  }

  // N-conf maturity of THIS receipt (atomic conditional; replays no-op).
  if (confirmations >= REQUIRED_CONFIRMATIONS) {
    await models.$executeRaw`
      UPDATE "ObservedSubFee"
      SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmed_at" = NOW()
      WHERE "tx_hash" = ${txHash} AND "payment_id" = ${paymentId} AND state = 'DETECTED'`
  }
  return { transitioned, cumulative }
}
