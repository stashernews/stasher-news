/* eslint-env jest */

// Stubbed-wallet unit tests for the rewards hot-wallet signer (Task 9 / spec §6.2).
//
// These verify the sendPAYOUTS LOGIC + state machine WITHOUT a real stagenet
// wallet or spend keys: the wallet is injected (a plain object exposing
// createTx / getUnlockedBalance) and the Prisma client is an in-memory stub, so
// the suite never touches the network or spends real XMR. This is the Task-9
// primary gate; a real stagenet send is exercised end-to-end in Task 10.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/api/monero/rewards.test.js

import { sendPayouts } from '@/api/monero/rewards'
import { logInfo, logError } from '../../../lib/logger'

// D1 migrated rewards.js from console.* to the pino logger (lib/logger.js), so
// CRITICAL/relayed logs no longer hit console.error/console.log. Mock the logger
// with a relative path (next/jest gives jest.mock no `@/` alias) and assert on
// the logInfo/logError stubs — mirrors test/worker/deleteUnusedImages.test.js.
jest.mock('../../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))

// Build a QUEUED RewardPayout-shaped row (BigInt piconeros, like the schema).
let idSeq = 1000
function makePayout (overrides = {}) {
  idSeq += 1
  return {
    id: idSeq,
    distributionId: 1,
    curatorId: 1,
    recipientAddress: '5' + 'A'.repeat(94),
    piconeros: 1_000_000_000n,
    txHash: null,
    state: 'QUEUED',
    ...overrides
  }
}

// In-memory rewardPayout store: update() mutates + returns the row, mirroring
// Prisma's shape so sendPayouts can be driven without a database.
function makeFakeModels (rows) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  return {
    store,
    rewardPayout: {
      async update ({ where, data }) {
        const row = store.get(where.id)
        if (!row) throw new Error(`fake rewardPayout.update: id ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      }
    }
  }
}

// Fake wallet. createTx records each request and returns a stub tx whose
// getHash() yields a stable 64-hex-char string (the real monero-ts wallet
// returns a hex string too). throwsOn maps a destination address -> Error to
// simulate hard failures.
function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, throwsOn = {} } = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    async getUnlockedBalance () { return unlocked },
    async createTx (req) {
      calls.push(req)
      if (throwsOn[req.destinations?.[0]?.address]) throw throwsOn[req.destinations[0].address]
      n += 1
      const hash = 'ab' + String(n).padStart(6, '0') + 'cd'.repeat(28) // 2+6+56 = 64 hex chars
      return { getHash: () => hash, getFee: async () => 50_000_000n }
    }
  }
}

test('sends all QUEUED payouts in a single createTx with destinations', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA' })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB' })
  const p3 = makePayout({ id: 3, recipientAddress: '5CCC' })
  const models = makeFakeModels([p1, p2, p3])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([p1, p2, p3], { models, wallet })
  expect(summary).toEqual({ sent: 3, failed: 0, skipped: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    destinations: [
      { address: '5AAA', amount: 1_000_000_000n },
      { address: '5BBB', amount: 1_000_000_000n },
      { address: '5CCC', amount: 1_000_000_000n }
    ],
    relay: true
  })
  for (const p of [p1, p2, p3]) {
    const row = models.store.get(p.id)
    expect(row.state).toBe('SENT')
    expect(row.txHash).toMatch(/^[0-9a-f]{64}$/)
  }
  const hashes = new Set([p1, p2, p3].map(p => models.store.get(p.id).txHash))
  expect(hashes.size).toBe(1) // one tx, one shared hash
})

test('skips the whole batch when unlocked balance cannot cover the sum', async () => {
  const p1 = makePayout({ id: 1, piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ unlocked: 5_000_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 2 })
  expect(models.store.get(p1.id).state).toBe('QUEUED')
  expect(models.store.get(p2.id).state).toBe('QUEUED')
  expect(wallet.calls).toHaveLength(0)
})

test('marks every payout FAILED when createTx throws a hard error', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BADADDR' })
  const p2 = makePayout({ id: 2, recipientAddress: '5GOOD' })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ throwsOn: { '5BADADDR': new Error('invalid recipient address') } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 2, skipped: 0 })
  expect(models.store.get(p1.id).state).toBe('FAILED')
  expect(models.store.get(p2.id).state).toBe('FAILED')
  expect(models.store.get(p1.id).txHash).toBeNull() // funds stayed in the wallet
})

test('treats a not-enough-money createTx error as a SKIP for the whole batch', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5LOCKED' })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ throwsOn: { '5LOCKED': new Error('not enough unlocked money') } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('is a no-op when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ id: 1, state: 'SENT', txHash: 'ab'.repeat(32) })
  const models = makeFakeModels([alreadySent])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([alreadySent], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0 })
  expect(wallet.calls).toHaveLength(0)
})

test('handles an empty payout list', async () => {
  const models = makeFakeModels([])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0 })
  expect(wallet.calls).toHaveLength(0)
})

test('persists the shared tx hash (SENT) when a DB update throws then retry succeeds', async () => {
  const p1 = makePayout({ id: 1 })
  const p2 = makePayout({ id: 2 })
  const update = jest.fn()
    .mockRejectedValueOnce(new Error('transient db connection blip')) // first p1 persist blips
    .mockResolvedValue({ id: p1.id, state: 'SENT' })
    .mockResolvedValue({ id: p2.id, state: 'SENT' })
  const models = { rewardPayout: { update } }
  const wallet = makeFakeWallet()
  logInfo.mockClear()
  logError.mockClear()
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0 })
  expect(update).toHaveBeenCalledTimes(3) // p1: fail + retry, p2: once
  const persisted = update.mock.calls[1][0].data
  expect(persisted.state).toBe('SENT')
  expect(persisted.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(update.mock.calls[2][0].data.txHash).toBe(persisted.txHash) // same batch hash
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: p1.id, txHash: persisted.txHash }),
    expect.stringContaining('CRITICAL')
  )
})
