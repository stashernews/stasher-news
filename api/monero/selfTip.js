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
// unscannable). Also advances the cursor forward-only (best-effort; a lost
// advance only costs one fuller scan). Errors propagate to the caller.
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
  // forward-only cursor advance (never regresses on concurrent/lws re-sends)
  const maxId = (resp.transactions || []).reduce(
    (m, t) => (typeof t.id === 'number' && t.id > m ? t.id : m), Number(account.lastTxId ?? 0))
  if (maxId > Number(account.lastTxId ?? 0)) {
    await models.moneroAccount.updateMany({
      where: { id: account.id, OR: [{ lastTxId: null }, { lastTxId: { lt: BigInt(maxId) } }] },
      data: { lastTxId: BigInt(maxId) }
    }).catch(() => {}) // best-effort: a lost advance only costs one fuller scan
  }
  return tx
}

// Confirm-time self-send re-check (the 0-conf gap). At detection the tx is in
// the mempool and lws get_address_txs carries no spent_outputs for it, so
// isSelfSend fails open — the documented worst case. Once MINED the evidence
// exists, so this re-check runs at the last gate before CONFIRMED credit
// (the webhook N-conf callback and the confirmFinalizer maturity pass — the
// only two claimers of DETECTED -> CONFIRMED) and at the webhook's first
// callback that carries a block height. On a match it claims EXCLUDED from
// DETECTED (atomic conditional UPDATE, race-safe vs the CONFIRMED claim),
// reverses the detection-applied ranking delta via reverseTip (the same
// posture as the REORGED reversal in reverseStaleDetections), and writes the
// AbuseSignal — all in ONE Serializable transaction.
//
// Guards mirror the detection-time check: unscannable accounts (view key
// wiped / INACTIVE) fail open; the DIRECT_SELF_TIP case needs no scan.
// Streaks granted at DETECTED are an accepted residual (same as REORGED).
// Returns true when THIS caller claimed the exclusion; lws errors propagate
// (webhook: non-200 so lws retries; finalizer: skip the tip, retry next run).
export async function excludeDetectedTipIfSelfSend ({ models, monero, tip, confirmations = 0, height = null }) {
  const account = tip.recipientAccount
  if (!account?.viewKey || account.status !== 'ACTIVE') return false
  const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
  let tx = null
  if (!direct) {
    tx = await lookupTipTx(models, monero, account, tip.paymentId)
    if (!isSelfSend(account, tx)) return false
  }
  const reason = direct ? 'DIRECT_SELF_TIP' : 'SELF_SEND'
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
      if (!direct) details.note = 'amount recorded as lws reported it (change-output inflation possible)'
      await txh.abuseSignal.create({
        data: {
          kind: direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED',
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
