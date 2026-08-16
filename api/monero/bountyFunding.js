import { bountyFeePiconeros } from './bounties'
import { alert } from '@/lib/alert'

// Bounty funding CONFIRMED path (A-13). Shared by the lws webhook receiver
// (pages/api/monero/webhook.js) and the confirmFinalizer backstop
// (worker/confirmFinalizer.js) so a bounty funding cannot stay provisional when
// the webhook's N-conf callback is lost. Runs inside the caller's Serializable
// transaction so the three writes commit together:
//   1. ObservedBounty -> CONFIRMED (confirmedAt, height, confirmations)
//   2. Item -> FUNDED with bountyPiconeros = observed − fee (the payer may have
//      sent more or less than expected; the fee piconeros stay in escrow until
//      disposition, so the signer can always zero the escrow exactly) +
//      bountyConfirmedAt
//   3. FeeObservation('BOUNTY_FEE') born CONFIRMED at the funding height —
//      the fee is 100% ops and books into the rewards pool ledger at funding
//      time.
// The fee is computed via bountyFeePiconeros on the DECLARED bounty
// (item.bountyPiconeros, frozen by the edit gate from DETECTED onward), NOT on
// the observed amount: the funding quote quotes f(declared), so a payer who
// sends the quoted total books exactly the declared bounty. Fee-on-observed
// would recompute on declared + fee, so the 20% cap binds below the 0.01 floor
// and books a minimum bounty (0.01) at 0.0096 — below BOUNTY_MIN_PICONEROS.
// Dispositions settle the booked fee (FeeObservation), so payout total =
// escrow received and the escrow zeroes exactly for every funded bounty.
// Idempotent across concurrent callers: the ObservedBounty flip + Item update are
// deterministic by value, and the FeeObservation INSERT carries
// ON CONFLICT (txHash, recipientMajor, recipientMinor) DO NOTHING, so a retried
// webhook callback racing the finalizer backstop cannot double-book. Each caller
// also filters on state = 'DETECTED' before calling, and Serializable isolation
// serializes any same-row overlap (a loser aborts and retries on the next run).
// The funding only confirms once the CUMULATIVE received (sum of receipts)
// covers declared + fee; a short funding is held at DETECTED (top-up-able) and
// the 7-day abandonment sweep (worker/bounties.js) is the escape hatch for a
// funding that never crosses the quote.
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
// into ObservedBounty.piconeros as the CUMULATIVE received total. Backfills a
// non-null height. Returns the cumulative total.
export async function recordBountyReceipt (tx, bounty, { txHash, piconeros, height }) {
  if (!txHash) return bounty.piconeros
  await tx.$queryRaw`
    INSERT INTO "ObservedBountyReceipt" ("bountyId","txHash","piconeros","height","detectedAt")
    VALUES (${bounty.id}, ${txHash}, ${piconeros}, ${height ?? null}, NOW())
    ON CONFLICT ("bountyId","txHash") DO NOTHING`
  const agg = await tx.observedBountyReceipt.aggregate({
    _sum: { piconeros: true },
    where: { bountyId: bounty.id }
  })
  const cumulative = agg._sum.piconeros ?? 0n
  const data = { piconeros: cumulative }
  if (height != null) data.height = height
  await tx.observedBounty.update({ where: { id: bounty.id }, data })
  return cumulative
}

export async function driveBountyFunding (tx, bounty, { txHash, height, confirmations, piconeros }) {
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  const item = await tx.item.findUnique({
    where: { id: bounty.postId },
    select: { bountyPiconeros: true }
  })
  const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
  const expected = item.bountyPiconeros + feePiconeros
  if (piconeros < expected) {
    alert('warn', 'bounty underfunded at confirmation attempt',
      `bounty item ${bounty.postId}: received ${piconeros} of ${expected} piconeros; funding held at DETECTED awaiting top-up (7-day abandonment window applies)`,
      // day-bucketed so the 60s finalizer tick pages at most once per bounty
      // per day (lib/alert's own dedupe window is only 5 minutes)
      { dedupeKey: `bounty-underfunded-${bounty.postId}-${new Date().toISOString().slice(0, 10)}` })
    return false
  }
  const data = { state: 'CONFIRMED', confirmations, confirmedAt: new Date(), height }
  if (txHash) data.txHash = txHash
  await tx.observedBounty.update({ where: { id: bounty.id }, data })
  await tx.item.update({
    where: { id: bounty.postId },
    data: { bountyStatus: 'FUNDED', bountyPiconeros: piconeros - feePiconeros, bountyConfirmedAt: new Date() }
  })
  await tx.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","state","detectedAt","confirmedAt")
    VALUES (${txHash || bounty.txHash}, NULL, 'BOUNTY_FEE'::"FeeType", ${bounty.postId}, NULL, 0, 0, ${feePiconeros}, ${height}, 'CONFIRMED'::"ObservedState", NOW(), NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING`
  return true
}
