/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { runReconcilePendingTipsOnce } from '@/worker/reconcilePendingTips'
import { RECONCILE_PENDING_AGE_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { moneroTipsRecoveredTotal, moneroTipsExpiredTotal } from '@/lib/metrics'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, xorWithMask } from '@/api/monero/pidDecrypt'

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
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
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
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
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
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
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
  expect(out).toEqual({ recovered: 1, expired: 1, excluded: 0, pidFallback: 0 })
  expect((await moneroTipsRecoveredTotal.get()).values[0].value).toBe(1)
  expect((await moneroTipsExpiredTotal.get()).values[0].value).toBe(1)
})

// ---------------------------------------------------------------------------
// Wrong-pid fallback (lws shared-derivation pid misattribution; see
// docs/ops/lws-pid-misattribution.md). When both sender and recipient are
// lws-registered and the sender scans a tx first, lws stores/serves the
// SENDER-side pid decryption for the recipient's row: webhooks never fire and
// the primary pid-keyed reconcile match above finds nothing. The fallback
// fetches the raw tx from monerod and decrypts the encrypted pid with the
// RECIPIENT's view key (pidDecrypt.js), recovering the tip without lws.
// ---------------------------------------------------------------------------

const L_ORDER = ed25519.CURVE.n
const G_BASE = ed25519.ExtendedPoint.BASE

function randomScalarHexLE () {
  // wallet-grade scalar 1 <= s < l (Monero sc_check rejects >= l), LE hex
  const b = randomBytes(31)
  const bytes = Buffer.concat([b, Buffer.alloc(1)])
  let v = 0n
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  v = (v % (L_ORDER - 2n)) + 1n
  const out = Buffer.alloc(32)
  let x = v
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out.toString('hex')
}

// Build the fixture for a two-account tip whose lws row carries the WRONG pid:
//  - viewKey envelope for a random recipient view key `a`
//  - raw tx extra whose encrypted pid decrypts (under 8*a*R) to `pidHex`
//  - a daemon fake serving that extra for `txHash`
function wrongPidFixture ({ pidHex, txHash, spentOutputs = [{ sender: { maj_i: 4, min_i: 2 } }] }) {
  const viewKeyHex = randomScalarHexLE()
  const rHex = randomScalarHexLE()
  const R = G_BASE.multiply(BigInt('0x' + Buffer.from(rHex, 'hex').reverse().toString('hex').padStart(64, '0')))
  const RBytes = Buffer.from(R.toRawBytes())
  const mask = maskFromTxPubKey(RBytes, viewKeyHex)
  const stored = xorWithMask(Buffer.from(pidHex, 'hex'), mask)
  const extra = Buffer.concat([
    Buffer.from([0x01, ...RBytes]),
    Buffer.from([0x02, 9, 0x01, ...stored])
  ])
  return {
    account: (over = {}) => ({ id: 7, address: 'ADDR', status: 'ACTIVE', subaddresses: [], ...over }),
    viewKey: encryptViewKey(viewKeyHex),
    daemon: { getTransactions: async () => [{ hash: txHash, extra }] },
    extra
  }
}

test('fallback recovers a PENDING tip when lws serves the sender-side pid (raw-decrypt with recipient view key)', async () => {
  const realPid = '661bf254912cb9f7' // the issued pid (HMAC-minted)
  const servedPid = 'd048685749d57220' // what lws stored (sender derivation)
  const t = tip({ id: 30n, paymentId: realPid, tipperId: 6 })
  const fx = wrongPidFixture({ pidHex: realPid, txHash: 'b9c84119f7275b39' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'b9c84119f7275b39', height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 3217000
    })
  }
  const execs = []
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async () => {} }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => { applied = true; return 700000000n }
  })
  expect(out).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(applied).toBe(true)
  const detected = execs.find(e => e.sql.includes("state = 'DETECTED'"))
  expect(detected).toBeDefined()
  expect(detected.vals).toContain('b9c84119f7275b39')
  expect(alert).toHaveBeenCalledWith('warn', 'lws payment-id misattribution recovered',
    expect.stringContaining('1 tip(s) recovered by raw-decrypt fallback'),
    expect.objectContaining({ dedupeKey: 'lws-pid-misattribution' }))
})

test('fallback recovery goes through the self-send exclusion check (spent_outputs honored)', async () => {
  const realPid = 'a0211a0a2c1217c6'
  const servedPid = '871967eaeb0fa5e4'
  const t = tip({ id: 31n, paymentId: realPid, tipperId: null }) // anon tip
  const fx = wrongPidFixture({ pidHex: realPid, txHash: '780e241fe18f0543' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      // self-send: a spent output owned by the recipient's own primary (0,0)
      transactions: [{ hash: '780e241fe18f0543', height: 3216991, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }],
      blockchain_height: 3217000
    })
  }
  let signalData = null
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ subName: 'stasher' }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => { applied = true; return 0n }
  })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 1, pidFallback: 1 })
  expect(applied).toBe(false)
  expect(signalData).toMatchObject({ kind: 'SELF_SEND_EXCLUDED', paymentId: realPid })
})

test('daemon failure during the fallback does NOT expire unmatched tips (anti-strand)', async () => {
  // 2 days old, unmatched, and the raw-tx fetch fails: expiring now would
  // strand a possibly-paid tip; the next run retries.
  const t = tip({ id: 32n, detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const fx = wrongPidFixture({ pidHex: t.paymentId, txHash: 'deadbeef' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const daemon = {
    getTransactions: async () => { throw new Error('monerod get_transactions unavailable') }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, daemonClient: daemon, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toBeNull()
  expect(alert).toHaveBeenCalledWith('warn', 'lws raw-decrypt fallback failed',
    expect.stringContaining('monerod get_transactions unavailable'),
    expect.objectContaining({ dedupeKey: 'lws-pid-fallback-error' }))
})

test('fallback that runs clean still expires genuinely unpaid tips', async () => {
  const t = tip({ id: 33n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const fx = wrongPidFixture({ pidHex: '0000000000000000', txHash: 'cafebabe' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      // one tx on the account whose (wrong) pid matches nothing we issued
      transactions: [{ hash: 'cafebabe', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 33n, state: 'PENDING' })
})

test('fallback is skipped entirely when no daemon is injected (legacy callers keep today\'s behavior)', async () => {
  const t = tip({ id: 34n, detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 34n, state: 'PENDING' })
})
