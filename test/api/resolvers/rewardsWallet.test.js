/* eslint-env jest */

// Unit tests for Query.rewardsWalletInfo / Query.rewardDistributions — the
// public transparency surface for the platform rewards wallet (spec §4.4,
// §6.4).
//
// Every monetary fact comes from the SHARED readers, read in one Serializable
// snapshot:
//   - api/monero/rewardsInflow.js — all-time CONFIRMED eligible receipts,
//   - api/monero/rewardsLedger.js — external principal (payouts + sweeps),
//     actual network fees and outstanding reward commitments,
//   - lib/rewardsPool.js          — the next pool and the signed pending ops.
// received = eligible receipts; sent = EXTERNAL PRINCIPAL ONLY (payouts +
// sweeps, never fees); balance = received - principal - network fees.
//
// The mocked models expose DB methods only: there is no wallet/lws handle and
// no observedDownvote/feeObservation aggregate fallback, so any accidental
// wallet open or independent sum fails the test. A static import check pins
// that neither the resolver nor lib/metrics.js imports a wallet/lws module.
//
// The published view key must be the address-embedded PUBLIC key, never the
// stored private one: the fixture row still carries an encrypted private view
// key (encryptViewKey under VIEWKEY_MASTER_KEY) so the assertions can prove it
// is not leaked.

import { readFileSync } from 'node:fs'
import resolvers from '@/api/resolvers/rewardsWallet'
import { encryptViewKey } from '@/api/monero/viewkey'
import { publicViewKeyFromAddress } from '@/api/monero/viewKeyCheck'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'
import { piconerosToXmr } from '@/lib/format'
import { collectDBBackedMetrics, register, __resetMetricsForTests } from '@/lib/metrics'

process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')
process.env.MONERO_NETWORK = 'stagenet'
const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
// getNextRewardsPool / readRewardsWalletLedger read through walletScope().
process.env.PLATFORM_REWARDS_ADDRESS = STAGENET_ADDR
const VIEW_KEY = '5580e0440c77c9b720950defd0bcfbd87b6a10f098ed345fac290c7f48b3c60e'
const SCOPE = { network: 'STAGENET', walletAddress: STAGENET_ADDR }

function makeAccount (overrides = {}) {
  return {
    id: 1,
    address: STAGENET_ADDR,
    label: 'platform_rewards',
    network: 'STAGENET',
    viewKey: encryptViewKey(VIEW_KEY),
    ...overrides
  }
}

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  walletlessTipRewardsPct: 70,
  boostRewardsPct: 30
}

// A RELAYED consolidation is a pure fee fact (principal zero, self transfer):
// it adds an actual network cost and proof of an on-chain relay, never cash.
// The row carries the journal's FULL closed select shape (null where the
// column is nullable) — the audit snapshot projects every expected column.
function feeFact (fee, txHash) {
  return {
    id: null,
    network: 'STAGENET',
    walletAddress: STAGENET_ADDR,
    txHash,
    kind: 'CONSOLIDATION',
    accountIndex: 0,
    state: 'RELAYED',
    distributionId: null,
    principalPiconeros: 0n,
    networkFeePiconeros: fee,
    metadata: { destination: STAGENET_ADDR, selfTransfer: true },
    preparedAt: null,
    relayAttemptedAt: null,
    relayedAt: null,
    relayProvenance: null,
    dispatchId: null,
    captureContractVersion: null,
    claimDigest: null,
    paymentClaims: null,
    proofId: null
  }
}

function makeDistribution (overrides = {}) {
  return {
    id: 1,
    periodStart: new Date('2026-01-01T00:00:00.000Z'),
    periodEnd: new Date('2026-01-08T00:00:00.000Z'),
    poolPiconeros: 5_000n,
    distributedPiconeros: 4_000n,
    rolledOverPiconeros: 1_000n,
    payoutCount: 2,
    status: 'COMPLETE',
    startedAt: new Date('2026-01-08T00:00:00.000Z'),
    completedAt: new Date('2026-01-08T00:00:00.000Z'),
    opsInflowPiconeros: 1_500n,
    opsRolledOverPiconeros: 500n,
    opsAvailablePiconeros: 2_000n,
    opsSweptPiconeros: 2_000n,
    opsSweepTxHash: null,
    opsSweepState: 'NOT_SWEEPED',
    opsNetworkFeesAccountedPiconeros: 0n,
    payouts: [],
    ...overrides
  }
}

// The main worked fixture from the plan: eligible receipts 100 (downvote 96 +
// bounty fee 4 at receipt time), recorded payout principal 60 (SENT), one
// RELAYED hot-wallet fee 7, recorded sweep principal 10, and a fee-adjusted
// ops carry of -7 + the open cycle's ops earmark 4 => pending ops -3.
function mainFixture () {
  return {
    allTime: { downvote: 96n, bountyfee: 4n },
    payouts: [{
      id: 1,
      distributionId: 1,
      curatorId: 42,
      state: 'SENT',
      txHash: 'aa'.repeat(32),
      recipientAddress: '5Arecipient',
      piconeros: 60n
    }],
    distributions: [makeDistribution({
      id: 1,
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 10n,
      opsSweptPiconeros: 10n,
      opsNetworkFeesAccountedPiconeros: 0n
    })],
    transactions: [feeFact(7n, 'bb'.repeat(32))]
  }
}

// The audit snapshot projects every expected journal column, so fake journal
// rows default their nullable/omittable fields; tests specify only the facts.
const JOURNAL_DEFAULTS = {
  id: null,
  accountIndex: 0,
  preparedAt: null,
  relayAttemptedAt: null,
  relayedAt: null,
  relayProvenance: null,
  dispatchId: null,
  captureContractVersion: null,
  claimDigest: null,
  paymentClaims: null,
  proofId: null
}

function makeModels ({
  account = makeAccount(),
  config = CONFIG,
  allTime = {},
  cycle = allTime,
  payouts = [],
  distributions = [],
  transactions = [],
  audits = [],
  latestAudit = audits[0] ?? null,
  // Audit-snapshot-only groups (the reader reads them; the money union never
  // consumes them).
  receipts = [],
  downvotes = [],
  bountyPayments = [],
  observedBounties = [],
  observedBountyReceipts = [],
  items = [],
  earns = [],
  escrowTransactions = [],
  subaddresses = []
} = {}) {
  const inflowRow = overrides => ({
    downvote: 0n,
    posting: 0n,
    territory: 0n,
    donate: 0n,
    donateRaw: 0n,
    boost: 0n,
    walletlesstip: 0n,
    bountyrollover: 0n,
    bountyrolloverRewards: 0n,
    bountyfee: 0n,
    time: new Date('2026-09-21T00:00:00.000Z'),
    ...overrides
  })
  const allTimeRow = inflowRow(allTime)
  const cycleRow = inflowRow(cycle)
  const lastDistribution = distributions.length > 0 ? distributions[distributions.length - 1] : null
  const models = {
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        where?.label === 'platform_rewards' ? account : null)
    },
    platformFeeConfig: {
      findUnique: jest.fn(async () => config),
      // getNextRewardsPool's own read uses the singleton upsert.
      upsert: jest.fn(async () => config)
    },
    rewardPayout: { findMany: jest.fn(async () => payouts.map(p => ({ curatorId: null, ...p }))) },
    rewardDistribution: {
      findFirst: jest.fn(async () => lastDistribution),
      findMany: jest.fn(async () => distributions)
    },
    rewardsWalletTransaction: {
      findMany: jest.fn(async () => transactions.map(t => ({ ...JOURNAL_DEFAULTS, ...t }))),
      findUnique: jest.fn(async () => null)
    },
    rewardsWalletReconciliation: {
      findMany: jest.fn(async () => audits),
      findFirst: jest.fn(async () => latestAudit)
    },
    subaddressIndex: { findMany: jest.fn(async () => subaddresses) },
    feeObservation: { findMany: jest.fn(async () => receipts) },
    observedDownvote: { findMany: jest.fn(async () => downvotes) },
    escrowWalletTransaction: {
      findMany: jest.fn(async () => escrowTransactions),
      findUnique: jest.fn(async () => null)
    },
    bountyPayment: { findMany: jest.fn(async () => bountyPayments) },
    observedBounty: { findMany: jest.fn(async () => observedBounties) },
    observedBountyReceipt: { findMany: jest.fn(async () => observedBountyReceipts) },
    item: { findMany: jest.fn(async () => items) },
    earn: { findMany: jest.fn(async () => earns) },
    paymentTransactionProof: { findUnique: jest.fn(async () => null) },
    observedTip: { count: jest.fn(async () => 0) },
    // The shared inflow reader's two calls are distinguishable by the bound
    // window start: epoch = the all-time transparency reader, anything else =
    // the pool's open-cycle reader.
    $queryRaw: jest.fn(async (strings, ...values) => {
      const start = values[0]
      const isAllTime = start instanceof Date && start.getTime() === 0
      return [isAllTime ? allTimeRow : cycleRow]
    })
  }
  // models.$transaction runs the callback on this same object so the resolver
  // and the pool helper read one mock snapshot.
  models.$transaction = async fn => fn(models)
  return models
}

function audit (overrides = {}) {
  return {
    checkedAt: new Date('2026-10-01T00:00:00.000Z'),
    ledgerFingerprint: '00'.repeat(32),
    positiveDriftPiconeros: 0n,
    // A published audit only clears the reconciliation gate when its report
    // proves the manifest was issue-free.
    report: { manifest: { issues: [] } },
    ...overrides
  }
}

describe('Query.rewardsWalletInfo', () => {
  test('derives received, principal, network fees and balance from the shared readers (100 - 70 - 7 = 23)', async () => {
    const models = makeModels(mainFixture())

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info).toMatchObject({
      totalReceivedPiconeros: 100n,
      totalSentPiconeros: 70n,
      totalNetworkFeesPiconeros: 7n,
      balancePiconeros: 23n,
      opsDeficitPiconeros: 3n,
      pendingSweepPiconeros: -3n,
      outstandingRewardsPiconeros: 0n,
      accountingUncertain: false,
      balanceNeedsReconciliation: false,
      reconciliationCheckedAt: null,
      reconciliationEvidenceCurrent: false
    })
    // The literal pool allocation (96 this cycle + 0 rollover), never a
    // pro-rata slice of the 23-piconero balance.
    expect(info.nextPoolPiconeros).toBe(96n)
    expect(info.inflowBreakdown.totalPiconeros).toBe(100n)
    expect(info.inflowBreakdown.rewardsPiconeros).toBe(96n)
    expect(info.inflowBreakdown.opsPiconeros).toBe(4n)
    expect(info.balanceXmr).toBe('0.000000000023')

    // Exact BigInts end-to-end: no monetary value is rounded through Number.
    for (const key of [
      'totalReceivedPiconeros', 'totalSentPiconeros', 'totalNetworkFeesPiconeros',
      'balancePiconeros', 'outstandingRewardsPiconeros', 'opsDeficitPiconeros',
      'nextPoolPiconeros', 'pendingSweepPiconeros'
    ]) {
      expect(typeof info[key]).toBe('bigint')
    }
    expect(typeof info.inflowBreakdown.totalPiconeros).toBe('bigint')
  })

  test('publishes the address-embedded public view key, never the stored private one', async () => {
    const models = makeModels(mainFixture())

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.address).toBe(STAGENET_ADDR)
    expect(info.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$/)
    expect(info.viewKey).toBe(publicViewKeyFromAddress(STAGENET_ADDR))
    expect(info.viewKey).not.toBe(VIEW_KEY)
    expect(info.network).toBe('STAGENET')
  })

  test('maps the shared source reader into the all-time inflowBreakdown', async () => {
    // downvote 100 (100%) + posting 200 (70%) + territory 300 (30%)
    // rewards = 100 + 140 + 90 = 330, total 600, ops 270.
    const models = makeModels({
      allTime: { downvote: 100n, posting: 200n, territory: 300n }
    })

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.inflowBreakdown).toMatchObject({
      downvotePiconeros: 100n,
      postingFeePiconeros: 200n,
      territoryFeePiconeros: 300n,
      totalPiconeros: 600n,
      rewardsPiconeros: 330n,
      opsPiconeros: 270n,
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      walletlessTipRewardsPct: 70
    })
  })

  test('keeps the shared reader\'s exact donation split and wallet-less tip bucket', async () => {
    const models = makeModels({
      allTime: {
        walletlesstip: 4_000n,
        donate: 2_000n,
        donateRaw: 4_000n,
        bountyrollover: 6_000n,
        bountyrolloverRewards: 6_000n,
        bountyfee: 1_000n
      }
    })

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.inflowBreakdown.walletlessTipPiconeros).toBe(4_000n)
    expect(info.inflowBreakdown.territoryFeePiconeros).toBe(0n) // NOT mislabeled as turf
    // total = 4000 + 4000 + 6000 + 1000 = 15000; rewards = 2800 + 2000 + 6000 = 10800
    expect(info.inflowBreakdown.totalPiconeros).toBe(15_000n)
    expect(info.inflowBreakdown.rewardsPiconeros).toBe(10_800n)
    expect(info.inflowBreakdown.opsPiconeros).toBe(4_200n)
  })

  test('journal-only proved payout and sweep principal are real outflows with their fees', async () => {
    // No recorded payout row and no recorded swept amount: the RELAYED journal
    // facts alone prove 60 payout + 10 sweep principal, and both fees are real
    // costs. The sweep is attributed to a recorded distribution that has not
    // recorded the hash yet (post-relay persist failure), so no uncertainty.
    const payout = {
      network: 'STAGENET',
      walletAddress: STAGENET_ADDR,
      txHash: 'a1'.repeat(32),
      kind: 'PAYOUT',
      accountIndex: 0,
      state: 'RELAYED',
      distributionId: 1,
      principalPiconeros: 60n,
      networkFeePiconeros: 2n,
      metadata: { payouts: [{ payoutId: 9, recipientAddress: '5Arecipient', piconeros: '60' }] },
      preparedAt: null,
      relayAttemptedAt: null,
      relayedAt: null,
      relayProvenance: null,
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    }
    const sweep = {
      network: 'STAGENET',
      walletAddress: STAGENET_ADDR,
      txHash: 'a2'.repeat(32),
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      state: 'RELAYED',
      distributionId: 1,
      principalPiconeros: 10n,
      networkFeePiconeros: 1n,
      metadata: { destination: '5Acold' },
      preparedAt: null,
      relayAttemptedAt: null,
      relayedAt: null,
      relayProvenance: null,
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    }
    const models = makeModels({
      allTime: { downvote: 100n },
      distributions: [makeDistribution({
        id: 1,
        opsAvailablePiconeros: 10n,
        opsSweptPiconeros: 0n,
        opsNetworkFeesAccountedPiconeros: 0n
      })],
      transactions: [payout, sweep]
    })

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.totalSentPiconeros).toBe(70n)
    expect(info.totalNetworkFeesPiconeros).toBe(3n)
    expect(info.balancePiconeros).toBe(27n)
    expect(info.pendingSweepPiconeros).toBe(-3n) // 10 - 10 proven swept - 3 fees + 0 open ops
    expect(info.opsDeficitPiconeros).toBe(3n)
    expect(info.accountingUncertain).toBe(false)
  })

  test('an attempted PREPARED journal row flags accounting uncertainty without counting a fee or principal', async () => {
    const attempt = {
      network: 'STAGENET',
      walletAddress: STAGENET_ADDR,
      txHash: 'c1'.repeat(32),
      kind: 'PAYOUT',
      accountIndex: 0,
      state: 'PREPARED',
      distributionId: 1,
      relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
      principalPiconeros: 60n,
      networkFeePiconeros: 3n,
      metadata: { payouts: [{ payoutId: 1, recipientAddress: '5Arecipient', piconeros: '60' }] },
      preparedAt: null,
      relayedAt: null,
      relayProvenance: null,
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    }
    const models = makeModels({ allTime: { downvote: 100n }, transactions: [attempt] })

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.accountingUncertain).toBe(true)
    expect(info.balanceNeedsReconciliation).toBe(true)
    expect(info.totalSentPiconeros).toBe(0n) // a PREPARED row is not an expense
    expect(info.totalNetworkFeesPiconeros).toBe(0n)
    expect(info.balancePiconeros).toBe(100n)
  })

  test('flags balanceNeedsReconciliation on a genuinely negative ledger balance', async () => {
    // Sent principal exceeding received is a real accounting bug, not an lws
    // artifact: it must be surfaced, never clamped.
    const models = makeModels({
      allTime: { downvote: 100n },
      payouts: [{
        id: 1,
        distributionId: 1,
        curatorId: null,
        state: 'SENT',
        txHash: 'dd'.repeat(32),
        recipientAddress: '5Arecipient',
        piconeros: 150n
      }]
    })

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.balancePiconeros).toBe(-50n)
    expect(info.balanceXmr).toBe('-0.00000000005')
    expect(info.balanceNeedsReconciliation).toBe(true)
  })

  test('a current positive-drift audit flags reconciliation and reports current freshness', async () => {
    const models = makeModels(mainFixture())
    const { fingerprint } = await readRewardsWalletLedger(models, { scope: SCOPE })
    const published = audit({ ledgerFingerprint: fingerprint, positiveDriftPiconeros: 5n })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([published])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(published)

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.accountingUncertain).toBe(false) // drift is separate from uncertainty
    expect(info.balanceNeedsReconciliation).toBe(true)
    expect(info.reconciliationCheckedAt).toEqual(published.checkedAt)
    expect(info.reconciliationEvidenceCurrent).toBe(true)
  })

  test('a stale clean audit is not current evidence and does not itself flag uncertainty', async () => {
    const models = makeModels(mainFixture())
    const stale = audit({ ledgerFingerprint: 'ff'.repeat(32), positiveDriftPiconeros: 0n })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([stale])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(stale)

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.accountingUncertain).toBe(false)
    expect(info.balanceNeedsReconciliation).toBe(false)
    expect(info.reconciliationCheckedAt).toEqual(stale.checkedAt)
    expect(info.reconciliationEvidenceCurrent).toBe(false)
  })

  test('a stale positive discrepancy keeps warning until a newer complete check clears it', async () => {
    const models = makeModels(mainFixture())
    const { fingerprint } = await readRewardsWalletLedger(models, { scope: SCOPE })
    const stalePositive = audit({
      checkedAt: new Date('2026-09-01T00:00:00.000Z'),
      ledgerFingerprint: 'ee'.repeat(32),
      positiveDriftPiconeros: 5n
    })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([stalePositive])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(stalePositive)

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(info.balanceNeedsReconciliation).toBe(true)
    expect(info.reconciliationEvidenceCurrent).toBe(false)

    const freshClean = audit({ checkedAt: new Date('2026-10-04T00:00:00.000Z'), ledgerFingerprint: fingerprint })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([freshClean, stalePositive])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(freshClean)

    const cleared = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(cleared.balanceNeedsReconciliation).toBe(false)
    expect(cleared.reconciliationEvidenceCurrent).toBe(true)
    expect(cleared.reconciliationCheckedAt).toEqual(freshClean.checkedAt)
  })

  test('an issue-bearing check cannot clear a positive discrepancy', async () => {
    const models = makeModels(mainFixture())
    const { fingerprint } = await readRewardsWalletLedger(models, { scope: SCOPE })
    const stalePositive = audit({
      checkedAt: new Date('2026-09-01T00:00:00.000Z'),
      ledgerFingerprint: 'ee'.repeat(32),
      positiveDriftPiconeros: 5n
    })
    // A CHECK of exactly the current facts, but published while a material
    // unknown remained: it records the discrepancy, it does not clear it.
    const issueMatch = audit({
      checkedAt: new Date('2026-10-04T00:00:00.000Z'),
      ledgerFingerprint: fingerprint,
      positiveDriftPiconeros: 0n,
      report: { manifest: { issues: [{ code: 'UNKNOWN_INCOMING' }] } }
    })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([issueMatch, stalePositive])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(issueMatch)

    const stillWarned = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(stillWarned.balanceNeedsReconciliation).toBe(true)

    // Only a clean check of the same facts clears it.
    const freshClean = audit({ checkedAt: new Date('2026-10-04T01:00:00.000Z'), ledgerFingerprint: fingerprint })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([freshClean, stalePositive])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(freshClean)

    const cleared = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(cleared.balanceNeedsReconciliation).toBe(false)
  })

  test('mutating one audited receipt invalidates the published audit without changing delivery', async () => {
    const receipts = [{
      id: 1n,
      txHash: 'aa'.repeat(32),
      feeType: 'BOOST',
      postId: 9,
      subName: null,
      payInId: null,
      recipientMajor: 0,
      recipientMinor: 0,
      walletReceipt: true,
      state: 'CONFIRMED',
      piconeros: 700n,
      rewardsPiconeros: null,
      donationRewardsPct: null,
      height: 2999001,
      confirmedAt: new Date('2026-10-01T00:00:00.000Z')
    }]
    const models = makeModels({ ...mainFixture(), receipts })
    const before = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    const { fingerprint } = await readRewardsWalletLedger(models, { scope: SCOPE })
    const published = audit({ ledgerFingerprint: fingerprint })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([published])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(published)

    const current = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(current.reconciliationEvidenceCurrent).toBe(true)

    // One audited receipt input changes: the published CHECK is stale even
    // though no delivery fact (principal, fees, commitments) moved.
    receipts[0].walletReceipt = !receipts[0].walletReceipt
    const after = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    expect(after.reconciliationEvidenceCurrent).toBe(false)
    expect(after.totalSentPiconeros).toBe(before.totalSentPiconeros)
    expect(after.totalNetworkFeesPiconeros).toBe(before.totalNetworkFeesPiconeros)
    expect(after.outstandingRewardsPiconeros).toBe(before.outstandingRewardsPiconeros)
    expect(after.accountingUncertain).toBe(false)
  })

  test('an old stored audit row stays visible but stale and adds no new public warning', async () => {
    const models = makeModels(mainFixture())
    // A pre-migration audit row: bare legacy hash, zero drift, row-level
    // issues. It remains visible (checkedAt) but is stale by definition and
    // must not invent uncertainty or a fresh public warning.
    const old = audit({
      checkedAt: new Date('2026-09-01T00:00:00.000Z'),
      ledgerFingerprint: 'cd'.repeat(32),
      positiveDriftPiconeros: 0n,
      report: { manifest: { issues: [{ code: 'SOME_STALE_ISSUE' }] } }
    })
    models.rewardsWalletReconciliation.findMany.mockResolvedValue([old])
    models.rewardsWalletReconciliation.findFirst.mockResolvedValue(old)

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(info.reconciliationCheckedAt).toEqual(old.checkedAt)
    expect(info.reconciliationEvidenceCurrent).toBe(false)
    expect(info.accountingUncertain).toBe(false)
    expect(info.balanceNeedsReconciliation).toBe(false)
  })

  test('throws when the platform rewards wallet is not registered', async () => {
    const models = makeModels({ account: null })

    await expect(resolvers.Query.rewardsWalletInfo(null, null, { models }))
      .rejects.toThrow(/rewards wallet/i)
  })

  test('pendingSweepPiconeros agrees with the signed monero_ops_pending_piconeros metric', async () => {
    __resetMetricsForTests()
    const models = makeModels(mainFixture())

    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    await collectDBBackedMetrics(models)

    expect(info.pendingSweepPiconeros).toBe(-3n)
    expect(await metricValue('monero_ops_pending_piconeros')).toBe(-3)
    expect(await metricValue('monero_ops_deficit_piconeros')).toBe(3)
    expect(await metricValue('monero_rewards_network_fees_piconeros')).toBe(7)
    expect(await metricValue('monero_rewards_accounting_uncertain')).toBe(0)
  })

  test('renders an adjusted reward amount for direct display', async () => {
    const models = makeModels(mainFixture())
    const info = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(piconerosToXmr(info.nextPoolPiconeros)).toBe('0.000000000096 XMR')
    expect(piconerosToXmr(info.totalNetworkFeesPiconeros)).toBe('0.000000000007 XMR')
  })
})

describe('Query.rewardDistributions', () => {
  test('passes the recorded ops-sweep fields through unchanged', async () => {
    const dist = makeDistribution({
      id: 1,
      opsInflowPiconeros: 1_500n,
      opsAvailablePiconeros: 2_000n,
      opsSweptPiconeros: 2_000n,
      opsSweepTxHash: 'ab'.repeat(32),
      opsSweepState: 'SWEPT',
      opsNetworkFeesAccountedPiconeros: 5n
    })
    const models = makeModels({
      distributions: [dist],
      transactions: [feeFact(5n, 'ff'.repeat(32))]
    })

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result).toHaveLength(1)
    expect(result[0].opsInflowPiconeros).toBe(1_500n)
    expect(result[0].opsAvailablePiconeros).toBe(2_000n)
    expect(result[0].opsSweptPiconeros).toBe(2_000n)
    expect(result[0].opsSweepTxHash).toBe('ab'.repeat(32))
    expect(result[0].opsSweepState).toBe('SWEPT')
    expect(result[0].opsNetworkFeesAccountedPiconeros).toBe(5n)
    expect(result[0].correctedPendingOpsPiconeros).toBe(0n)
  })

  test('corrects the pending ops carry with the cumulative fee cost and proved sweep facts', async () => {
    const dist = makeDistribution({
      id: 1,
      opsAvailablePiconeros: 100n,
      opsSweptPiconeros: 40n,
      opsNetworkFeesAccountedPiconeros: 7n
    })
    const models = makeModels({
      distributions: [dist],
      transactions: [feeFact(9n, 'dd'.repeat(32))]
    })

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    // 100 - 40 proven swept - (9 cumulative fees - 7 already accounted) = 58,
    // NOT the old opsAvailable - opsSwept = 60.
    expect(result[0].correctedPendingOpsPiconeros).toBe(58n)
    expect(result[0].correctedPendingOpsPiconeros).not.toBe(60n)
    expect(typeof result[0].correctedPendingOpsPiconeros).toBe('bigint')
  })

  test('bounds each historical row\'s fee adjustment to its successor checkpoint (two distributions)', async () => {
    // Older row: available 100, proven swept 98, checkpoint 0; its successor's
    // checkpoint is 1, so its own window paid 1 piconero in fees and its
    // adjusted carry is 1. The active row (no successor) absorbs today's
    // cumulative 50: 200 - 0 - (50 - 1) = 151. Charging the older row with all
    // 50 later fees would show -48 and falsely label it "unfunded".
    const older = makeDistribution({
      id: 1,
      periodEnd: new Date('2026-01-08T00:00:00.000Z'),
      opsAvailablePiconeros: 100n,
      opsSweptPiconeros: 98n,
      opsNetworkFeesAccountedPiconeros: 0n
    })
    const active = makeDistribution({
      id: 2,
      periodEnd: new Date('2026-01-15T00:00:00.000Z'),
      opsAvailablePiconeros: 200n,
      opsSweptPiconeros: 0n,
      opsNetworkFeesAccountedPiconeros: 1n
    })
    const models = makeModels({
      // The display read returns newest first; the correction must still find
      // each row's successor chronologically.
      distributions: [active, older],
      transactions: [feeFact(50n, 'aa'.repeat(32))]
    })

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result.map(d => d.id)).toEqual([2, 1])
    const displayedOlder = result[1]
    const displayedActive = result[0]
    expect(displayedOlder.correctedPendingOpsPiconeros).toBe(1n) // 100 - 98 - (1 - 0)
    expect(displayedOlder.correctedPendingOpsPiconeros).not.toBe(-48n) // never Fnow-bounded
    expect(displayedOlder.correctedPendingOpsPiconeros >= 0n).toBe(true) // page cannot label it unfunded
    expect(displayedActive.correctedPendingOpsPiconeros).toBe(151n) // 200 - 0 - (50 - 1)

    // Later periods' fees cannot move a settled historical row: with Fnow 60
    // the older row is unchanged while the active row absorbs the new cost.
    models.rewardsWalletTransaction.findMany.mockResolvedValue([
      feeFact(50n, 'aa'.repeat(32)),
      feeFact(10n, 'bb'.repeat(32))
    ])
    const grown = await resolvers.Query.rewardDistributions(null, {}, { models })
    expect(grown[1].correctedPendingOpsPiconeros).toBe(1n)
    expect(grown[0].correctedPendingOpsPiconeros).toBe(141n)
  })

  test('a deferred sweep keeps its corrected carry visible', async () => {
    const dist = makeDistribution({
      id: 1,
      opsAvailablePiconeros: 500n,
      opsSweptPiconeros: 0n,
      opsSweepTxHash: null,
      opsSweepState: 'SKIPPED_LOCKED',
      opsNetworkFeesAccountedPiconeros: 5n
    })
    const models = makeModels({
      distributions: [dist],
      transactions: [feeFact(8n, 'ee'.repeat(32))]
    })

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result[0].opsSweepState).toBe('SKIPPED_LOCKED')
    expect(result[0].opsSweepTxHash).toBeNull()
    expect(result[0].correctedPendingOpsPiconeros).toBe(497n) // 500 - 0 - (8 - 5)
  })

  test('resolves curator nym and renders payout XMR amount alongside raw piconeros', async () => {
    const dist = makeDistribution({
      payouts: [{
        id: 7,
        curatorId: 42,
        curator: { name: 'satoshi' },
        piconeros: 1_000_000_000_000n,
        txHash: 'cd'.repeat(32),
        state: 'SENT'
      }]
    })
    const models = makeModels({ distributions: [dist] })

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result[0].payouts[0].curatorNym).toBe('satoshi')
    expect(result[0].payouts[0].amountXmr).toBe('1')
  })
})

describe('wallet-free transparency surface', () => {
  test('the resolver and metrics never import a wallet or lws module', () => {
    const walletImport = /from\s+['"][^'"]*(?:wallet|lws)[^'"]*['"]/i
    for (const file of ['api/resolvers/rewardsWallet.js', 'lib/metrics.js']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(walletImport)
    }
  })
})

// Reads a gauge value out of the shared Prometheus registry exposition
// (mirrors test/lib/metrics.test.js) so the resolver figures are pinned to the
// metric definitions.
async function metricValue (name) {
  const exposition = await register.metrics()
  const line = exposition.split('\n').find(l => {
    if (!l.startsWith(name)) return false
    const rest = l.slice(name.length)
    return rest.startsWith(' ') || rest.startsWith('{')
  })
  if (!line) throw new Error(`metric ${name} not found in exposition`)
  return Number(line.trim().split(/\s+/).pop())
}
