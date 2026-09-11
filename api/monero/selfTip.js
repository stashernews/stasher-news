import { Prisma } from '@prisma/client'
import { reverseTip } from '@/api/monero/ranking'

// Self-tip exclusion helpers (spec §2.2). Pure functions — no I/O.
//
// A tip is a SELF-SEND when the incoming tx's spent_outputs (from a
// get_address_txs scan of the RECIPIENT account) include an output whose
// subaddress indices exactly match one of that account's OWN addresses:
// the primary (0,0) or a SubaddressIndex row. lws only decodes indices for
// outputs it can attribute to the scanned account (key-image matching), but
// candidates can false-match — hence the exact-match requirement.
//
// lws spent_outputs wire shape (verified on dev lws 2026-08-23): subaddress
// indices arrive ONLY nested under `sender` — {"sender":{"maj_i":0,"min_i":0}} —
// the subaddress of the scanned account that owned the spent output. There is
// no flat maj_i/min_i and no `recipient` object on this build;
// scripts/probe-lws-spent-outputs.js re-verifies the shape on other lws builds.

function ownSubaddressSet (account) {
  const set = new Set(['0,0']) // the primary address is always (0,0)
  for (const s of account?.subaddresses || []) {
    set.add(`${s.majorIndex},${s.minorIndex}`)
  }
  return set
}

export function isSelfSend (account, tx) {
  if (!tx || !Array.isArray(tx.spent_outputs)) return false
  const own = ownSubaddressSet(account)
  for (const so of tx.spent_outputs) {
    const maj = so?.sender?.maj_i
    const min = so?.sender?.min_i
    if (maj == null || min == null) continue
    if (own.has(`${maj},${min}`)) return true
  }
  return false
}

export function shouldExcludeTip ({ tipperId, postUserId, account, tx }) {
  if (tipperId != null && tipperId === postUserId) return true
  return isSelfSend(account, tx)
}

// Resolve an item's turf name with the same COALESCE(root, item) logic the
// ranking/trust code uses; null when the item has no subNames. Rare-path
// helper (only called on exclusions), one indexed-PK query.
export async function resolveItemSubName (postId, handle) {
  const q = Prisma.sql`
    SELECT COALESCE(r."subNames"[1], i."subNames"[1]) AS "subName"
    FROM "Item" i
    LEFT JOIN "Item" r ON r.id = i."rootId"
    WHERE i.id = ${postId}::INTEGER`
  const rows = await handle.$queryRaw(q)
  return rows?.[0]?.subName ?? null
}

// Find the lws tx row for a payment id on a scannable recipient account.
// Incremental scan via the account's lastTxId cursor (full history was
// O(account age) per tip callback). Guarantee: if the incremental response
// does not contain OUR pid, fall back to one full scan — the detection
// semantics can only match today's, never regress. A mempool tx may lack an
// id / be excluded from since_tx_id responses, and the fallback covers that
// too (worst case = fail-open non-exclusion, same as when the account is
// unscannable). The cursor advance is forward-only and best-effort (a lost
// advance only costs one fuller scan) — and is SKIPPED entirely for the
// platform rewards account, whose lastTxId belongs to the
// rewardsWalletObserver (see the guard below). Errors propagate to the caller.
export async function lookupTipTx (models, monero, account, paymentId) {
  const lookup = (txs) => {
    const byPid = new Map()
    for (const t of (txs || [])) {
      if (t.payment_id) byPid.set(String(t.payment_id).toLowerCase(), t)
    }
    return byPid.get(String(paymentId).toLowerCase()) ?? null
  }
  let resp = await monero.getAddressTxs(account, account.lastTxId ?? 0, null)
  let tx = lookup(resp.transactions)
  if (!tx && account.lastTxId != null) {
    resp = await monero.getAddressTxs(account, 0, null)
    tx = lookup(resp.transactions)
  }
  // Forward-only cursor advance (never regresses on concurrent/lws re-sends)
  // — but NEVER for the platform rewards account: its lastTxId is the
  // rewardsWalletObserver's incremental watermark, and the observer is the
  // ONLY attributor for fee-subaddress outputs, DONATE payIns, and
  // upload-paid flips (none register lws webhooks). A webhook/finalizer
  // lookup advancing this cursor permanently skips every tx between the old
  // watermark and the response's newest id (lws since_tx_id never
  // re-delivers them) with no re-attribution backstop — starved fees leave
  // items PENDING_FEE until abandonFeeItems deletes them. The observer
  // itself advances the cursor every minute, so verification lookups stay
  // incremental without this write. (Audit 2026-09-11, finding 1.)
  if (account.label !== 'platform_rewards') {
    const maxId = (resp.transactions || []).reduce(
      (m, t) => (typeof t.id === 'number' && t.id > m ? t.id : m), Number(account.lastTxId ?? 0))
    if (maxId > Number(account.lastTxId ?? 0)) {
      await models.moneroAccount.updateMany({
        where: { id: account.id, OR: [{ lastTxId: null }, { lastTxId: { lt: BigInt(maxId) } }] },
        data: { lastTxId: BigInt(maxId) }
      }).catch(() => {}) // best-effort: a lost advance only costs one fuller scan
    }
  }
  return tx
}

// True when a DETECTED tip's stored amount/txHash disagree with the chain tx
// found for its payment id — evidence of a forged pre-verification callback
// (audit 2026-09-11, finding 2). Hash comparison only when BOTH are present: a
// NULL stored txHash is not itself forgery evidence (callbacks may omit
// tx_hash; verifyReceiptAmount tolerates that at detection). A multi-pid
// single-tx compares against the whole-tx amount — the same accepted posture
// as verifyReceiptAmount. Exported for the audit script
// (scripts/audit-detected-tips.js).
export function chainMismatch (tip, tx) {
  if (!tx) return false
  if (tx.piconeros != null && BigInt(tx.piconeros) !== BigInt(tip.piconeros)) return true
  if (tip.txHash != null && tx.hash != null &&
      String(tip.txHash).toLowerCase() !== String(tx.hash).toLowerCase()) return true
  return false
}

// Confirm-time re-check (the 0-conf gap). At detection the tx is in the
// mempool and lws get_address_txs carries no spent_outputs for it, so the
// self-send check fails open — the documented worst case. Once MINED the
// evidence exists, so this re-check runs at the last gate before CONFIRMED
// credit (the webhook N-conf callback and the confirmFinalizer maturity pass —
// the only two claimers of DETECTED -> CONFIRMED) and at the webhook's first
// callback that carries a block height. It now performs TWO bindings:
//   - SELF_SEND (spec §2.3): spent_outputs from the recipient's own wallet ->
//     claim EXCLUDED from DETECTED (atomic conditional UPDATE, race-safe vs
//     the CONFIRMED claim), reverse the detection-applied ranking delta via
//     reverseTip (the same posture as the REORGED reversal in
//     reverseStaleDetections), write the AbuseSignal.
//   - CHAIN_MISMATCH (audit 2026-09-11, finding 2): the STORED piconeros or
//     txHash disagree with the chain tx -> the stored amount was forged
//     through the pre-verification webhook; same EXCLUDED + reverseTip +
//     AbuseSignal disposition. This closes the credit path for legacy DETECTED
//     rows whose stored value no re-verification ever saw: verifyReceiptAmount
//     binds the CALLBACK to the chain, but the finalizer/webhook credit uses
//     the STORED amount — only this check compares the stored value itself.
// All in ONE Serializable transaction.
//
// Guards mirror the detection-time check: unscannable accounts (view key
// wiped / INACTIVE) fail open; the DIRECT_SELF_TIP case needs no scan.
// `prefetchedTx` lets a caller that already fetched the tx (the webhook's C4
// receipt verification) share its lookup — one lws call per callback. Callers
// that omit it behave exactly as before (own lookupTipTx).
// Streaks granted at DETECTED are an accepted residual (same as REORGED).
// Returns true when THIS caller claimed the exclusion; lws errors propagate
// (webhook: non-200 so lws retries; finalizer: skip the tip, retry next run).
export async function recheckDetectedTip ({ models, monero, tip, confirmations = 0, height = null, prefetchedTx = null }) {
  const account = tip.recipientAccount
  if (!account?.viewKey || account.status !== 'ACTIVE') return false
  const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
  let tx = null
  let reason = null
  if (!direct) {
    tx = prefetchedTx ?? await lookupTipTx(models, monero, account, tip.paymentId)
    if (isSelfSend(account, tx)) reason = 'SELF_SEND'
    else if (chainMismatch(tip, tx)) reason = 'CHAIN_MISMATCH'
    if (!reason) return false
  } else {
    reason = 'DIRECT_SELF_TIP'
  }
  let claimed = 0
  await models.$transaction(async (txh) => {
    claimed = await txh.$executeRaw`
      UPDATE "ObservedTip"
      SET state = 'EXCLUDED', "exclusionReason" = ${reason}::"TipExclusionReason",
          confirmations = ${confirmations}, height = COALESCE("height", ${height}::INT)
      WHERE id = ${tip.id} AND state = 'DETECTED'`
    if (claimed > 0) {
      await reverseTip(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, txh)
      const subName = await resolveItemSubName(tip.postId, txh)
      const details = { lateRecheck: true }
      if (reason === 'SELF_SEND') details.note = 'amount recorded as lws reported it (change-output inflation possible)'
      if (reason === 'CHAIN_MISMATCH') {
        details.storedPiconeros = String(tip.piconeros)
        details.onChainPiconeros = tx?.piconeros == null ? null : String(tx.piconeros)
        details.storedTxHash = tip.txHash ?? null
        details.onChainTxHash = tx?.hash ?? null
      }
      await txh.abuseSignal.create({
        data: {
          kind: reason === 'CHAIN_MISMATCH' ? 'CHAIN_MISMATCH_EXCLUDED' : (direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED'),
          subjectUserId: tip.post.userId,
          actorUserId: tip.tipperId ?? null,
          tipId: tip.id,
          postId: tip.postId,
          subName,
          piconeros: tip.piconeros,
          txHash: tip.txHash || tx?.hash || 'unknown',
          paymentId: tip.paymentId,
          details
        }
      })
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  return claimed > 0
}
