/* eslint-env jest */

// Unit tests for the owner-fee receipt applier (api/monero/subFeeObservation.js).
//
// A daemon-verified 0-conf receipt is provisional (height NULL, callback
// amount): display-only until the atomic NULL->height CAS claims a
// chain-verified height. The live flip gates on the count-eligible cumulative
// only, and the BOOST bump fires on the exactly-once CAS transition — never on
// a replay (an already-height receipt matches zero CAS rows). `xmax`/RETURNING
// inference cannot distinguish "just backfilled" from "replayed with the same
// height", which is why the CAS is the single transition signal.

import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'
import { applyBoostDetected, flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { alert } from '@/lib/alert'

jest.mock(`${process.cwd()}/worker/rewardsWalletObserver`, () => ({
  flipPendingToLive: jest.fn().mockResolvedValue(undefined),
  applyBoostDetected: jest.fn().mockResolvedValue(undefined)
}))

jest.mock(`${process.cwd()}/lib/alert`, () => {
  const actual = jest.requireActual(`${process.cwd()}/lib/alert`)
  return { ...actual, alert: jest.fn() }
})

function feeModels ({ fresh = false, height = null } = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ fresh, height }]),
    observedSubFee: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 0n } }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    $executeRaw: jest.fn().mockResolvedValue(1)
  }
}

// SQL-shape-aware fake: the applier writes the provisional row first and only
// then claims it via the CAS; asserting on the statement shape keeps the
// exactly-once semantics testable without a live DB.
function sqlModels ({ claimed = true, priorPiconeros = null, counted = 0n } = {}) {
  return {
    $queryRaw: jest.fn(async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings)
      if (sql.includes('INSERT INTO "ObservedSubFee"')) return []
      if (sql.includes('SELECT piconeros')) return priorPiconeros == null ? [] : [{ piconeros: priorPiconeros }]
      if (sql.includes('UPDATE "ObservedSubFee"')) return claimed ? [{ id: 1 }] : []
      return []
    }),
    observedSubFee: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: counted } }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    $executeRaw: jest.fn().mockResolvedValue(1)
  }
}

const payIn = (payInType) => ({ id: 7, payInType, moneroUri: null })

beforeEach(() => {
  jest.clearAllMocks()
})

test('the live gate sums only count-eligible (height non-null) receipts', async () => {
  const models = feeModels({ fresh: true, height: null })
  await applySubFeeReceipt(models, { feePayIn: payIn('ITEM_CREATE'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: null, confirmations: 0 })
  expect(models.observedSubFee.aggregate).toHaveBeenCalledWith(expect.objectContaining({
    where: { payInId: 7, height: { not: null }, state: { in: ['DETECTED', 'CONFIRMED'] } }
  }))
})

test('boost fires only when the receipt is verified, never on the provisional insert', async () => {
  const provisional = feeModels({ fresh: true, height: null })
  await applySubFeeReceipt(provisional, { feePayIn: payIn('BOOST'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: null, confirmations: 0 })
  expect(applyBoostDetected).not.toHaveBeenCalled()

  const verified = feeModels({ fresh: false, height: 100 })
  await applySubFeeReceipt(verified, { feePayIn: payIn('BOOST'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: 100, confirmations: 0 })
  expect(applyBoostDetected).toHaveBeenCalledTimes(1)
})

test('replaying an already-height receipt never re-fires the boost (CAS matches 0 rows)', async () => {
  const models = sqlModels({ claimed: false, counted: 1n })
  const out = await applySubFeeReceipt(models, { feePayIn: payIn('BOOST'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: 100, confirmations: 10 })
  expect(out.transitioned).toBe(false)
  expect(applyBoostDetected).not.toHaveBeenCalled()
})

test('a provisional-only receipt never opens the live flip (count-eligible cumulative stays 0)', async () => {
  const models = sqlModels({ claimed: false, counted: 0n })
  const out = await applySubFeeReceipt(models, { feePayIn: payIn('ITEM_CREATE'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: null, confirmations: 0 })
  expect(out.cumulative).toBe(0n)
  expect(flipPendingToLive).not.toHaveBeenCalled()
})

test('the live flip receives the count-eligible cumulative only, and skips an underpaid leg', async () => {
  const models = sqlModels({ claimed: true, counted: 0n })
  models.$queryRaw = jest.fn(async (strings) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings)
    if (sql.includes('SELECT piconeros')) return []
    if (sql.includes('UPDATE "ObservedSubFee"')) return [{ id: 1 }]
    return []
  })
  // moneroUri quotes 1e9; only a 5e8 receipt is count-eligible -> held.
  const feePayIn = { id: 7, payInType: 'ITEM_CREATE', moneroUri: 'monero:9?tx_amount=0.001' }
  models.observedSubFee.aggregate.mockResolvedValue({ _sum: { piconeros: 500_000_000n } })
  await applySubFeeReceipt(models, { feePayIn, paymentId: 'p', txHash: 'h', piconeros: 500_000_000n, height: 100, confirmations: 0 })
  expect(flipPendingToLive).not.toHaveBeenCalled()

  models.observedSubFee.aggregate.mockResolvedValue({ _sum: { piconeros: 1_000_000_000n } })
  await applySubFeeReceipt(models, { feePayIn, paymentId: 'p', txHash: 'h2', piconeros: 500_000_000n, height: 101, confirmations: 0 })
  expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 7 }), 1_000_000_000n)
  expect(models.observedSubFee.aggregate).toHaveBeenLastCalledWith(expect.objectContaining({
    where: { payInId: 7, height: { not: null }, state: { in: ['DETECTED', 'CONFIRMED'] } }
  }))
})

test('a diverging provisional amount is corrected at the height transition and alerts (deduped per tx+payment)', async () => {
  const models = sqlModels({ claimed: true, priorPiconeros: 5n })
  const out = await applySubFeeReceipt(models, { feePayIn: payIn('BOOST'), paymentId: 'p', txHash: 'h', piconeros: 7n, height: 100, confirmations: 0 })
  expect(out.transitioned).toBe(true)
  expect(applyBoostDetected).toHaveBeenCalledWith(models, expect.objectContaining({ id: 7 }), 7n)
  expect(alert).toHaveBeenCalledWith(
    'warn',
    'owner-fee receipt amount corrected at height transition',
    expect.stringContaining('h'),
    { dedupeKey: 'subfee-receipt-corrected-h-p' }
  )
})

test('N-conf maturity of THIS receipt is an atomic state-guarded update (replays no-op)', async () => {
  const models = feeModels({ fresh: true, height: 100 })
  await applySubFeeReceipt(models, { feePayIn: payIn('ITEM_CREATE'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: 100, confirmations: 12 })
  expect(models.$executeRaw).toHaveBeenCalledTimes(1)
  const sql = models.$executeRaw.mock.calls[0][0].join('')
  expect(sql).toContain('UPDATE "ObservedSubFee"')
  expect(sql).toContain("state = 'CONFIRMED'")
  expect(sql).toContain("state = 'DETECTED'")

  // Below the threshold: no maturity write at all.
  models.$executeRaw.mockClear()
  await applySubFeeReceipt(models, { feePayIn: payIn('ITEM_CREATE'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: 100, confirmations: 3 })
  expect(models.$executeRaw).not.toHaveBeenCalled()
})

test('the height CAS is state-gated to DETECTED — a refused self-send row (EXCLUDED) can never be claimed', async () => {
  // The webhook's self-payment ban flips height-NULL provisional rows to
  // EXCLUDED; the applier's CAS matches on height IS NULL AND state DETECTED,
  // so no replay can ever resurrect an excluded receipt into the gate.
  const models = sqlModels({ claimed: true, priorPiconeros: 1n, counted: 0n })
  await applySubFeeReceipt(models, { feePayIn: payIn('ITEM_CREATE'), paymentId: 'p', txHash: 'h', piconeros: 1n, height: 100, confirmations: 0 })
  const casSql = models.$queryRaw.mock.calls
    .map((c) => Array.isArray(c[0]) ? c[0].join('') : String(c[0]))
    .find(sql => sql.includes('UPDATE "ObservedSubFee"'))
  expect(casSql).toContain('height IS NULL')
  expect(casSql).toContain("state = 'DETECTED'")
})
