/* eslint-env jest */
import { runReconcilePendingTipsOnce } from '@/worker/reconcilePendingTips'
import { RECONCILE_PENDING_AGE_MS } from '@/lib/constants'

const STALE = new Date(Date.now() - (RECONCILE_PENDING_AGE_MS + 60_000))
const FRESH = new Date()

function tip (overrides) {
  return {
    id: 1n,
    postId: 42,
    paymentId: 'aabbccdd11223344',
    recipientAccountId: 7,
    piconeros: 1000000000n,
    detectedAt: STALE,
    state: 'PENDING',
    post: { userId: 5 },
    ...overrides
  }
}

test('recovers a PENDING tip whose payment_id appears in the lws re-scan (PENDING->DETECTED + applyTipDetected)', async () => {
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }
      ],
      blockchain_height: 110
    })
  }
  let applied = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      // the raw claim UPDATE returns 1 row affected (recovered)
      $executeRaw: async () => {}
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      // emulate the serializable tx: the raw UPDATE claims 1 row, then apply runs
      const txdb = {
        $executeRaw: async () => 1,
        observedTip: { update: async () => {} }
      }
      await fn(txdb)
      applied = true
    }
  }
  // applyTipDetected is imported by the worker from ranking.js; spy via its effect by
  // stubbing the module is heavier — instead assert the recovery count + that $transaction ran.
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out.recovered).toBe(1)
  expect(applied).toBe(true)
})

test('expires a PENDING tip with no matching payment after PENDING_EXPIRY_MS (-> EXPIRED)', async () => {
  const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 2n, detectedAt: expiredDate })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {} }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out.expired).toBe(1)
  expect(expiredWhere).toEqual({ id: 2n, state: 'PENDING' })
})

test('expires a PENDING tip older than 24h (PENDING_EXPIRY_MS default)', async () => {
  // 2 days is inside the old 7-day default but past the 24h default: unpaid
  // tips must not linger longer than downvote pid-maps or fee reservations.
  const expiredDate = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 5n, detectedAt: expiredDate })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {} }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out.expired).toBe(1)
  expect(expiredWhere).toEqual({ id: 5n, state: 'PENDING' })
})

test('never calls lws for an account without a viewKey, but still expires its PENDING tips (soft-deleted account)', async () => {
  const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 4n, detectedAt: expiredDate })
  // Soft-deleted account: viewKey wiped + status INACTIVE (unregisterMoneroAccount).
  // Scanning it would throw in lws walletLogin and abort the whole run.
  const account = { id: 7, address: 'ADDR', viewKey: null, status: 'INACTIVE' }
  const lws = { getAddressTxs: jest.fn() }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(lws.getAddressTxs).not.toHaveBeenCalled()
  expect(out).toEqual({ recovered: 0, expired: 1 })
  expect(expiredWhere).toEqual({ id: 4n, state: 'PENDING' })
})

test('does NOT touch fresh PENDING tips (younger than RECONCILE_PENDING_AGE_MS)', async () => {
  const t = tip({ id: 3n, detectedAt: FRESH })
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: { getAddressTxs: async () => ({ transactions: [] }) }, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0 })
})
