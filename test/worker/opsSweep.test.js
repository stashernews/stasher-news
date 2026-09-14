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
import { logInfo, logWarn, logError } from '../../lib/logger'

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

function makeFakeWallet ({ unlocked = 10_000_000_000_000n, unlockedByAccount, unlockedAfterSync, throwsOn = false, throwErr = null, throwsOnAccount = {}, fee = 0n } = {}) {
  const calls = []
  const relayCalls = []
  const order = []
  let byAccount = unlockedByAccount || { 0: unlocked }
  let n = 0
  const hash = () => 'ab' + String(++n).padStart(6, '0') + 'cd'.repeat(28) // 64 hex chars
  async function getBalance (idx) { return BigInt(byAccount[idx] || 0n) }
  return {
    calls,
    relayCalls,
    order,
    async sync () {
      order.push('sync')
      if (unlockedAfterSync !== undefined) byAccount = { 0: unlockedAfterSync }
    },
    async getUnlockedBalance (idx) {
      order.push('getUnlockedBalance')
      return getBalance(idx)
    },
    async createTx (req) {
      order.push('createTx')
      calls.push(req)
      if (throwsOnAccount[req.accountIndex]) throw throwsOnAccount[req.accountIndex]
      if (throwsOn) throw throwErr
      // fee-aware balance validation mirrors the real wallet on every create:
      // the fee is charged on top of the destination amount, from the source account.
      if (BigInt(fee) > 0n && await getBalance(req.accountIndex) < BigInt(req.amount) + BigInt(fee)) {
        throw new Error('not enough unlocked money')
      }
      return { getHash: () => hash(), getFee: async () => BigInt(fee) }
    },
    async relayTx (req) {
      relayCalls.push(req)
      return req.getHash() // the real wallet returns the relayed tx hash
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
    relay: false
  })
  expect(wallet.relayCalls).toHaveLength(1)
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
  expect(wallet.order[0]).toBe('sync')
  expect(wallet.order[wallet.order.length - 1]).toBe('createTx')
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('syncs the wallet exactly once before reading the balance when a sweep is attempted', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()

  await sweepOpsEarmark({ distribution: dist, models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('sweeps across multiple accounts when the earmark exceeds any single account (2026-08-24 fix)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n } })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(5_000_000_000_000n)
  expect(wallet.calls).toHaveLength(2)
  expect(wallet.calls[0]).toEqual({ accountIndex: 0, address: COLD_ADDRESS, amount: 3_000_000_000_000n, relay: false })
  expect(wallet.calls[1]).toEqual({ accountIndex: 1, address: COLD_ADDRESS, amount: 2_000_000_000_000n, relay: false })
  expect(wallet.relayCalls).toHaveLength(2)
  expect(models.store.opsSweptPiconeros).toBe(5_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/)
})

test('persists the partial sweep (relayed hashes + swept amount) when a later account hard-fails', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n },
    throwsOnAccount: { 1: new Error('invalid recipient address') }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('FAILED')
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
})

test('fee-aware sweeps: full-balance accounts send unlocked minus fee headroom, not a silent SKIPPED_LOCKED (audit #1)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_500_000_000_000n })
  const models = makeFakeModels(dist)
  // The earmark (5.5e12) exceeds either account (3e12 / 2.5e12), so BOTH sends
  // are full-balance sends. With relay:true + no fee awareness every createTx
  // threw 'not enough unlocked money' and the sweep no-op'd SKIPPED_LOCKED.
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n },
    fee: 400_000_000n // 0.0004 XMR — inside the 0.001 XMR headroom default
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  // each account: first attempt = full balance (fee overflows), retry decrements by the headroom
  expect(wallet.calls[0]).toEqual({ accountIndex: 0, address: COLD_ADDRESS, amount: 3_000_000_000_000n, relay: false })
  expect(wallet.calls[1]).toEqual({ accountIndex: 0, address: COLD_ADDRESS, amount: 3_000_000_000_000n - 1_000_000_000n, relay: false })
  expect(wallet.calls[2]).toEqual({ accountIndex: 1, address: COLD_ADDRESS, amount: 2_500_000_000_000n, relay: false })
  expect(wallet.calls[3]).toEqual({ accountIndex: 1, address: COLD_ADDRESS, amount: 2_500_000_000_000n - 1_000_000_000n, relay: false })
  expect(wallet.relayCalls).toHaveLength(2)
  expect(res.swept).toBe((3_000_000_000_000n - 1_000_000_000n) + (2_500_000_000_000n - 1_000_000_000n))
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/)
})

test('defers (SKIPPED_LOCKED, not FAILED) when createTx throws "tx not possible" (retryable output-selection error)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('tx not possible')
  })
  logWarn.mockClear()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
  expect(wallet.calls).toHaveLength(3) // headroom-decrement retries before deferring
  expect(wallet.calls.map(c => c.amount)).toEqual([
    3_000_000_000_000n,
    3_000_000_000_000n - 1_000_000_000n,
    3_000_000_000_000n - 2_000_000_000n
  ])
  // A permanent non-lock deferral must not be silent (review finding).
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id, target: '3000000000000' }),
    expect.stringContaining('deferred')
  )
})

test('refuses to re-drive a partially swept row (opsSwept > 0, not SWEPT) — no createTx', async () => {
  const dist = makeDistribution({
    opsAvailablePiconeros: 5_000_000_000_000n,
    opsSweptPiconeros: 3_000_000_000_000n,
    opsSweepState: 'FAILED'
  })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0) // never re-targets opsAvailablePiconeros
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n) // unchanged
})

test('logs the attempted amount and account unlocked balance before createTx (incident diagnosability)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  logInfo.mockClear()
  await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(logInfo).toHaveBeenCalledWith(
    expect.objectContaining({
      distributionId: dist.id,
      accountIndex: 0,
      amount: '3000000000000',
      unlocked: '10000000000000'
    }),
    'sweepOpsEarmark: attempting account sweep'
  )
})
