/* eslint-env jest */

// Stubbed-wallet unit tests for the bounty escrow signer's dispatch loop
// (A-13, 2026-08-19 beta incident). The wallet is injected (a plain object
// exposing getUnlockedBalance / createTx / getTx) and the Prisma client is an
// in-memory stub, so the suite never touches the network or spends real XMR —
// same pattern as test/api/monero/rewards.test.js.
//
// Covers: single-tx payout dispatch (prize + platform fee as destinations with
// the network fee subtracted from the last destination); the insufficient-
// balance skip-streak alert, exercised from both the pre-dispatch guard and
// the in-createTx balance-error catch; and the legacy fee-settlement
// defer/retry (feePendingAt) for payouts sent before 2026-09-18. Hard
// (non-balance) errors still fail loudly and are left for manual
// reconciliation (never auto-retried).

import { sendBountyPayments, __resetSkipStreaks } from '@/api/monero/bounties'
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
    },
    // ROLLOVER booking reads the item and inserts a BOUNTY_ROLLOVER
    // FeeObservation through $queryRaw; no-op stubs keep the tx-focused tests
    // independent of booking SQL.
    item: { async findUnique () { return { id: 1, bountyPiconeros: 12_000_000_000n } } },
    async $queryRaw () { return [] }
  }
}

function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, unlockedAfterSync, throwsOn = {}, netFee = 0n } = {}) {
  const calls = [] // createTx requests only (existing assertions depend on this shape)
  const order = [] // method-call order: 'sync' | 'getUnlockedBalance' | 'createTx'
  let balance = unlocked
  let n = 0
  return {
    calls,
    order,
    setUnlocked (value) { balance = value },
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
      const addresses = req.destinations ? req.destinations.map(d => d.address) : [req.address]
      for (const address of addresses) {
        if (throwsOn[address]) throw throwsOn[address]
      }
      // Model wallet2's balance requirement: the network fee is charged on top
      // of the destination sum unless subtractFeeFrom folds it into a
      // destination (netFee defaults to 0 for the legacy fee-retry tests).
      const destSum = req.destinations
        ? req.destinations.reduce((acc, d) => acc + BigInt(d.amount), 0n)
        : BigInt(req.amount)
      if (balance < destSum + (req.subtractFeeFrom ? 0n : netFee)) {
        throw new Error('not enough unlocked money')
      }
      balance -= destSum + (req.subtractFeeFrom ? 0n : netFee)
      n += 1
      const hash = 'ab' + String(n).padStart(6, '0') + 'cd'.repeat(28) // 2+6+56 = 64 hex chars
      return { getHash: () => hash }
    },
    async getTx () { return { getHeight: async () => 200 } }
  }
}

test('dispatches an award on exactly prize + platform fee in one tx, draining the escrow exactly', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 12_000_000_000n, netFee: 40_000n })

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(await wallet.getUnlockedBalance(0)).toBe(0n)
  expect(models.store.get(payout.id).state).toBe('SENT')
})

test('AWARD sends prize and platform fee as two destinations, subtracting the fee from the ops cut', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 12_000_000_000n, netFee: 40_000n })

  await sendBountyPayments([payout], { models, wallet })

  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    destinations: [
      { address: WINNER_ADDR, amount: 10_000_000_000n },
      { address: FEE_ADDR, amount: 2_000_000_000n }
    ],
    subtractFeeFrom: [1],
    relay: true
  })
})

test('wallet2 contract: the winner receives the exact prize and ops receives fee minus the network fee', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const netFee = 40_000n
  const wallet = makeFakeWallet({ unlocked: 12_000_000_000n, netFee })

  await sendBountyPayments([payout], { models, wallet })

  const req = wallet.calls[0]
  const effective = req.destinations.map((d, i) => ({
    address: d.address,
    amount: BigInt(d.amount) - (req.subtractFeeFrom.includes(i) ? netFee : 0n)
  }))
  expect(effective[0]).toEqual({ address: WINNER_ADDR, amount: 10_000_000_000n })
  expect(effective[1]).toEqual({ address: FEE_ADDR, amount: 2_000_000_000n - netFee })
})

test('ROLLOVER sends the full amount as one destination with the miner fee subtracted from it', async () => {
  const payout = makePayout({ kind: 'ROLLOVER', piconeros: 12_000_000_000n, feePiconeros: 0n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 12_000_000_000n, netFee: 40_000n })

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    destinations: [{ address: WINNER_ADDR, amount: 12_000_000_000n }],
    subtractFeeFrom: [0],
    relay: true
  })
  expect(await wallet.getUnlockedBalance(0)).toBe(0n)
})

test('a hard createTx error (non-balance) marks the payout FAILED with the funds still in escrow', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({
    unlocked: 12_000_000_000n,
    netFee: 40_000n,
    throwsOn: { [WINNER_ADDR]: new Error('invalid recipient address') }
  })
  logError.mockClear()

  const summary = await sendBountyPayments([payout], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0, settled: 0 })
  expect(models.store.get(payout.id).state).toBe('FAILED')
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: payout.id }),
    expect.stringContaining('FAILED (funds stayed in escrow)')
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

test('alerts exactly once after N consecutive insufficient-balance skips, naming the payout', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 0n, netFee: 40_000n })
  alert.mockClear()

  for (let i = 0; i < 4; i++) {
    const summary = await sendBountyPayments([payout], { models, wallet })
    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
  }
  expect(alert).not.toHaveBeenCalled()

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'bounty payout stuck — insufficient escrow balance',
    expect.stringContaining(`payout ${payout.id}`),
    expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
  )

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1) // does not re-fire while the streak continues
})

test('a dispatched payout clears its streak, and a later strand alerts on a fresh streak', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 0n, netFee: 40_000n })
  alert.mockClear()

  for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models, wallet })
  expect(alert).not.toHaveBeenCalled()

  wallet.setUnlocked(12_000_000_000n)
  expect((await sendBountyPayments([payout], { models, wallet })).sent).toBe(1)
  expect(alert).not.toHaveBeenCalled() // the dispatch cleared the streak

  alert.mockClear()
  for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models, wallet })
  expect(alert).not.toHaveBeenCalled()
  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1)
})

test('a legacy deferred-fee retry stuck on a short balance also alerts after N runs', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 5_000_000_000n }) // < feePiconeros (10e9)
  alert.mockClear()

  for (let i = 0; i < 5; i++) {
    const summary = await sendBountyPayments([payout], { models, wallet })
    expect(summary.skipped).toBe(1)
  }

  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'bounty payout stuck — insufficient escrow balance',
    expect.stringContaining(`payout ${payout.id}`),
    expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
  )
})

test('__resetSkipStreaks clears the consecutive-skip state', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  const wallet = makeFakeWallet({ unlocked: 0n, netFee: 40_000n })
  alert.mockClear()

  for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models, wallet })
  __resetSkipStreaks()
  for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models, wallet })
  expect(alert).not.toHaveBeenCalled()

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1) // a fresh streak needs a full N
})

test('a QUEUED payout that passes the guard but fails createTx on balance (in-createTx catch) alerts after N runs', async () => {
  const payout = makePayout({ piconeros: 10_000_000_000n, feePiconeros: 2_000_000_000n })
  const models = makeFakeModels([payout])
  // The guard passes (local unlocked 12e9 >= needs 12e9) but wallet2 cannot
  // gather inputs for the tx despite the sufficient unlocked total and throws
  // a balance-class error inside createTx — the skip must go through the
  // in-createTx catch, which must bump the streak like the guard path does.
  const wallet = makeFakeWallet({
    unlocked: 12_000_000_000n,
    netFee: 40_000n,
    throwsOn: { [WINNER_ADDR]: new Error('not enough unlocked money') }
  })
  alert.mockClear()

  for (let i = 0; i < 4; i++) {
    const summary = await sendBountyPayments([payout], { models, wallet })
    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
  }
  expect(alert).not.toHaveBeenCalled()

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'bounty payout stuck — insufficient escrow balance',
    expect.stringContaining(`payout ${payout.id}`),
    expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
  )

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1) // does not re-fire while the streak continues
})

// Characterization coverage of the legacy branch's existing in-createTx catch bump (green from birth by design).
test('a legacy deferred-fee retry that passes its guard but fails createTx on the network fee alerts after N runs', async () => {
  const payout = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
  const models = makeFakeModels([payout])
  // Guard passes exactly (unlocked == feePiconeros) but createTx additionally
  // needs the network fee (10e9 + 40k) and throws a balance error in-createTx.
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, netFee: 40_000n })
  alert.mockClear()

  for (let i = 0; i < 4; i++) {
    const summary = await sendBountyPayments([payout], { models, wallet })
    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
  }
  expect(alert).not.toHaveBeenCalled()

  await sendBountyPayments([payout], { models, wallet })
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'bounty payout stuck — insufficient escrow balance',
    expect.stringContaining(`payout ${payout.id}`),
    expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
  )
})
