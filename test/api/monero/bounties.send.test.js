/* eslint-env jest */

// Stubbed-wallet unit tests for the bounty escrow signer's fee settlement
// (A-13, 2026-08-19 beta incident). The wallet is injected (a plain object
// exposing getUnlockedBalance / createTx / getTx) and the Prisma client is an
// in-memory stub, so the suite never touches the network or spends real XMR —
// same pattern as test/api/monero/rewards.test.js.
//
// Covers the fee-settlement defer/retry: a fee that fails with a balance error
// (the payout's change output is locked until the payout tx confirms) is
// deferred (feePendingAt set, feeTxHash NULL) and retried on a later tick for
// SENT payouts; a hard (non-balance) fee error still fails loudly and is left
// for manual reconciliation (never auto-retried).

import { sendBountyPayments } from '@/api/monero/bounties'
import { logInfo, logError } from '../../../lib/logger'
import { alert } from '../../../lib/alert'

jest.mock('../../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))

jest.mock('../../../lib/alert', () => ({ alert: jest.fn() }))

const FEE_ADDR = '5' + 'C'.repeat(94)
const WINNER_ADDR = '5' + 'A'.repeat(94)

beforeAll(() => {
  process.env.REWARDS_COLD_STORAGE_ADDRESS = FEE_ADDR
})
afterAll(() => {
  delete process.env.REWARDS_COLD_STORAGE_ADDRESS
})

let idSeq = 1000
function makePayout (overrides = {}) {
  idSeq += 1
  return {
    id: idSeq,
    itemId: 1,
    winnerUserId: 1,
    piconeros: 1_000_000_000n,
    feePiconeros: 10_000_000_000n,
    recipientAddress: WINNER_ADDR,
    kind: 'AWARD',
    txHash: null,
    feeTxHash: null,
    feePendingAt: null,
    height: null,
    state: 'QUEUED',
    ...overrides
  }
}

function makeFakeModels (rows) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  return {
    store,
    bountyPayment: {
      async update ({ where, data }) {
        const row = store.get(where.id)
        if (!row) throw new Error(`fake bountyPayment.update: id ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      }
    }
  }
}

function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, unlockedAfterSync, throwsOn = {} } = {}) {
  const calls = [] // createTx requests only (existing assertions depend on this shape)
  const order = [] // method-call order: 'sync' | 'getUnlockedBalance' | 'createTx'
  let balance = unlocked
  let n = 0
  return {
    calls,
    order,
    async sync () {
      order.push('sync')
      if (unlockedAfterSync !== undefined) balance = unlockedAfterSync
    },
    async getUnlockedBalance () {
      order.push('getUnlockedBalance')
      return balance
    },
    async createTx (req) {
      order.push('createTx')
      calls.push(req)
      if (throwsOn[req.address]) throw throwsOn[req.address]
      n += 1
      const hash = 'ab' + String(n).padStart(6, '0') + 'cd'.repeat(28) // 2+6+56 = 64 hex chars
      return { getHash: () => hash }
    },
    async getTx () { return { getHeight: async () => 200 } }
  }
}

test('defers the fee (feePendingAt set, feeTxHash NULL) when fee settlement hits a balance error; payout still SENT', async () => {
  const payout = makePayout()
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ throwsOn: { [FEE_ADDR]: new Error('not enough unlocked money') } })
  logInfo.mockClear()
  logError.mockClear()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
  const row = models.store.get(payout.id)
  expect(row.state).toBe('SENT')
  expect(row.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(row.feeTxHash).toBeNull()
  expect(row.feePendingAt).toBeInstanceOf(Date)
  expect(wallet.calls).toHaveLength(2) // payout + failed fee attempt
  expect(logError).not.toHaveBeenCalled() // balance error is retryable, not loud
})

test('a hard (non-balance) fee error still fails loudly and does NOT set feePendingAt', async () => {
  const payout = makePayout()
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ throwsOn: { [FEE_ADDR]: new Error('invalid recipient address') } })
  logInfo.mockClear()
  logError.mockClear()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
  const row = models.store.get(payout.id)
  expect(row.state).toBe('SENT')
  expect(row.feeTxHash).toBeNull()
  expect(row.feePendingAt).toBeNull()
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: payout.id }),
    expect.stringContaining('reconcile manually')
  )
})

test('settles a deferred fee for a SENT payout on a later run (feeTxHash set exactly once, feePendingAt cleared, payout not re-sent)', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 1 })
  const row = models.store.get(payout.id)
  expect(row.state).toBe('SENT')
  expect(row.txHash).toBe('ab'.repeat(32)) // payout tx untouched
  expect(row.feeTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(row.feePendingAt).toBeNull()
  expect(wallet.calls).toHaveLength(1) // fee only, no payout re-send
  expect(wallet.calls[0]).toEqual({ accountIndex: 0, address: FEE_ADDR, amount: 10_000_000_000n, relay: true })
})

test('skips a deferred-fee retry while the unlocked balance is still short (fee stays pending)', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 5_000_000_000n }) // < feePiconeros

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
  const row = models.store.get(payout.id)
  expect(row.feeTxHash).toBeNull()
  expect(row.feePendingAt).toBeInstanceOf(Date)
  expect(wallet.calls).toHaveLength(0)
})

test('a hard fee error during a deferred-fee retry clears feePendingAt and fails loudly (manual reconciliation)', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ throwsOn: { [FEE_ADDR]: new Error('invalid recipient address') } })
  logInfo.mockClear()
  logError.mockClear()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
  const row = models.store.get(payout.id)
  expect(row.feeTxHash).toBeNull()
  expect(row.feePendingAt).toBeNull() // no auto-retry for hard errors
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: payout.id }),
    expect.stringContaining('reconcile manually')
  )
})

test('never double-sends the fee: a SENT payout with feeTxHash already set is left alone', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feeTxHash: 'cd'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
  expect(models.store.get(payout.id).feeTxHash).toBe('cd'.repeat(32))
  expect(wallet.calls).toHaveLength(0)
})

test('a fee relayed but unpersisted alerts CRITICAL and stops auto-retry (no double-send)', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  let updateCalls = 0
  models.bountyPayment.update = async ({ where, data }) => {
    updateCalls += 1
    if (updateCalls === 1) throw new Error('transient db blip') // persist feeTxHash fails
    Object.assign(models.store.get(where.id), data) // clear feePendingAt succeeds
    return { ...models.store.get(where.id) }
  }
  const wallet = makeFakeWallet()
  alert.mockClear()
  logError.mockClear()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
  const row = models.store.get(payout.id)
  expect(row.feeTxHash).toBeNull()
  expect(row.feePendingAt).toBeNull() // auto-retry stopped -> no double-send
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'fee-relayed-but-unpersisted',
    expect.stringContaining('relayed but DB persist failed'),
    expect.any(Object)
  )
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: payout.id }),
    expect.stringContaining('CRITICAL')
  )
})

test('settles a deferred fee whose change unlocked after the wallet was opened (sync refreshes the stale cached balance)', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  // Cached view is stale (pre-change-unlock): 1e9 < 10e9 fee. The sync refreshes
  // it to 21.9e9 (the live probe value from the 2026-08-20 incident) >= fee.
  const wallet = makeFakeWallet({ unlocked: 1_000_000_000n, unlockedAfterSync: 21_900_000_000n })

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 1 })
  const row = models.store.get(payout.id)
  expect(row.feeTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(row.feePendingAt).toBeNull()
  expect(wallet.order).toEqual(['sync', 'getUnlockedBalance', 'createTx'])
})

test('syncs the wallet exactly once before reading the unlocked balance whenever there is dispatch work', async () => {
  const payout = makePayout()
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet()

  await sendBountyPayments([payout], { models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('does not touch the wallet when there is nothing queued or pending (no sync in the hot path)', async () => {
  const models = makeFakeModels([])
  const wallet = makeFakeWallet()

  const summary = await sendBountyPayments([], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
  expect(wallet.order).toEqual([])
})
