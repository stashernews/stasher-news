import { alert } from '@/lib/alert'

// Confirmed bounty-arrival receipts (rewards accounting repair §4).
//
// The rewards hot wallet books bounty revenue ONLY from a verified incoming
// output on the platform rewards wallet (the rewardsWalletObserver scan)
// matched against the frozen escrow settlement on BountyPayment (Task 3): the
// Exact settlement tx hash, the frozen destination, the receiving index that
// identifies it, and the captured net amount. A signed sender-side tx is not
// proof of receipt, so funding and relay write no cash row — these attributed
// arrivals are the only bounty revenue bookings.
//
// Exports:
//   - bountyReceiptSplit: the pure split rule.
//   - attributeBountyReceipt: attribute ONE scanned output (fresh dispatch).
//   - reconcileBountyReceipts: bounded recovery for known settlements that
//     still lack a wallet receipt. The observer's forward cursor alone misses
//     a receipt that was scanned before the sender's DB persist completed, so
//     recovery scans the full history, oldest-first (payout id), bounded, with
//     a process-local rotation cursor so unbookable candidates cannot starve
//     newer recoverable ones.
//   - __resetBountyRecoveryCursor: test-only rotation reset.
//
// Split rule (§4): a rollover uses ONE row for its real output — net total in
// `piconeros` with the exact rewards component in `rewardsPiconeros`. For net
// received N and frozen booked prize B: rewards = min(B, N), ops = N - rewards
// (the escrow miner fee consumes the fee/ops portion first). Award/reclaim and
// legacy separate fees are 100% ops. The existing confirmation threshold
// matures DETECTED -> CONFIRMED.
//
// Deferral posture: when the escrow settlement scan is missing/inconsistent,
// the observed receiving index does not identify the frozen destination, or
// the scanned amount does not equal the captured net, no row is written and
// the sight is alerted for the next scan — never substitute the requested
// gross amount, and never guess which address/subaddress received it. Internal
// fee-account consolidations and unknown primary-address receipts have no
// matching settlement hash and book nothing (reported only by the transparency
// surfaces, never auto-classified as bounty fees/donations).

// Split one verified arrival. `receivedPiconeros` is the actual net amount the
// hot wallet received; `bountyPiconeros` is the frozen booked prize. Exported
// for tests.
export function bountyReceiptSplit ({ kind, receivedPiconeros, bountyPiconeros }) {
  const received = BigInt(receivedPiconeros)
  if (received < 0n) throw new Error('negative bounty receipt')
  const reward = kind === 'ROLLOVER'
    ? (BigInt(bountyPiconeros) < received ? BigInt(bountyPiconeros) : received)
    : 0n
  return { piconeros: received, rewardsPiconeros: reward }
}

// Process-local rotation cursor for the bounded recovery pass (see
// reconcileBountyReceipts): a Map of account id -> last processed composite
// leg key `{ id, hash }`. Exported for test resets only.
const recoveryCursors = new Map()

export function __resetBountyRecoveryCursor () {
  recoveryCursors.clear()
}

// Resolve the settlement leg for one scanned output hash and classify it
// against the frozen terms:
//   { skip: true }             no hot receipt is expected (fee waived, or a
//                              captured zero/negative amount)
//   { defer: <reason> }        a hot receipt is expected but the settlement
//                              scan is missing/inconsistent — report, retry
//   { feeType, kind, net, bountyPiconeros, destination }  the verified leg
function settlementLeg (payout, hash) {
  const feeTxLeg = payout.feeTxHash != null && String(payout.feeTxHash).toLowerCase() === hash

  // Legacy separate fee tx (pre-2026-09-18 deferred fees): its own txHash, its
  // own frozen destination and captured amount — never inferred from the prize
  // tx or today's environment. Destination/index binding happens in the caller.
  if (feeTxLeg) {
    if (payout.feePiconeros <= 0n) return { skip: true }
    if (payout.feeRecipientAddress == null) return { defer: 'fee destination not frozen' }
    if (payout.feeReceivedPiconeros == null) return { defer: 'fee settlement amount not captured' }
    if (payout.feeReceivedPiconeros <= 0n) return { skip: true }
    return {
      feeType: 'BOUNTY_FEE',
      kind: 'BOUNTY_FEE',
      net: payout.feeReceivedPiconeros,
      bountyPiconeros: 0n,
      destination: payout.feeRecipientAddress
    }
  }

  // Rollover: one combined net output to the frozen rewards destination. The
  // split needs the frozen booked prize (Item.bountyPiconeros, snapshotted at
  // funding), NOT the payout's requested total (booked prize + frozen fee).
  if (payout.kind === 'ROLLOVER') {
    if (payout.recipientAddress == null) return { defer: 'rollover destination not frozen' }
    if (payout.recipientReceivedPiconeros == null) return { defer: 'rollover settlement amount not captured' }
    if (payout.recipientReceivedPiconeros <= 0n) return { skip: true }
    return {
      feeType: 'BOUNTY_ROLLOVER',
      kind: 'ROLLOVER',
      net: payout.recipientReceivedPiconeros,
      bountyPiconeros: payout.item?.bountyPiconeros ?? 0n,
      destination: payout.recipientAddress
    }
  }

  // AWARD/RECLAIM prize tx: the ops fee leg rides in the same tx as the prize,
  // landing at the frozen fee destination.
  if (payout.feePiconeros <= 0n) return { skip: true }
  if (payout.feeRecipientAddress == null) return { defer: 'fee destination not frozen' }
  if (payout.feeReceivedPiconeros == null) return { defer: 'fee settlement amount not captured' }
  if (payout.feeReceivedPiconeros <= 0n) return { skip: true }
  return {
    feeType: 'BOUNTY_FEE',
    kind: payout.kind,
    net: payout.feeReceivedPiconeros,
    bountyPiconeros: 0n,
    destination: payout.feeRecipientAddress
  }
}

// Resolve the receiving index that identifies the frozen settlement
// destination. The primary rewards address is (0, 0); any other frozen
// destination must resolve to one of the platform_rewards account's registered
// SubaddressIndex rows. Returns the expected { major, minor }, or { defer }
// with a reason when the destination does not identify a rewards-wallet
// address at all. The caller compares it with the observed output index.
async function bindReceiptIndex ({ models, account, destination }) {
  if (destination === account.address) return { major: 0, minor: 0 }
  if (account.id == null) return { defer: 'frozen destination cannot be resolved (rewards account id unavailable)' }
  const sub = await models.subaddressIndex.findFirst({
    where: { accountId: account.id, address: destination }
  })
  if (!sub) return { defer: 'frozen destination is not a rewards-wallet address' }
  return { major: sub.majorIndex, minor: sub.minorIndex }
}

// Attribute one scanned rewards-wallet output to its known bounty settlement.
// Returns the fresh FeeObservation id, or null when the output is not a
// verified bounty arrival (unknown hash, wrong receiving index, missing
// recipient metadata) or the settlement evidence defers.
export async function attributeBountyReceipt ({ models, account, tx } = {}) {
  if (!account || account.label !== 'platform_rewards' || !account.address) return null
  if (!tx || tx.hash == null) return null
  const major = tx.recipient?.maj_i
  const minor = tx.recipient?.min_i
  // Never fabricate a receiving index: without the lws-reported (major, minor)
  // the output cannot be placed on this wallet's ledger (a real primary-address
  // receipt carries 0/0 metadata; that is data, not a default).
  if (major == null || minor == null) return null
  if (tx.piconeros == null) return null
  const received = BigInt(tx.piconeros)
  if (received <= 0n) return null

  const hash = String(tx.hash).toLowerCase()
  const payout = await models.bountyPayment.findFirst({
    where: {
      OR: [
        { txHash: { equals: hash, mode: 'insensitive' } },
        { feeTxHash: { equals: hash, mode: 'insensitive' } }
      ]
    },
    include: { item: { select: { bountyPiconeros: true } } },
    orderBy: { id: 'asc' }
  })
  if (!payout) return null

  const leg = settlementLeg(payout, hash)
  if (leg.skip) return null
  if (leg.defer) {
    alert('warn', 'bounty receipt deferred: escrow settlement unavailable',
      `tx ${hash}: payout ${payout.id} (${payout.kind}) — ${leg.defer}; no receipt booked, retried on the next scan`,
      { dedupeKey: `bounty-receipt-deferred-${hash}` })
    return null
  }

  // The observed receiving index must identify the frozen destination: the
  // primary rewards address is (0, 0); any other destination must resolve to a
  // registered rewards subaddress. An equal-amount output on another
  // subaddress is NOT this settlement — defer, never book.
  const binding = await bindReceiptIndex({ models, account, destination: leg.destination })
  if (binding.defer) {
    alert('warn', 'bounty receipt deferred: escrow settlement unavailable',
      `tx ${hash}: payout ${payout.id} (${payout.kind}) — ${binding.defer}; no receipt booked, retried on the next scan`,
      { dedupeKey: `bounty-receipt-deferred-${hash}` })
    return null
  }
  if (binding.major !== major || binding.minor !== minor) {
    alert('warn', 'bounty receipt deferred: receiving index does not match the frozen destination',
      `tx ${hash}: payout ${payout.id} settled to ${leg.destination} (index ${binding.major}/${binding.minor}) but the output arrived on index ${major}/${minor}; no receipt booked`,
      { dedupeKey: `bounty-receipt-index-mismatch-${hash}` })
    return null
  }

  if (leg.net !== received) {
    alert('warn', 'bounty receipt deferred: amount mismatch',
      `tx ${hash}: the rewards wallet received ${received} piconeros but payout ${payout.id} settled ${leg.net} piconeros to the frozen destination; no receipt booked`,
      { dedupeKey: `bounty-receipt-mismatch-${hash}` })
    return null
  }

  const split = bountyReceiptSplit({ kind: leg.kind, receivedPiconeros: received, bountyPiconeros: leg.bountyPiconeros })
  const inserted = await models.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","state","walletReceipt","rewardsPiconeros","detectedAt")
    VALUES (${hash}, NULL, ${leg.feeType}::"FeeType", ${payout.itemId}, NULL, ${major}, ${minor}, ${received}, ${tx.height ?? null}, 'DETECTED'::"ObservedState", true, ${split.rewardsPiconeros}, NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING
    RETURNING id`
  if (inserted && inserted.length > 0) return inserted[0].id

  // Replay: the row already exists (re-poll, webhook race, or a legacy
  // relay-time rollover booking still awaiting the operator manifest). Backfill
  // a missing height only — never rewrite the amount (no inflation) and never
  // reset a CONFIRMED row.
  if (tx.height != null) {
    await models.$executeRaw`
      UPDATE "FeeObservation"
      SET height = ${tx.height}
      WHERE "txHash" = ${hash} AND "recipientMajor" = ${major} AND "recipientMinor" = ${minor}
        AND height IS NULL AND state = 'DETECTED'`
  }
  return null
}

// Bounded recovery for known settlements that still lack a wallet receipt.
// `transactions` is a full-history lws scan (the forward cursor cannot see a
// receipt that was already scanned before the sender's persist). Candidates
// are queried by ABSENCE of a matching wallet receipt — never by payout state
// alone — so CONFIRMED payouts and legacy separate feeTxHash receipts are
// recoverable. Ordered oldest-first (payout id) and capped at `limit` per call.
// Only settlement hashes present in the scan are considered: unknown
// primary-address revenue is never auto-classified. Returns the number of
// fresh receipts.
//
// FAIRNESS (rewards accounting repair review fix): a persistently unbookable
// oldest window (settlement metadata missing, amount mismatch, wrong index)
// must not monopolise every pass. A process-local rotation cursor (keyed by
// rewards account id) advances over the FULL ordered leg key — the composite
// (payout id, leg hash) — so a bounded window that splits two legs of one
// payout cannot permanently hide the leg on the far side of the boundary.
// Successive calls select strictly after the cursor on that composite axis and
// wrap to the oldest candidates at the end of the rotation: every candidate
// leg becomes reachable within one full cycle, and deferred rows are revisited
// on later cycles. Process-local: a worker restart resets the rotation to the
// oldest window — acceptable because unbookable rows already alert and nothing
// is lost, only the revisit order changes. No scheduler, no boss self-requeue.
export async function reconcileBountyReceipts ({ models, account, transactions, limit = 100 } = {}) {
  if (!account || account.label !== 'platform_rewards' || !account.address) return 0
  if (!Array.isArray(transactions)) return 0
  const txByHash = new Map()
  for (const tx of transactions) {
    if (!tx || typeof tx.hash !== 'string' || tx.hash === '') continue
    txByHash.set(tx.hash.toLowerCase(), tx)
  }
  const hashes = [...txByHash.keys()]
  if (hashes.length === 0) return 0
  const bound = Number.isInteger(limit) && limit > 0 ? limit : 100
  const hot = account.address
  const accountId = account.id

  // Candidate legs (payout tx leg + per-leg feeTxHash leg). Fee-waived payouts
  // and captured zero amounts are excluded, and destinations must be the
  // primary rewards address or one of its registered subaddresses, so a
  // permanently un-receiptable row cannot occupy the bounded window forever.
  // The rotation predicate uses the SAME composite key the rows are ordered by
  // (`id`, `hash`), so a window boundary between two legs of one payout never
  // hides the second leg.
  const fetchCandidates = (after) => models.$queryRaw`
    SELECT legs.id, legs.hash FROM (
      SELECT bp.id::int AS id, lower(bp."txHash") AS hash
      FROM "BountyPayment" bp
      WHERE bp."txHash" IS NOT NULL
        AND lower(bp."txHash") = ANY(${hashes}::text[])
        AND (
          (bp.kind = 'ROLLOVER'::"BountyPayoutKind"
            AND (bp."recipientAddress" = ${hot}
              OR EXISTS (SELECT 1 FROM "SubaddressIndex" si WHERE si."accountId" = ${accountId}::int AND si.address = bp."recipientAddress"))
            AND (bp."recipientReceivedPiconeros" IS NULL OR bp."recipientReceivedPiconeros" > 0))
          OR (bp.kind <> 'ROLLOVER'::"BountyPayoutKind"
            AND bp."feePiconeros" > 0
            AND (bp."feeRecipientAddress" IS NULL
              OR bp."feeRecipientAddress" = ${hot}
              OR EXISTS (SELECT 1 FROM "SubaddressIndex" si WHERE si."accountId" = ${accountId}::int AND si.address = bp."feeRecipientAddress"))
            AND (bp."feeReceivedPiconeros" IS NULL OR bp."feeReceivedPiconeros" > 0))
        )
        AND NOT EXISTS (
          SELECT 1 FROM "FeeObservation" fo
          WHERE fo."walletReceipt" = true AND lower(fo."txHash") = lower(bp."txHash")
        )
      UNION ALL
      SELECT bp.id::int AS id, lower(bp."feeTxHash") AS hash
      FROM "BountyPayment" bp
      WHERE bp."feeTxHash" IS NOT NULL
        AND lower(bp."feeTxHash") = ANY(${hashes}::text[])
        AND bp."feePiconeros" > 0
        AND (bp."feeRecipientAddress" IS NULL
          OR bp."feeRecipientAddress" = ${hot}
          OR EXISTS (SELECT 1 FROM "SubaddressIndex" si WHERE si."accountId" = ${accountId}::int AND si.address = bp."feeRecipientAddress"))
        AND (bp."feeReceivedPiconeros" IS NULL OR bp."feeReceivedPiconeros" > 0)
        AND NOT EXISTS (
          SELECT 1 FROM "FeeObservation" fo
          WHERE fo."walletReceipt" = true AND lower(fo."txHash") = lower(bp."feeTxHash")
        )
    ) legs
    WHERE legs.id > ${after?.id ?? 0}
      OR (legs.id = ${after?.id ?? 0} AND legs.hash > ${after?.hash ?? ''})
    ORDER BY legs.id ASC, legs.hash ASC
    LIMIT ${bound}`

  const cursorKey = account.id ?? 0
  let after = recoveryCursors.get(cursorKey) || null
  let legs = await fetchCandidates(after)
  if ((!legs || legs.length === 0) && after != null) {
    // End of the rotation: wrap to the oldest candidates so deferred rows are
    // revisited on later cycles.
    after = null
    legs = await fetchCandidates(null)
  }

  let attributed = 0
  for (const leg of legs || []) {
    // Advance the full composite key BEFORE attribution so one throwing leg
    // cannot pin every future pass to the same window.
    after = { id: Number(leg.id), hash: String(leg.hash) }
    recoveryCursors.set(cursorKey, after)
    const tx = txByHash.get(String(leg.hash).toLowerCase())
    if (!tx) continue
    if (await attributeBountyReceipt({ models, account, tx })) attributed += 1
  }
  return attributed
}
