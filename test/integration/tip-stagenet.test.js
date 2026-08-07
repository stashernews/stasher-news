/* eslint-env jest */

// =============================================================================
// Phase 2 exit-gate integration test — WEBHOOK FLOW (spec 2026-07-27 §7).
//
// End-to-end on STAGENET against the REAL monerod + monero-lws + app + worker:
//   register an author wallet (primary address + view key)
//   -> create a post
//   -> initiateTip (generates payment ID + integrated address, registers a lws
//      tx-confirmation webhook, creates a PENDING ObservedTip)
//   -> send a real stagenet tip to the integrated address
//   -> lws pushes a 0-conf webhook -> ObservedTip DETECTED, Item.piconeros +
//      ranktop/ranklit bumped by the ranking trigger
//   -> lws pushes a 10-conf webhook (or confirmFinalizer catches it) ->
//      ObservedTip CONFIRMED, author's User.stackedPiconeros bumped.
//
// This exercises the FULL non-custodial webhook pipeline against real chain
// state. It is the Phase 2 exit gate.
//
// -----------------------------------------------------------------------------
// SKIP GUARD: this test NEVER runs under `./sndev test`. It is gated on
//   RUN_STAGENET_INTEGRATION=1
// so a normal CI/local test run skips it (it needs a live stagenet stack and
// ~20 min of wall-clock for confirmation). See the describe.skip block below.
// -----------------------------------------------------------------------------
//
// =============================================================================
// PREREQUISITES (operator must set these up before running)
// =============================================================================
//
// 1. Bring up the monero stack + app + worker:
//      COMPOSE_PROFILES=minimal,monero ./sndev start
//    (monerod + monero-lws + app + worker all running. The app's webhook
//    receiver is at http://app:3000/api/monero/webhook — lws calls it.)
//
// 2. Sync monerod to the stagenet tip:
//      ./sndev monero status
//    (height should track the stagenet target; lws scans lag behind monerod.)
//
// 3. A funded stagenet SENDER wallet to tip FROM (needed only for programmatic
//    send mode; in manual mode any faucet/wallet works).
//
// 4. Environment (export before running):
//      RUN_STAGENET_INTEGRATION=1
//      STAGENET_AUTHOR_ADDRESS   primary address of the author wallet to register
//      STAGENET_AUTHOR_VIEWKEY   matching PRIVATE view key
//      VIEWKEY_MASTER_KEY        MUST match what the app/worker process reads —
//                                the app decrypts the view key at runtime, so
//                                the test must encrypt with the SAME key.
//      LWS_WEBHOOK_URL           must match what lws can reach (default
//                                http://app:3000/api/monero/webhook in dev).
//
//    Send mode (pick one):
//      STAGENET_SENDER_SEED      25-word mnemonic of a funded stagenet wallet ->
//                                PROGRAMMATIC send via monero-ts (default if set).
//                                Optional STAGENET_DAEMON_URI (default
//                                http://127.0.0.1:38081).
//      (unset STAGENET_SENDER_SEED) -> MANUAL send: the test prints the
//                                integrated address + monero: URI and waits
//                                for the operator to send, then polls.
//
//    Optional tuning:
//      STAGENET_TIP_PICONEROS    tip amount in piconeros (default 1_000_000_000
//                                = 0.001 XMR; must be > dust).
//
// 5. TIME BUDGET: stagenet blocks are ~2 min; confirmation needs
//    REQUIRED_CONFIRMATIONS (10) => ~20 min to CONFIRMED. The test budgets
//    ~25 min for the confirmation phase. Plan accordingly.
//
// -----------------------------------------------------------------------------
// HOW TO RUN (once the above is in place):
//   RUN_STAGENET_INTEGRATION=1 \
//   STAGENET_AUTHOR_ADDRESS=... STAGENET_AUTHOR_VIEWKEY=... \
//   VIEWKEY_MASTER_KEY=... \
//   [STAGENET_SENDER_SEED=...] \
//   ./sndev test test/integration/tip-stagenet.test.js
// =============================================================================

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/monero'
import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import {
  CONFIRM_POLL_INTERVAL_MS,
  REQUIRED_CONFIRMATIONS
} from '@/lib/constants'

process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'
process.env.LWS_WEBHOOK_URL = process.env.LWS_WEBHOOK_URL || 'http://app:3000/api/monero/webhook'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'

const TIP_PICONEROS = BigInt(process.env.STAGENET_TIP_PICONEROS || '1000000000')

// Detection: the webhook should fire within seconds of lws seeing the tx, but
// lws scan lag exists. Confirmation: ~2 min/block * 10 + finalizer cadence.
const DETECT_TIMEOUT_MS = 120_000
const DETECT_POLL_MS = 5_000
const CONFIRM_TIMEOUT_MS = 6 * 60_000
const CONFIRM_POLL_MS = 30_000

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function requireEnv (name) {
  const v = process.env[name]
  if (!v) throw new Error(`integration test requires ${name} to be set (see the prerequisites at the top of this file)`)
  return v
}

async function dumpDiagnostics (postId, accountId, paymentId) {
  console.log('--- diagnostic dump ---')
  const tip = await prisma.observedTip.findFirst({
    where: paymentId ? { paymentId } : { postId },
    orderBy: { detectedAt: 'desc' }
  })
  console.log('  ObservedTip:', tip ? JSON.stringify(tip, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2) : '(none)')
  const item = await prisma.item.findUnique({ where: { id: postId }, select: { piconeros: true, ranktop: true, ranklit: true, commentPiconeros: true } })
  console.log('  Item:', item ? JSON.stringify(item, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v) : '(missing)')
  const acct = await prisma.moneroAccount.findUnique({
    where: { id: accountId },
    select: { id: true, address: true, status: true }
  })
  console.log('  MoneroAccount:', acct ? JSON.stringify(acct) : '(missing)')
  try {
    const webhooks = await lwsClient.listWebhooks()
    console.log('  lws webhooks:', JSON.stringify(webhooks, null, 2))
  } catch (err) {
    console.log('  lws listWebhooks FAILED:', err && err.message)
  }
  console.log('--- end diagnostic dump ---')
}

async function chainHeight () {
  try { return await daemonClient.getHeight() } catch { return 0 }
}

async function sendTipProgrammatic (recipientAddress, amountPiconeros) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const daemon = await api.connectToDaemonRpc(process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081')
  const chainHeight = await daemon.getHeight()
  const wallet = await api.createWalletFull({
    password: 'sndev-stagenet-integration-test',
    networkType: api.MoneroNetworkType.STAGENET,
    seed: requireEnv('STAGENET_SENDER_SEED'),
    server: { uri: process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081' },
    restoreHeight: Math.max(0, chainHeight - 500),
    proxyToWorker: false
  })
  try {
    await wallet.sync()
    const unlocked = await wallet.getUnlockedBalance(0)
    if (unlocked < BigInt(amountPiconeros)) {
      throw new Error(`sender has insufficient unlocked balance (${unlocked.toString()} < ${amountPiconeros.toString()}); fund STAGENET_SENDER_SEED or wait for change to mature`)
    }
    const tx = await wallet.createTx({
      accountIndex: 0,
      address: recipientAddress,
      amount: amountPiconeros,
      relay: true
    })
    const hash = tx.getHash()
    return Array.isArray(hash) ? hash[0] : hash
  } finally {
    await wallet.close()
  }
}

async function sendTipManual (integratedAddress, moneroUri, amountPiconeros) {
  console.log('\n  ============================================================')
  console.log('  MANUAL SEND MODE (STAGENET_SENDER_SEED not set)')
  console.log('  Send >= 0.001 XMR stagenet to this INTEGRATED address:')
  console.log(`    ${integratedAddress}`)
  console.log('  Or scan / open this monero: URI:')
  console.log(`    ${moneroUri}`)
  console.log(`  (expected tip for this run: ${amountPiconeros.toString()} piconeros)`)
  console.log('  Faucets / explorer:')
  console.log('    https://stagenet.xmrchain.net/')
  console.log('  ============================================================\n')
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const pasted = await rl.question('  Press ENTER once you have sent the tip (optionally paste the tx hash first): ')
    const trimmed = pasted.trim()
    return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed : null
  } finally {
    rl.close()
  }
}

// =============================================================================
// The exit gate. Skipped unless RUN_STAGENET_INTEGRATION=1.
// =============================================================================
;(STAGENET_ENABLED ? describe : describe.skip)('Phase 2 stagenet exit gate (webhook flow)', () => {
  const run = { postId: null, accountId: null, userId: null, tipperId: null, paymentId: null, tipHash: null }

  beforeAll(() => {
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

  test('register -> initiateTip -> send -> DETECTED (piconeros + ranking) -> CONFIRMED (stackedPiconeros)', async () => {
    const address = process.env.STAGENET_AUTHOR_ADDRESS
    const viewKey = process.env.STAGENET_AUTHOR_VIEWKEY
    const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()

    // ---- 1. Register the author (or reuse an existing account across runs) ----
    let account = await prisma.moneroAccount.findFirst({ where: { address, network }, include: { user: true } })
    if (!account) {
      const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      const userId = rows[0].id
      const created = await resolvers.Mutation.registerMoneroAccount(null, {
        address,
        viewKey,
        privacyMode: 'AUTO_INDEX'
      }, { me: { id: userId }, models: prisma, monero: lwsClient })
      account = await prisma.moneroAccount.findUnique({ where: { id: created.id }, include: { user: true } })
      console.log(`  registered author account id=${account.id} user=${userId} (full resolver path)`)
    } else {
      console.log(`  reusing author account id=${account.id} user=${account.ownerUserId}`)
    }
    run.accountId = account.id
    run.userId = account.ownerUserId

    // ---- 2. Create a fresh post (piconeros starts at 0) -------------------------
    const title = `test-stagenet-webhook-${Date.now()}`
    const inserted = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title) VALUES (${run.userId}::int, ${title}) RETURNING id::int AS id`
    const postId = inserted[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree WHERE id = ${postId}::int`
    run.postId = postId
    console.log(`  created post id=${postId} title="${title}"`)

    // ---- 3. Initiate the tip (payment ID + integrated address + webhook) -----
    const tipperRows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    run.tipperId = tipperRows[0].id
    const initiation = await resolvers.Mutation.initiateTip(null, {
      postId: String(postId),
      amount: TIP_PICONEROS.toString()
    }, { me: { id: run.tipperId }, models: prisma, monero: lwsClient })
    run.paymentId = initiation.paymentId
    console.log(`  initiateTip: paymentId=${initiation.paymentId} integrated=${initiation.integratedAddress.slice(0, 20)}...`)

    // ---- 4. Capture baselines ------------------------------------------------
    const baseItem = await prisma.item.findUnique({ where: { id: postId }, select: { piconeros: true, ranktop: true, ranklit: true } })
    const baseUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })
    console.log(`  baseline: Item.piconeros=${baseItem.piconeros.toString()} ranktop=${baseItem.ranktop} ranklit=${baseItem.ranklit}; User.stackedPiconeros=${baseUser.stackedPiconeros.toString()}`)

    // ---- 5. Send the tip to the integrated address ---------------------------
    const sendMode = process.env.STAGENET_SENDER_SEED ? 'programmatic' : 'manual'
    console.log(`  send mode: ${sendMode} (tip=${TIP_PICONEROS.toString()} piconeros)`)
    try {
      run.tipHash = sendMode === 'programmatic'
        ? await sendTipProgrammatic(initiation.integratedAddress, TIP_PICONEROS)
        : await sendTipManual(initiation.integratedAddress, initiation.uri, TIP_PICONEROS)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, run.paymentId)
      throw new Error(`send failed (${sendMode} mode): ${err && err.message}`)
    }
    if (run.tipHash) console.log(`  sent tx ${run.tipHash}`)

    // ---- 6. Poll for DETECTED (webhook fires at 0-conf) ----------------------
    let detected = null
    try {
      detected = await pollUntil(
        'ObservedTip DETECTED',
        async () => {
          const row = await prisma.observedTip.findFirst({ where: { paymentId: run.paymentId } })
          return row && row.state === 'DETECTED' ? row : null
        },
        { timeoutMs: DETECT_TIMEOUT_MS, intervalMs: DETECT_POLL_MS }
      )
    } catch (err) {
      await dumpDiagnostics(postId, account.id, run.paymentId)
      throw err
    }
    console.log(`  DETECTED: tip id=${detected.id} piconeros=${detected.piconeros.toString()} height=${detected.height ?? 'mempool'}`)

    const tipAmount = detected.piconeros

    // ---- 7. Assert DETECTED effects ------------------------------------------
    const detItem = await prisma.item.findUnique({ where: { id: postId }, select: { piconeros: true, ranktop: true, ranklit: true } })
    const detUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })

    try {
      expect(detItem.piconeros - baseItem.piconeros).toBe(tipAmount)
      expect(detItem.ranktop).not.toBe(baseItem.ranktop)
      expect(detItem.ranklit).not.toBe(baseItem.ranklit)
      expect(detUser.stackedPiconeros).toBe(baseUser.stackedPiconeros)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, run.paymentId)
      throw err
    }
    console.log('  DETECTED assertions passed (piconeros + ranking trigger fired; stackedPiconeros unchanged)')

    // ---- 8. Poll for CONFIRMED (webhook at 10-conf, or confirmFinalizer) -----
    let confirmed = null
    try {
      confirmed = await pollUntil(
        'ObservedTip CONFIRMED',
        async () => {
          const row = await prisma.observedTip.findUnique({ where: { id: detected.id } })
          return row && row.state === 'CONFIRMED' ? row : null
        },
        {
          timeoutMs: CONFIRM_TIMEOUT_MS,
          intervalMs: CONFIRM_POLL_MS,
          onPoll: async () => {
            const row = await prisma.observedTip.findUnique({ where: { id: detected.id }, select: { height: true, confirmations: true } })
            const tipH = row?.height ?? null
            const chain = await chainHeight()
            const confs = tipH != null ? chain - tipH + 1 : 0
            return `chain=${chain} tipHeight=${tipH ?? 'mempool'} confs=${confs}/${REQUIRED_CONFIRMATIONS} (finalizer cadence ${Math.round(CONFIRM_POLL_INTERVAL_MS / 1000)}s)`
          }
        }
      )
    } catch (err) {
      await dumpDiagnostics(postId, account.id, run.paymentId)
      throw err
    }
    console.log(`  CONFIRMED: tip id=${confirmed.id} confirmations=${confirmed.confirmations} confirmedAt=${confirmed.confirmedAt.toISOString()}`)

    // ---- 9. Assert CONFIRMED effects -----------------------------------------
    const confUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })
    try {
      expect(confirmed.confirmedAt).toBeInstanceOf(Date)
      expect(confirmed.confirmations).toBeGreaterThanOrEqual(REQUIRED_CONFIRMATIONS)
      expect(confUser.stackedPiconeros - baseUser.stackedPiconeros).toBe(tipAmount)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, run.paymentId)
      throw err
    }
    console.log('  CONFIRMED assertions passed (stackedPiconeros bumped by exactly the tip amount)')
  }, 10 * 60_000)
})

async function pollUntil (label, condition, { timeoutMs, intervalMs, onPoll } = {}) {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const detail = onPoll ? await onPoll() : ''
    const result = await condition()
    if (result) return result
    console.log(`  [${label}] poll #${attempt}: not yet${detail ? ` — ${detail}` : ''}; retry in ${Math.round(intervalMs / 1000)}s`)
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for "${label}" after ${Math.round(timeoutMs / 1000)}s`)
}
