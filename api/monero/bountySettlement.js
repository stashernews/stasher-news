// Bounty escrow settlement reader (rewards accounting repair §3.1). The
// signed sender-side transaction is the settlement authority: it carries the
// ACTUAL outgoing destinations (post subtractFeeFrom) and the real network
// fee. The dispatcher snapshots these facts on BountyPayment after relay, so a
// later environment change cannot reclassify where an old fee landed — the
// stored feeRecipientAddress is the attribution authority, never today's
// configured cold address.
//
// Pure (tx object in, facts out) so the signer can be tested without a wallet.
// Every function throws on any shape it cannot attribute EXACTLY against the
// frozen payout terms: callers must treat that as a CRITICAL accounting alert
// and keep the relayed payout SENT (never FAILED, never re-sent). Deferring an
// ambiguous settlement to read-only escrow-history recovery is always safer
// than guessing a fee-only or prize-only split.

// Read a signed tx's real network fee and actual outgoing destinations.
// `destinations[].amount` is the amount the destination ACTUALLY receives
// (wallet2 folds the network fee into subtractFeeFrom destinations).
export async function readTxSettlement (tx) {
  if (!tx || typeof tx.getFee !== 'function') throw new Error('escrow network fee unavailable')
  const rawFee = await tx.getFee()
  if (rawFee == null) throw new Error('escrow network fee unavailable')
  const networkFeePiconeros = BigInt(rawFee)
  if (networkFeePiconeros < 0n) throw new Error('negative escrow network fee')
  if (typeof tx.getOutgoingTransfer !== 'function') throw new Error('escrow outgoing settlement unavailable')
  const outgoing = tx.getOutgoingTransfer()
  if (!outgoing || typeof outgoing.getDestinations !== 'function') throw new Error('escrow outgoing settlement unavailable')
  const rawDestinations = outgoing.getDestinations()
  if (!Array.isArray(rawDestinations) || rawDestinations.length === 0) {
    throw new Error('escrow outgoing settlement unavailable')
  }
  const destinations = rawDestinations.map(d => {
    if (!d || typeof d.getAddress !== 'function' || typeof d.getAmount !== 'function') {
      throw new Error('escrow outgoing settlement unavailable')
    }
    return { address: d.getAddress(), amount: BigInt(d.getAmount()) }
  })
  return { networkFeePiconeros, destinations }
}

// Classify a relayed bounty payout tx against its frozen terms.
//   - AWARD/RECLAIM with a fee: one exact-prize destination for the frozen
//     recipient plus one destination for the frozen fee address carrying the
//     network-fee-subtracted remainder. A single coalesced output must NOT be
//     guessed into prize/fee parts -> ambiguous.
//   - ROLLOVER (feePiconeros frozen 0 on the payout) and fee-waived refunds:
//     one combined net output; recipientReceived is its whole amount and
//     feeReceived is 0n (receipt attribution splits a rollover from the
//     separately frozen booked prize).
export async function readBountySettlement (tx, { payout, feeRecipientAddress } = {}) {
  if (!payout) throw new Error('bounty payout unavailable for settlement')
  const { networkFeePiconeros, destinations } = await readTxSettlement(tx)
  const prize = BigInt(payout.piconeros)
  const requestedFee = payout.kind === 'ROLLOVER' ? 0n : BigInt(payout.feePiconeros ?? 0n)
  const consumedEscrowPiconeros = prize + requestedFee
  const sumPiconeros = destinations.reduce((acc, d) => acc + d.amount, 0n)

  if (requestedFee > 0n) {
    if (!feeRecipientAddress) throw new Error('escrow fee destination unavailable')
    const addresses = destinations.map(d => d.address)
    const attributable = destinations.length === 2 &&
      new Set(addresses).size === 2 &&
      addresses.includes(payout.recipientAddress) &&
      addresses.includes(feeRecipientAddress) &&
      payout.recipientAddress !== feeRecipientAddress
    if (!attributable) {
      throw new Error('ambiguous escrow settlement: prize and fee destinations cannot be attributed')
    }
    if (sumPiconeros + networkFeePiconeros !== consumedEscrowPiconeros) {
      throw new Error('escrow settlement mismatch: destinations do not sum to the consumed escrow total')
    }
    const prizeDestination = destinations.find(d => d.address === payout.recipientAddress)
    const feeDestination = destinations.find(d => d.address === feeRecipientAddress)
    if (prizeDestination.amount !== prize) {
      throw new Error('escrow settlement mismatch: prize amount changed')
    }
    return {
      networkFeePiconeros,
      recipientReceivedPiconeros: prizeDestination.amount,
      feeReceivedPiconeros: feeDestination.amount
    }
  }

  if (destinations.length !== 1 || destinations[0].address !== payout.recipientAddress) {
    throw new Error('ambiguous escrow settlement: expected a single net destination')
  }
  if (sumPiconeros + networkFeePiconeros !== consumedEscrowPiconeros) {
    throw new Error('escrow settlement mismatch: destinations do not sum to the consumed escrow total')
  }
  return {
    networkFeePiconeros,
    recipientReceivedPiconeros: destinations[0].amount,
    feeReceivedPiconeros: 0n
  }
}

// Classify a legacy deferred-fee settlement tx (feePendingAt retries created
// before 2026-09-18): no subtractFeeFrom, so the frozen fee destination
// receives the full amount and the network fee is a separate escrow cost.
export async function readFeeSettlement (tx, { feeRecipientAddress } = {}) {
  if (!feeRecipientAddress) throw new Error('escrow fee destination unavailable')
  const { networkFeePiconeros, destinations } = await readTxSettlement(tx)
  if (destinations.length !== 1 || destinations[0].address !== feeRecipientAddress) {
    throw new Error('ambiguous escrow settlement: expected the single fee destination')
  }
  return { networkFeePiconeros, feeReceivedPiconeros: destinations[0].amount }
}
