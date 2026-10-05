/* eslint-env jest */

// Pure settlement reader for the bounty escrow signer (rewards accounting
// repair §3.1). The signed sender-side transaction is the settlement
// authority: it carries the ACTUAL destinations (post subtractFeeFrom) and
// the real network fee. These tests pin the classification rules:
//   - AWARD/RECLAIM: exact prize to the frozen recipient + net fee to the
//     frozen fee destination; a coalesced single output is ambiguous.
//   - ROLLOVER / fee-waived: one combined net output.
//   - Anything not exactly attributable throws (caller alerts; never guesses).
// The reader must return actual amounts, never recompute them from the
// requested totals.

import { readBountySettlement, readFeeSettlement, readTxSettlement } from '@/api/monero/bountySettlement'

const txWith = (fee, destinations) => ({
  getFee: () => fee,
  getOutgoingTransfer: () => ({
    getDestinations: () => destinations.map(d => ({
      getAddress: () => d.address,
      getAmount: () => d.amount
    }))
  })
})

const AWARD = { kind: 'AWARD', recipientAddress: '5WINNER', piconeros: 10n, feePiconeros: 4n }

test('preserves actual net cold fee and exact prize separately', async () => {
  const payout = { kind: 'AWARD', recipientAddress: '5WINNER', piconeros: 10n, feePiconeros: 4n }
  const tx = txWith(1n, [{ address: '5WINNER', amount: 10n }, { address: '5COLD', amount: 3n }])
  expect(await readBountySettlement(tx, { payout, feeRecipientAddress: '5COLD' })).toEqual({
    networkFeePiconeros: 1n, recipientReceivedPiconeros: 10n, feeReceivedPiconeros: 3n
  })
})

test('rejects ambiguous coalesced prize/fee address attribution', async () => {
  const payout = { kind: 'AWARD', recipientAddress: '5HOT', piconeros: 10n, feePiconeros: 4n }
  await expect(readBountySettlement(txWith(1n, [{ address: '5HOT', amount: 13n }]),
    { payout, feeRecipientAddress: '5HOT' })).rejects.toThrow(/ambiguous/i)
})

test('RECLAIM settles the refund exactly and the fee destination net of the network fee', async () => {
  const payout = { kind: 'RECLAIM', recipientAddress: '5AUTHOR', piconeros: 10n, feePiconeros: 4n }
  const tx = txWith(1n, [{ address: '5AUTHOR', amount: 10n }, { address: '5COLD', amount: 3n }])
  expect(await readBountySettlement(tx, { payout, feeRecipientAddress: '5COLD' })).toEqual({
    networkFeePiconeros: 1n, recipientReceivedPiconeros: 10n, feeReceivedPiconeros: 3n
  })
})

test('ROLLOVER books the whole net output as recipientReceived with a zero fee receipt', async () => {
  const payout = { kind: 'ROLLOVER', recipientAddress: '5HOT', piconeros: 14n, feePiconeros: 0n }
  const tx = txWith(1n, [{ address: '5HOT', amount: 13n }])
  // The award/reclaim coalescence rule is deliberately NOT applied: the single
  // combined output is the intended rollover shape.
  expect(await readBountySettlement(tx, { payout, feeRecipientAddress: '5HOT' })).toEqual({
    networkFeePiconeros: 1n, recipientReceivedPiconeros: 13n, feeReceivedPiconeros: 0n
  })
})

test('a fee-waived award settles a single net refund destination', async () => {
  const payout = { kind: 'AWARD', recipientAddress: '5WINNER', piconeros: 10n, feePiconeros: 0n }
  const tx = txWith(1n, [{ address: '5WINNER', amount: 9n }])
  expect(await readBountySettlement(tx, { payout, feeRecipientAddress: null })).toEqual({
    networkFeePiconeros: 1n, recipientReceivedPiconeros: 9n, feeReceivedPiconeros: 0n
  })
})

test('reads the stored destination, not a changed current cold address', async () => {
  const payout = { kind: 'AWARD', recipientAddress: '5WINNER', piconeros: 10n, feePiconeros: 4n }
  // The environment has moved on to 5NEW, but this settlement's fee landed at
  // the snapshotted 5OLD destination — the stored address is the authority.
  const previous = process.env.REWARDS_COLD_STORAGE_ADDRESS
  process.env.REWARDS_COLD_STORAGE_ADDRESS = '5NEW'
  try {
    const tx = txWith(1n, [{ address: '5WINNER', amount: 10n }, { address: '5OLD', amount: 3n }])
    expect(await readBountySettlement(tx, { payout, feeRecipientAddress: '5OLD' })).toEqual({
      networkFeePiconeros: 1n, recipientReceivedPiconeros: 10n, feeReceivedPiconeros: 3n
    })
  } finally {
    if (previous === undefined) delete process.env.REWARDS_COLD_STORAGE_ADDRESS
    else process.env.REWARDS_COLD_STORAGE_ADDRESS = previous
  }
})

test('rejects duplicate fee destinations as unattributable', async () => {
  const tx = txWith(1n, [
    { address: '5WINNER', amount: 10n },
    { address: '5COLD', amount: 2n },
    { address: '5COLD', amount: 1n }
  ])
  await expect(readBountySettlement(tx, { payout: AWARD, feeRecipientAddress: '5COLD' })).rejects.toThrow(/ambiguous/i)
})

test('rejects a degraded prize even when the fee destination absorbs the requested fee', async () => {
  // Sum + network fee still equals the consumed escrow total, but the winner
  // would receive 9 instead of the exact booked 10 — never accept that.
  const tx = txWith(1n, [{ address: '5WINNER', amount: 9n }, { address: '5COLD', amount: 4n }])
  await expect(readBountySettlement(tx, { payout: AWARD, feeRecipientAddress: '5COLD' })).rejects.toThrow(/prize/i)
})

test('rejects destinations that do not sum to the consumed escrow total', async () => {
  const tx = txWith(1n, [{ address: '5WINNER', amount: 10n }, { address: '5COLD', amount: 2n }])
  await expect(readBountySettlement(tx, { payout: AWARD, feeRecipientAddress: '5COLD' })).rejects.toThrow(/sum/i)
})

test('rejects a settlement to an unknown destination address', async () => {
  const tx = txWith(1n, [{ address: '5WINNER', amount: 10n }, { address: '5ELSEWHERE', amount: 3n }])
  await expect(readBountySettlement(tx, { payout: AWARD, feeRecipientAddress: '5COLD' })).rejects.toThrow(/ambiguous/i)
})

test('rejects a multi-destination rollover (the single combined output is the only legal shape)', async () => {
  const payout = { kind: 'ROLLOVER', recipientAddress: '5HOT', piconeros: 14n, feePiconeros: 0n }
  const tx = txWith(1n, [{ address: '5HOT', amount: 10n }, { address: '5HOT', amount: 3n }])
  await expect(readBountySettlement(tx, { payout, feeRecipientAddress: null })).rejects.toThrow(/ambiguous/i)
})

test.each([
  ['missing getFee', { getOutgoingTransfer: () => ({ getDestinations: () => [] }) }, /fee unavailable/i],
  ['null getFee', txWith(null, [{ address: '5WINNER', amount: 10n }]), /fee unavailable/i],
  ['negative fee', txWith(-1n, [{ address: '5WINNER', amount: 10n }]), /negative/i],
  ['missing outgoing transfer', { getFee: () => 1n }, /outgoing settlement unavailable/i],
  ['empty destination list', txWith(1n, []), /outgoing settlement unavailable/i]
])('rejects a tx with %s', async (_name, tx, pattern) => {
  await expect(readBountySettlement(tx, { payout: AWARD, feeRecipientAddress: '5COLD' })).rejects.toThrow(pattern)
})

test('readTxSettlement returns the raw actual fee and destinations', async () => {
  const tx = txWith(1n, [{ address: '5WINNER', amount: 10n }, { address: '5COLD', amount: 3n }])
  expect(await readTxSettlement(tx)).toEqual({
    networkFeePiconeros: 1n,
    destinations: [{ address: '5WINNER', amount: 10n }, { address: '5COLD', amount: 3n }]
  })
})

test('readFeeSettlement returns the actual fee received and the fee tx network cost', async () => {
  // Legacy deferred fee: no subtractFeeFrom, so the destination receives the
  // full frozen fee and the network fee is an additional escrow cost.
  const tx = txWith(1n, [{ address: '5COLD', amount: 4n }])
  expect(await readFeeSettlement(tx, { feeRecipientAddress: '5COLD' })).toEqual({
    networkFeePiconeros: 1n, feeReceivedPiconeros: 4n
  })
})

test('readFeeSettlement rejects a fee tx that does not pay the frozen destination', async () => {
  const tx = txWith(1n, [{ address: '5ELSEWHERE', amount: 4n }])
  await expect(readFeeSettlement(tx, { feeRecipientAddress: '5COLD' })).rejects.toThrow(/ambiguous/i)
})
