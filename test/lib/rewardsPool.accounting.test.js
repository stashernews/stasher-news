/* eslint-env jest */
import { getNextRewardsPool } from '@/lib/rewardsPool'

// getNextRewardsPool now reads ONE inflow reader (readRewardsInflow) and ONE
// factual ledger (readRewardsWalletLedger) inside a consistent Serializable
// transaction, and prices the unswept ops carry with the cumulative network
// cost checkpoint (spec §5). These tests pin the exact checkpoint arithmetic
// and the separation between reward commitments, the next pool and ops.

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  boostRewardsPct: 30,
  walletlessTipRewardsPct: 70
}

process.env.PLATFORM_REWARDS_ADDRESS = '5HOT'
process.env.MONERO_NETWORK = 'stagenet'

const HOT = '5HOT'
const TIME = new Date('2026-10-12T00:00:00.000Z')
const PERIOD_END = new Date('2026-10-05T00:00:00.000Z')

// A RELAYED consolidation is a pure fee fact (principal zero, self transfer).
// Journal rows carry the audit snapshot's FULL closed column shape.
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
const feeFact = (fee, txHash) => ({
  network: 'STAGENET',
  walletAddress: HOT,
  txHash,
  kind: 'CONSOLIDATION',
  state: 'RELAYED',
  distributionId: null,
  principalPiconeros: 0n,
  networkFeePiconeros: fee,
  metadata: { destination: HOT, selfTransfer: true },
  ...JOURNAL_DEFAULTS
})

const relayedSweep = ({ txHash, distributionId, principal, fee }) => ({
  network: 'STAGENET',
  walletAddress: HOT,
  txHash,
  kind: 'OPS_SWEEP',
  state: 'RELAYED',
  distributionId,
  principalPiconeros: principal,
  networkFeePiconeros: fee,
  metadata: { destination: '5COLD' },
  ...JOURNAL_DEFAULTS
})

function makeModels ({ lastDistribution = null, inflow = {}, ledger = {} } = {}) {
  const row = {
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
    time: TIME,
    ...inflow
  }
  const models = {
    platformFeeConfig: {
      upsert: jest.fn(async () => CONFIG),
      findUnique: jest.fn(async () => CONFIG)
    },
    $queryRaw: jest.fn(async () => [row]),
    rewardDistribution: {
      findFirst: jest.fn(async () => lastDistribution),
      // Full closed distribution shape: the audit snapshot projects every
      // expected column; tests only vary the accounting facts.
      findMany: jest.fn(async () => (ledger.distributions ?? []).map(d => ({
        status: null,
        periodStart: null,
        periodEnd: null,
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: null,
        opsSweptPiconeros: 0n,
        opsSweepState: null,
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n,
        ...d
      })))
    },
    rewardPayout: { findMany: jest.fn(async () => (ledger.payouts ?? []).map(p => ({ curatorId: null, ...p }))) },
    rewardsWalletTransaction: {
      findMany: jest.fn(async () => ledger.transactions ?? []),
      findUnique: jest.fn(async () => null)
    },
    rewardsWalletReconciliation: { findMany: jest.fn(async () => ledger.audits ?? []) },
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        where?.label === 'platform_rewards'
          ? { id: 1, label: 'platform_rewards', address: HOT, network: 'STAGENET' }
          : null)
    },
    // Audit-snapshot side groups (empty; no bounty/escrow facts in this DB).
    subaddressIndex: { findMany: jest.fn(async () => []) },
    feeObservation: { findMany: jest.fn(async () => []) },
    observedDownvote: { findMany: jest.fn(async () => []) },
    escrowWalletTransaction: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    bountyPayment: { findMany: jest.fn(async () => []) },
    observedBounty: { findMany: jest.fn(async () => []) },
    observedBountyReceipt: { findMany: jest.fn(async () => []) },
    item: { findMany: jest.fn(async () => []) },
    earn: { findMany: jest.fn(async () => []) },
    paymentTransactionProof: { findUnique: jest.fn(async () => null) }
  }
  // Ruling: mocks must provide $transaction explicitly so the production
  // path (both readers inside one transaction) is what actually runs.
  models.$transaction = async fn => fn(models)
  return models
}

test('reads the allocation config and inflow inside one Serializable transaction', async () => {
  const models = makeModels()
  let inTransaction = false
  const contexts = { config: [], inflow: [] }
  const configImpl = models.platformFeeConfig.upsert
  models.platformFeeConfig.upsert = jest.fn(async (...args) => {
    contexts.config.push(inTransaction)
    return configImpl(...args)
  })
  const rawImpl = models.$queryRaw
  models.$queryRaw = jest.fn(async (...args) => {
    contexts.inflow.push(inTransaction)
    return rawImpl(...args)
  })
  models.$transaction = jest.fn(async fn => {
    inTransaction = true
    try {
      return await fn(models)
    } finally {
      inTransaction = false
    }
  })

  await getNextRewardsPool(models)

  expect(models.$transaction).toHaveBeenCalledTimes(1)
  // A concurrent config change can never combine an old split with newer
  // inflow/ledger facts.
  expect(contexts.config).toEqual([true])
  expect(contexts.inflow).toEqual([true])
})

test('getNextRewardsPool keeps every existing key and adds the accounting fields', async () => {
  const pool = await getNextRewardsPool(makeModels())
  expect(Object.keys(pool).sort()).toEqual([
    'accountingUncertain',
    'ledgerFingerprint',
    'outstandingRewardsPiconeros',
    'pendingSweepPiconeros',
    'poolPiconeros',
    'rewardsInflowPiconeros',
    'rolledOverPiconeros',
    'sources',
    'time',
    'totalInflowPiconeros',
    'totalNetworkFeesPiconeros'
  ])
  // The fingerprint is the shared versioned accounting audit digest.
  expect(pool.ledgerFingerprint).toMatch(/^accounting:v2:[0-9a-f]{64}$/)
})

test('prior opsAvailable20, opsSwept10, cost checkpoint4, fees7 and open-cycle ops5 => pending12', async () => {
  const lastDistribution = {
    id: 9,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 20n,
    opsSweptPiconeros: 10n,
    opsNetworkFeesAccountedPiconeros: 4n
  }
  const models = makeModels({
    lastDistribution,
    inflow: { donate: 0n, donateRaw: 5n },
    ledger: {
      distributions: [{ id: 9, opsSweptPiconeros: 10n, opsSweepTxHash: null }],
      transactions: [feeFact(3n, 'a1'.repeat(32)), feeFact(4n, 'a2'.repeat(32))]
    }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.pendingSweepPiconeros).toBe(12n) // 20 - 10 - (7-4) + 5
  expect(pool.totalNetworkFeesPiconeros).toBe(7n)
  expect(pool.outstandingRewardsPiconeros).toBe(0n)
})

test('next distribution opsAvailable12 with checkpoint7 and a new fee2 yields carry10, not 3 or 17', async () => {
  const lastDistribution = {
    id: 10,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 12n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 7n
  }
  const models = makeModels({
    lastDistribution,
    ledger: { transactions: [feeFact(7n, 'b1'.repeat(32)), feeFact(2n, 'b2'.repeat(32))] }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.pendingSweepPiconeros).toBe(10n) // 12 - 0 - (9-7)
  expect(pool.pendingSweepPiconeros).not.toBe(3n) // checkpoint ignored would double-debit the 7
  expect(pool.pendingSweepPiconeros).not.toBe(17n) // adding the delta instead of debiting it
})

test('a late historical fee insertion debits the active carry now, exactly once', async () => {
  const lastDistribution = {
    id: 11,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 12n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 7n
  }
  const models = makeModels({
    lastDistribution,
    ledger: { transactions: [feeFact(7n, 'c1'.repeat(32))] }
  })
  expect((await getNextRewardsPool(models)).pendingSweepPiconeros).toBe(12n)

  models.rewardsWalletTransaction.findMany.mockResolvedValue([
    feeFact(7n, 'c1'.repeat(32)),
    feeFact(2n, 'c2'.repeat(32)) // inserted later, whatever its old chain timestamp
  ])
  expect((await getNextRewardsPool(models)).pendingSweepPiconeros).toBe(10n)
  // Re-reading does not debit it again.
  expect((await getNextRewardsPool(models)).pendingSweepPiconeros).toBe(10n)
})

test('with no distribution, a fee3 debits current ops5 to pending2 (never hiding the deficit)', async () => {
  const models = makeModels({
    lastDistribution: null,
    inflow: { donate: 0n, donateRaw: 5n },
    ledger: { transactions: [feeFact(3n, 'd1'.repeat(32))] }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.pendingSweepPiconeros).toBe(2n) // -3 carry + 5 inflow
  expect(pool.totalNetworkFeesPiconeros).toBe(3n)
})

test('journal-proven sweep principal substitutes for the recorded swept amount', async () => {
  const lastDistribution = {
    id: 12,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 20n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 0n
  }
  const models = makeModels({
    lastDistribution,
    inflow: { donate: 0n, donateRaw: 5n },
    ledger: {
      distributions: [{ id: 12, opsSweptPiconeros: 0n, opsSweepTxHash: null }],
      transactions: [relayedSweep({ txHash: 'e1'.repeat(32), distributionId: 12, principal: 10n, fee: 1n })]
    }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.pendingSweepPiconeros).toBe(14n) // 20 - 10 proven swept - 1 fee + 5 open ops
})

test('old queued rewards stay separate from the new pool and are never reported as ops', async () => {
  const lastDistribution = {
    id: 13,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 0n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 0n
  }
  const models = makeModels({
    lastDistribution,
    inflow: { donate: 0n, donateRaw: 5n },
    ledger: {
      payouts: [{ id: 21, distributionId: 13, state: 'QUEUED', txHash: null, recipientAddress: '5C', piconeros: 15n }]
    }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.pendingSweepPiconeros).toBe(5n) // open ops only: the 15 owed is not free cash
  expect(pool.poolPiconeros).toBe(0n) // already-allocated rewards are not new pool
  expect(pool.outstandingRewardsPiconeros).toBe(15n)
})

test('an attempted journal row surfaces accounting uncertainty without changing the carry', async () => {
  const lastDistribution = {
    id: 14,
    periodEnd: PERIOD_END,
    rolledOverPiconeros: 0n,
    opsAvailablePiconeros: 12n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 7n
  }
  const models = makeModels({
    lastDistribution,
    ledger: {
      distributions: [{ id: 14, opsSweptPiconeros: 0n, opsSweepTxHash: null }],
      transactions: [
        feeFact(7n, 'f0'.repeat(32)),
        {
          ...JOURNAL_DEFAULTS,
          network: 'STAGENET',
          walletAddress: HOT,
          txHash: 'f1'.repeat(32),
          kind: 'PAYOUT',
          state: 'PREPARED',
          relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
          distributionId: 14,
          principalPiconeros: 60n,
          networkFeePiconeros: 3n,
          metadata: { payouts: [{ payoutId: 1, recipientAddress: '5A', piconeros: '60' }] }
        }
      ]
    }
  })
  const pool = await getNextRewardsPool(models)
  expect(pool.accountingUncertain).toBe(true)
  expect(pool.totalNetworkFeesPiconeros).toBe(7n) // PREPARED adds no expense
  expect(pool.pendingSweepPiconeros).toBe(12n) // 12 - 0 - (7-7)
})
