/* eslint-env jest */

// Unit tests for the reconcileOwnerFeeLegs cron backstop (I2c) — the safety
// net for owner-routed fee legs whose lws tx-confirmation webhook callback was
// missed (deploy restart across the confirmation window, lws hiccup). The
// chain re-observes receipts via lws get_address_txs and replays them through
// the shared applier applySubFeeReceipt, re-running the cumulative gate so
// PENDING_FEE items flip before abandonFeeItems strikes at 1 day.
//
// Mirrors test/worker/reconcilePendingTips.test.js: injected lws `monero`
// client, in-memory models factory. applySubFeeReceipt is jest-mocked with a
// relative path (next/jest gives jest.mock no `@/` alias — see
// test/worker/opsSweep.test.js) so the receipt replay args are assertable.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/reconcileOwnerFeeLegs.test.js

import { runReconcileOwnerFeeLegsOnce } from '@/worker/reconcileOwnerFeeLegs'
import { applySubFeeReceipt } from '../../api/monero/subFeeObservation'

jest.mock('../../api/monero/subFeeObservation', () => ({
  __esModule: true,
  applySubFeeReceipt: jest.fn()
}))

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)

// Stateful models factory: records every model call so tests can assert both
// effects (receipt replay) and non-effects (no lws scan, no payIn query).
function makeModels ({ maps = [], payIns = [], accounts = [] } = {}) {
  const calls = { payInFindMany: 0, accountFindFirst: [] }
  return {
    calls,
    subFeePidMap: {
      findMany: async () => maps
    },
    payIn: {
      findMany: async (args) => {
        calls.payInFindMany += 1
        calls.payInWhere = args?.where
        return payIns.filter(p => p.payInState === 'PENDING_PAYMENT')
      }
    },
    moneroAccount: {
      findFirst: async ({ where }) => {
        calls.accountFindFirst.push(where)
        return accounts.find(a => a.ownerUserId === where.ownerUserId) || null
      }
    }
  }
}

function leg (overrides = {}) {
  return {
    id: 1,
    paymentId: 'a1b2c3d4e5f6a7b8',
    subName: 'meta',
    ownerUserId: 7,
    amountPiconeros: 1500000000000n,
    webhookEventId: 'evt_1',
    expiresAt: FUTURE,
    ...overrides
  }
}

function payIn (overrides = {}) {
  return {
    id: 101,
    moneroPaymentId: 'a1b2c3d4e5f6a7b8',
    payInState: 'PENDING_PAYMENT',
    payInType: 'ITEM_CREATE',
    moneroUri: 'monero:ADDR?tx_amount=0.0015&tx_payment_id=a1b2c3d4e5f6a7b8',
    ...overrides
  }
}

function account (overrides = {}) {
  return {
    id: 7,
    ownerUserId: 7,
    address: 'ADDR',
    status: 'ACTIVE',
    viewKey: { ciphertext: Buffer.alloc(0) },
    ...overrides
  }
}

beforeEach(() => {
  applySubFeeReceipt.mockReset()
})

test('replays an lws-observed receipt for an active owner leg (missed webhook) with confirmations 0', async () => {
  const l = leg()
  const pi = payIn()
  const acc = account()
  const models = makeModels({ maps: [l], payIns: [pi], accounts: [acc] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'deadbeef', height: 500, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  // Replay args bind the correction set: tx.hash (parseTx field name), exact
  // PayIn row, and confirmations ALWAYS 0 — maturity is confirmFinalizer's
  // pass, never fabricated here.
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledWith(models, {
    feePayIn: pi,
    paymentId: 'a1b2c3d4e5f6a7b8',
    txHash: 'deadbeef',
    piconeros: 1500000000000n,
    height: 500,
    confirmations: 0
  })
  expect(monero.getAddressTxs).toHaveBeenCalledWith(acc, 0, null)
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1 })
})

test('replays a still-mempool receipt (missed 0-conf callback) with height null', async () => {
  const models = makeModels({ maps: [leg()], payIns: [payIn()], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'cafebabe', height: null, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n }
      ]
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({
    txHash: 'cafebabe', height: null, confirmations: 0
  }))
  expect(out.replayed).toBe(1)
})

test('skips legs whose PayIn is no longer PENDING_PAYMENT (flipped/confirmed/abandoned) — no lws call', async () => {
  // Map row alive, but the PayIn already left the paying state (e.g. fee paid
  // and item flipped, or payment abandoned): replaying is pointless — and the
  // Item flip is already idempotent inside flipPendingToLive, so the scan is
  // skipped entirely.
  const models = makeModels({ maps: [leg()], payIns: [], accounts: [account()] })
  const monero = { getAddressTxs: jest.fn() }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(models.calls.payInFindMany).toBe(1)
  expect(models.calls.accountFindFirst).toHaveLength(0)
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 0, replayed: 0, flipped: 0 })
})

test('skips owners without an ACTIVE scanable account (viewKey missing)', async () => {
  // Unregistered/soft-deleted owner account: lws scan impossible — the
  // webhook remains the primary observer for this leg.
  const models = makeModels({
    maps: [leg()],
    payIns: [payIn()],
    accounts: [account({ status: 'INACTIVE', viewKey: null })]
  })
  const monero = { getAddressTxs: jest.fn() }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 1, replayed: 0, flipped: 0 })
})

test('warns and continues other owners when one owner lws scan fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const l1 = leg({ id: 1, paymentId: 'a1b2c3d4e5f6a7b8', ownerUserId: 7 })
    const l2 = leg({ id: 2, paymentId: 'b2c3d4e5f6a7b8c9', ownerUserId: 9 })
    const p1 = payIn({ id: 101, moneroPaymentId: 'a1b2c3d4e5f6a7b8' })
    const p2 = payIn({ id: 102, moneroPaymentId: 'b2c3d4e5f6a7b8c9' })
    const a1 = account({ id: 7, ownerUserId: 7 })
    const a2 = account({ id: 9, ownerUserId: 9, address: 'ADDR2' })
    const models = makeModels({ maps: [l1, l2], payIns: [p1, p2], accounts: [a1, a2] })
    const monero = {
      getAddressTxs: jest.fn(async (acct) => {
        if (acct.id === 7) throw new Error('lws down')
        return {
          transactions: [
            { hash: 'baadf00d', height: 600, payment_id: 'b2c3d4e5f6a7b8c9', piconeros: 1500000000000n }
          ]
        }
      })
    }
    const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner 7'))
    expect(monero.getAddressTxs).toHaveBeenCalledTimes(2)
    expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
    expect(applySubFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({
      feePayIn: p2, paymentId: 'b2c3d4e5f6a7b8c9', txHash: 'baadf00d'
    }))
    expect(out).toEqual({ legs: 2, replayed: 1, flipped: 1 })
  } finally {
    warn.mockRestore()
  }
})

test('nothing to do: zero active legs → zero payIn queries, zero lws calls', async () => {
  const models = makeModels({ maps: [] })
  const monero = { getAddressTxs: jest.fn() }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(models.calls.payInFindMany).toBe(0)
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 0, replayed: 0, flipped: 0 })
})
