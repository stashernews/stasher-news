/* eslint-env jest */

// Real-DB tests for the bounty escrow signer's dispatch loop (A-13, 2026-08-19
// beta incident), driven through the FULL capture barrier (Finding #1, Task 7):
// build(relay:false) -> extract the ACTUAL settlement from the built object
// BEFORE the pair commits -> durable journal+proof pair -> authenticate ->
// CAS the single attempt -> relayTx the SAME object once -> persist. The
// wallet is a capture-grade fake; the database is the dedicated isolated one
// (real Task 2 crypto, real store rows, real BountyPayment/Item/User rows).
//
// Covers the money contracts: single-tx payout dispatch (prize + platform fee
// as destinations with the network fee subtracted from the last destination)
// and the settlement snapshot persisted after the barrier (actual network fee,
// actual net received amounts, and the fee destination frozen BEFORE dispatch
// so a later env change cannot reclassify it); zero relay-time hot-wallet
// receipt writes; the insufficient-balance skip-streak alert, exercised from
// both the pre-dispatch guard and the in-createTx balance-error catch; and the
// legacy fee-settlement defer/retry (feePendingAt, full-fee destination with
// NO subtraction and its own extra miner cost). Hard (non-balance) errors
// still fail loudly and are left for manual reconciliation (never
// auto-retried); a built settlement that cannot be attributed stops BEFORE
// relay (nothing ever moved). The crash/race matrix itself is pinned in
// test/api/monero/escrowTransactions.test.js. Runs ONLY via the guarded
// isolated runner.

import { PrismaClient } from '@prisma/client'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { sendBountyPayments, __resetSkipStreaks } from '@/api/monero/bounties'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { logInfo, logError } from '../../../lib/logger'
import { alert } from '../../../lib/alert'
import { secretBundleHex } from '@/test/fixtures/payment-proof'

jest.mock('../../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))

jest.mock('../../../lib/alert', () => ({ alert: jest.fn() }))

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// --- deterministic synthetic address/point helpers (throwaway, Task 1 style;
// scalar space 910+ stays clear of the other suites) ---

const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')

const STAGENET_PRIMARY_PREFIX = 24
function encodeStagenetPrimaryAddress ({ spendKey, viewKey }) {
  const body = new Uint8Array(65)
  body[0] = STAGENET_PRIMARY_PREFIX
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}

const makeAddress = n => encodeStagenetPrimaryAddress({ spendKey: point(2n * BigInt(n)), viewKey: point(2n * BigInt(n) + 1n) })

;(ISOLATED_DB ? describe : describe.skip)('bounty escrow dispatch money contracts through the capture barrier (isolated DB only)', () => {
  const WADDR = makeAddress(910)
  const FEE_ADDR = makeAddress(912)
  const NEW_FEE_ADDR = makeAddress(913)
  const WINNER_ADDR = makeAddress(911)
  const NET_FEE = 40_000n
  const PRIZE = 10_000_000_000n
  const FEE = 2_000_000_000n
  const ROLLOVER_PRIZE = 12_000_000_000n
  const LEGACY_FEE = 10_000_000_000n

  const keyProvider = createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 17).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
  })

  let db
  let hashSeq
  let trackedUsers
  let trackedItems
  let trackedPayments
  let envSnapshot

  const nextHash = () => {
    hashSeq += 1
    return ('f3' + String(hashSeq).padStart(4, '0') + 'b7').repeat(8)
  }

  const purgeScope = () => db.$transaction([
    db.paymentTransactionProof.deleteMany({ where: { escrowJournal: { walletAddress: WADDR } } }),
    db.escrowWalletTransaction.deleteMany({ where: { walletAddress: WADDR } })
  ])

  beforeAll(async () => {
    db = new PrismaClient()
    envSnapshot = {}
    for (const key of ['BOUNTY_ESCROW_ADDRESS', 'BOUNTY_ESCROW_SPEND_KEY', 'BOUNTY_ESCROW_VIEW_KEY', 'REWARDS_COLD_STORAGE_ADDRESS']) {
      envSnapshot[key] = process.env[key]
      delete process.env[key]
    }
    process.env.REWARDS_COLD_STORAGE_ADDRESS = FEE_ADDR
    await purgeScope()
  })

  beforeEach(() => {
    hashSeq = 0
    trackedUsers = []
    trackedItems = []
    trackedPayments = []
    __resetSkipStreaks()
    jest.clearAllMocks()
  })

  afterEach(async () => {
    await purgeScope()
    await db.bountyPayment.deleteMany({ where: { id: { in: trackedPayments } } })
    for (const id of trackedItems) await db.item.delete({ where: { id } })
    for (const id of trackedUsers) await db.user.delete({ where: { id } })
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
    for (const key of Object.keys(envSnapshot)) {
      if (envSnapshot[key] === undefined) delete process.env[key]
      else process.env[key] = envSnapshot[key]
    }
  })

  async function seedPayout (overrides = {}) {
    const [user] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    trackedUsers.push(user.id)
    const item = await db.item.create({
      data: { userId: user.id, title: `escrow send fixture ${trackedItems.length + 1}`, status: 'ACTIVE' }
    })
    trackedItems.push(item.id)
    const payout = await db.bountyPayment.create({
      data: {
        itemId: item.id,
        winnerUserId: user.id,
        piconeros: PRIZE,
        feePiconeros: FEE,
        recipientAddress: WINNER_ADDR,
        kind: 'AWARD',
        state: 'QUEUED',
        ...overrides
      }
    })
    trackedPayments.push(payout.id)
    return payout
  }

  // Capture-grade fake escrow signer (SDK-shaped getters the capture store
  // reads) with the wallet2 balance contract: the network fee rides inside
  // subtractFeeFrom destinations; without subtractFeeFrom it is charged on top.
  function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, unlockedAfterSync, throwsOn = {}, netFee = NET_FEE, missingSettlement = false } = {}) {
    const calls = [] // createTx requests only (existing assertions depend on this shape)
    const order = [] // method-call order: 'sync' | 'getUnlockedBalance' | 'createTx'
    const built = []
    let balance = unlocked
    let builds = 0
    return {
      calls,
      order,
      built,
      relayTx: jest.fn(async tx => String(await tx.getHash()).toLowerCase()),
      getPrimaryAddress: jest.fn(async () => WADDR),
      getNetworkType: jest.fn(async () => 2),
      setUnlocked (value) { balance = value },
      async sync () {
        order.push('sync')
        if (unlockedAfterSync !== undefined) balance = unlockedAfterSync
      },
      getUnlockedBalance: jest.fn(async () => {
        order.push('getUnlockedBalance')
        return balance
      }),
      createTx: jest.fn(async req => {
        order.push('createTx')
        calls.push(req)
        const requested = req.destinations
          ? req.destinations.map(d => ({ address: d.address, amount: BigInt(d.amount) }))
          : [{ address: req.address, amount: BigInt(req.amount) }]
        for (const destination of requested) {
          if (throwsOn[destination.address]) throw throwsOn[destination.address]
        }
        const destSum = requested.reduce((acc, d) => acc + d.amount, 0n)
        if (balance < destSum + (req.subtractFeeFrom ? 0n : netFee)) {
          throw new Error('not enough unlocked money')
        }
        balance -= destSum + (req.subtractFeeFrom ? 0n : netFee)
        builds += 1
        const hash = nextHash()
        const keySeed = 500n + BigInt(builds) * 7n
        const actual = requested.map((d, i) => ({
          address: d.address,
          amount: d.amount - (req.subtractFeeFrom && req.subtractFeeFrom.includes(i) ? netFee : 0n)
        }))
        const outputKeys = actual.map((_, i) => point(keySeed + 10n + BigInt(i)))
        outputKeys.push(point(keySeed + 10n + BigInt(outputKeys.length)))
        const tx = {
          getHash: () => hash,
          getFee: () => netFee,
          getOutgoingTransfer: () => (missingSettlement
            ? undefined
            : { getDestinations: () => actual.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount })) }),
          getChangeAddress: () => WADDR,
          getChangeAmount: () => destSum - netFee,
          // The SDK captures the SECRET-bundle STRING (final-review C1).
          getKey: () => secretBundleHex(keySeed, 3)
        }
        built.push(tx)
        return tx
      }),
      getTx: jest.fn(async () => ({ getHeight: async () => 200 }))
    }
  }

  // Wrap the real client so selected bountyPayment.update calls fail.
  const withFaultyPayoutUpdate = (match, impl) => {
    const wrapModel = delegate => new Proxy(delegate, {
      get (inner, prop) {
        if (prop === 'update') {
          const fn = Reflect.get(inner, prop, inner)
          return (...args) => (match(args) ? impl(...args) : fn.apply(inner, args))
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return new Proxy(db, {
      get (inner, prop) {
        if (prop === 'bountyPayment') return wrapModel(Reflect.get(inner, prop, inner))
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
  }

  const loadRow = id => db.bountyPayment.findUnique({ where: { id } })

  test('dispatches an award on exactly prize + platform fee in one tx, draining the escrow exactly', async () => {
    const payout = await seedPayout({ piconeros: PRIZE, feePiconeros: FEE })
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.calls).toHaveLength(1)
    expect(await wallet.getUnlockedBalance(0)).toBe(0n)
    expect(await loadRow(payout.id).then(r => r.state)).toBe('SENT')
  })

  test('AWARD builds prize and platform fee as two destinations with relay:false, subtracting the fee from the ops cut', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(wallet.calls).toHaveLength(1)
    expect(wallet.calls[0]).toEqual({
      accountIndex: 0,
      destinations: [
        { address: WINNER_ADDR, amount: PRIZE },
        { address: FEE_ADDR, amount: FEE }
      ],
      subtractFeeFrom: [1],
      relay: false
    })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(wallet.relayTx.mock.calls[0][0]).toBe(wallet.built[0]) // the SAME object
  })

  test('wallet2 contract: the winner receives the exact prize and ops receives fee minus the network fee', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    const req = wallet.calls[0]
    const effective = req.destinations.map((d, i) => ({
      address: d.address,
      amount: BigInt(d.amount) - (req.subtractFeeFrom.includes(i) ? NET_FEE : 0n)
    }))
    expect(effective[0]).toEqual({ address: WINNER_ADDR, amount: PRIZE })
    expect(effective[1]).toEqual({ address: FEE_ADDR, amount: FEE - NET_FEE })

    // The built tx's ACTUAL settlement is snapshotted on the payout: the prize
    // stays exact, the fee receipt is the post-subtraction net, and the network
    // fee is the real signed fee — extracted before the pair committed.
    const row = await loadRow(payout.id)
    expect(row.feeRecipientAddress).toBe(FEE_ADDR)
    expect(row.networkFeePiconeros).toBe(NET_FEE)
    expect(row.recipientReceivedPiconeros).toBe(PRIZE)
    expect(row.feeReceivedPiconeros).toBe(FEE - NET_FEE)
  })

  test('ROLLOVER builds the full amount as one destination with the miner fee subtracted from it', async () => {
    const payout = await seedPayout({ kind: 'ROLLOVER', piconeros: ROLLOVER_PRIZE, feePiconeros: 0n })
    const wallet = makeFakeWallet({ unlocked: ROLLOVER_PRIZE, netFee: NET_FEE })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.calls).toHaveLength(1)
    expect(wallet.calls[0]).toEqual({
      accountIndex: 0,
      destinations: [{ address: WINNER_ADDR, amount: ROLLOVER_PRIZE }],
      subtractFeeFrom: [0],
      relay: false
    })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(await wallet.getUnlockedBalance(0)).toBe(0n)

    // The single combined output is snapshotted as the full net receipt with no
    // separate fee receipt; receipt attribution later splits it from the
    // separately frozen prize.
    const row = await loadRow(payout.id)
    expect(row.networkFeePiconeros).toBe(NET_FEE)
    expect(row.recipientReceivedPiconeros).toBe(ROLLOVER_PRIZE - NET_FEE)
    expect(row.feeReceivedPiconeros).toBe(0n)
    // No relay-time hot-wallet revenue: the old BOUNTY_ROLLOVER insert is gone.
    expect(await db.feeObservation.count()).toBe(0)
  })

  test('a fee-waived award skips the fee destination and snapshots one net refund output', async () => {
    const payout = await seedPayout({ feePiconeros: 0n })
    const wallet = makeFakeWallet({ unlocked: PRIZE, netFee: NET_FEE })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.calls[0]).toEqual({
      accountIndex: 0,
      destinations: [{ address: WINNER_ADDR, amount: PRIZE }],
      subtractFeeFrom: [0],
      relay: false
    })
    const row = await loadRow(payout.id)
    expect(row.feeRecipientAddress).toBeNull() // no fee leg, nothing to freeze
    expect(row.networkFeePiconeros).toBe(NET_FEE)
    expect(row.recipientReceivedPiconeros).toBe(PRIZE - NET_FEE)
    expect(row.feeReceivedPiconeros).toBe(0n)
  })

  test('persists the configured fee destination before relay, once, when unset', async () => {
    const payout = await seedPayout()
    let storedAtRelay
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })
    const inner = wallet.createTx.getMockImplementation()
    wallet.createTx.mockImplementation(async req => {
      storedAtRelay = (await loadRow(payout.id)).feeRecipientAddress
      return inner(req)
    })

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(storedAtRelay).toBe(FEE_ADDR) // written BEFORE createTx can move funds
    expect((await loadRow(payout.id)).feeRecipientAddress).toBe(FEE_ADDR)
  })

  test('reuses the payout’s stored fee destination after the configured cold address changes', async () => {
    const payout = await seedPayout({ feeRecipientAddress: FEE_ADDR })
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })
    const previous = process.env.REWARDS_COLD_STORAGE_ADDRESS
    process.env.REWARDS_COLD_STORAGE_ADDRESS = NEW_FEE_ADDR
    try {
      await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    } finally {
      if (previous === undefined) delete process.env.REWARDS_COLD_STORAGE_ADDRESS
      else process.env.REWARDS_COLD_STORAGE_ADDRESS = previous
    }

    // The old settlement keeps its frozen destination; the new env value never
    // reclassifies where this fee lands.
    expect(wallet.calls[0].destinations[1]).toEqual({ address: FEE_ADDR, amount: FEE })
    const row = await loadRow(payout.id)
    expect(row.feeRecipientAddress).toBe(FEE_ADDR)
    expect(row.feeReceivedPiconeros).toBe(FEE - NET_FEE)
  })

  test('a pre-send fee-destination persist failure leaves the payout QUEUED and dispatches nothing', async () => {
    const payout = await seedPayout({ feeRecipientAddress: null })
    const models = withFaultyPayoutUpdate(
      args => args?.[0]?.data?.feeRecipientAddress === FEE_ADDR,
      async () => { throw new Error('transient db blip') }
    )
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE })
    logError.mockClear()

    const summary = await sendBountyPayments([payout], { models, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.calls).toHaveLength(0) // no on-chain send without a frozen destination
    const row = await loadRow(payout.id)
    expect(row.state).toBe('QUEUED')
    expect(row.feeRecipientAddress).toBeNull()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: payout.id }),
      expect.stringContaining('before dispatch')
    )
  })

  test('a built payout whose settlement facts cannot be read stops BEFORE relay as FAILED (no broadcast, critical alert)', async () => {
    // The built tx exposes no outgoing transfer, so its settlement is not
    // attributable — the barrier refuses it BEFORE anything can broadcast
    // (the pre-barrier code relayed first and alerted after).
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: PRIZE + FEE, netFee: NET_FEE, missingSettlement: true })
    alert.mockClear()
    logError.mockClear()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0, settled: 0 })
    expect(wallet.calls).toHaveLength(1) // built relay:false...
    expect(wallet.relayTx).not.toHaveBeenCalled() // ...never broadcast
    const row = await loadRow(payout.id)
    expect(row.state).toBe('FAILED')
    expect(row.txHash).toBeNull()
    expect(row.networkFeePiconeros).toBeNull()
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'payout settlement not attributable',
      expect.stringContaining('nothing was relayed'),
      expect.objectContaining({ dedupeKey: `bounty-settlement-unattributable-${payout.id}` })
    )
  })

  test('a hard createTx error (non-balance) marks the payout FAILED with the funds still in escrow', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet({
      unlocked: PRIZE + FEE,
      netFee: NET_FEE,
      throwsOn: { [WINNER_ADDR]: new Error('invalid recipient address') }
    })
    logError.mockClear()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0, settled: 0 })
    expect((await loadRow(payout.id)).state).toBe('FAILED')
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: payout.id }),
      expect.stringContaining('FAILED (funds stayed in escrow)')
    )
  })

  test('settles a deferred fee for a SENT payout on a later run (feeTxHash set exactly once, feePendingAt cleared, payout not re-sent)', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePiconeros: LEGACY_FEE, feePendingAt: new Date() })
    let storedAtRelay
    const wallet = makeFakeWallet({ netFee: NET_FEE })
    const inner = wallet.createTx.getMockImplementation()
    wallet.createTx.mockImplementation(async req => {
      storedAtRelay = (await loadRow(payout.id)).feeRecipientAddress
      return inner(req)
    })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 1 })
    const row = await loadRow(payout.id)
    expect(row.state).toBe('SENT')
    expect(row.txHash).toBe('ab'.repeat(32)) // payout tx untouched
    expect(row.feeTxHash).toBe(wallet.built[0].getHash())
    expect(row.feePendingAt).toBeNull()
    expect(wallet.calls).toHaveLength(1) // fee only, no payout re-send
    expect(wallet.calls[0]).toEqual({ accountIndex: 0, address: FEE_ADDR, amount: LEGACY_FEE, relay: false })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    // The fee's destination is frozen BEFORE the fee can move, and the actual
    // settlement fields (real network fee, actual full amount received — no
    // subtraction on the legacy branch) are stored with feeTxHash.
    expect(storedAtRelay).toBe(FEE_ADDR)
    expect(row.feeRecipientAddress).toBe(FEE_ADDR)
    expect(row.feeSettlementNetworkFeePiconeros).toBe(NET_FEE)
    expect(row.feeReceivedPiconeros).toBe(LEGACY_FEE)
  })

  test('skips a deferred-fee retry while the unlocked balance is still short (fee stays pending)', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePiconeros: LEGACY_FEE, feePendingAt: new Date() })
    const wallet = makeFakeWallet({ unlocked: 5_000_000_000n }) // < feePiconeros

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
    const row = await loadRow(payout.id)
    expect(row.feeTxHash).toBeNull()
    expect(row.feePendingAt).toBeInstanceOf(Date)
    expect(wallet.calls).toHaveLength(0)
  })

  test('a hard fee error during a deferred-fee retry clears feePendingAt and fails loudly (manual reconciliation)', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
    const wallet = makeFakeWallet({ throwsOn: { [FEE_ADDR]: new Error('invalid recipient address') } })
    logInfo.mockClear()
    logError.mockClear()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    const row = await loadRow(payout.id)
    expect(row.feeTxHash).toBeNull()
    expect(row.feePendingAt).toBeNull() // no auto-retry for hard errors
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: payout.id }),
      expect.stringContaining('reconcile manually')
    )
  })

  test('never double-sends the fee: a SENT payout with feeTxHash already set is left alone', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feeTxHash: 'cd'.repeat(32), feePendingAt: new Date() })
    const wallet = makeFakeWallet()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect((await loadRow(payout.id)).feeTxHash).toBe('cd'.repeat(32))
    expect(wallet.calls).toHaveLength(0)
  })

  test('a fee relayed but unpersisted alerts CRITICAL and recovers DB-only on the next drive (no double-send)', async () => {
    // The destination was already frozen by an earlier attempt, so the FIRST
    // update here is the post-relay feeTxHash persist (not the pre-send write).
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date(), feeRecipientAddress: FEE_ADDR })
    const models = withFaultyPayoutUpdate(
      args => args?.[0]?.data?.feeTxHash != null,
      async () => { throw new Error('transient db blip') }
    )
    const wallet = makeFakeWallet()
    alert.mockClear()
    logError.mockClear()

    const summary = await sendBountyPayments([payout], { models, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    const row = await loadRow(payout.id)
    expect(row.feeTxHash).toBeNull() // the persist failed...
    expect(row.feePendingAt).not.toBeNull() // ...so the recovery marker STAYS for the durable RELAYED dispatch
    expect(wallet.relayTx).toHaveBeenCalledTimes(1) // relayed exactly once
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

    // The next drive's reconciliation recovers the fee facts DB-only from the
    // durable RELAYED dispatch: feeTxHash is recorded, feePendingAt cleared, and
    // the fee is never rebuilt or re-relayed.
    const recoveredWallet = makeFakeWallet()
    const second = await sendBountyPayments([row], { models: db, wallet: recoveredWallet, keyProvider })
    expect(second).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(recoveredWallet.createTx).not.toHaveBeenCalled()
    expect(recoveredWallet.relayTx).not.toHaveBeenCalled()
    const after = await loadRow(payout.id)
    expect(after.feeTxHash).toBe(wallet.built[0].getHash())
    expect(after.feePendingAt).toBeNull()
    expect(after.feeSettlementNetworkFeePiconeros).toBe(NET_FEE)
    expect(after.feeReceivedPiconeros).toBe(FEE)
  })

  test('settles a deferred fee whose change unlocked after the wallet was opened (sync refreshes the stale cached balance)', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePendingAt: new Date() })
    // Cached view is stale (pre-change-unlock): 1e9 < 10e9 fee. The sync refreshes
    // it to 21.9e9 (the live probe value from the 2026-08-20 incident) >= fee.
    const wallet = makeFakeWallet({ unlocked: 1_000_000_000n, unlockedAfterSync: 21_900_000_000n })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 1 })
    const row = await loadRow(payout.id)
    expect(row.feeTxHash).not.toBeNull()
    expect(row.feePendingAt).toBeNull()
    expect(wallet.order).toEqual(['sync', 'getUnlockedBalance', 'createTx'])
  })

  test('syncs the wallet exactly once before reading the unlocked balance whenever there is dispatch work', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet()

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
    expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
  })

  test('does not touch the wallet when there is nothing queued or pending (no sync in the hot path)', async () => {
    const wallet = makeFakeWallet()

    const summary = await sendBountyPayments([], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.order).toEqual([])
    expect(wallet.getPrimaryAddress).not.toHaveBeenCalled()
  })

  test('alerts exactly once after N consecutive insufficient-balance skips, naming the payout', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: 0n, netFee: NET_FEE })
    alert.mockClear()

    for (let i = 0; i < 4; i++) {
      const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })
      expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
    }
    expect(alert).not.toHaveBeenCalled()

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty payout stuck — insufficient escrow balance',
      expect.stringContaining(`payout ${payout.id}`),
      expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
    )

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1) // does not re-fire while the streak continues
  })

  test('a dispatched payout clears its streak, and a later strand alerts on a fresh streak', async () => {
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: 0n, netFee: NET_FEE })
    alert.mockClear()

    for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).not.toHaveBeenCalled()

    wallet.setUnlocked(PRIZE + FEE)
    expect((await sendBountyPayments([payout], { models: db, wallet, keyProvider })).sent).toBe(1)
    expect(alert).not.toHaveBeenCalled() // the dispatch cleared the streak

    // The completed dispatch now withholds its leg from the stale offer; a
    // DIFFERENT queued payout then strands on a fresh streak and alerts.
    alert.mockClear()
    wallet.setUnlocked(0n)
    const stranded = await seedPayout()
    for (let i = 0; i < 4; i++) await sendBountyPayments([stranded], { models: db, wallet, keyProvider })
    expect(alert).not.toHaveBeenCalled()
    await sendBountyPayments([stranded], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1)
  })

  test('a legacy deferred-fee retry stuck on a short balance also alerts after N runs', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePiconeros: LEGACY_FEE, feePendingAt: new Date() })
    const wallet = makeFakeWallet({ unlocked: 5_000_000_000n }) // < feePiconeros (10e9)
    alert.mockClear()

    for (let i = 0; i < 5; i++) {
      const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })
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
    const payout = await seedPayout()
    const wallet = makeFakeWallet({ unlocked: 0n, netFee: NET_FEE })
    alert.mockClear()

    for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    __resetSkipStreaks()
    for (let i = 0; i < 4; i++) await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).not.toHaveBeenCalled()

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1) // a fresh streak needs a full N
  })

  test('a QUEUED payout that passes the guard but fails createTx on balance (in-createTx catch) alerts after N runs', async () => {
    const payout = await seedPayout()
    // The guard passes (local unlocked 12e9 >= needs 12e9) but wallet2 cannot
    // gather inputs for the tx despite the sufficient unlocked total and throws
    // a balance-class error inside createTx — the skip must go through the
    // in-createTx catch, which must bump the streak like the guard path does.
    const wallet = makeFakeWallet({
      unlocked: PRIZE + FEE,
      netFee: NET_FEE,
      throwsOn: { [WINNER_ADDR]: new Error('not enough unlocked money') }
    })
    alert.mockClear()

    for (let i = 0; i < 4; i++) {
      const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })
      expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
    }
    expect(alert).not.toHaveBeenCalled()

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty payout stuck — insufficient escrow balance',
      expect.stringContaining(`payout ${payout.id}`),
      expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
    )

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1) // does not re-fire while the streak continues
  })

  // Characterization coverage of the legacy branch's existing in-createTx catch bump (green from birth by design).
  test('a legacy deferred-fee retry that passes its guard but fails createTx on the network fee alerts after N runs', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: 'ab'.repeat(32), feePiconeros: LEGACY_FEE, feePendingAt: new Date() })
    // Guard passes exactly (unlocked == feePiconeros) but createTx additionally
    // needs the network fee (10e9 + 40k) and throws a balance error in-createTx.
    const wallet = makeFakeWallet({ unlocked: LEGACY_FEE, netFee: NET_FEE })
    alert.mockClear()

    for (let i = 0; i < 4; i++) {
      const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })
      expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, settled: 0 })
    }
    expect(alert).not.toHaveBeenCalled()

    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty payout stuck — insufficient escrow balance',
      expect.stringContaining(`payout ${payout.id}`),
      expect.objectContaining({ dedupeKey: `bounty-skip-stuck-${payout.id}` })
    )
  })
})
