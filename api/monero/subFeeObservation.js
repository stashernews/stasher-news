import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { applyBoostDetected, flipPendingToLive } from '@/worker/rewardsWalletObserver'

// Shared owner-fee receipt applier — the SINGLE implementation of fee-leg
// observation effects. Called by (a) the lws tx-confirmation webhook
// (pages/api/monero/webhook.js, primary) and (b) the reconcileOwnerFeeLegs
// cron backstop (missed-callback self-heal). Idempotent by construction:
// one receipt row per (txHash, paymentId), effects fire on fresh rows or
// through atomic conditional updates, so webhook retries and replayed scans
// are no-ops. feePayIn may be null (late-payment callers): the receipt is
// still inserted with a null payInId, the gate/flip is skipped, and N-conf
// maturity still applies.
export async function applySubFeeReceipt (models, { feePayIn, paymentId, txHash, piconeros, height, confirmations }) {
  const rows = await models.$queryRaw`
    INSERT INTO "ObservedSubFee" ("tx_hash","payment_id","pay_in_id","subName","owner_user_id","piconeros","height","confirmations","state","detected_at")
    SELECT ${txHash}, ${paymentId}, ${feePayIn?.id ?? null}, m."subName", m."owner_user_id", ${piconeros}, ${height ?? null}, ${confirmations}, 'DETECTED'::"ObservedState", NOW()
    FROM "SubFeePidMap" m WHERE m."payment_id" = ${paymentId}
    ON CONFLICT ("tx_hash","payment_id") DO NOTHING
    RETURNING id`
  const fresh = rows && rows.length > 0

  // Owner-routed boost: the ranking bump fires on a fresh receipt only
  // (a replayed txHash must not re-bump), mirroring the observer.
  if (fresh && feePayIn?.payInType === 'BOOST') {
    try {
      await applyBoostDetected(models, feePayIn, piconeros)
    } catch (err) {
      console.error(`subFeeObservation: owner-fee boost bump failed for payIn ${feePayIn.id}:`, err?.message || err)
    }
  }

  // Cumulative amount gate (underpayment top-up support) — idempotent flip.
  const expected = feePayIn?.moneroUri ? moneroUriAmountPiconeros(feePayIn.moneroUri) : null
  const agg = await models.observedSubFee.aggregate({
    _sum: { piconeros: true },
    where: { payInId: feePayIn?.id ?? -1 }
  })
  const cumulative = agg._sum.piconeros ?? 0n
  if (feePayIn && (expected === null || cumulative >= expected)) {
    await flipPendingToLive(models, feePayIn, cumulative)
  }

  // N-conf maturity of THIS receipt (atomic conditional; replays no-op).
  if (confirmations >= REQUIRED_CONFIRMATIONS) {
    await models.$executeRaw`
      UPDATE "ObservedSubFee"
      SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmed_at" = NOW()
      WHERE "tx_hash" = ${txHash} AND "payment_id" = ${paymentId} AND state = 'DETECTED'`
  }
  return { fresh, cumulative }
}
