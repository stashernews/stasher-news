/* eslint-env jest */

// Stubbed-wallet unit tests for sweepOpsEarmark (task B3 / spec §6.4).
//
// These verify the ops-sweep state machine WITHOUT a real stagenet wallet or
// spend keys: the wallet is injected (a plain object exposing createTx /
// getUnlockedBalance) and the Prisma client is an in-memory stub, so the suite
// never touches the network or spends real XMR. Mirrors the
// sendPayouts stubbed-wallet tests in test/api/monero/rewards.test.js.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/opsSweep.test.js

import { sweepOpsEarmark } from '@/api/monero/rewards'
import { logError } from '../../lib/logger'

// D1 migrated rewards.js from console.* to the pino logger (lib/logger.js), so
// CRITICAL/relayed logs no longer hit console.error/console.log. Mock the logger
// with a relative path (next/jest gives jest.mock no `@/` alias) and assert on
// the logError stub — mirrors test/worker/deleteUnusedImages.test.js.
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))

const COLD_ADDRESS = '5COLD' + 'A'.repeat(90)
const MIN_FLOOR = 1_000_000_000n // default REWARDS_OPS_SWEEP_MIN_PICONEROS (0.001 XMR)

let savedCold, savedEnabled
beforeAll(() => {
  savedCold = process.env.REWARDS_COLD_STORAGE_ADDRESS
  savedEnabled = process.env.REWARDS_OPS_SWEEP_ENABLED
  process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD_ADDRESS
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'true'
})
afterAll(() => {
  if (savedCold === undefined) delete process.env.REWARDS_COLD_STORAGE_ADDRESS
  else process.env.REWARDS_COLD_STORAGE_ADDRESS = savedCold
  if (savedEnabled === undefined) delete process.env.REWARDS_OPS_SWEEP_ENABLED
  else process.env.REWARDS_OPS_SWEEP_ENABLED = savedEnabled
})

function makeDistribution (overrides = {}) {
  return {
    id: 1,
    opsAvailablePiconeros: 5_000_000_000_000n,
    opsSweptPiconeros: 0n,
    opsSweepTxHash: null,
    opsSweepState: 'NOT_SWEEPED',
    ...overrides
  }
}

function makeFakeModels (distribution) {
  const store = { ...distribution }
  return {
    store,
    rewardDistribution: {
      async update ({ where, data }) {
        if (store.id !== where.id) throw new Error(`fake rewardDistribution.update: id ${where.id} not found`)
        Object.assign(store, data)
        return { ...store }
      }
    }
  }
}

function makeFakeWallet ({ unlocked = 10_000_000_000_000n, unlockedAfterSync, throwsOn = false, throwErr = null } = {}) {
  const calls = []
  const order = []
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
      if (throwsOn) throw throwErr
      n += 1
      const hash = 'ab' + String(n).padStart(6, '0') + 'cd'.repeat(28) // 2+6+56 = 64 hex chars
      return { getHash: () => hash }
    }
  }
}

test('skips (SKIPPED_LOCKED) when the ops earmark is at/below the dust floor and never calls createTx', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: MIN_FLOOR })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('skips (SKIPPED_LOCKED) when unlocked balance minus the dust floor is negative', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 500_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
})

test('sweeps the ops earmark (SWEPT) when it fits under unlocked minus the floor', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(3_000_000_000_000n)
  expect(res.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    address: COLD_ADDRESS,
    amount: 3_000_000_000_000n,
    relay: true
  })
  expect(models.store.opsSweepState).toBe('SWEPT')
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toBe(res.txHash)
})

test('caps the swept amount at unlocked minus the dust floor when the earmark exceeds it', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 20_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(10_000_000_000_000n - MIN_FLOOR)
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].amount).toBe(10_000_000_000_000n - MIN_FLOOR)
})

test('skips (SKIPPED_LOCKED) on a balance error from createTx, not FAILED', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('not enough unlocked money')
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('marks FAILED on a hard createTx error (funds stayed in the wallet)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('invalid recipient address')
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(0n)
  expect(models.store.opsSweepTxHash).toBeNull()
})

test('is idempotent on a distribution already SWEPT (no createTx call)', async () => {
  const dist = makeDistribution({
    opsSweepState: 'SWEPT',
    opsSweptPiconeros: 3_000_000_000_000n,
    opsSweepTxHash: 'ab'.repeat(32)
  })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SWEPT', txHash: 'ab'.repeat(32), swept: 3_000_000_000_000n })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.order).toEqual([])
})

test('returns DISABLED and never calls the wallet when REWARDS_COLD_STORAGE_ADDRESS is unset', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const saved = process.env.REWARDS_COLD_STORAGE_ADDRESS
  process.env.REWARDS_COLD_STORAGE_ADDRESS = ''
  try {
    const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
    expect(res).toEqual({ state: 'DISABLED' })
    expect(wallet.calls).toHaveLength(0)
    expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  } finally {
    process.env.REWARDS_COLD_STORAGE_ADDRESS = saved
  }
})

test('returns DISABLED when REWARDS_OPS_SWEEP_ENABLED is false', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const saved = process.env.REWARDS_OPS_SWEEP_ENABLED
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'false'
  try {
    const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
    expect(res).toEqual({ state: 'DISABLED' })
    expect(wallet.calls).toHaveLength(0)
  } finally {
    process.env.REWARDS_OPS_SWEEP_ENABLED = saved
  }
})

test('persists SWEPT (not FAILED) when the first DB update throws but the retry succeeds', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const update = jest.fn()
    .mockRejectedValueOnce(new Error('transient db connection blip'))
    .mockResolvedValue({ id: dist.id })
  const models = { rewardDistribution: { update } }
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  logError.mockClear()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(update).toHaveBeenCalledTimes(2)
  const persisted = update.mock.calls[1][0].data
  expect(persisted.opsSweepState).toBe('SWEPT')
  expect(persisted.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(persisted.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id, txHash: persisted.opsSweepTxHash }),
    expect.stringContaining('CRITICAL')
  )
})

test('sweeps once the wallet is synced, even when the cached balance was stale', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  // Cached view stale: 500e6 - floor is negative -> would SKIPPED_LOCKED. The
  // sync refreshes it to cover the earmark.
  const wallet = makeFakeWallet({ unlocked: 500_000_000n, unlockedAfterSync: 10_000_000_000_000n })

  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })

  expect(res.state).toBe('SWEPT')
  expect(wallet.order).toEqual(['sync', 'getUnlockedBalance', 'createTx'])
})

test('syncs the wallet exactly once before reading the balance when a sweep is attempted', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()

  await sweepOpsEarmark({ distribution: dist, models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})
