import { Prisma } from '@prisma/client'

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
