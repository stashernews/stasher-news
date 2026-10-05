/* eslint-env jest */
import * as util from 'node:util'
import { PrismaClient } from '@prisma/client'
import { alert } from '@/lib/alert'
import { logError, logWarn } from '@/lib/logger'
import {
  assertWalletScope,
  prepareWalletTransaction,
  reconcileWalletTransactions,
  relayWalletTransaction
} from '@/api/monero/rewardsTransactions'

// lib/alert and lib/logger are mocked (same pattern as
// test/worker/rewardsDistributor.test.js): operator pages are assertable
// without a network side effect, and every log call this module makes is
// captured so nothing sensitive can hide in pino output.
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Isolated real-DB tests for the rewards-wallet transaction journal (Task 6).
//
// The journal is the durable per-transaction boundary every later send path
// uses: an immutable PREPARED row is written from the built (UNRELAYED)
// transaction, the attempt is claimed with a CAS, the SAME object is relayed,
// and the exact fee is recorded once as RELAYED. A transport failure is never
// proof of non-relay: the row stays PREPARED+attempted and reconciliation
// resolves it only from exact hashes with explicit relayed/confirmed flags.
//
// The wallet here is a fake; the database is the dedicated isolated one.
// Runs only when DATABASE_URL points at /stasher_rewards_repair_test (the
// isolated runner); skipped everywhere else so ordinary dev-DB collection
// neither crashes nor touches that database. Run via:
//   docker exec stasher-rewards-repair-runner npm run test -- \
//     --runInBand --runTestsByPath test/api/monero/rewardsTransactions.test.js

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// The closed diagnostic label set the module may emit. Duplicated here on
// purpose: if the module's label set ever changes, this suite fails loudly.
const ERROR_LABELS = ['timeout', 'connection', 'rpc', 'unknown']

;(ISOLATED_DB ? describe : describe.skip)('rewards wallet transaction journal (isolated DB only)', () => {
  const scope = { network: 'STAGENET', walletAddress: '5JOURNALTEST' }
  const HASH = 'e3'.repeat(32)
  let db

  beforeAll(() => {
    db = new PrismaClient()
  })

  afterEach(async () => {
    jest.clearAllMocks()
    await db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } })
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  const makeTx = ({ hash = HASH, fee = 17n } = {}) => ({ getHash: () => hash, getFee: () => fee })

  const makeWallet = (overrides = {}) => ({
    getPrimaryAddress: jest.fn(async () => scope.walletAddress),
    getNetworkType: jest.fn(async () => 2),
    relayTx: jest.fn(async () => HASH),
    getOutgoingTransfers: jest.fn(async () => []),
    ...overrides
  })

  const makeTransfer = ({ hash = HASH, relayed = true, confirmed = false, fee = 17n, destinations = [] } = {}) => ({
    getTx: () => ({
      getHash: () => hash,
      getIsRelayed: () => relayed,
      getIsConfirmed: () => confirmed,
      getFee: () => fee
    }),
    getDestinations: () => destinations.map(({ address, amount }) => ({
      getAddress: () => address,
      getAmount: () => amount
    }))
  })

  const prepareConsolidation = (overrides = {}) => prepareWalletTransaction({
    models: db,
    scope,
    tx: makeTx(),
    kind: 'CONSOLIDATION',
    accountIndex: 1,
    principalPiconeros: 0n,
    metadata: { selfTransfer: true, destination: scope.walletAddress },
    ...overrides
  })

  const preparePayout = (overrides = {}) => prepareWalletTransaction({
    models: db,
    scope,
    tx: makeTx(),
    kind: 'PAYOUT',
    accountIndex: 0,
    principalPiconeros: 75n,
    metadata: {
      payouts: [
        { payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: '60' },
        { payoutId: 2, recipientAddress: '5RECIPIENTTWO', piconeros: '15' }
      ]
    },
    ...overrides
  })

  // A real queued payout row for durable-recovery tests (FK-safe user +
  // distribution), with its own teardown.
  const seedQueuedPayout = async ({ recipientAddress, piconeros }) => {
    const [user] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    const distribution = await db.rewardDistribution.create({
      data: { periodStart: new Date(0), periodEnd: new Date(1), poolPiconeros: piconeros }
    })
    const payout = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: user.id, recipientAddress, piconeros, state: 'QUEUED' }
    })
    const cleanup = async () => {
      await db.rewardPayout.deleteMany({ where: { distributionId: distribution.id } })
      await db.rewardDistribution.deleteMany({ where: { id: distribution.id } })
      await db.user.deleteMany({ where: { id: user.id } })
    }
    return { user, distribution, payout, cleanup }
  }

  const markAttempted = (id) => db.rewardsWalletTransaction.update({
    where: { id },
    data: { relayAttemptedAt: new Date() }
  })

  const loadRow = (id) => db.rewardsWalletTransaction.findUnique({ where: { id } })

  test('records one exact fee for one hash, only after relay is proven', async () => {
    const wallet = makeWallet()
    const tx = makeTx()
    const a = await prepareConsolidation({ tx })
    const b = await prepareConsolidation({ tx })
    expect(a.id).toBe(b.id)
    expect(a.state).toBe('PREPARED')

    const sent = await relayWalletTransaction({ models: db, wallet, journal: a, tx })
    expect(sent).toMatchObject({ relayed: true, uncertain: false, accountingUnpersisted: 0 })
    expect(sent.txHash).toBe(HASH)
    expect(sent.networkFeePiconeros).toBe(17n)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(wallet.relayTx).toHaveBeenCalledWith(tx)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: scope.walletAddress, state: 'RELAYED' } })).toBe(1)

    const stored = await loadRow(a.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.networkFeePiconeros).toBe(17n)
    expect(stored.relayAttemptedAt).not.toBeNull()
    expect(stored.relayedAt).not.toBeNull()
  })

  test('a relay timeout remains attempted and cannot be blindly sent again', async () => {
    const wallet = makeWallet({
      relayTx: jest.fn(async () => { throw new Error('timeout after submission') })
    })
    const tx = makeTx()
    const a = await prepareConsolidation({ tx })

    const result = await relayWalletTransaction({ models: db, wallet, journal: a, tx })
    expect(result).toMatchObject({ relayed: false, uncertain: true, accountingUnpersisted: 0 })
    await expect(relayWalletTransaction({ models: db, wallet, journal: a, tx })).rejects.toThrow(/attempt|uncertain/i)

    const result2 = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result2.uncertainSweep).toBe(true)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)

    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()
    expect(stored.relayedAt).toBeNull()
  })

  test('a relay that returns a different hash is uncertainty, not a false proof', async () => {
    const wallet = makeWallet({ relayTx: jest.fn(async () => 'e5'.repeat(32)) })
    const tx = makeTx()
    const a = await prepareConsolidation({ tx })

    const result = await relayWalletTransaction({ models: db, wallet, journal: a, tx })
    expect(result).toMatchObject({ relayed: false, uncertain: true, accountingUnpersisted: 0 })
    await expect(relayWalletTransaction({ models: db, wallet, journal: a, tx })).rejects.toThrow(/attempt|uncertain/i)

    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()
    expect(stored.relayedAt).toBeNull()
  })

  test('only the journaled transaction object may be relayed', async () => {
    const wallet = makeWallet()
    const a = await prepareConsolidation({ tx: makeTx() })
    await expect(relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx({ hash: 'e5'.repeat(32) }) }))
      .rejects.toThrow(/journaled hash/i)
    expect(wallet.relayTx).not.toHaveBeenCalled()
    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).toBeNull()
  })

  test('a failed pre-attempt persist blocks the relay entirely', async () => {
    const wallet = makeWallet()
    const a = await prepareConsolidation()
    const models = {
      rewardsWalletTransaction: { updateMany: jest.fn().mockRejectedValue(new Error('journal db down')) }
    }

    await expect(relayWalletTransaction({ models, wallet, journal: a, tx: makeTx() })).rejects.toThrow('journal db down')
    expect(wallet.relayTx).not.toHaveBeenCalled()
    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).toBeNull()
  })

  test.each([
    ['missing', { getHash: () => HASH }, /money|fee/i],
    ['unsafe', makeTx({ fee: 2 ** 53 }), /unsafe/i],
    ['negative', makeTx({ fee: -1n }), /negative/i]
  ])('refuses a %s network fee before any journal write', async (_label, tx, pattern) => {
    await expect(prepareConsolidation({ tx })).rejects.toThrow(pattern)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: scope.walletAddress } })).toBe(0)
  })

  test.each([
    ['missing', null],
    ['invalid', 'zz'.repeat(32)]
  ])('refuses a %s transaction hash', async (_label, hash) => {
    await expect(prepareConsolidation({ tx: makeTx({ hash }) })).rejects.toThrow(/invalid transaction hash/)
  })

  test('normalizes the transaction hash to lowercase', async () => {
    const a = await prepareConsolidation({ tx: makeTx({ hash: 'E3'.repeat(32) }) })
    expect(a.txHash).toBe(HASH)
    expect((await loadRow(a.id)).txHash).toBe(HASH)
  })

  test('conflicting immutable facts for one hash are refused', async () => {
    await preparePayout()
    await expect(preparePayout({ accountIndex: 1 })).rejects.toThrow(/conflict/i)
    await expect(preparePayout({
      principalPiconeros: 74n,
      metadata: { payouts: [{ payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: '74' }] }
    })).rejects.toThrow(/conflict/i)
    expect(await db.rewardsWalletTransaction.count({ where: { txHash: HASH, walletAddress: scope.walletAddress } })).toBe(1)
  })

  test('metadata is a validated closed union', async () => {
    await expect(prepareConsolidation({ principalPiconeros: 1n })).rejects.toThrow(/principal/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: false, destination: scope.walletAddress } })).rejects.toThrow(/self/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: true, destination: '5NOTPRIMARY' } })).rejects.toThrow(/primary/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: true, destination: scope.walletAddress, extra: 1 } })).rejects.toThrow(/metadata/i)
    await expect(preparePayout({ principalPiconeros: 74n })).rejects.toThrow(/principal/i)
    await expect(preparePayout({
      metadata: { payouts: [{ payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: '75', extra: true }] }
    })).rejects.toThrow(/metadata/i)
    await expect(preparePayout({
      metadata: { payouts: [{ payoutId: 4, recipientAddress: '5A', piconeros: '30' }, { payoutId: 4, recipientAddress: '5B', piconeros: '45' }] }
    })).rejects.toThrow(/duplicate/i)
    await expect(prepareWalletTransaction({
      models: db, scope, tx: makeTx(), kind: 'OPS_SWEEP', accountIndex: 0, principalPiconeros: 1n, metadata: { destination: '' }
    })).rejects.toThrow(/metadata|destination/i)
    await expect(prepareWalletTransaction({
      models: db, scope, tx: makeTx(), kind: 'OPS_SWEEP', accountIndex: 0, principalPiconeros: 1n, metadata: { destination: '5COLD', extra: true }
    })).rejects.toThrow(/metadata/i)
  })

  test('payout metadata is normalized to exact decimal strings and stored canonically', async () => {
    const a = await preparePayout({
      principalPiconeros: 75n,
      metadata: {
        payouts: [
          { payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: 60n },
          { payoutId: 2, recipientAddress: '5RECIPIENTTWO', piconeros: 15n }
        ]
      }
    })
    expect((await loadRow(a.id)).metadata).toEqual({
      payouts: [
        { payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: '60' },
        { payoutId: 2, recipientAddress: '5RECIPIENTTWO', piconeros: '15' }
      ]
    })
    // The same facts in another member order are still the same immutable row.
    const b = await preparePayout({
      principalPiconeros: 75n,
      metadata: {
        payouts: [
          { payoutId: 2, recipientAddress: '5RECIPIENTTWO', piconeros: 15n },
          { payoutId: 1, recipientAddress: '5RECIPIENTONE', piconeros: 60n }
        ]
      }
    })
    expect(b.id).toBe(a.id)
  })

  test('a differing distribution binding conflicts for one hash', async () => {
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date('2036-01-01T00:00:00.000Z'),
        periodEnd: new Date('2036-01-08T00:00:00.000Z'),
        poolPiconeros: 0n
      }
    })
    try {
      const tx = makeTx()
      const a = await preparePayout({ tx, distributionId: distribution.id })
      expect(a.distributionId).toBe(distribution.id)
      await expect(preparePayout({ tx, distributionId: null })).rejects.toThrow(/conflict/i)
    } finally {
      await db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } })
      await db.rewardDistribution.delete({ where: { id: distribution.id } })
    }
  })

  test('an attempted row whose wallet history query throws retains uncertainty', async () => {
    const wallet = makeWallet({
      relayTx: jest.fn(async () => { throw new Error('timeout after submission') }),
      getOutgoingTransfers: jest.fn(async () => { throw new Error('history unavailable') })
    })
    const a = await prepareConsolidation()
    await relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })

    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: true, accountingUnpersisted: 0 })
    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()
    await expect(relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })).rejects.toThrow(/attempt|uncertain/i)
  })

  test('a built-but-unrelayed cached transaction is not evidence of relay', async () => {
    const wallet = makeWallet({ relayTx: jest.fn(async () => { throw new Error('timeout after submission') }) })
    const a = await prepareConsolidation()
    await relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })

    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({ relayed: false, confirmed: false, destinations: [{ address: scope.walletAddress, amount: 5n }] })
    ])
    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: true, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')

    // A hash missing from history is equally not proof of anything.
    wallet.getOutgoingTransfers.mockResolvedValue([])
    const missing = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(missing.uncertainSweep).toBe(true)
    expect((await loadRow(a.id)).state).toBe('PREPARED')
  })

  test('an exact-hash proven relay recovers the journal state idempotently', async () => {
    const wallet = makeWallet()
    const a = await preparePayout()
    await markAttempted(a.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n }
        ]
      })
    ])

    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect(wallet.relayTx).not.toHaveBeenCalled()
    const stored = await loadRow(a.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayedAt).not.toBeNull()

    const again = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(again).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
  })

  test('an exact-hash proven ops sweep recovers while an unproven sweep blocks sweeping', async () => {
    const wallet = makeWallet()
    const sweep = await prepareWalletTransaction({
      models: db,
      scope,
      tx: makeTx(),
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: '5COLDSTORE' }
    })
    await markAttempted(sweep.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({ destinations: [{ address: '5COLDSTORE', amount: 500n }] })
    ])
    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result.uncertainSweep).toBe(false)
    expect((await loadRow(sweep.id)).state).toBe('RELAYED')

    const unproven = await prepareWalletTransaction({
      models: db,
      scope,
      tx: makeTx({ hash: 'e4'.repeat(32) }),
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: '5COLDSTORE' }
    })
    await markAttempted(unproven.id)
    const blocked = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(blocked.uncertainSweep).toBe(true)
    expect((await loadRow(unproven.id)).state).toBe('PREPARED')
  })

  test('a proven hash must agree with the stored fee and destinations', async () => {
    const wallet = makeWallet()
    const a = await preparePayout()
    await markAttempted(a.id)

    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        fee: 99n,
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n }
        ]
      })
    ])
    const wrongFee = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(wrongFee).toEqual({ uncertainPayoutIds: [1, 2], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')

    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5SOMEWHEREELSE', amount: 15n }
        ]
      })
    ])
    const wrongDestination = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(wrongDestination).toEqual({ uncertainPayoutIds: [1, 2], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')
  })

  test('history must match exactly: extra recipients and conflicting duplicates retain uncertainty', async () => {
    const wallet = makeWallet()
    const a = await preparePayout()
    await markAttempted(a.id)

    // An unclaimed extra external recipient must never be absorbed.
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n },
          { address: '5EXTRA', amount: 1n }
        ]
      })
    ])
    let result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [1, 2], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')

    // A duplicate history entry with a conflicting fee must not be averaged away.
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n }
        ]
      }),
      makeTransfer({
        fee: 18n,
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n }
        ]
      })
    ])
    result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [1, 2], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')
  })

  test('an ops sweep or consolidation with an extra external recipient is never proven', async () => {
    const wallet = makeWallet()
    const sweep = await prepareWalletTransaction({
      models: db,
      scope,
      tx: makeTx(),
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: '5COLDSTORE' }
    })
    await markAttempted(sweep.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5COLDSTORE', amount: 500n },
          { address: '5EXTRA', amount: 7n }
        ]
      })
    ])
    let result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: true, accountingUnpersisted: 0 })
    expect((await loadRow(sweep.id)).state).toBe('PREPARED')

    // A consolidation that paid an external address is not a self transfer.
    const consolidation = await prepareConsolidation({ tx: makeTx({ hash: 'e6'.repeat(32) }) })
    await markAttempted(consolidation.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({ hash: 'e6'.repeat(32), destinations: [{ address: '5EXTERNAL', amount: 7n }] })
    ])
    result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: true, accountingUnpersisted: 0 })
    expect((await loadRow(consolidation.id)).state).toBe('PREPARED')
    expect((await loadRow(sweep.id)).state).toBe('PREPARED')
  })

  test('a proven relay whose journal persist fails is reported, then recovered', async () => {
    const wallet = makeWallet()
    const a = await preparePayout()
    await markAttempted(a.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({
        destinations: [
          { address: '5RECIPIENTONE', amount: 60n },
          { address: '5RECIPIENTTWO', amount: 15n }
        ]
      })
    ])
    const models = {
      rewardsWalletTransaction: {
        findMany: (...args) => db.rewardsWalletTransaction.findMany(...args),
        findUnique: (...args) => db.rewardsWalletTransaction.findUnique(...args),
        updateMany: jest.fn().mockRejectedValue(new Error('journal db down'))
      }
    }

    const result = await reconcileWalletTransactions({ models, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [1, 2], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 1 })
    expect((await loadRow(a.id)).state).toBe('PREPARED')
    expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining(HASH))

    const recovered = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(recovered).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('RELAYED')
  })

  test('a proven ops sweep whose journal persist fails is reported, then recovered without another relay', async () => {
    const wallet = makeWallet()
    const sweep = await prepareWalletTransaction({
      models: db,
      scope,
      tx: makeTx(),
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: '5COLDSTORE' }
    })
    await markAttempted(sweep.id)
    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({ destinations: [{ address: '5COLDSTORE', amount: 500n }] })
    ])
    const models = {
      rewardsWalletTransaction: {
        findMany: (...args) => db.rewardsWalletTransaction.findMany(...args),
        findUnique: (...args) => db.rewardsWalletTransaction.findUnique(...args),
        updateMany: jest.fn().mockRejectedValue(new Error('journal db down'))
      }
    }

    const result = await reconcileWalletTransactions({ models, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: true, accountingUnpersisted: 1 })
    expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining(HASH))
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect((await loadRow(sweep.id)).state).toBe('PREPARED')

    const recovered = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(recovered).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(sweep.id)).state).toBe('RELAYED')
    expect(wallet.relayTx).not.toHaveBeenCalled()

    const idempotent = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(idempotent).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect(wallet.relayTx).not.toHaveBeenCalled()
  })

  test('a relay proven before an unpersisted journal write is recovered from history', async () => {
    const wallet = makeWallet()
    const a = await prepareConsolidation()
    let updates = 0
    const models = {
      rewardsWalletTransaction: {
        findUnique: (...args) => db.rewardsWalletTransaction.findUnique(...args),
        updateMany: (...args) => {
          updates += 1
          if (updates === 1) return db.rewardsWalletTransaction.updateMany(...args) // the attempt CAS
          return Promise.reject(new Error('journal persist down'))
        }
      }
    }

    const sent = await relayWalletTransaction({ models, wallet, journal: a, tx: makeTx() })
    expect(sent).toMatchObject({ relayed: true, uncertain: false, accountingUnpersisted: 1 })
    expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining(HASH))
    expect((await loadRow(a.id)).state).toBe('PREPARED')

    wallet.getOutgoingTransfers.mockResolvedValue([
      makeTransfer({ destinations: [{ address: scope.walletAddress, amount: 1n }] })
    ])
    const recovered = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(recovered).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(a.id)).state).toBe('RELAYED')
  })

  test('a RELAYED journal row stays proven when the recipient persist is missing', async () => {
    const wallet = makeWallet()
    const tx = makeTx()
    const a = await preparePayout({ tx })
    const sent = await relayWalletTransaction({ models: db, wallet, journal: a, tx })
    expect(sent.relayed).toBe(true)

    // The caller may not have persisted recipient rows yet; reconciliation must
    // not manufacture new uncertainty about an already-proven relay, and it
    // must never re-relay.
    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect(wallet.getOutgoingTransfers).not.toHaveBeenCalled()
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect((await loadRow(a.id)).state).toBe('RELAYED')
  })

  // Final-review Critical regression: a durable RELAYED payout journal entry
  // must recover/exclude its still-QUEUED members from durable proof alone —
  // never through the legacy history matcher, and never with a fresh relay —
  // even when the wallet-history read throws or returns nothing.
  test('a durable RELAYED payout proof recovers a QUEUED member without any history read', async () => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5DURABLERECOVERY', piconeros: 75n })
    const tx = makeTx({ hash: 'e7'.repeat(32) })
    const a = await preparePayout({
      tx,
      metadata: {
        payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: '75' }]
      }
    })
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet({ relayTx: jest.fn(async () => 'e7'.repeat(32)) }), journal: a, tx })
    expect(sent.relayed).toBe(true)
    expect((await db.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')

    try {
      // The history read FAILS: durable proof must still settle the row.
      const failingWallet = makeWallet({
        getOutgoingTransfers: jest.fn(async () => { throw new Error('history read down') })
      })
      const result = await reconcileWalletTransactions({ models: db, wallet: failingWallet, scope })
      expect(result).toEqual({
        uncertainPayoutIds: [],
        recoveredPayoutIds: [{ id: payout.id, txHash: 'e7'.repeat(32) }],
        uncertainSweep: false,
        accountingUnpersisted: 0
      })
      expect(failingWallet.getOutgoingTransfers).not.toHaveBeenCalled()
      expect((await db.rewardPayout.findUnique({ where: { id: payout.id } }))).toMatchObject({
        state: 'SENT',
        txHash: 'e7'.repeat(32)
      })

      // A history that returns NOTHING must not change the outcome: a second
      // reconciliation is idempotent (nothing recovered again).
      const emptyWallet = makeWallet({ getOutgoingTransfers: jest.fn(async () => []) })
      const again = await reconcileWalletTransactions({ models: db, wallet: emptyWallet, scope })
      expect(again).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
      expect(emptyWallet.relayTx).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test('a durable RELAYED proof that disagrees with the live payout is withheld with an alert', async () => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5DURABLEMISMATCH', piconeros: 75n })
    const tx = makeTx({ hash: 'e8'.repeat(32) })
    const a = await preparePayout({
      tx,
      principalPiconeros: 74n,
      metadata: {
        payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: '74' }]
      }
    })
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet({ relayTx: jest.fn(async () => 'e8'.repeat(32)) }), journal: a, tx })
    expect(sent.relayed).toBe(true)

    try {
      const wallet = makeWallet()
      const result = await reconcileWalletTransactions({ models: db, wallet, scope })
      expect(result).toEqual({
        uncertainPayoutIds: [payout.id],
        recoveredPayoutIds: [],
        uncertainSweep: false,
        accountingUnpersisted: 0
      })
      expect((await db.rewardPayout.findUnique({ where: { id: payout.id } }))).toMatchObject({
        state: 'QUEUED',
        txHash: null
      })
      expect(alert).toHaveBeenCalledWith('critical', 'rewards payout journal proof unresolved',
        expect.stringContaining(String(payout.id)), expect.anything())
      expect(wallet.relayTx).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test('an in-pass PREPARED promotion immediately recovers its live member', async () => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5PROMOTED', piconeros: 75n })
    try {
      const journal = await preparePayout({
        metadata: { payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: '75' }] }
      })
      await markAttempted(journal.id)
      const wallet = makeWallet({
        getOutgoingTransfers: jest.fn(async () => [
          makeTransfer({ destinations: [{ address: payout.recipientAddress, amount: 75n }] })
        ])
      })
      const result = await reconcileWalletTransactions({ models: db, wallet, scope })
      expect((await loadRow(journal.id)).state).toBe('RELAYED')
      expect(result.recoveredPayoutIds).toEqual([{ id: payout.id, txHash: HASH }])
      expect(result.uncertainPayoutIds).toEqual([])
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'SENT', txHash: HASH })
      expect(wallet.relayTx).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test.each(['member', 'hash', 'promoted member', 'promoted hash'])('a conflicting %s proof is rejected before any payout mutation', async conflict => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5CONFLICT', piconeros: 75n })
    try {
      const metadata = amount => ({ payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: String(amount) }] })
      const first = await preparePayout({ metadata: metadata(75n) })
      await db.rewardsWalletTransaction.update({ where: { id: first.id }, data: { state: 'RELAYED', relayedAt: new Date() } })
      const conflictingHash = 'ea'.repeat(32)
      const amount = conflict.includes('member') ? 74n : 75n
      const second = await preparePayout({ tx: makeTx({ hash: conflictingHash }), principalPiconeros: amount, metadata: metadata(amount) })
      const promoted = conflict.startsWith('promoted')
      await db.rewardsWalletTransaction.update({
        where: { id: second.id },
        data: promoted ? { relayAttemptedAt: new Date() } : { state: 'RELAYED', relayedAt: new Date() }
      })
      const updateMany = jest.fn(args => db.rewardPayout.updateMany(args))
      const models = {
        rewardsWalletTransaction: db.rewardsWalletTransaction,
        rewardPayout: { findMany: args => db.rewardPayout.findMany(args), updateMany }
      }
      const wallet = makeWallet({
        getOutgoingTransfers: jest.fn(async () => [
          makeTransfer({ hash: conflictingHash, destinations: [{ address: payout.recipientAddress, amount }] })
        ])
      })
      const result = await reconcileWalletTransactions({ models, wallet, scope })
      expect(result.uncertainPayoutIds).toEqual([payout.id])
      expect(result.recoveredPayoutIds).toEqual([])
      expect(updateMany).not.toHaveBeenCalled()
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'QUEUED', txHash: null })
      expect(alert).toHaveBeenCalledWith('critical', 'rewards payout journal proof unresolved', expect.any(String), expect.anything())
    } finally {
      await cleanup()
    }
  })

  test('an existing conflicting payout hash is not overwritten by recovery', async () => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5RECORDEDHASH', piconeros: 75n })
    try {
      const recordedHash = 'eb'.repeat(32)
      await db.rewardPayout.update({ where: { id: payout.id }, data: { txHash: recordedHash } })
      const journal = await preparePayout({ metadata: { payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: '75' }] } })
      await db.rewardsWalletTransaction.update({ where: { id: journal.id }, data: { state: 'RELAYED', relayedAt: new Date() } })
      const updateMany = jest.fn(args => db.rewardPayout.updateMany(args))
      const models = { rewardsWalletTransaction: db.rewardsWalletTransaction, rewardPayout: { findMany: args => db.rewardPayout.findMany(args), updateMany } }
      const result = await reconcileWalletTransactions({ models, wallet: makeWallet(), scope })
      expect(result.uncertainPayoutIds).toEqual([payout.id])
      expect(result.recoveredPayoutIds).toEqual([])
      expect(updateMany).not.toHaveBeenCalled()
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'QUEUED', txHash: recordedHash })
      expect(alert).toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test.each([
    ['recipient', { recipientAddress: '5CHANGED' }],
    ['amount', { piconeros: 76n }],
    ['hash', { txHash: 'ec'.repeat(32) }],
    ['completed recipient', { state: 'SENT', txHash: HASH, recipientAddress: '5CHANGED' }],
    ['completed amount', { state: 'CONFIRMED', txHash: HASH, piconeros: 76n }]
  ])('a concurrent %s change cannot authorize recovery or overwrite facts', async (_label, changed) => {
    const { payout, cleanup } = await seedQueuedPayout({ recipientAddress: '5RECOVERYRACE', piconeros: 75n })
    try {
      const journal = await preparePayout({ metadata: { payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: '75' }] } })
      await db.rewardsWalletTransaction.update({ where: { id: journal.id }, data: { state: 'RELAYED', relayedAt: new Date() } })
      const models = {
        rewardsWalletTransaction: db.rewardsWalletTransaction,
        rewardPayout: {
          findMany: args => db.rewardPayout.findMany(args),
          updateMany: async args => {
            await db.rewardPayout.update({ where: { id: payout.id }, data: changed })
            return db.rewardPayout.updateMany(args)
          }
        }
      }
      const result = await reconcileWalletTransactions({ models, wallet: makeWallet(), scope })
      expect(result.uncertainPayoutIds).toEqual([payout.id])
      expect(result.recoveredPayoutIds).toEqual([])
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'QUEUED', txHash: null, ...changed })
      expect(alert).toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test('a RELAYED ops sweep stays proven when the sweep persist is missing', async () => {
    const wallet = makeWallet()
    const tx = makeTx()
    const sweep = await prepareWalletTransaction({
      models: db,
      scope,
      tx,
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: '5COLDSTORE' }
    })
    const sent = await relayWalletTransaction({ models: db, wallet, journal: sweep, tx })
    expect(sent.relayed).toBe(true)

    // The caller's opsSwept/opsSweepTxHash persist may be missing; reconciliation
    // hands the already-proven journal fact to the ledger without re-relaying.
    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect(wallet.getOutgoingTransfers).not.toHaveBeenCalled()
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)

    const again = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(again).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect((await loadRow(sweep.id)).state).toBe('RELAYED')
  })

  test('sensitive wallet exceptions never reach the logs', async () => {
    const privateKeyName = 'a'.repeat(64)
    const credentialCode = 'cr_live_1a2b3c4d5e6f'
    const sensitive = Object.assign(new Error('seed absorb abandon ability'), {
      name: privateKeyName,
      code: credentialCode,
      privateSpendKey: 'f'.repeat(64),
      signedTxBlob: 'deadbeef'.repeat(8)
    })
    const wallet = makeWallet({
      relayTx: jest.fn(async () => { throw sensitive }),
      getOutgoingTransfers: jest.fn(async () => { throw sensitive })
    })
    const a = await prepareConsolidation()
    const relay = await relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })
    expect(relay).toMatchObject({ relayed: false, uncertain: true })
    const result = await reconcileWalletTransactions({ models: db, wallet, scope })
    expect(result.uncertainSweep).toBe(true)

    expect(logError).toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
    const logged = util.inspect([...logError.mock.calls, ...logWarn.mock.calls], { depth: 8, maxStringLength: Infinity })
    expect(logged).not.toContain(privateKeyName)
    expect(logged).not.toContain(credentialCode)
    expect(logged).not.toContain('seed absorb abandon')
    expect(logged).not.toContain('f'.repeat(64))
    expect(logged).not.toContain('deadbeef')
    // Every emitted diagnostic is one of the fixed, code-defined labels.
    for (const call of [...logError.mock.calls, ...logWarn.mock.calls]) {
      expect(ERROR_LABELS).toContain(call[0].errorClass)
    }
  })

  test('a real timeout classifies as the fixed timeout label, not its text', async () => {
    const timeoutText = 'sensitive timeout detail seed'
    const cases = [
      typeof DOMException !== 'undefined' ? new DOMException(timeoutText, 'TimeoutError') : Object.assign(new Error(timeoutText), { errno: 110 }),
      Object.assign(new Error(timeoutText), { errno: 110 })
    ]
    for (const thrown of cases) {
      jest.clearAllMocks()
      const wallet = makeWallet({ relayTx: jest.fn(async () => { throw thrown }) })
      const a = await prepareConsolidation()
      const result = await relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })
      expect(result.uncertain).toBe(true)
      const call = logError.mock.calls.find(args => String(args[1]).includes('relay outcome uncertain'))
      expect(call[0]).toMatchObject({ errorClass: 'timeout' })
      expect(util.inspect(call, { depth: 8 })).not.toContain(timeoutText)
      await db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } })
    }
  })

  test.each([
    { label: 'network errno', markers: { errno: 111 }, expected: 'connection' },
    { label: 'numeric rpc code', markers: { code: -17 }, expected: 'rpc' },
    { label: 'unrecognized shape', markers: { message: 'credential-like text' }, expected: 'unknown' }
  ])('classifies a $label structurally as $expected', async ({ markers, expected }) => {
    const wallet = makeWallet({ relayTx: jest.fn(async () => { throw Object.assign(new Error('ignored'), markers) }) })
    const a = await prepareConsolidation()
    await relayWalletTransaction({ models: db, wallet, journal: a, tx: makeTx() })
    const call = logError.mock.calls.find(args => String(args[1]).includes('relay outcome uncertain'))
    expect(call[0]).toMatchObject({ errorClass: expected })
  })

  test('a different wallet identity is refused before it is read as an authority', async () => {
    const tx = makeTx()
    const a = await prepareConsolidation({ tx })
    await markAttempted(a.id)

    await expect(assertWalletScope(makeWallet({ getPrimaryAddress: async () => '5OTHERWALLET' }), scope)).rejects.toThrow(/mismatch/i)
    await expect(assertWalletScope(makeWallet({ getNetworkType: async () => 0 }), scope)).rejects.toThrow(/mismatch/i)
    await expect(assertWalletScope({}, scope)).rejects.toThrow(/mismatch/i)
    await expect(reconcileWalletTransactions({
      models: db, wallet: makeWallet({ getPrimaryAddress: async () => '5OTHERWALLET' }), scope
    })).rejects.toThrow(/mismatch/i)
    await expect(reconcileWalletTransactions({
      models: db, wallet: makeWallet({ getNetworkType: async () => 0 }), scope
    })).rejects.toThrow(/mismatch/i)
    await expect(relayWalletTransaction({
      models: db, wallet: makeWallet({ getNetworkType: async () => 0 }), journal: a, tx
    })).rejects.toThrow(/mismatch/i)

    // Nothing was relayed or burned on the mismatched wallet.
    const stored = await loadRow(a.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()

    // The installed library's network constants: MAINNET=0, STAGENET=2.
    await assertWalletScope(makeWallet({ getNetworkType: async () => 2 }), { network: 'STAGENET', walletAddress: scope.walletAddress })
    await assertWalletScope(makeWallet({ getNetworkType: async () => 0 }), { network: 'MAINNET', walletAddress: scope.walletAddress })
  })

  test.each([null, false, '', '0', 1, undefined, '2'])('refuses a malformed wallet network value %p', async value => {
    await expect(assertWalletScope(makeWallet({ getNetworkType: async () => value }), scope)).rejects.toThrow(/mismatch/i)
  })

  test('concurrent identical preparations settle on one journal row', async () => {
    const tx = makeTx()
    const results = await Promise.all([0, 1, 2, 3].map(() => prepareConsolidation({ tx })))
    expect(new Set(results.map(r => String(r.id))).size).toBe(1)
    expect(await db.rewardsWalletTransaction.count({ where: { txHash: HASH, walletAddress: scope.walletAddress } })).toBe(1)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: scope.walletAddress, state: 'PREPARED' } })).toBe(1)
  })
})
