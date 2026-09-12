/* eslint-env jest */

// =============================================================================
// Post-reorg TWO-ACCOUNT tip coverage (mainnet incident 2026-09-12).
//
// monero-lws decrypts a tx's encrypted payment id ONCE, with the derivation
// of the FIRST registered account that matches an output — and stores those
// bytes on every matching account's row (src/scanner.cpp scan_transaction_base
// in 0.3; src/util/ownership_test.cpp in 1.0.x — identical defect). When the
// SENDER is also an lws-registered account (payer change output matches it)
// and scans before the recipient — exactly what a "Blockchain reorg detected,
// resetting state" reset re-sorts accounts into — lws serves the sender-side
// pid for the recipient: webhooks never fire and reconcilePendingTips'
// pid-keyed match finds nothing.
//
// This suite covers the ACCEPTANCE CONTRACT of that incident: a tip where
// BOTH sender and recipient are lws-registered accounts is still detected
// reliably — either via the lws webhook (when scan order was lucky) or via
// reconcilePendingTips' raw-decrypt fallback (api/monero/pidDecrypt.js),
// which recomputes the pid with the recipient's view key from the raw tx.
// A real reorg cannot be scheduled, but the misattribution itself is
// order-dependent and this shape is what triggers it; detection must not
// depend on lws getting the order right.
//
// -----------------------------------------------------------------------------
// SKIP GUARD: never runs under `./sndev test`. Gated on
//   RUN_STAGENET_INTEGRATION=1
// (needs the live stagenet monero stack, a funded sender, ~45 min).
//
// PREREQUISITES (in addition to tip-stagenet.test.js's 1-4):
//   STAGENET_SENDER_SEED        funded stagenet wallet mnemonic (MANDATORY —
//                               the sender must be a real registered wallet
//                               for its change output to match its account)
//   STAGENET_SENDER_ADDRESS     the sender wallet's PRIMARY address
//   STAGENET_SENDER_VIEWKEY     the sender wallet's PRIVATE view key
//   STAGENET_AUTHOR_ADDRESS     recipient author's primary address
//   STAGENET_AUTHOR_VIEWKEY     matching PRIVATE view key
//   VIEWKEY_MASTER_KEY          must match the app/worker's key
//
// HOW TO RUN:
//   RUN_STAGENET_INTEGRATION=1 \
//   STAGENET_SENDER_SEED=... STAGENET_SENDER_ADDRESS=... STAGENET_SENDER_VIEWKEY=... \
//   STAGENET_AUTHOR_ADDRESS=... STAGENET_AUTHOR_VIEWKEY=... VIEWKEY_MASTER_KEY=... \
//   ./sndev test test/integration/post-reorg-two-account-tip-stagenet.test.js
// =============================================================================

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/monero'
import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { runReconcilePendingTipsOnce } from '@/worker/reconcilePendingTips'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'
process.env.LWS_WEBHOOK_URL = process.env.LWS_WEBHOOK_URL || 'http://app:3000/api/monero/webhook'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'
const TIP_PICONEROS = BigInt(process.env.STAGENET_TIP_PICONEROS || '1000000000')

// Webhook detection is near-instant when lws decrypted the pid with the
// recipient's derivation; the fallback path is bounded by
// RECONCILE_PENDING_AGE_MS (5 min) + this suite's own inline reconcile
// invocations, so 12 min covers both deterministically.
const DETECT_TIMEOUT_MS = 12 * 60_000
const DETECT_POLL_MS = 15_000
const CONFIRM_TIMEOUT_MS = 30 * 60_000
const CONFIRM_POLL_MS = 30_000

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function requireEnv (name) {
  const v = process.env[name]
  if (!v) throw new Error(`integration test requires ${name} to be set (see the prerequisites at the top of this file)`)
  return v
}

async function registerOrReuse (address, viewKey, network) {
  let account = await prisma.moneroAccount.findFirst({ where: { address, network } })
  if (!account) {
    const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    const userId = rows[0].id
    const created = await resolvers.Mutation.registerMoneroAccount(null, {
      address,
      viewKey,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lwsClient })
    account = await prisma.moneroAccount.findUnique({ where: { id: created.id } })
    console.log(`  registered account id=${account.id} for ${address.slice(0, 16)}...`)
  } else {
    console.log(`  reusing account id=${account.id} for ${address.slice(0, 16)}...`)
  }
  return account
}

async function sendFromRegisteredSender (integratedAddress, amountPiconeros) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const uri = process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081'
  const daemon = await api.connectToDaemonRpc(uri)
  const height = await daemon.getHeight()
  const wallet = await api.createWalletFull({
    password: 'sndev-stagenet-two-account-test',
    networkType: api.MoneroNetworkType.STAGENET,
    seed: requireEnv('STAGENET_SENDER_SEED'),
    server: { uri },
    restoreHeight: Math.max(0, height - 500),
    proxyToWorker: false
  })
  try {
    await wallet.sync()
    const unlocked = await wallet.getUnlockedBalance(0)
    if (unlocked < BigInt(amountPiconeros)) {
      throw new Error(`sender has insufficient unlocked balance (${unlocked.toString()} < ${amountPiconeros.toString()})`)
    }
    const tx = await wallet.createTx({
      accountIndex: 0,
      address: integratedAddress,
      amount: amountPiconeros,
      relay: true
    })
    const hash = tx.getHash()
    return Array.isArray(hash) ? hash[0] : hash
  } finally {
    await wallet.close()
  }
}

// Diagnostic: does lws's get_address_txs row for this tx carry the issued pid
// (recipient-side decryption) or a wrong one (sender-side — the incident)?
// Purely informational: detection must NOT depend on the answer.
async function servedPidDiagnostics (account, txHash, issuedPid) {
  try {
    const withKey = await prisma.moneroAccount.findUnique({
      where: { id: account.id },
      include: { viewKey: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
    })
    const resp = await lwsClient.getAddressTxs(withKey, 0, null)
    const row = (resp.transactions || []).find(t => String(t.hash).toLowerCase() === String(txHash).toLowerCase())
    if (!row) {
      console.log(`  [lws pid] tx ${txHash.slice(0, 12)}... not visible on the recipient account yet`)
      return
    }
    const served = String(row.payment_id ?? '').toLowerCase()
    let verdict = 'none'
    if (served === issuedPid) {
      verdict = 'CORRECT (webhook path should have fired)'
    } else if (served && served !== issuedPid) {
      verdict = `WRONG (served ${served}, issued ${issuedPid}) — sender-side decryption, the 2026-09-12 incident shape`
    }
    console.log(`  [lws pid] served pid verdict: ${verdict}`)
  } catch (err) {
    console.log(`  [lws pid] diagnostic lookup failed: ${err && err.message}`)
  }
}

async function pollUntil (label, condition, { timeoutMs, intervalMs, onPoll } = {}) {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const detail = onPoll ? await onPoll() : ''
    const result = await condition()
    if (result) return result
    console.log(`  [${label}] poll #${attempt}: not yet${detail ? ` — ${detail}` : ''}; retry in ${Math.round(intervalMs / 1000)}s`)
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for "${label}" after ${Math.round(timeoutMs / 60000)} min`)
}

;(STAGENET_ENABLED ? describe : describe.skip)('post-reorg two-account tip (lws pid misattribution coverage)', () => {
  const run = { postId: null, recipientAccountId: null, authorUserId: null, tipperId: null, paymentId: null, tipHash: null }

  beforeAll(() => {
    requireEnv('STAGENET_SENDER_SEED')
    requireEnv('STAGENET_SENDER_ADDRESS')
    requireEnv('STAGENET_SENDER_VIEWKEY')
    requireEnv('STAGENET_AUTHOR_ADDRESS')
    requireEnv('STAGENET_AUTHOR_VIEWKEY')
    requireEnv('VIEWKEY_MASTER_KEY')
  })

  afterEach(async () => {
    if (!run.postId) return
    try {
      await prisma.observedTip.deleteMany({ where: { postId: run.postId } })
      await prisma.itemUserAgg.deleteMany({ where: { itemId: run.postId } })
      await prisma.item.deleteMany({ where: { id: run.postId } })
    } catch (err) {
      console.warn('afterEach cleanup failed (left for manual cleanup):', err && err.message)
    }
    run.postId = null
    run.paymentId = null
  })

  afterAll(async () => { await prisma.$disconnect() })

  test('sender-registered tip to a registered author is detected (webhook OR raw-decrypt fallback) and confirmed', async () => {
    const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()

    // ---- 1. Both sides registered (the two-account shape) ---------------------
    const recipient = await registerOrReuse(process.env.STAGENET_AUTHOR_ADDRESS, process.env.STAGENET_AUTHOR_VIEWKEY, network)
    const sender = await registerOrReuse(process.env.STAGENET_SENDER_ADDRESS, process.env.STAGENET_SENDER_VIEWKEY, network)
    run.recipientAccountId = recipient.id
    run.authorUserId = recipient.ownerUserId
    console.log(`  two-account shape: recipient account=${recipient.id}, sender account=${sender.id}`)

    // ---- 2. Fresh post + initiateTip ------------------------------------------
    const title = `test-stagenet-two-account-${Date.now()}`
    const inserted = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title) VALUES (${run.authorUserId}::int, ${title}) RETURNING id::int AS id`
    const postId = inserted[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree WHERE id = ${postId}::int`
    run.postId = postId
    const tipperRows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    run.tipperId = tipperRows[0].id
    const initiation = await resolvers.Mutation.initiateTip(null, {
      postId: String(postId),
      amount: TIP_PICONEROS.toString()
    }, { me: { id: run.tipperId }, models: prisma, monero: lwsClient })
    run.paymentId = initiation.paymentId
    console.log(`  initiateTip: paymentId=${initiation.paymentId}`)

    const baseUser = await prisma.user.findUnique({ where: { id: run.authorUserId }, select: { stackedPiconeros: true } })

    // ---- 3. Send from the REGISTERED sender wallet -----------------------------
    run.tipHash = await sendFromRegisteredSender(initiation.integratedAddress, TIP_PICONEROS)
    console.log(`  sent tx ${run.tipHash} from the registered sender (change output -> second account match)`)

    // ---- 4. Poll for DETECTED: webhook first, then the reconcile fallback ------
    // The inline runReconcilePendingTipsOnce call IS the incident's recovery
    // path: when lws serves the sender-side pid, only the raw-decrypt fallback
    // can claim the tip. RECONCILE_PENDING_AGE_MS gates eligibility (5 min
    // default); polls before that exercise only the webhook, after it the
    // fallback too — both are acceptable detection paths.
    let detectedVia = null
    const detected = await pollUntil(
      'ObservedTip DETECTED',
      async () => {
        const row = await prisma.observedTip.findFirst({ where: { paymentId: run.paymentId } })
        if (row && row.state === 'DETECTED') {
          if (!detectedVia) detectedVia = 'webhook'
          return row
        }
        // 0-conf webhook missed AND the tip is past RECONCILE_PENDING_AGE_MS
        // (5 min default): drive the exact production recovery function inline.
        if (row && row.detectedAt && Date.now() - row.detectedAt.getTime() > 5 * 60_000) {
          const out = await runReconcilePendingTipsOnce({ models: prisma, daemonClient })
          if (out.recovered || out.excluded || out.pidFallback) {
            console.log(`  inline reconcile: ${JSON.stringify(out)}`)
          }
        }
        const after = await prisma.observedTip.findFirst({ where: { paymentId: run.paymentId } })
        if (after && after.state === 'DETECTED') {
          detectedVia = 'reconcile-raw-decrypt-fallback'
          return after
        }
        return null
      },
      {
        timeoutMs: DETECT_TIMEOUT_MS,
        intervalMs: DETECT_POLL_MS,
        onPoll: async () => {
          await servedPidDiagnostics(recipient, run.tipHash, run.paymentId)
          const row = await prisma.observedTip.findFirst({ where: { paymentId: run.paymentId }, select: { state: true } })
          return `tipState=${row?.state ?? 'none'}`
        }
      }
    )
    console.log(`  DETECTED via ${detectedVia}: tip id=${detected.id} piconeros=${detected.piconeros.toString()}`)
    expect(['webhook', 'reconcile-raw-decrypt-fallback']).toContain(detectedVia)
    expect(detected.txHash).toBeTruthy()
    expect(detected.height).not.toBeNull()

    // ---- 5. CONFIRMED at REQUIRED_CONFIRMATIONS (webhook or confirmFinalizer) --
    const confirmed = await pollUntil(
      'ObservedTip CONFIRMED',
      async () => {
        const row = await prisma.observedTip.findUnique({ where: { id: detected.id } })
        return row && row.state === 'CONFIRMED' ? row : null
      },
      { timeoutMs: CONFIRM_TIMEOUT_MS, intervalMs: CONFIRM_POLL_MS }
    )
    console.log(`  CONFIRMED: confirmations=${confirmed.confirmations}`)
    expect(confirmed.confirmations).toBeGreaterThanOrEqual(REQUIRED_CONFIRMATIONS)

    const confUser = await prisma.user.findUnique({ where: { id: run.authorUserId }, select: { stackedPiconeros: true } })
    expect(confUser.stackedPiconeros - baseUser.stackedPiconeros).toBe(detected.piconeros)
    console.log('  two-account tip fully credited — detection did not depend on lws pid attribution')
  }, 45 * 60_000)
})
