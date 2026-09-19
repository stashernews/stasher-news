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
import { alert } from '../../lib/alert'

jest.mock('../../api/monero/subFeeObservation', () => ({
  __esModule: true,
  applySubFeeReceipt: jest.fn()
}))

jest.mock('../../lib/alert', () => ({
  __esModule: true,
  alert: jest.fn()
}))

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)

// Stateful models factory: records every model call so tests can assert both
// effects (receipt replay) and non-effects (no lws scan, no payIn query).
function makeModels ({ maps = [], payIns = [], accounts = [] } = {}) {
  const calls = { payInFindMany: 0, accountFindFirst: [] }
  return {
    calls,
    // The self-payment ban's provisional-row cleanup (EXCLUDED) runs through
    // $executeRaw; jest.fn so tests can assert both the call and the SQL shape.
    $executeRaw: jest.fn().mockResolvedValue(1),
    subFeePidMap: {
      findMany: async () => maps
    },
    payIn: {
      findMany: async (args) => {
        calls.payInFindMany += 1
        calls.payInWhere = args?.where
        // Fee payIns are created PAID by design — no state filter any more.
        return payIns.filter(p => (args?.where?.moneroPaymentId?.in ?? []).includes(p.moneroPaymentId))
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
    subName: 'stasher',
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

test('scans a PAID fee payIn leg (the pre-fix PENDING_PAYMENT filter never matched — backstop was dead)', async () => {
  // Fee payIns are created PAID by design (piconeros=0; the fee gate lives on
  // Item.feeStatus). The old filter could never match, so this backstop never
  // ran; the selection must no longer filter on payInState at all.
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'deadbeef', height: 500, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n, spent_outputs: [] }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1 })
})

test('SELF-PAYMENT BAN: a self-spend tx is never replayed (no receipt write, no flip)', async () => {
  // Payer == owner account: lws total_received = inputs - fee (the sender's
  // change), which is never the leg amount — no amount from a self-send is
  // credible, so the backstop skips the tx entirely.
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 8211672641492n,
          spent_outputs: [{ amount: '8211616401492', out_index: 1, sender: { maj_i: 0, min_i: 0 } }]
        }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 1, replayed: 0, flipped: 0 })
})

test('SELF-PAYMENT BAN: a self-spend tx EXCLUDES its height-NULL provisional row and alerts (deduped)', async () => {
  // A 0-conf callback may have seeded a provisional receipt before the
  // self-send was identified — the backstop's cleanup must EXCLUDE it so the
  // display never shows the change as received (the applier's CAS is
  // state-gated to DETECTED, so an EXCLUDED row can never be claimed).
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 8211672641492n,
          spent_outputs: [{ amount: '8211616401492', out_index: 1, sender: { maj_i: 0, min_i: 0 } }]
        }
      ],
      blockchain_height: 510
    }))
  }
  await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(models.$executeRaw).toHaveBeenCalledTimes(1)
  const sql = Array.isArray(models.$executeRaw.mock.calls[0][0]) ? models.$executeRaw.mock.calls[0][0].join('') : models.$executeRaw.mock.calls[0][0]
  expect(sql).toContain("'EXCLUDED'")
  expect(sql).toContain('"tx_hash"')
  expect(sql).toContain('height IS NULL')
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee self-payment refused',
    expect.stringContaining('a1b2c3d4e5f6a7b8'),
    expect.objectContaining({ dedupeKey: 'subfee-selfpay-a1b2c3d4e5f6a7b8-deadbeef' }))
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
})

test('misattributed foreign spent_outputs (lws scan-pass bug) do NOT trip the ban — tx replays normally', async () => {
  // Review follow-up: lws attributes FOREIGN wallets' spends to a scanned
  // account (AGENTS.md 2026-08-10). The ban uses the same EXACT (maj,min)
  // sender match as the webhook, so a foreign-index sender is NOT a
  // self-send: the genuine fee receipt replays instead of being stranded
  // behind an unreclaimable EXCLUDED row (which abandonFeeItems would turn
  // into a 24h deletion).
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 1500000000000n,
          spent_outputs: [{ amount: '1500000000000', out_index: 0, sender: { maj_i: 4, min_i: 2 } }] // foreign indices
        }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(models.$executeRaw).not.toHaveBeenCalled() // no EXCLUDED write
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1 })
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
