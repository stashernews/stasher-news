/* eslint-env jest */
import { runReconcilePendingTipsOnce } from '@/worker/reconcilePendingTips'
import { RECONCILE_PENDING_AGE_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { moneroTipsRecoveredTotal, moneroTipsExpiredTotal } from '@/lib/metrics'

// lib/alert is mocked so operator pages are assertable without a network side
// effect (reverseStaleDetections.test.js pattern).
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

beforeEach(() => { jest.clearAllMocks() })

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

function tips (n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => tip({ id: BigInt(i + 1), ...overrides }))
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
  // Capture the txdb raw SQL (the exclusion tests' idiom) so the rank-delta
  // persistence UPDATE is assertable.
  const execs = []
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
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        observedTip: { update: async () => {} }
      }
      await fn(txdb)
      applied = true
    }
  }
  // applyTipDetected is imported by the worker from ranking.js; spy via its effect by
  // stubbing the module is heavier — instead assert the recovery count + that $transaction ran.
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true; return 700000000n } })
  expect(out.recovered).toBe(1)
  expect(applied).toBe(true)
  // The applied rank delta is persisted on the tip row (exact reorg reversal).
  const rankSet = execs.find(e => e.sql.includes('"rankPiconeros"'))
  expect(rankSet).toBeDefined()
  expect(rankSet.vals).toContain(700000000n)
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
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0 })
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
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0 })
})

test('recovers a PENDING direct self-tip as EXCLUDED (no apply, AbuseSignal written)', async () => {
  const t = tip({ id: 10n, tipperId: 5, post: { userId: 5 } }) // tipper === author
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let applied = false
  let signalData = null
  // Capture BOTH the SQL text and the bound values: the exclusionReason is a
  // tagged-template BIND PARAM, so it never appears in the SQL text — only in
  // the call's trailing arguments.
  const execs = []
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      const txdb = {
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      }
      await fn(txdb)
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out.excluded).toBe(1)
  expect(out.recovered).toBe(0)
  expect(applied).toBe(false)
  const excluded = execs.find(e => e.sql.includes("state = 'EXCLUDED'") && e.sql.includes("state = 'PENDING'"))
  expect(excluded).toBeDefined()
  expect(excluded.sql).toContain('"TipExclusionReason"')
  expect(excluded.vals).toContain('DIRECT_SELF_TIP')
  expect(signalData).toMatchObject({ kind: 'SELF_TIP_EXCLUDED', subjectUserId: 5, actorUserId: 5, tipId: 10n, postId: 42 })
})

test('recovers a PENDING self-send (anon tip from the author registered wallet) as EXCLUDED', async () => {
  const t = tip({ id: 11n, tipperId: null, post: { userId: 5 } })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }],
      blockchain_height: 110
    })
  }
  let applied = false
  let signalData = null
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      const txdb = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ subName: 'stasher' }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      }
      await fn(txdb)
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out.excluded).toBe(1)
  expect(applied).toBe(false)
  expect(signalData).toMatchObject({ kind: 'SELF_SEND_EXCLUDED', subName: 'stasher' })
})

test('a normal recovered tip still detects (exclusion check passes it through)', async () => {
  const t = tip({ id: 12n, tipperId: 6, post: { userId: 5 } })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({ $executeRaw: async () => 1 })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true; return 700000000n } })
  expect(out.recovered).toBe(1)
  expect(out.excluded).toBe(0)
  expect(applied).toBe(true)
})

test('does NOT alert on a large pool of unpaid young tips (cry-wolf regression pin)', async () => {
  // 12 abandoned checkouts past reconcile age but inside the 24h expiry window:
  // nothing on chain, so nothing is recovered — no alert may fire.
  const t = tips(12)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  const models = {
    observedTip: { findMany: async () => t, updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0 })
  expect(alert).not.toHaveBeenCalled()
})

test('fires a warn alert when a small batch of tips is recovered (missed webhooks)', async () => {
  const t = tips(1)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out.recovered).toBe(1)
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith('warn', 'missed tip webhooks',
    expect.stringContaining('1 tips recovered by reconciliation scan'),
    { dedupeKey: 'missed-tip-webhooks' })
  expect(alert).not.toHaveBeenCalledWith('critical', expect.any(String), expect.any(String), expect.anything())
})

test('fires a critical alert when a large batch of tips is recovered (webhook outage)', async () => {
  // All 10 tips share the default paymentId; one matching tx recovers all 10
  // (each claim UPDATE returns 1, so recovered = 10 = CRITICAL threshold).
  const t = tips(10)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out.recovered).toBe(10)
  expect(alert).toHaveBeenCalledWith('critical', 'missed tip webhooks',
    expect.stringContaining('10 tips recovered by reconciliation scan'),
    { dedupeKey: 'missed-tip-webhooks' })
})

test('run counters tick monero_tips_recovered_total / monero_tips_expired_total', async () => {
  moneroTipsRecoveredTotal.reset()
  moneroTipsExpiredTotal.reset()
  // One recoverable tip + one unpaid tip past the 24h expiry window
  // (unpaid = its paymentId is absent from the lws scan).
  const t = [
    tip({ id: 20n }),
    tip({ id: 21n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  ]
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t, updateMany: async () => ({ count: 1 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out).toEqual({ recovered: 1, expired: 1, excluded: 0 })
  expect((await moneroTipsRecoveredTotal.get()).values[0].value).toBe(1)
  expect((await moneroTipsExpiredTotal.get()).values[0].value).toBe(1)
})
