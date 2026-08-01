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
// returns a hex string too). throwsOn maps `${address}:${amount}` -> Error to
// simulate per-payout failures.
function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, throwsOn = {} } = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    async getUnlockedBalance () { return unlocked },
    async createTx (req) {
      calls.push(req)
      const key = `${req.address}:${req.amount.toString()}`
      if (throwsOn[key]) throw throwsOn[key]
      n += 1
      const hash = 'ab' + String(n).padStart(6, '0') + 'cd'.repeat(28) // 2+6+56 = 64 hex chars
      return { getHash: () => hash, getFee: async () => 50_000_000n }
    }
  }
}

test('marks a payout SENT with the tx hash when createTx succeeds', async () => {
  const p = makePayout()
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 })
  const row = models.store.get(p.id)
  expect(row.state).toBe('SENT')
  expect(row.txHash).toMatch(/^[0-9a-f]{64}$/)
})

test('passes accountIndex 0, the payout address/amount, and relay:true to createTx', async () => {
  const p = makePayout({ recipientAddress: '5DESTADDR', piconeros: 2_500_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet()
  await sendPayouts([p], { models, wallet })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    address: '5DESTADDR',
    amount: 2_500_000_000n,
    relay: true
  })
})

test('marks a payout FAILED when createTx throws a hard error, but still sends the others', async () => {
  const ok = makePayout({ recipientAddress: '5GOOD' })
  const bad = makePayout({ recipientAddress: '5BADADDR', piconeros: 1_000_000_000n })
  const models = makeFakeModels([ok, bad])
  const wallet = makeFakeWallet({
    throwsOn: { '5BADADDR:1000000000': new Error('invalid recipient address') }
  })
  const summary = await sendPayouts([ok, bad], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 1, skipped: 0 })
  expect(models.store.get(ok.id).state).toBe('SENT')
  const failed = models.store.get(bad.id)
  expect(failed.state).toBe('FAILED')
  // funds are not lost: a FAILED payout keeps no tx hash (the share rolls over)
  expect(failed.txHash).toBeNull()
})

test('leaves a payout QUEUED (skipped, not FAILED) when unlocked balance is insufficient', async () => {
  const p = makePayout({ piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  // wallet reports far less unlocked than the payout needs
  const wallet = makeFakeWallet({ unlocked: 1_000_000_000n })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1 })
  const row = models.store.get(p.id)
  expect(row.state).toBe('QUEUED') // retryable next run; not abandoned as FAILED
  expect(row.txHash).toBeNull()
  expect(wallet.calls).toHaveLength(0) // never even attempted createTx
})

test('treats a not-enough-money createTx error as a SKIP (funds may be locked), not a hard FAILED', async () => {
  const p = makePayout({ recipientAddress: '5LOCKED' })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    throwsOn: { '5LOCKED:1000000000': new Error('not enough unlocked money') }
  })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('is a no-op (no createTx calls) when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ state: 'SENT', txHash: 'ab'.repeat(32) })
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

test('persists the tx hash (SENT, not FAILED) when the first DB update throws but retry succeeds', async () => {
  const p = makePayout()
  // createTx succeeds (tx broadcast, funds left) but the first DB update throws,
  // then the retry succeeds — simulating a transient blip AFTER relay.
  const update = jest.fn()
    .mockRejectedValueOnce(new Error('transient db connection blip'))
    .mockResolvedValue({ id: p.id, state: 'SENT' })
  const models = { rewardPayout: { update } }
  const wallet = makeFakeWallet()
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const summary = await sendPayouts([p], { models, wallet })
    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 })
    // the retrying update call wrote SENT with the relayed tx hash (never FAILED)
    expect(update).toHaveBeenCalledTimes(2)
    const persisted = update.mock.calls[1][0].data
    expect(persisted.state).toBe('SENT')
    expect(persisted.txHash).toMatch(/^[0-9a-f]{64}$/)
    // the relayed tx hash was logged the instant relay succeeded (never lost)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`payout ${p.id} relayed txHash=${persisted.txHash}`))
    // a CRITICAL warning was emitted for the first (failed) persist attempt
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'))
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
  }
})
