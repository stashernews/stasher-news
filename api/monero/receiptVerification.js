// Webhook receipt integrity helpers (H3). Amounts arrive as untrusted strings
// from the lws callback. A missing/garbage/zero/negative amount must never be
// recorded or credited.
import { lookupTipTx } from '@/api/monero/selfTip'

export function parsePiconeros (amount) {
  if (amount === null || amount === undefined || amount === '') return null
  let value
  try {
    value = BigInt(amount)
  } catch {
    return null
  }
  if (value <= 0n) return null
  return value
}

export class ReceiptLookupError extends Error {}

// Cross-check a callback against the chain before any state change or credit.
// `lookupTipTx` is account-generic despite the name: it fetches the tx for a
// payment id via the account's lws view key (incremental cursor + full-scan
// fallback). Fail closed for any scannable account:
//   - transient lws failure -> ReceiptLookupError (caller returns non-200 so
//     lws retries; reconcilePendingTips/confirmFinalizer are the backstops)
//   - missing/mismatched tx or hash -> { ok: false } (caller records no credit)
// The callback txHash is BOUND to the chain tx: without it, a token-holding
// attacker could replay one real payment with fabricated txHash values and
// inflate (txHash, paymentId)-keyed receipts. `tx` lets the tip branch reuse
// the tx it already fetched for the self-send check (one lws call per callback).
// Unscannable accounts (no view key / INACTIVE) return { ok: true, skipped },
// preserving the repo's documented fail-open posture for the one edge where the
// chain cannot be consulted at all (same as the self-send check).
export async function verifyReceiptAmount ({ models, monero, account, paymentId, piconeros, txHash, tx = null }) {
  if (!account?.viewKey || account.status !== 'ACTIVE') {
    return { ok: true, skipped: true }
  }
  let verified = tx
  if (!verified) {
    try {
      verified = await lookupTipTx(models, monero, account, paymentId)
    } catch (err) {
      throw new ReceiptLookupError(`lws receipt lookup failed for ${paymentId}: ${err?.message || err}`)
    }
  }
  if (!verified) return { ok: false, reason: 'tx_not_found' }
  if (!verified.hash) return { ok: false, reason: 'hash_unavailable' }
  if (txHash != null && String(verified.hash).toLowerCase() !== String(txHash).toLowerCase()) {
    return { ok: false, reason: 'hash_mismatch' }
  }
  if (BigInt(verified.piconeros ?? 0) !== BigInt(piconeros)) {
    return { ok: false, reason: 'amount_mismatch', onChain: BigInt(verified.piconeros ?? 0) }
  }
  return { ok: true, tx: verified }
}
