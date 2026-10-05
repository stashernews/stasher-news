/* eslint-env jest */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { summarizeRewardsLedger, readRewardsWalletLedger } from '@/api/monero/rewardsLedger'

// The factual rewards-hot-wallet ledger (rewards accounting repair §5):
// ONE read-side union of proved facts — recorded payouts/sweeps, journal-proven
// relays and unique RELAYED network fees — de-duplicated so no amount is
// counted twice and no proven outflow is silently dropped. It is NOT a send
// eligibility engine. The mocked contracts run everywhere; the real-DB
// scoping/identity/union checks run only against the dedicated isolated
// database (same gate as test/api/monero/rewardsInflow.test.js).

const scope = { network: 'STAGENET', walletAddress: '5HOT' }
const DAY_MS = 24 * 60 * 60 * 1000
const H = hex => hex.repeat(32)

test('a shared-hash journal adds missing recipient principal, not duplicate fees', () => {
  const hash = 'e4'.repeat(32)
  const payouts = [
    { id: 1, state: 'SENT', txHash: hash, recipientAddress: '5A', piconeros: 60n },
    { id: 2, state: 'QUEUED', txHash: null, recipientAddress: '5B', piconeros: 15n }
  ]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    principalPiconeros: 75n,
    networkFeePiconeros: 3n,
    metadata: {
      payouts: [
        { payoutId: 1, recipientAddress: '5A', piconeros: '60' },
        { payoutId: 2, recipientAddress: '5B', piconeros: '15' }
      ]
    }
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  expect(ledger.payoutSentPiconeros).toBe(75n)
  expect(ledger.totalNetworkFeesPiconeros).toBe(3n)
  expect(ledger.outstandingRewardsPiconeros).toBe(0n)
})

test('two proven different hashes for one payout remain visible as a double-send', () => {
  const payout = { id: 1, state: 'SENT', txHash: 'e5'.repeat(32), recipientAddress: '5A', piconeros: 60n }
  const make = hash => ({
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    principalPiconeros: 60n,
    networkFeePiconeros: 3n,
    metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
  })
  const ledger = summarizeRewardsLedger({
    payouts: [payout],
    distributions: [],
    transactions: [make(payout.txHash), make('e6'.repeat(32))],
    scope
  })
  expect(ledger.payoutSentPiconeros).toBe(120n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a signed negative ops snapshot with no proven sweep is known debt, not uncertainty', () => {
  const distributions = [{ id: 5, opsSweptPiconeros: 0n, opsSweepTxHash: null, opsAvailablePiconeros: -3n }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions: [], scope })
  expect(ledger.accountingUncertain).toBe(false)
  expect(ledger.sweptByDistribution.get(5)).toBe(0n)
})

test('swept principal beyond a deficit snapshot is an excessive sweep and stays uncertain', () => {
  // A positive swept amount while the corrected snapshot is in deficit exceeds
  // every possible nonnegative obligation: explicit uncertainty, unlike the
  // zero-sweep known debt above.
  const recordedOnly = summarizeRewardsLedger({
    payouts: [],
    distributions: [{ id: 5, opsSweptPiconeros: 3n, opsSweepTxHash: null, opsAvailablePiconeros: -3n }],
    transactions: [],
    scope
  })
  expect(recordedOnly.accountingUncertain).toBe(true)

  const hash = H('aa')
  const journaled = summarizeRewardsLedger({
    payouts: [],
    distributions: [{ id: 5, opsSweptPiconeros: 5n, opsSweepTxHash: hash, opsAvailablePiconeros: -3n }],
    transactions: [{
      ...scope,
      txHash: hash,
      kind: 'OPS_SWEEP',
      state: 'RELAYED',
      distributionId: 5,
      principalPiconeros: 5n,
      networkFeePiconeros: 1n,
      metadata: { destination: '5COLD' }
    }],
    scope
  })
  expect(journaled.accountingUncertain).toBe(true)
})

test('an unreadable ops available value still flags uncertainty', () => {
  const distributions = [{ id: 5, opsSweptPiconeros: 0n, opsSweepTxHash: null, opsAvailablePiconeros: Number.MAX_SAFE_INTEGER + 1 }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions: [], scope })
  expect(ledger.accountingUncertain).toBe(true)
})

test('recorded sweeps and their journal facts are de-duplicated by exact hash', () => {
  const hash = H('a1')
  const distributions = [{ id: 5, opsSweptPiconeros: 10n, opsSweepTxHash: hash }]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 10n,
    networkFeePiconeros: 2n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweepSentPiconeros).toBe(10n)
  expect(ledger.sweptByDistribution.get(5)).toBe(10n)
  expect(ledger.totalNetworkFeesPiconeros).toBe(2n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('an unrepresented journal-proven sweep adds principal to the recorded total', () => {
  const distributions = [{ id: 5, opsSweptPiconeros: 10n, opsSweepTxHash: H('a1') }]
  const transactions = [{
    ...scope,
    txHash: H('a2'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 4n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweepSentPiconeros).toBe(14n)
  expect(ledger.sweptByDistribution.get(5)).toBe(14n)
  expect(ledger.totalNetworkFeesPiconeros).toBe(1n)
})

test('a represented sweep hash with a zero recorded total is a conflict; the journal fact protects the carry', () => {
  const hash = H('a3')
  const distributions = [{ id: 5, opsSweptPiconeros: 0n, opsSweepTxHash: hash, opsAvailablePiconeros: 20n }]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 10n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweptByDistribution.get(5)).toBe(10n)
  expect(ledger.sweepSentPiconeros).toBe(10n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a single-hash recorded sweep whose amount contradicts the journal flags uncertainty', () => {
  const hash = H('a4')
  const distributions = [{ id: 5, opsSweptPiconeros: 9n, opsSweepTxHash: hash, opsAvailablePiconeros: 20n }]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 10n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweptByDistribution.get(5)).toBe(10n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a proven sweep with no attributable distribution is an outflow and uncertainty', () => {
  const transactions = [{
    ...scope,
    txHash: H('a5'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: null,
    principalPiconeros: 6n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.sweepSentPiconeros).toBe(6n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a consolidation contributes its fee only', () => {
  const transactions = [{
    ...scope,
    txHash: H('b1'),
    kind: 'CONSOLIDATION',
    state: 'RELAYED',
    principalPiconeros: 0n,
    networkFeePiconeros: 5n,
    metadata: { destination: scope.walletAddress, selfTransfer: true }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(5n)
  expect(ledger.payoutSentPiconeros).toBe(0n)
  expect(ledger.sweepSentPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('a nonzero consolidation principal is uncertainty, still fee-only', () => {
  const transactions = [{
    ...scope,
    txHash: H('b2'),
    kind: 'CONSOLIDATION',
    state: 'RELAYED',
    principalPiconeros: 7n,
    networkFeePiconeros: 5n,
    metadata: { destination: scope.walletAddress, selfTransfer: true }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(5n)
  expect(ledger.payoutSentPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('an attempted PREPARED row is uncertainty, never proved principal or cost', () => {
  const transactions = [{
    ...scope,
    txHash: H('c1'),
    kind: 'PAYOUT',
    state: 'PREPARED',
    relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
    principalPiconeros: 60n,
    networkFeePiconeros: 3n,
    metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(0n)
  expect(ledger.payoutSentPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a never-attempted PREPARED row is inert: no expense and no uncertainty', () => {
  const transactions = [{
    ...scope,
    txHash: H('c2'),
    kind: 'PAYOUT',
    state: 'PREPARED',
    relayAttemptedAt: null,
    principalPiconeros: 60n,
    networkFeePiconeros: 3n,
    metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(0n)
  expect(ledger.payoutSentPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('a NOT_RELAYED row contributes neither expense nor uncertainty', () => {
  const transactions = [{
    ...scope,
    txHash: H('c3'),
    kind: 'PAYOUT',
    state: 'NOT_RELAYED',
    relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
    principalPiconeros: 60n,
    networkFeePiconeros: 3n,
    metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('queued and unreconciled FAILED payouts remain outstanding commitments', () => {
  const payouts = [
    { id: 3, distributionId: 1, state: 'QUEUED', txHash: null, recipientAddress: '5C', piconeros: 5n },
    { id: 4, distributionId: 1, state: 'FAILED', txHash: null, recipientAddress: '5D', piconeros: 9n },
    // FAILED WITH a hash is still unreconciled until a journal fact proves the relay.
    { id: 5, distributionId: 1, state: 'FAILED', txHash: H('d1'), recipientAddress: '5E', piconeros: 4n }
  ]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions: [], scope })
  expect(ledger.outstandingRewardsPiconeros).toBe(18n)
  expect(ledger.payoutSentPiconeros).toBe(0n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('only a validated journal relay releases an outstanding payout', () => {
  const payouts = [
    { id: 6, distributionId: 1, state: 'FAILED', txHash: null, recipientAddress: '5F', piconeros: 9n }
  ]
  const transactions = [{
    ...scope,
    txHash: H('d2'),
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 6, recipientAddress: '5F', piconeros: '9' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  expect(ledger.outstandingRewardsPiconeros).toBe(0n)
  expect(ledger.payoutSentPiconeros).toBe(9n)
  expect(ledger.accountingUncertain).toBe(false)
})

test('a relay whose recipient disagrees is proven outflow plus retained commitment and uncertainty', () => {
  const payouts = [
    { id: 7, distributionId: 1, state: 'QUEUED', txHash: null, recipientAddress: '5G', piconeros: 9n }
  ]
  const transactions = [{
    ...scope,
    txHash: H('d3'),
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 7, recipientAddress: '5WRONG', piconeros: '9' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  expect(ledger.payoutSentPiconeros).toBe(9n)
  expect(ledger.outstandingRewardsPiconeros).toBe(9n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a conflicting amount for the same (hash, payout) counts the on-chain fact once and flags it', () => {
  const hash = H('d4')
  const payouts = [
    { id: 8, distributionId: 1, state: 'SENT', txHash: hash, recipientAddress: '5I', piconeros: 60n }
  ]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 70n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 8, recipientAddress: '5I', piconeros: '70' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  // The larger of the two facts, counted exactly once.
  expect(ledger.payoutSentPiconeros).toBe(70n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a RELAYED row with corrupt metadata still counts its fee and principal once', () => {
  const transactions = [{
    ...scope,
    txHash: H('d5'),
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 20n,
    networkFeePiconeros: 2n,
    metadata: null
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope })
  expect(ledger.totalNetworkFeesPiconeros).toBe(2n)
  expect(ledger.payoutSentPiconeros).toBe(20n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a transaction-total conflict never releases the queued commitment', () => {
  const hash = H('e1')
  const payouts = [
    { id: 9, distributionId: 1, state: 'QUEUED', txHash: null, recipientAddress: '5A', piconeros: 9n }
  ]
  // The member claims 9 but the journal's own principal is only 5, so the row
  // is transaction-level invalid and can prove nothing.
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 5n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 9, recipientAddress: '5A', piconeros: '9' }] }
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  expect(ledger.payoutSentPiconeros).toBe(5n) // the proven outflow is never omitted
  expect(ledger.outstandingRewardsPiconeros).toBe(9n) // commitment retained
  expect(ledger.totalNetworkFeesPiconeros).toBe(1n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('two proven hashes for one queued payout retain the commitment and flag uncertainty', () => {
  const payout = { id: 4, distributionId: 1, state: 'QUEUED', txHash: null, recipientAddress: '5C', piconeros: 9n }
  const make = hash => ({
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 4, recipientAddress: '5C', piconeros: '9' }] }
  })
  const ledger = summarizeRewardsLedger({
    payouts: [payout],
    distributions: [],
    transactions: [make(H('e2')), make(H('e3'))],
    scope
  })
  expect(ledger.payoutSentPiconeros).toBe(18n) // both relays are real outflows
  expect(ledger.outstandingRewardsPiconeros).toBe(9n) // conflicting proofs release nothing
  expect(ledger.totalNetworkFeesPiconeros).toBe(2n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a second hash naming a payout through an unreadable member retains the commitment', () => {
  const payout = { id: 11, distributionId: 1, state: 'QUEUED', txHash: null, recipientAddress: '5K', piconeros: 9n }
  const valid = {
    ...scope,
    txHash: H('f1'),
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 11, recipientAddress: '5K', piconeros: '9' }] }
  }
  // The second relay names the same payout but its amount is unreadable: the
  // member must still register the payout as conflicted, never be discarded.
  const unreadable = {
    ...scope,
    txHash: H('f2'),
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 1n,
    metadata: { payouts: [{ payoutId: 11, recipientAddress: '5K' }] }
  }
  for (const transactions of [[valid, unreadable], [unreadable, valid]]) {
    const ledger = summarizeRewardsLedger({ payouts: [payout], distributions: [], transactions, scope })
    expect(ledger.payoutSentPiconeros).toBe(18n) // both proven relays are outflows
    expect(ledger.outstandingRewardsPiconeros).toBe(9n) // the conflicted commitment remains
    expect(ledger.totalNetworkFeesPiconeros).toBe(2n)
    expect(ledger.accountingUncertain).toBe(true)
  }
})

test('a corrupt same-hash journal never counts a recorded send twice', () => {
  const hash = H('e4')
  const payouts = [
    { id: 5, distributionId: 1, state: 'SENT', txHash: hash, recipientAddress: '5D', piconeros: 9n }
  ]
  const transactions = [{
    ...scope,
    txHash: hash,
    kind: 'PAYOUT',
    state: 'RELAYED',
    distributionId: 1,
    principalPiconeros: 9n,
    networkFeePiconeros: 2n,
    metadata: null
  }]
  const ledger = summarizeRewardsLedger({ payouts, distributions: [], transactions, scope })
  expect(ledger.payoutSentPiconeros).toBe(9n) // the recorded send, never 18
  expect(ledger.totalNetworkFeesPiconeros).toBe(2n) // one fee for one proven hash
  expect(ledger.accountingUncertain).toBe(true)
})

test('represented sweep facts are reconciled against the recorded snapshot, not a running total', () => {
  const distributions = [{
    id: 5,
    opsSweptPiconeros: 10n,
    opsSweepTxHash: `${H('b1')},${H('b2')}`,
    opsAvailablePiconeros: 20n
  }]
  const transactions = [
    {
      ...scope,
      txHash: H('b1'),
      kind: 'OPS_SWEEP',
      state: 'RELAYED',
      distributionId: 5,
      principalPiconeros: 6n,
      networkFeePiconeros: 1n,
      metadata: { destination: '5COLD' }
    },
    {
      ...scope,
      txHash: H('b2'),
      kind: 'OPS_SWEEP',
      state: 'RELAYED',
      distributionId: 5,
      principalPiconeros: 7n,
      networkFeePiconeros: 1n,
      metadata: { destination: '5COLD' }
    }
  ]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweptByDistribution.get(5)).toBe(13n) // the larger proven fact, not a running 10
  expect(ledger.sweepSentPiconeros).toBe(13n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('sweep totals and the fingerprint are independent of journal row order', () => {
  // Zero recorded total with one represented hash: the old single-pass code
  // compared a represented row against the already-mutated total, so reversing
  // the two rows produced 8 vs 5. The phased union must be order-independent.
  const distributions = [{
    id: 5,
    opsSweptPiconeros: 0n,
    opsSweepTxHash: H('b3'),
    opsAvailablePiconeros: 30n
  }]
  const represented = {
    ...scope,
    txHash: H('b3'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 5n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }
  const extra = {
    ...scope,
    txHash: H('b4'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 3n,
    networkFeePiconeros: 2n,
    metadata: { destination: '5COLD' }
  }
  const a = summarizeRewardsLedger({ payouts: [], distributions, transactions: [extra, represented], scope })
  const b = summarizeRewardsLedger({ payouts: [], distributions, transactions: [represented, extra], scope })
  expect(a.sweptByDistribution.get(5)).toBe(8n)
  expect(a.sweptByDistribution.get(5)).toBe(b.sweptByDistribution.get(5))
  expect(a.sweepSentPiconeros).toBe(b.sweepSentPiconeros)
  expect(a.accountingUncertain).toBe(b.accountingUncertain)
  expect(a.fingerprint).toBe(b.fingerprint)
})

test('a journal sweep declaring another distribution\'s hash is a contradiction counted once', () => {
  const distributions = [
    { id: 7, opsSweptPiconeros: 10n, opsSweepTxHash: H('b5'), opsAvailablePiconeros: 20n },
    { id: 5, opsSweptPiconeros: 0n, opsSweepTxHash: null }
  ]
  const transactions = [{
    ...scope,
    txHash: H('b5'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 10n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }]
  const ledger = summarizeRewardsLedger({ payouts: [], distributions, transactions, scope })
  expect(ledger.sweptByDistribution.get(7)).toBe(10n) // the recorded hash owner wins
  expect(ledger.sweptByDistribution.get(5)).toBe(0n)
  expect(ledger.sweepSentPiconeros).toBe(10n) // never counted under both distributions
  expect(ledger.accountingUncertain).toBe(true)
})

test('duplicate recorded sweep-hash ownership is a conflict and stays order-independent', () => {
  // Two distributions record 5n and 10n under the SAME hash, and the journal
  // proves 20n for it. No distribution may be silently preferred and the
  // larger proven outflow may never be dropped: the per-hash floor is 20n in
  // both orders, with uncertainty and an identical fingerprint.
  const a = { id: 5, opsSweptPiconeros: 5n, opsSweepTxHash: H('c1'), opsAvailablePiconeros: 30n }
  const b = { id: 9, opsSweptPiconeros: 10n, opsSweepTxHash: H('c1'), opsAvailablePiconeros: 30n }
  const journal = {
    ...scope,
    txHash: H('c1'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 9,
    principalPiconeros: 20n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }
  const forward = summarizeRewardsLedger({ payouts: [], distributions: [a, b], transactions: [journal], scope })
  const reversed = summarizeRewardsLedger({ payouts: [], distributions: [b, a], transactions: [journal], scope })
  expect(forward.sweepSentPiconeros).toBe(20n) // max(5+10 recorded, 20 journal), counted once
  // Conservative per-distribution floors (not summed): each owner is floored at
  // the hash's proven principal.
  expect(forward.sweptByDistribution.get(5)).toBe(20n)
  expect(forward.sweptByDistribution.get(9)).toBe(20n)
  expect(forward.accountingUncertain).toBe(true)
  expect(reversed.sweepSentPiconeros).toBe(forward.sweepSentPiconeros)
  expect(reversed.sweptByDistribution.get(5)).toBe(forward.sweptByDistribution.get(5))
  expect(reversed.sweptByDistribution.get(9)).toBe(forward.sweptByDistribution.get(9))
  expect(reversed.accountingUncertain).toBe(forward.accountingUncertain)
  expect(reversed.fingerprint).toBe(forward.fingerprint)
})

test('duplicate recorded claims under one hash collapse to the proven journal principal', () => {
  // The conservative floor is the minimum total consistent with ALL evidence:
  // x ≥ 5, x ≥ 10 (the recorded claims) and x ≥ 10 (the journal) bound the
  // single hash at 10n. The overlapping recorded 5n+10n is not an extra
  // proven outflow, so 15n would overstate what the hash provably moved.
  const a = { id: 5, opsSweptPiconeros: 5n, opsSweepTxHash: H('c2'), opsAvailablePiconeros: 30n }
  const b = { id: 9, opsSweptPiconeros: 10n, opsSweepTxHash: H('c2'), opsAvailablePiconeros: 30n }
  const journal = {
    ...scope,
    txHash: H('c2'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 9,
    principalPiconeros: 10n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [a, b], transactions: [journal], scope })
  expect(ledger.sweepSentPiconeros).toBe(10n) // min consistent with every bound, never the overlapping 15
  expect(ledger.accountingUncertain).toBe(true)
})

test('a conservative floor never lets a shared-hash mask hide distinct proven journal principal', () => {
  // A records 100n under {H}; B records 5n under {H,K}; the journal proves
  // H=1n and K=20n. The minimum consistent with every bound is x_H ≥ 100 and
  // x_K ≥ 20 → 120n. A component-wide max(recorded, journal) (105n here)
  // understates the proven outflow on the distinct hash K.
  const a = { id: 5, opsSweptPiconeros: 100n, opsSweepTxHash: H('e1'), opsAvailablePiconeros: 300n }
  const b = { id: 9, opsSweptPiconeros: 5n, opsSweepTxHash: `${H('e1')},${H('e2')}`, opsAvailablePiconeros: 300n }
  const journalH = {
    ...scope,
    txHash: H('e1'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 5,
    principalPiconeros: 1n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }
  const journalK = {
    ...scope,
    txHash: H('e2'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: 9,
    principalPiconeros: 20n,
    networkFeePiconeros: 1n,
    metadata: { destination: '5COLD' }
  }
  const results = []
  for (const distributions of [[a, b], [b, a]]) {
    for (const transactions of [[journalH, journalK], [journalK, journalH]]) {
      results.push(summarizeRewardsLedger({ payouts: [], distributions, transactions, scope }))
    }
  }
  for (const ledger of results) {
    expect(ledger.sweepSentPiconeros).toBe(120n)
    expect(ledger.accountingUncertain).toBe(true)
  }
  expect(results.map(r => r.fingerprint).every(fp => fp === results[0].fingerprint)).toBe(true)
})

test('a shared hash serves both recorded totals instead of summing them', () => {
  // A records 100n under {H,K} and B records 100n under {K}; nothing is
  // journaled. x_K ≥ 100 alone satisfies every bound, so the conservative
  // floor is 100n — the shared K is never double counted into 200n.
  const a = { id: 5, opsSweptPiconeros: 100n, opsSweepTxHash: `${H('f1')},${H('f2')}`, opsAvailablePiconeros: 300n }
  const b = { id: 9, opsSweptPiconeros: 100n, opsSweepTxHash: H('f2'), opsAvailablePiconeros: 300n }
  const forward = summarizeRewardsLedger({ payouts: [], distributions: [a, b], transactions: [], scope })
  const reversed = summarizeRewardsLedger({ payouts: [], distributions: [b, a], transactions: [], scope })
  expect(forward.sweepSentPiconeros).toBe(100n)
  expect(forward.accountingUncertain).toBe(true)
  expect(reversed.sweepSentPiconeros).toBe(forward.sweepSentPiconeros)
  expect(reversed.accountingUncertain).toBe(forward.accountingUncertain)
  expect(reversed.fingerprint).toBe(forward.fingerprint)
})

test('three pairwise-overlapping recorded totals meet at the exact dual optimum, not the disjoint cover', () => {
  // A=100{H,K}, B=100{K,L}, C=100{H,L}: adding the constraints gives
  // 2(x_H+x_K+x_L) ≥ 300, attained at 50n per hash, so the exact minimum is
  // 150n. The incidence matrix is not totally unimodular (determinant 2) and
  // the dual optimum is fractional (y = ½ each), so a pairwise hash-disjoint
  // cover (100n) undercounts a proven outflow. Uncertainty does not repair
  // the undercount; the floor must be exact.
  const a = { id: 5, opsSweptPiconeros: 100n, opsSweepTxHash: `${H('a6')},${H('a7')}`, opsAvailablePiconeros: 300n }
  const b = { id: 6, opsSweptPiconeros: 100n, opsSweepTxHash: `${H('a7')},${H('a8')}`, opsAvailablePiconeros: 300n }
  const c = { id: 7, opsSweptPiconeros: 100n, opsSweepTxHash: `${H('a6')},${H('a8')}`, opsAvailablePiconeros: 300n }
  const forward = summarizeRewardsLedger({ payouts: [], distributions: [a, b, c], transactions: [], scope })
  const reversed = summarizeRewardsLedger({ payouts: [], distributions: [c, b, a], transactions: [], scope })
  expect(forward.sweepSentPiconeros).toBe(150n)
  expect(forward.accountingUncertain).toBe(true)
  expect(reversed.sweepSentPiconeros).toBe(forward.sweepSentPiconeros)
  expect(reversed.accountingUncertain).toBe(forward.accountingUncertain)
  expect(reversed.fingerprint).toBe(forward.fingerprint)
})

test('a fractional exact optimum is reported as its ceiling and flagged uncertain', () => {
  // 1n recorded under {H,K}, {K,L} and {H,L}: the exact minimum is 1.5n
  // (x = 0.5n per hash). No integral outflow smaller than 2n is consistent
  // with the evidence, so the conservative floor is ceil(1.5n) = 2n — never
  // a rounded 1n.
  const a = { id: 5, opsSweptPiconeros: 1n, opsSweepTxHash: `${H('a9')},${H('b6')}`, opsAvailablePiconeros: 10n }
  const b = { id: 6, opsSweptPiconeros: 1n, opsSweepTxHash: `${H('b6')},${H('b7')}`, opsAvailablePiconeros: 10n }
  const c = { id: 7, opsSweptPiconeros: 1n, opsSweepTxHash: `${H('a9')},${H('b7')}`, opsAvailablePiconeros: 10n }
  const ledger = summarizeRewardsLedger({ payouts: [], distributions: [a, b, c], transactions: [], scope })
  expect(ledger.sweepSentPiconeros).toBe(2n)
  expect(ledger.accountingUncertain).toBe(true)
})

test('a hash-less recorded sweep keeps its total as a separate proven outflow', () => {
  // A records 7n with no sweep hash list while B records 100n under {H,K}:
  // the hash-less claim cannot share a variable, so it is added directly and
  // the component floor is 107n — it must never vanish from the total.
  const a = { id: 5, opsSweptPiconeros: 7n, opsSweepTxHash: null, opsAvailablePiconeros: 300n }
  const b = { id: 6, opsSweptPiconeros: 100n, opsSweepTxHash: `${H('b8')},${H('b9')}`, opsAvailablePiconeros: 300n }
  const forward = summarizeRewardsLedger({ payouts: [], distributions: [a, b], transactions: [], scope })
  const reversed = summarizeRewardsLedger({ payouts: [], distributions: [b, a], transactions: [], scope })
  expect(forward.sweepSentPiconeros).toBe(107n)
  expect(forward.sweptByDistribution.get(5)).toBe(7n)
  expect(reversed.sweepSentPiconeros).toBe(forward.sweepSentPiconeros)
  expect(reversed.fingerprint).toBe(forward.fingerprint)
})

test('a journal row outside the configured wallet scope is refused, never aggregated', () => {
  const transactions = [{
    network: 'STAGENET',
    walletAddress: '5OTHER',
    txHash: H('d6'),
    kind: 'CONSOLIDATION',
    state: 'RELAYED',
    principalPiconeros: 0n,
    networkFeePiconeros: 5n,
    metadata: { destination: '5OTHER', selfTransfer: true }
  }]
  expect(() => summarizeRewardsLedger({ payouts: [], distributions: [], transactions, scope }))
    .toThrow(/scope/i)
})

test('the fingerprint is deterministic, safe-field-only, and changes with exact facts', () => {
  const hash = H('d7')
  const base = {
    payouts: [{ id: 1, distributionId: 1, state: 'SENT', txHash: hash, recipientAddress: '5A', piconeros: 60n }],
    distributions: [{ id: 1, opsAvailablePiconeros: 20n, opsSweptPiconeros: 10n, opsSweepTxHash: H('d8') }],
    transactions: [{
      ...scope,
      txHash: H('d9'),
      kind: 'PAYOUT',
      state: 'RELAYED',
      distributionId: 1,
      principalPiconeros: 60n,
      networkFeePiconeros: 3n,
      metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
    }],
    scope
  }
  const a = summarizeRewardsLedger(base)
  expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  // Unsafe/irrelevant extra fields (keys, blobs) are not part of the fingerprint.
  const b = summarizeRewardsLedger({
    ...base,
    transactions: base.transactions.map(t => ({ ...t, privateSpendKey: 'secret', signedTxBlob: 'blob' }))
  })
  expect(b.fingerprint).toBe(a.fingerprint)
  const c = summarizeRewardsLedger({ ...base, payouts: [{ ...base.payouts[0], piconeros: 61n }] })
  expect(c.fingerprint).not.toBe(a.fingerprint)
})

// =============================================================================
// readRewardsWalletLedger (mocked contracts): scoping, identity and the audit
// drift carry-forward. The real-DB union lives in the isolated block below.
// =============================================================================

function makeLedgerModels ({
  account = { address: scope.walletAddress, network: scope.network },
  payouts = [],
  distributions = [],
  transactions = [],
  audits = []
} = {}) {
  const models = {
    moneroAccount: { findFirst: jest.fn(async () => account) },
    rewardPayout: { findMany: jest.fn(async () => payouts) },
    rewardDistribution: { findMany: jest.fn(async () => distributions) },
    rewardsWalletTransaction: { findMany: jest.fn(async () => transactions) },
    rewardsWalletReconciliation: { findMany: jest.fn(async () => audits) }
  }
  return models
}

describe('readRewardsWalletLedger', () => {
  test('scopes the journal by wallet/network and selects only explicit ledger fields', async () => {
    const models = makeLedgerModels()
    await readRewardsWalletLedger(models, { scope })
    expect(models.rewardsWalletTransaction.findMany).toHaveBeenCalledWith({
      where: { network: scope.network, walletAddress: scope.walletAddress },
      select: expect.objectContaining({
        network: true,
        walletAddress: true,
        txHash: true,
        kind: true,
        state: true,
        distributionId: true,
        principalPiconeros: true,
        networkFeePiconeros: true,
        metadata: true
      })
    })
    const select = models.rewardsWalletTransaction.findMany.mock.calls[0][0].select
    expect(Object.values(select)).not.toContain('viewKey')
    expect(Object.values(select)).not.toContain('privateViewKey')
    expect(models.moneroAccount.findFirst).toHaveBeenCalledWith({
      where: { label: 'platform_rewards' },
      select: { address: true, network: true }
    })
  })

  test('refuses a configured identity that does not match the registered platform wallet', async () => {
    const models = makeLedgerModels({ account: { address: '5DIFFERENT', network: scope.network } })
    await expect(readRewardsWalletLedger(models, { scope })).rejects.toThrow(/identity|match/i)
  })

  test('refuses a registered platform wallet on another network (unscoped ledger belongs to it)', async () => {
    const byNetwork = makeLedgerModels({ account: { address: scope.walletAddress, network: 'MAINNET' } })
    await expect(readRewardsWalletLedger(byNetwork, { scope })).rejects.toThrow(/identity|match/i)
  })

  test('a stored positive drift keeps warning until a CLEAN current-fingerprint check clears it', async () => {
    const payouts = [{ id: 1, distributionId: 1, state: 'SENT', txHash: H('f1'), recipientAddress: '5A', piconeros: 60n }]
    const distributions = []
    const transactions = []
    const current = summarizeRewardsLedger({ payouts, distributions, transactions, scope })
    const cleanReport = { manifest: { issues: [] } }
    const issueReport = { manifest: { issues: [{ code: 'UNKNOWN_INCOMING' }] } }

    const stalePositive = makeLedgerModels({
      payouts,
      audits: [{ positiveDriftPiconeros: 5n, ledgerFingerprint: H('f2') }]
    })
    const carried = await readRewardsWalletLedger(stalePositive, { scope })
    expect(carried.positiveDriftPiconeros).toBe(5n)
    expect(carried.accountingUncertain).toBe(false)

    const cleared = makeLedgerModels({
      payouts,
      audits: [
        { positiveDriftPiconeros: 0n, ledgerFingerprint: current.fingerprint, report: cleanReport },
        { positiveDriftPiconeros: 5n, ledgerFingerprint: H('f3') }
      ]
    })
    expect((await readRewardsWalletLedger(cleared, { scope })).positiveDriftPiconeros).toBe(0n)

    // A CHECK published while material issues remained is NOT clean: it cannot
    // clear a real, previous discrepancy even with a matching fingerprint.
    const issueBearing = makeLedgerModels({
      payouts,
      audits: [
        { positiveDriftPiconeros: 0n, ledgerFingerprint: current.fingerprint, report: issueReport },
        { positiveDriftPiconeros: 5n, ledgerFingerprint: H('f3') }
      ]
    })
    expect((await readRewardsWalletLedger(issueBearing, { scope })).positiveDriftPiconeros).toBe(5n)

    // A report whose shape cannot prove cleanliness is treated the same way,
    // and an issue-bearing check that itself reports positive drift keeps
    // warning too.
    const unknownShape = makeLedgerModels({
      payouts,
      audits: [
        { positiveDriftPiconeros: 0n, ledgerFingerprint: current.fingerprint },
        { positiveDriftPiconeros: 5n, ledgerFingerprint: H('f3') }
      ]
    })
    expect((await readRewardsWalletLedger(unknownShape, { scope })).positiveDriftPiconeros).toBe(5n)

    const issuePositive = makeLedgerModels({
      payouts,
      audits: [{ positiveDriftPiconeros: 7n, ledgerFingerprint: current.fingerprint, report: issueReport }]
    })
    expect((await readRewardsWalletLedger(issuePositive, { scope })).positiveDriftPiconeros).toBe(7n)

    const staleClean = makeLedgerModels({
      payouts,
      audits: [
        { positiveDriftPiconeros: 0n, ledgerFingerprint: H('f4'), report: cleanReport },
        { positiveDriftPiconeros: 5n, ledgerFingerprint: H('f5') }
      ]
    })
    expect((await readRewardsWalletLedger(staleClean, { scope })).positiveDriftPiconeros).toBe(5n)

    const none = makeLedgerModels({ payouts })
    expect((await readRewardsWalletLedger(none, { scope })).positiveDriftPiconeros).toBe(0n)
  })
})

// =============================================================================
// Real-DB checks (dedicated isolated database only): the union of recorded
// payouts/sweeps with journal-proven relays, exact-hash de-duplication, fee
// uniqueness, wallet scoping and the platform wallet identity refusal.
// Skipped (not thrown) anywhere else; the client is created in beforeAll,
// which does not run when skipped.
// =============================================================================

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const prisma = new PrismaClient()

;(ISOLATED_DB ? describe : describe.skip)('readRewardsWalletLedger (isolated DB only)', () => {
  const WALLET = '5' + '4242' + 'A'.repeat(90)
  const OTHER_WALLET = '5' + '4343' + 'A'.repeat(90)
  const ledgerScope = { network: 'STAGENET', walletAddress: WALLET }
  const created = { users: [], distributions: [], journalHashes: [], accounts: [] }

  const hash = () => randomUUID().replaceAll('-', '')

  beforeAll(async () => {
    await prisma.rewardsWalletTransaction.deleteMany({ where: { walletAddress: { in: [WALLET, OTHER_WALLET] } } })
  })

  afterEach(async () => {
    await prisma.rewardsWalletTransaction.deleteMany({ where: { walletAddress: { in: [WALLET, OTHER_WALLET] } } })
    for (const h of created.journalHashes) {
      await prisma.rewardsWalletTransaction.deleteMany({ where: { txHash: h } })
    }
    if (created.distributions.length) {
      await prisma.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
      await prisma.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    }
    if (created.accounts.length) await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    created.users.length = 0
    created.distributions.length = 0
    created.journalHashes.length = 0
    created.accounts.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function createUser () {
    const [user] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(user.id)
    return user.id
  }

  async function createDistribution ({ opsAvailablePiconeros = 20n, opsSweptPiconeros = 0n, opsSweepTxHash = null } = {}) {
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 2 * DAY_MS),
        periodEnd: new Date(Date.now() - DAY_MS),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE',
        opsAvailablePiconeros,
        opsSweptPiconeros,
        opsSweepTxHash
      }
    })
    created.distributions.push(dist.id)
    return dist
  }

  async function createPayout ({ distributionId, curatorId, state, txHash = null, piconeros, recipientAddress = '5A' }) {
    return prisma.rewardPayout.create({
      data: { distributionId, curatorId, state, txHash, piconeros, recipientAddress }
    })
  }

  async function createJournal ({
    txHash = hash(),
    walletAddress = WALLET,
    kind,
    state = 'RELAYED',
    distributionId = null,
    principalPiconeros = 0n,
    networkFeePiconeros = 0n,
    metadata,
    relayAttemptedAt = null
  }) {
    created.journalHashes.push(txHash)
    return prisma.rewardsWalletTransaction.create({
      data: {
        network: 'STAGENET',
        walletAddress,
        txHash,
        kind,
        accountIndex: 0,
        distributionId,
        principalPiconeros,
        networkFeePiconeros,
        metadata,
        state,
        relayAttemptedAt
      }
    })
  }

  test('unions recorded facts with journal-proven relays, de-duplicated and wallet-scoped', async () => {
    const curatorId = await createUser()
    const dist = await createDistribution({ opsSweptPiconeros: 10n, opsSweepTxHash: H('aa') })
    const sent = await createPayout({ distributionId: dist.id, curatorId, state: 'SENT', txHash: H('ab'), piconeros: 60n, recipientAddress: '5A' })
    const queued = await createPayout({ distributionId: dist.id, curatorId, state: 'QUEUED', txHash: null, piconeros: 15n, recipientAddress: '5B' })

    await createJournal({
      txHash: H('ab'),
      kind: 'PAYOUT',
      distributionId: dist.id,
      principalPiconeros: 60n,
      networkFeePiconeros: 3n,
      metadata: { payouts: [{ payoutId: sent.id, recipientAddress: '5A', piconeros: '60' }] }
    })
    await createJournal({
      txHash: H('ac'),
      kind: 'PAYOUT',
      distributionId: dist.id,
      principalPiconeros: 15n,
      networkFeePiconeros: 1n,
      metadata: { payouts: [{ payoutId: queued.id, recipientAddress: '5B', piconeros: '15' }] }
    })
    await createJournal({
      txHash: H('aa'),
      kind: 'OPS_SWEEP',
      distributionId: dist.id,
      principalPiconeros: 10n,
      networkFeePiconeros: 2n,
      metadata: { destination: '5COLD' }
    })
    await createJournal({
      txHash: H('ad'),
      kind: 'CONSOLIDATION',
      principalPiconeros: 0n,
      networkFeePiconeros: 4n,
      metadata: { destination: WALLET, selfTransfer: true }
    })
    // Another wallet's journal row must never enter this wallet's ledger.
    await createJournal({
      txHash: H('ae'),
      walletAddress: OTHER_WALLET,
      kind: 'CONSOLIDATION',
      principalPiconeros: 0n,
      networkFeePiconeros: 99n,
      metadata: { destination: OTHER_WALLET, selfTransfer: true }
    })

    const ledger = await readRewardsWalletLedger(prisma, { scope: ledgerScope })

    expect(ledger.payoutSentPiconeros).toBe(75n) // 60 recorded + 15 journal-proven
    expect(ledger.sweepSentPiconeros).toBe(10n) // recorded == journal hash, counted once
    expect(ledger.sweptByDistribution.get(dist.id)).toBe(10n)
    expect(ledger.totalNetworkFeesPiconeros).toBe(10n) // 3 + 1 + 2 + 4, never the other wallet's 99
    expect(ledger.totalSentPiconeros).toBe(85n)
    expect(ledger.outstandingRewardsPiconeros).toBe(0n)
    expect(ledger.accountingUncertain).toBe(false)
    expect(ledger.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses a configured identity that does not match the registered platform wallet', async () => {
    const account = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: OTHER_WALLET, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    await expect(readRewardsWalletLedger(prisma, { scope: ledgerScope })).rejects.toThrow(/identity|match/i)
  })

  test('refuses a registered platform wallet on another network', async () => {
    const account = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: WALLET, label: 'platform_rewards', network: 'MAINNET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    await expect(readRewardsWalletLedger(prisma, { scope: ledgerScope })).rejects.toThrow(/identity|match/i)
  })

  test('a matching registered platform wallet is accepted', async () => {
    const account = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: WALLET, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    const ledger = await readRewardsWalletLedger(prisma, { scope: ledgerScope })
    expect(ledger.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})
