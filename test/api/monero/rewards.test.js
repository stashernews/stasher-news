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

import { sendPayouts, resolveRewardsRestoreHeight, ensureFeeAccounts, planAccountSends } from '@/api/monero/rewards'
import { logInfo, logError, logWarn } from '../../../lib/logger'

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

// The build-failure state dump reads the daemon height; mock the client so
// unit tests never touch the network (the dump guards every read, but a real
// HTTP attempt could hang the suite).
jest.mock('../../../api/monero/daemonClient', () => ({
  daemonClient: { getHeight: jest.fn().mockResolvedValue(2345) }
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

// Outgoing-transfer fixture shaped like monero-ts MoneroOutgoingTransfer.
const makeOutgoing = (hash, address, amount) => ({
  getDestinations: () => [{ getAddress: () => address, getAmount: () => amount }],
  getTx: () => ({ getHash: () => hash })
})

// In-memory rewardPayout store: update() mutates + returns the row, mirroring
// Prisma's shape so sendPayouts can be driven without a database. The
// healthSnapshot upsert is a jest.fn so tests can assert the balance bridge
// write (and make it reject to prove the payout flow swallows persist errors).
function makeFakeModels (rows) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  const healthUpsert = jest.fn().mockResolvedValue({})
  return {
    store,
    healthUpsert,
    rewardPayout: {
      async findMany ({ where } = {}) {
        return [...store.values()].filter(r =>
          (!where?.recipientAddress || r.recipientAddress === where.recipientAddress) &&
          (!where?.piconeros || r.piconeros === where.piconeros) &&
          (!where?.state?.in || where.state.in.includes(r.state)))
      },
      async update ({ where, data }) {
        const row = store.get(where.id)
        if (!row) throw new Error(`fake rewardPayout.update: id ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      }
    },
    healthSnapshot: { upsert: healthUpsert }
  }
}

// Fake wallet. createTx records each request (and its relay flag) and returns
// a stub tx whose getHash() yields a stable 64-hex-char string (the real
// monero-ts wallet returns a hex string too); when relay is false it applies
// fee-aware balance validation mirroring the real wallet. throwsOn maps a
// destination address -> Error to simulate hard failures.
function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, unlockedByAccount, unlockedAfterSync, throwsOn = {}, throwsOnAccount = {}, fee = 0n, outgoing = [] } = {}) {
  const calls = [] // createTx requests only
  const relayCalls = [] // relayTx requests
  const sweepCalls = []
  const order = []
  let byAccount = unlockedByAccount || { 0: unlocked }
  let n = 0
  const hash = () => 'ab' + String(++n).padStart(6, '0') + 'cd'.repeat(28) // 64 hex chars

  async function getBalance (idx) { return BigInt(byAccount[idx] || 0n) }

  return {
    calls,
    relayCalls,
    sweepCalls,
    order,
    async sync () {
      order.push('sync')
      if (unlockedAfterSync !== undefined) byAccount = { 0: unlockedAfterSync }
    },
    async getUnlockedBalance (idx) {
      order.push('getUnlockedBalance')
      return getBalance(idx)
    },
    async getOutgoingTransfers () { return outgoing },
    async createTx (req) {
      order.push('createTx')
      calls.push(req)
      const hardThrown = throwsOnAccount[req.accountIndex] ||
        (req.destinations || []).map(d => throwsOn[d.address]).find(Boolean)
      if (hardThrown) throw hardThrown
      // fee-aware balance validation mirrors the real wallet: fee is charged
      // on top of the destination sum, from the source account.
      if (req.relay === false) {
        const sum = (req.destinations || []).reduce((a, d) => a + BigInt(d.amount), 0n)
        if (sum + BigInt(fee) > await getBalance(req.accountIndex)) {
          throw new Error('not enough unlocked money')
        }
      }
      const h = hash()
      return { getHash: () => h, getFee: async () => BigInt(fee) }
    },
    async relayTx (req) {
      order.push('relayTx')
      relayCalls.push(req)
      return req.getHash() // the real wallet returns the relayed tx hash
    },
    async sweepUnlocked (req) {
      sweepCalls.push(req)
      return [{ getHash: () => hash() }]
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
  expect(summary).toEqual({ sent: 3, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    destinations: [
      { address: '5AAA', amount: 1_000_000_000n },
      { address: '5BBB', amount: 1_000_000_000n },
      { address: '5CCC', amount: 1_000_000_000n }
    ],
    relay: false
  })
  expect(wallet.relayCalls).toHaveLength(1)
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
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 2, unpersisted: 0 })
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
  expect(summary).toEqual({ sent: 0, failed: 2, skipped: 0, unpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('FAILED')
  expect(models.store.get(p2.id).state).toBe('FAILED')
  expect(models.store.get(p1.id).txHash).toBeNull() // funds stayed in the wallet
})

test('treats a not-enough-money createTx error as a SKIP for the whole batch', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5LOCKED' })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ throwsOn: { '5LOCKED': new Error('not enough unlocked money') } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('treats a "tx not possible" createTx error as a retryable pre-relay SKIP: whole bucket stays QUEUED (2026-09-28 incident)', async () => {
  const p1 = makePayout({ id: 1 })
  const p2 = makePayout({ id: 2 })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ throwsOnAccount: { 0: new Error('tx not possible') } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 2, unpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('QUEUED')
  expect(models.store.get(p2.id).state).toBe('QUEUED')
  expect(models.store.get(p1.id).txHash).toBeNull() // provably pre-relay: no tx ever existed
  expect(models.store.get(p2.id).txHash).toBeNull()
})

test('a "tx not possible" on one account skips only that bucket; the healthy account still sends, and consolidation self-heals', async () => {
  const pBig = makePayout({ id: 1, piconeros: 4_000_000_000n }) // packs onto account 0
  const pSmall = makePayout({ id: 2, piconeros: 1_000_000_000n }) // packs onto account 1
  const models = makeFakeModels([pBig, pSmall])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 5_000_000_000n, 1: 2_000_000_000n },
    throwsOnAccount: { 0: new Error('tx not possible') }
  })
  const summary = await sendPayouts([pBig, pSmall], { models, wallet })
  expect(summary.sent).toBe(1)
  expect(summary.skipped).toBe(1)
  expect(summary.failed).toBe(0)
  expect(models.store.get(pBig.id).state).toBe('QUEUED') // the failed-account bucket stays QUEUED
  expect(models.store.get(pSmall.id).state).toBe('SENT') // the healthy account delivered
  // skipped > 0 triggers the consolidation self-heal (fresh output set for the next run)
  expect(wallet.sweepCalls.length).toBeGreaterThan(0)
})

test('a retryable build failure logs the guarded state dump (plan-time vs failure-time unlocked, heights) with stringified BigInts', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000n },
    throwsOnAccount: { 0: new Error('tx not possible') }
  })
  wallet.getHeight = async () => 1234
  await sendPayouts([p], { models, wallet })
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({
      accountIndex: 0,
      payoutCount: 1,
      dump: expect.objectContaining({
        unlockedAtPlan: '3000000000',
        unlockedNow: '3000000000',
        walletHeight: 1234,
        daemonHeight: 2345
      })
    }),
    expect.stringContaining('retryable'))
})

test('the state dump never breaks the send flow when wallet diagnostics are absent or throw', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ throwsOnAccount: { 0: new Error('transaction not possible') } })
  wallet.getHeight = () => { throw new Error('height unavailable') } // hostile diagnostics
  // note: getBalance / getOutputs are absent from the fake wallet entirely
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('is a no-op when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ id: 1, state: 'SENT', txHash: 'ab'.repeat(32) })
  const models = makeFakeModels([alreadySent])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([alreadySent], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.calls).toHaveLength(0)
})

test('handles an empty payout list', async () => {
  const models = makeFakeModels([])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0 })
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
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0 })
  expect(update).toHaveBeenCalledTimes(3) // p1: fail + retry, p2: once
  const persisted = update.mock.calls[1][0].data
  expect(persisted.state).toBe('SENT')
  expect(persisted.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(update.mock.calls[2][0].data.txHash).toBe(persisted.txHash) // same batch hash
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: p1.id, txHash: persisted.txHash }),
    expect.stringContaining('CRITICAL')
  )
  expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ payoutCount: 2, txHash: persisted.txHash }), expect.stringContaining('batch created'))
})

test('sends the batch once the wallet is synced, even when the cached balance was stale (weekly-critical-path regression)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // Cached view stale (funds arrived after open): 5e9 < 6e9 total -> would skip
  // the whole batch. The sync refreshes it to cover the sum.
  const wallet = makeFakeWallet({ unlocked: 5_000_000_000n, unlockedAfterSync: 10_000_000_000n })

  const summary = await sendPayouts([p1, p2], { models, wallet })

  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.order[0]).toBe('sync')
  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.lastIndexOf('getUnlockedBalance')).toBeLessThan(wallet.order.indexOf('createTx'))
  expect(models.store.get(p1.id).state).toBe('SENT')
  expect(models.store.get(p2.id).state).toBe('SENT')
})

test('syncs the wallet exactly once before reading the balance when there are QUEUED payouts', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet()

  await sendPayouts([p], { models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('does not touch the wallet when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ id: 1, state: 'SENT', txHash: 'ab'.repeat(32) })
  const models = makeFakeModels([alreadySent])
  const wallet = makeFakeWallet()

  const summary = await sendPayouts([alreadySent], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.order).toEqual([])
})

test('spends from MULTIPLE accounts when the batch spans fee-pool balances (2026-08-24 fix)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // total 5e9 >= batch 5e9, but no single account covers both — aggregation is the fix
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 2_500_000_000n, 3: 3_000_000_000n } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.calls).toHaveLength(2)
  // largest account first: account 3 hosts the 3e9 payout, account 0 the 2e9
  expect(wallet.calls[0].accountIndex).toBe(3)
  expect(wallet.calls[0].destinations).toEqual([{ address: p1.recipientAddress, amount: 3_000_000_000n }])
  expect(wallet.calls[1].accountIndex).toBe(0)
  expect(wallet.calls[1].destinations).toEqual([{ address: p2.recipientAddress, amount: 2_000_000_000n }])
  expect(models.store.get(1).txHash).not.toBe(models.store.get(2).txHash) // distinct txs
})

test('consolidates fee accounts into the primary when no single account can host a payout', async () => {
  process.env.PLATFORM_REWARDS_ADDRESS = process.env.PLATFORM_REWARDS_ADDRESS || '5PRIMARYTESTADDRESS'
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 3_000_000_000n, 3: 2_500_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 }) // FAILED-resumable path
  expect(wallet.calls).toHaveLength(0) // no payout sends this run
  expect(wallet.sweepCalls).toEqual([{ accountIndex: 3, address: process.env.PLATFORM_REWARDS_ADDRESS, relay: true }])
  expect(models.store.get(1).state).toBe('QUEUED')
})

test('a per-account balance error skips only that account; other accounts still send, then consolidates', async () => {
  process.env.PLATFORM_REWARDS_ADDRESS = process.env.PLATFORM_REWARDS_ADDRESS || '5PRIMARYTESTADDRESS'
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 2_500_000_000n, 3: 3_000_000_000n },
    throwsOnAccount: { 3: new Error('not enough unlocked money') } // tx-fee margin bites account 3
  })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(2).state).toBe('SENT') // account 0 bucket delivered
  expect(models.store.get(1).state).toBe('QUEUED') // account 3 bucket stays retryable
  expect(wallet.sweepCalls.length).toBeGreaterThan(0) // consolidation fired for the stuck funds
})

test('drop-smallest: when the fee makes a bucket overflow, the smallest payout is skipped and the rest still send (2026-08-26 fix)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // account 0 has exactly 5e9 and a 1e9 fee: both payouts (5e9) + fee overflows,
  // so the 2e9 payout is dropped and only the 3e9 is sent.
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 5_000_000_000n }, fee: 1_000_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT') // largest (3e9) fit under 5e9 - 1e9
  expect(models.store.get(2).state).toBe('QUEUED') // smallest dropped, stays resumable
  // two createTx attempts: first the full bucket (fails), then the reduced one
  expect(wallet.calls).toHaveLength(2)
  expect(wallet.calls[1].destinations).toEqual([{ address: '5AAA', amount: 3_000_000_000n }])
  expect(wallet.relayCalls).toHaveLength(1)
})

test('packing leaves fee headroom: steady-state balances send with no drop, no CRITICAL (audit #3)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 2_200_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 1_500_000_000n })
  const models = makeFakeModels([p1, p2])
  // fee accounts hold their exact inflows {1: 3.4e9, 2: 2.6e9}; the fake wallet
  // charges a 0.4e9 fee per tx. Unreserved packing puts 1.5e9 on account 2's
  // tail or packs toward exact fits and the fee overflows a bucket; with the
  // 1e9 reserve both buckets keep fee room and everything sends in one run.
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 3_400_000_000n, 2: 2_600_000_000n }, fee: 400_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT')
  expect(models.store.get(2).state).toBe('SENT')
  expect(wallet.relayCalls).toHaveLength(2)
})

test('a single payout that cannot cover its own fee is skipped (not failed) and triggers consolidation', async () => {
  process.env.PLATFORM_REWARDS_ADDRESS = process.env.PLATFORM_REWARDS_ADDRESS || '5PRIMARYTESTADDRESS'
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 5_000_000_000n, 3: 1_000_000_000n }, fee: 1_000_000_000n })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(1).state).toBe('QUEUED')
  expect(wallet.relayCalls).toHaveLength(0) // nothing relayed
  expect(wallet.sweepCalls.length).toBeGreaterThan(0) // consolidation fired
})

test('a relay failure after a successful create leaves the bucket QUEUED (funds stayed)', async () => {
  const p = makePayout({ id: 1, piconeros: 1_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  wallet.relayTx = async () => { throw new Error('daemon unreachable') }
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.store.get(1).state).toBe('QUEUED')
  expect(models.store.get(1).txHash).toBeNull()
})

describe('planAccountSends', () => {
  const payout = (id, piconeros) => ({ id, piconeros: BigInt(piconeros) })

  test('packs greedily first-fit-decreasing: largest account hosts the largest payouts (deterministic)', () => {
    const plan = planAccountSends([payout(1, 3e9), payout(2, 2e9), payout(3, 1e9)], { 0: 4e9, 3: 3e9 })
    expect(plan).toEqual([
      { accountIndex: 0, payouts: [payout(1, 3e9), payout(3, 1e9)] },
      { accountIndex: 3, payouts: [payout(2, 2e9)] }
    ])
  })

  test('returns null when a payout exceeds every account (only then)', () => {
    expect(planAccountSends([payout(1, 5e9)], { 0: 3e9, 3: 2e9 })).toBeNull()
    expect(planAccountSends([payout(1, 5e9), payout(2, 1e9)], { 0: 5e9, 3: 1e9 })).not.toBeNull()
  })

  test('reserves fee headroom per account when packing (audit #3)', () => {
    // the 3e9 payout lands on the 4e9 account (1e9 reserve leaves 3e9), NOT on
    // the 3e9-exact account whose reserved capacity is only 2e9
    const plan = planAccountSends([payout(1, 3e9)], { 0: 3e9, 3: 4e9 }, 1e9)
    expect(plan).toEqual([{ accountIndex: 3, payouts: [payout(1, 3e9)] }])
  })

  test('reserve floors at zero — a sub-reserve account hosts nothing, never a negative capacity', () => {
    expect(planAccountSends([payout(1, 2e9)], { 0: 3e9 }, 1e9)).toEqual([{ accountIndex: 0, payouts: [payout(1, 2e9)] }])
    expect(planAccountSends([payout(1, 3e9)], { 0: 3e9 }, 1e9)).toBeNull()
    expect(planAccountSends([payout(1, 1e9)], { 0: 5e8 }, 1e9)).toBeNull()
  })
})

// Restore-height resolver (2026-08-24 fix): env wins, then earliest inflow,
// then daemon-margin, then genesis — mirroring resolveBountyEscrowRestoreHeight.
describe('resolveRewardsRestoreHeight', () => {
  test('env height wins when set (no DB/daemon calls)', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 2187815, earliestInflowHeight: 100, daemonHeight: 5000 }))
      .toEqual({ restoreHeight: 2187815, source: 'env' })
  })

  test('earliest inflow minus margin when env is unset and inflow heights exist', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: 1500, daemonHeight: 5000 }))
      .toEqual({ restoreHeight: 500, source: 'earliest-inflow' })
  })

  test('daemon height minus margin when env and inflow are unavailable', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: null, daemonHeight: 2500 }))
      .toEqual({ restoreHeight: 1500, source: 'daemon-margin' })
  })

  test('genesis when everything is unavailable', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: null, daemonHeight: null }))
      .toEqual({ restoreHeight: 0, source: 'genesis' })
  })

  test('floors at zero (inflow near genesis)', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: 100, daemonHeight: null }))
      .toEqual({ restoreHeight: 0, source: 'earliest-inflow' })
  })
})

// Fee-account mirroring (2026-08-24 fix): a keys-restored wallet only scans
// subaddresses it has derived, so the signer must create accounts 1-5 and each
// major's subaddresses up to the pool's max minor BEFORE syncing.
describe('ensureFeeAccounts', () => {
  function makeMirrorWallet () {
    const created = { accounts: 0, subaddresses: [] } // [major] -> count created
    const accounts = [{ index: 0 }]
    const subsByMajor = new Map([[0, 1]]) // account 0 always has minor 0
    return {
      created,
      async getAccounts () { return accounts },
      async createAccount () { const idx = accounts.length; accounts.push({ index: idx }); subsByMajor.set(idx, 1); return accounts[idx] },
      async getSubaddresses (major) { return Array.from({ length: subsByMajor.get(major) || 0 }) },
      async createSubaddress (major) {
        created.subaddresses.push(major)
        subsByMajor.set(major, (subsByMajor.get(major) || 0) + 1)
      }
    }
  }

  function makeMirrorModels (rows) {
    return { $queryRaw: async () => rows }
  }

  test('creates accounts 1-5 and extends each major to the pool max minor', async () => {
    const wallet = makeMirrorWallet()
    const models = makeMirrorModels([{ major: 1, maxMinor: 3 }, { major: 5, maxMinor: 1 }])
    await ensureFeeAccounts(wallet, models)
    expect((await wallet.getAccounts()).length).toBe(6) // 0-5
    expect(wallet.created.subaddresses).toEqual([1, 1, 1, 5]) // major 1 to minor 3, major 5 to minor 1
  })

  test('no-ops with a warning when models is unavailable', async () => {
    const wallet = makeMirrorWallet()
    await ensureFeeAccounts(wallet, undefined)
    expect((await wallet.getAccounts()).length).toBe(1)
  })

  test('still creates accounts 1-5 when SubaddressIndex has no rows (fresh dev pool)', async () => {
    const wallet = makeMirrorWallet()
    const models = makeMirrorModels([])
    await ensureFeeAccounts(wallet, models)
    expect((await wallet.getAccounts()).length).toBe(6)
    expect(wallet.created.subaddresses).toEqual([])
  })

  test('mirrors only non-AVAILABLE fee subaddresses (state predicate is an untyped SQL literal)', async () => {
    const wallet = makeMirrorWallet()
    let captured = null
    const models = {
      $queryRaw: async (sql, ...values) => {
        captured = sql.join('?')
        return []
      }
    }
    await ensureFeeAccounts(wallet, models)
    expect(captured).toMatch(/si\.state <> 'AVAILABLE'/)
  })
})

test('consolidation skips dust accounts below 0.0001 XMR (audit #4)', async () => {
  process.env.PLATFORM_REWARDS_ADDRESS = process.env.PLATFORM_REWARDS_ADDRESS || '5PRIMARYTESTADDRESS'
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  // account 3 = 2.5e9 (consolidated); account 1 = 50_000_000n dust (skipped);
  // accounts 2/4/5 empty (skipped by the existing <= 0n guard)
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 3_000_000_000n, 1: 50_000_000n, 3: 2_500_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(wallet.sweepCalls.map(c => c.accountIndex)).toEqual([3]) // dust account NOT swept
})

test('a payout relayed but unpersisted (both DB writes fail) counts as unpersisted, not silently sent (audit #6)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 1_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const update = jest.fn().mockRejectedValue(new Error('db down'))
  models.rewardPayout.update = update
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 1 })
  expect(update).toHaveBeenCalledTimes(2) // initial + one retry
  expect(wallet.relayCalls).toHaveLength(1) // the tx DID leave the wallet
})

test('reconciles a relayed-but-unpersisted payout from wallet history instead of re-sending (audit #6)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONCILE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), '5RECONCILE', 2_000_000_000n)]
  })
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT')
  expect(models.store.get(1).txHash).toBe('ef'.repeat(32))
  expect(wallet.calls).toHaveLength(0) // never re-sent — no double pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('reconciliation persist failure (both writes) counts the row unpersisted — never re-sent, never silently complete (final-review fix #1)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONFAIL', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ab'.repeat(32), '5RECONFAIL', 2_000_000_000n)]
  })
  // findMany stays healthy (it reads the store); only the persist fails — twice
  models.rewardPayout.update = jest.fn().mockRejectedValue(new Error('db down'))
  const summary = await sendPayouts([p1], { models, wallet })
  // sent: 1 because the money moved in the prior run (match WAS found); the
  // unpersisted count keeps the distribution FAILED-resumable, never COMPLETE
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 1 })
  expect(models.rewardPayout.update).toHaveBeenCalledTimes(2) // persist + retry, both failed
  expect(wallet.calls).toHaveLength(0) // never re-sent — no double pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('findMany failure fails closed: the row is skipped and never re-sent this run (final-review fix #2)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5UNPROVABLE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('cd'.repeat(32), '5UNPROVABLE', 2_000_000_000n)] // relayed last run
  })
  models.rewardPayout.findMany = jest.fn().mockRejectedValue(new Error('db down'))
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0 })
  expect(models.rewardPayout.findMany).toHaveBeenCalledTimes(1)
  expect(wallet.calls).toHaveLength(0) // a blind re-send of the relayed tx would double-pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('mixed run: one row reconciles from wallet history, the unmatched one sends fresh', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5MIX', piconeros: 2_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5MIX', piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), '5MIX', 2_000_000_000n)] // p1's lost relay only
  })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0 })
  expect(wallet.calls).toHaveLength(1) // only the unmatched row sends
  expect(models.store.get(1).txHash).toBe('ef'.repeat(32)) // reconciled from history
  expect(models.store.get(2).txHash).not.toBe('ef'.repeat(32)) // fresh tx
})

test('reconciliation ignores outgoing txs already recorded on SENT payouts — no false SENT (audit #6)', async () => {
  // last week's payout to the same curator: same address, same amount, hash RECORDED
  const prior = { id: 999, distributionId: 0, curatorId: 1, recipientAddress: '5RECONCILE', piconeros: 2_000_000_000n, txHash: 'ef'.repeat(32), state: 'SENT' }
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONCILE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([prior, p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), '5RECONCILE', 2_000_000_000n)]
  })
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0 }) // sent fresh
  expect(wallet.calls).toHaveLength(1) // actually sent this time
  expect(models.store.get(1).txHash).not.toBe('ef'.repeat(32))
})

// --- HealthSnapshot balance bridge: setBalanceGauge additionally persists the
// post-send unlocked balance to the single-row snapshot so the app process can
// serve monero_rewards_wallet_balance_piconeros from /api/metrics. ---

test('sendPayouts persists the post-send unlocked balance to the HealthSnapshot row', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BRIDGE' })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet() // unlocked: 1_000_000_000_000_000n on account 0
  await sendPayouts([p1], { models, wallet })
  const expected = 1_000_000_000_000_000n - 1_000_000_000n
  expect(models.healthUpsert).toHaveBeenCalledWith({
    where: { id: 1 },
    create: { id: 1, balancePiconeros: expected, balanceUpdatedAt: expect.any(Date) },
    update: { balancePiconeros: expected, balanceUpdatedAt: expect.any(Date) }
  })
})

test('a HealthSnapshot balance persist failure never throws into the payout flow', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BRIDGE' })
  const models = makeFakeModels([p1])
  models.healthUpsert.mockRejectedValue(new Error('db down'))
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0 }) // payout flow unaffected
  await new Promise(resolve => setImmediate(resolve)) // flush the fire-and-forget catch
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('HealthSnapshot balance persist failed'), expect.any(Error))
})
