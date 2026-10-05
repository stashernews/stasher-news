import { bountyFeePiconeros } from './bounties'
import { alert } from '@/lib/alert'

// Bounty funding CONFIRMED path (A-13). Shared by the lws webhook receiver
// (pages/api/monero/webhook.js) and the confirmFinalizer backstop
// (worker/confirmFinalizer.js) so a bounty funding cannot stay provisional when
// the webhook's N-conf callback is lost. Runs inside the caller's Serializable
// transaction so the two writes commit together:
//   1. ObservedBounty -> CONFIRMED (confirmedAt, height, confirmations)
//   2. Item -> FUNDED with bountyPiconeros = observed − fee (the payer may have
//      sent more or less than expected; the fee piconeros stay in escrow until
//      disposition, so the signer can always zero the escrow exactly) +
//      bountyFeePiconeros = the FROZEN disposition fee term + bountyConfirmedAt
// The fee stays IN THE ESCROW (it arrived with the payer's tx), so funding books
// NO hot-wallet cash: no FeeObservation receipt is created here. The hot-wallet
// ledger must only ever book money that actually sits in the hot wallet; a
// funding-time BOUNTY_FEE receipt would fabricate rewards-wallet inflow while
// the coins are still at the escrow address.
// The fee is computed via bountyFeePiconeros on the DECLARED bounty
// (item.bountyPiconeros, frozen by the edit gate from DETECTED onward), NOT on
// the observed amount: the funding quote quotes f(declared), so a payer who
// sends the quoted total books exactly the declared bounty. Fee-on-observed
// would recompute on declared + fee, so the 20% cap binds below the 0.01 floor
// and books a minimum bounty (0.01) at 0.0096 — below BOUNTY_MIN_PICONEROS.
// Dispositions settle the frozen fee (Item.bountyFeePiconeros), so payout
// total = escrow received and the escrow zeroes exactly for every funded
// bounty.
// Idempotent across concurrent callers: the ObservedBounty flip and Item update
// are deterministic by value (racing callers freeze the same fee), and
// recordBountyReceipt's INSERT carries ON CONFLICT DO NOTHING — covering both
// the (bountyId, txHash) unique and the global txHash unique (one tx = one
// pid = one bounty, storage-layer backstop) — so a retried webhook callback
// racing the finalizer backstop cannot double-count a receipt. Each caller
// also filters on state = 'DETECTED' before calling, and Serializable isolation
// serializes any same-row overlap (a loser aborts and retries on the next run).
// The funding only confirms once the CUMULATIVE received (sum of height-verified
// receipts — a provisional daemon-level receipt is display-only) covers declared
// + fee; a short funding is held at DETECTED (top-up-able) and the 7-day
// abandonment sweep (worker/bounties.js) is the escape hatch for a funding that
// never crosses the quote.
//
// Expected funding total for a bounty: declared bounty + platform fee (both
// computed on the DECLARED amount — see driveBountyFunding for why).
export async function bountyExpectedPiconeros (tx, bounty) {
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  const item = await tx.item.findUnique({
    where: { id: bounty.postId },
    select: { bountyPiconeros: true }
  })
  return item.bountyPiconeros + bountyFeePiconeros(item.bountyPiconeros, config)
}

// Record one funding receipt (idempotent by (bountyId, txHash)) and fold it
// into ObservedBounty.piconeros as the CUMULATIVE displayed total. Two
// eligibility levels (0-conf hardening): the provisional INSERT writes height
// NULL — a daemon-verified 0-conf receipt whose amount is only a callback claim,
// so it is DISPLAY-ONLY; a chain-verified sight (the lws callback or the
// finalizer's lws reconcile) claims the block height through the atomic
// NULL->height CAS below. The CAS is the exactly-once transition signal: a
// replay of an already-height receipt matches zero rows, so no value effect can
// re-fire (RETURNING/xmax-style freshness inference cannot tell a backfill from
// a same-height replay). Returns { display, counted, transitioned } — every
// FUNDED/abandonment gate must sum `counted` (height-verified rows only).
export async function recordBountyReceipt (tx, bounty, { txHash, piconeros, height }) {
  if (!txHash) return { display: bounty.piconeros, counted: null, transitioned: false }
  await tx.$queryRaw`
    INSERT INTO "ObservedBountyReceipt" ("bountyId","txHash","piconeros","height","detectedAt")
    VALUES (${bounty.id}, ${txHash}, ${piconeros}, NULL, NOW())
    ON CONFLICT DO NOTHING`
  let transitioned = false
  if (height != null) {
    // Read the provisional amount so a divergence between the callback claim
    // and the chain-verified amount is surfaced. Only the CAS changes it, and
    // the CAS only matches height IS NULL — a racing claimer that beats us
    // turns our CAS into a 0-row no-op, never a second transition.
    const prior = await tx.$queryRaw`
      SELECT piconeros FROM "ObservedBountyReceipt"
      WHERE "bountyId" = ${bounty.id} AND "txHash" = ${txHash} AND height IS NULL
      LIMIT 1`
    const previousPiconeros = prior?.[0]?.piconeros ?? null
    const claimed = await tx.$queryRaw`
      UPDATE "ObservedBountyReceipt"
      SET height = ${height}, piconeros = ${piconeros}
      WHERE "bountyId" = ${bounty.id} AND "txHash" = ${txHash} AND height IS NULL
      RETURNING id`
    transitioned = claimed.length > 0
    if (transitioned && previousPiconeros != null && previousPiconeros !== piconeros) {
      alert('warn', 'bounty receipt amount corrected at height transition',
        `bounty ${bounty.id}: receipt ${txHash} verified at ${piconeros} piconeros vs provisional ${previousPiconeros} piconeros; counted amount corrected`,
        { dedupeKey: `bounty-receipt-corrected-${bounty.id}-${txHash}` })
    }
  }
  const displayAgg = await tx.observedBountyReceipt.aggregate({
    _sum: { piconeros: true },
    where: { bountyId: bounty.id }
  })
  const countedAgg = await tx.observedBountyReceipt.aggregate({
    _sum: { piconeros: true },
    where: { bountyId: bounty.id, height: { not: null } }
  })
  const display = displayAgg._sum.piconeros ?? 0n
  await tx.observedBounty.update({ where: { id: bounty.id }, data: { piconeros: display } })
  return { display, counted: countedAgg._sum.piconeros ?? 0n, transitioned }
}

// Flip a bounty funding to CONFIRMED / FUNDED once the COUNT-ELIGIBLE receipts
// (height written from a chain-verified source) cover the quoted total. The
// gate self-computes from the receipt rows — never a caller-supplied cumulative,
// which could have been seeded from a provisional (daemon-verified, amount-
// unverified) callback claim. Writes the bounty as counted − fee and FREEZES the
// fee term on the Item (bountyFeePiconeros) for dispositions to settle, so the
// escrow zeroes exactly. Funding books no hot-wallet cash: the coins are still
// in escrow, so no FeeObservation receipt is created here.
export async function driveBountyFunding (tx, bounty, { txHash, height, confirmations }) {
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  const item = await tx.item.findUnique({
    where: { id: bounty.postId },
    select: { bountyPiconeros: true }
  })
  const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
  const expected = item.bountyPiconeros + feePiconeros
  const agg = await tx.observedBountyReceipt.aggregate({
    _sum: { piconeros: true },
    where: { bountyId: bounty.id, height: { not: null } }
  })
  const counted = agg._sum.piconeros ?? 0n
  if (counted < expected) {
    alert('warn', 'bounty underfunded at confirmation attempt',
      `bounty item ${bounty.postId}: received ${counted} of ${expected} piconeros (count-eligible); funding held at DETECTED awaiting top-up (7-day abandonment window applies)`,
      // day-bucketed so the 60s finalizer tick pages at most once per bounty
      // per day (lib/alert's own dedupe window is only 5 minutes)
      { dedupeKey: `bounty-underfunded-${bounty.postId}-${new Date().toISOString().slice(0, 10)}` })
    return false
  }
  const data = { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
  if (height != null) data.height = height
  if (txHash) data.txHash = txHash
  await tx.observedBounty.update({ where: { id: bounty.id }, data })
  await tx.item.update({
    where: { id: bounty.postId },
    data: {
      bountyStatus: 'FUNDED',
      bountyPiconeros: counted - feePiconeros,
      bountyFeePiconeros: feePiconeros,
      bountyConfirmedAt: new Date()
    }
  })
  return true
}
