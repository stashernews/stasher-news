/* eslint-env jest */

// =============================================================================
// Phase 2 exit-gate integration test (Task 10 / spec §10).
//
// End-to-end on STAGENET against the REAL monerod + monero-lws + app + worker:
//   register an author wallet
//   -> create a post bound to one of the author's subaddresses
//   -> send a real stagenet tip to that subaddress
//   -> the live moneroIndexer observes it (ObservedTip DETECTED, Item.msats +
//      ranktop/ranklit bumped by the ranking trigger)
//   -> after ~10 stagenet confirmations the live confirmFinalizer flips it
//      CONFIRMED and bumps the author's User.stackedPiconeros.
//
// This exercises the FULL non-custodial observation pipeline built in Tasks
// 1-9 against real chain state. It is the Phase 2 exit gate.
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
//    (monerod + monero-lws + app + worker all running.)
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
//                                the worker decrypts the view key at runtime to
//                                poll lws, so the test must encrypt with the
//                                SAME key the worker decrypts with.
//
//    Send mode (pick one):
//      STAGENET_SENDER_SEED      25-word mnemonic of a funded stagenet wallet ->
//                                PROGRAMMATIC send via monero-ts (default if set).
//                                Optional STAGENET_DAEMON_URI (default
//                                http://127.0.0.1:38081).
//      (unset STAGENET_SENDER_SEED) -> MANUAL send: the test prints the
//                                recipient subaddress + faucet URLs and waits
//                                for the operator to send, then polls.
//
//    Optional tuning:
//      STAGENET_TIP_PICONEROS    tip amount in piconeros (default 1_000_000_000
//                                = 0.001 XMR; must be > dust).
//      STAGENET_SUB_MAJOR / STAGENET_SUB_MINOR / STAGENET_AUTHOR_SUBADDRESS
//                                receive via a real subaddress instead of the
//                                primary (0,0). Defaults: primary @ (0,0).
//
// 5. TIME BUDGET: stagenet blocks are ~2 min; confirmFinalizer needs
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
  MONERO_POLL_INTERVAL_MS,
  CONFIRM_POLL_INTERVAL_MS,
  REQUIRED_CONFIRMATIONS
} from '@/lib/constants'

// Network pin: the resolver validates via monero-ts against MONERO_NETWORK and
// persists the Prisma Network enum from the same env. The whole pipeline is
// stagenet-only for this test.
process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'

// Tip amount: 0.001 XMR = 1e9 piconeros. Overridable for dust/threshold tests.
const TIP_PICONEROS = BigInt(process.env.STAGENET_TIP_PICONEROS || '1000000000')

// Subaddress to receive the tip. Default to the primary address at account 0,
// subaddress 0 (on a standard wallet (0,0) IS the primary address, so tipping
// the primary registers + maps cleanly — mirrors test/api/resolvers/monero.test.js).
const SUB_MAJOR = Number(process.env.STAGENET_SUB_MAJOR || 0)
const SUB_MINOR = Number(process.env.STAGENET_SUB_MINOR || 0)

// Detection: the worker polls every MONERO_POLL_INTERVAL_MS; budget a few
// intervals + lws scan lag. Confirmation: ~2 min/block * 10 + finalizer cadence.
const DETECT_TIMEOUT_MS = Math.max(4 * MONERO_POLL_INTERVAL_MS, 120_000)
const DETECT_POLL_MS = 5_000
const CONFIRM_TIMEOUT_MS = 25 * 60_000
const CONFIRM_POLL_MS = 30_000

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function requireEnv (name) {
  const v = process.env[name]
  if (!v) throw new Error(`integration test requires ${name} to be set (see the prerequisites at the top of this file)`)
  return v
}

// Diagnostic dump on failure: every signal an operator needs to localize where
// the pipeline stalled (lws vs indexer vs trigger vs finalizer).
async function dumpDiagnostics (postId, accountId, recipientAddress) {
  console.log('--- diagnostic dump ---')
  const tip = await prisma.observedTip.findFirst({
    where: { postId },
    orderBy: { detectedAt: 'desc' }
  })
  console.log('  ObservedTip:', tip ? JSON.stringify(tip, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2) : '(none for this post)')
  const item = await prisma.item.findUnique({ where: { id: postId }, select: { msats: true, ranktop: true, ranklit: true, commentMsats: true } })
  console.log('  Item:', item ? JSON.stringify(item, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v) : '(missing)')
  const acct = await prisma.moneroAccount.findUnique({
    where: { id: accountId },
    select: { id: true, address: true, status: true, lastTxId: true, lastBlockHash: true }
  })
  console.log('  MoneroAccount:', acct ? JSON.stringify(acct, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v) : '(missing)')
  const sub = await prisma.subaddressIndex.findUnique({
    where: { accountId_majorIndex_minorIndex: { accountId, majorIndex: SUB_MAJOR, minorIndex: SUB_MINOR } }
  })
  console.log('  SubaddressIndex:', sub ? JSON.stringify(sub) : '(missing)')
  try {
    const full = await prisma.moneroAccount.findUnique({ where: { id: accountId }, include: { viewKey: true } })
    const resp = await lwsClient.getAddressTxs(full, 0n, null)
    const txs = (resp.transactions || []).map(t => ({ hash: t.hash, id: t.id, height: t.height ?? null, piconeros: t.piconeros?.toString(), recipient: t.recipient }))
    console.log(`  lws /get_address_txs blockchain_height=${resp.blockchain_height} tx_count=${txs.length}`)
    console.log('  lws recent txs:', JSON.stringify(txs.slice(-5), null, 2))
  } catch (err) {
    console.log('  lws /get_address_txs FAILED:', err && err.message)
  }
  console.log('--- end diagnostic dump ---')
}

// Read the current chain tip once (for progress logging during confirmation).
async function chainHeight () {
  try { return await daemonClient.getHeight() } catch { return 0 }
}

// Race-safe cursor seed (only advances lastTxId if it is still 0). Prevents the
// live worker from re-detecting the wallet's pre-existing incoming history on
// first registration. Safe under concurrency: if the worker already advanced
// the cursor, the conditional update is a no-op.
async function seedCursorIfFresh (accountId) {
  const full = await prisma.moneroAccount.findUnique({ where: { id: accountId }, include: { viewKey: true } })
  const resp = await lwsClient.getAddressTxs(full, 0n, null)
  let maxId = 0n
  for (const t of resp.transactions || []) {
    if (typeof t.id === 'number' && BigInt(t.id) > maxId) maxId = BigInt(t.id)
  }
  if (maxId > 0n) {
    const r = await prisma.moneroAccount.updateMany({
      where: { id: accountId, lastTxId: 0n },
      data: { lastTxId: maxId }
    })
    if (r.count) console.log(`  cursor seeded to lastTxId=${maxId} (skipped ${maxId} pre-existing tx id(s))`)
  }
}

// PROGRAMMATIC send: restore the sender from its mnemonic, create+relay a tx to
// the recipient subaddress, return the tx hash. monero-ts is dynamically
// imported so the WASM module isn't loaded when the test is skipped.
async function sendTipProgrammatic (recipientAddress, amountPiconeros) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const wallet = await api.createWalletFull({
    password: 'sndev-stagenet-integration-test',
    networkType: api.MoneroNetworkType.STAGENET,
    seed: requireEnv('STAGENET_SENDER_SEED'),
    server: { uri: process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081' },
    proxyToWorker: false
  })
  try {
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

// MANUAL send: print the recipient + faucet URLs and block until the operator
// confirms they've sent the tip (Enter on stdin). Returns the optional tx hash
// the operator pastes (or null — assertions poll by postId either way).
async function sendTipManual (recipientAddress, amountPiconeros) {
  console.log('\n  ============================================================')
  console.log('  MANUAL SEND MODE (STAGENET_SENDER_SEED not set)')
  console.log('  Send >= 0.001 XMR stagenet to this address:')
  console.log(`    ${recipientAddress}`)
  console.log(`  (expected tip for this run: ${amountPiconeros.toString()} piconeros)`)
  console.log('  Faucets / explorer:')
  console.log(`    https://stagenet-faucet.xmr-tw.org/?address=${recipientAddress}`)
  console.log(`    https://melo.tools/faucet/stagenet/${recipientAddress}`)
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
;(STAGENET_ENABLED ? describe : describe.skip)('Phase 2 stagenet exit gate', () => {
  // NOTE: no suite-level jest.setTimeout here — the describe callback runs at
  // collection time EVEN when skipped, so a setTimeout call here would globally
  // raise the default timeout for a normal `./sndev test` run. The long-running
  // test instead passes its own 30-min timeout as test()'s 4th arg; the hooks
  // (env check, cleanup) are fast under the default timeout.

  // Per-run handle so afterAll/afterEach can clean up the fresh post even if an
  // assertion threw mid-flow.
  const run = { postId: null, accountId: null, userId: null, tipHash: null }

  beforeAll(() => {
    // Fail fast with a clear message if the operator forgot a required env var.
    requireEnv('STAGENET_AUTHOR_ADDRESS')
    requireEnv('STAGENET_AUTHOR_VIEWKEY')
    requireEnv('VIEWKEY_MASTER_KEY')
  })

  afterEach(async () => {
    if (!run.postId) return
    // Keep the account/user/subaddressIndex across runs: the MoneroAccount cursor
    // (lastTxId) must persist so old tips aren't re-detected, and lws addAccount is
    // idempotent on address. Only the per-run post + its observed tips are torn
    // down so each run starts from a fresh (msats=0) Item. Null the subaddress
    // assignment first (FK: SubaddressIndex.assignedPostId -> Item.id).
    try {
      await prisma.subaddressIndex.updateMany({
        where: { assignedPostId: run.postId },
        data: { assignedPostId: null }
      })
      await prisma.observedTip.deleteMany({ where: { postId: run.postId } })
      await prisma.itemUserAgg.deleteMany({ where: { itemId: run.postId } })
      await prisma.item.deleteMany({ where: { id: run.postId } })
    } catch (err) {
      console.warn('afterEach cleanup failed (left for manual cleanup):', err && err.message)
    }
    run.postId = null
  })

  afterAll(async () => { await prisma.$disconnect() })

  test('register -> send -> DETECTED (msats + ranking) -> CONFIRMED (stackedPiconeros)', async () => {
    const address = process.env.STAGENET_AUTHOR_ADDRESS
    const viewKey = process.env.STAGENET_AUTHOR_VIEWKEY
    const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()

    // ---- 1. Register the author (or reuse an existing account across runs) ----
    // First run exercises the full registerMoneroAccount path (monero-ts
    // validation, envelope encryption, lws addAccount + upsertSubaddrs, schema
    // writes). Re-runs reuse the account so its lws cursor persists.
    let account = await prisma.moneroAccount.findFirst({ where: { address, network }, include: { user: true } })
    if (!account) {
      const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      const userId = rows[0].id
      const subAddress = process.env.STAGENET_AUTHOR_SUBADDRESS || address
      const created = await resolvers.Mutation.registerMoneroAccount(null, {
        address,
        viewKey,
        privacyMode: 'AUTO_INDEX',
        subaddresses: [{ majorIndex: SUB_MAJOR, minorIndex: SUB_MINOR, address: subAddress }]
      }, { me: { id: userId }, models: prisma, monero: lwsClient })
      account = await prisma.moneroAccount.findUnique({ where: { id: created.id }, include: { user: true } })
      console.log(`  registered author account id=${account.id} user=${userId} (full resolver path)`)
    } else {
      console.log(`  reusing author account id=${account.id} user=${account.ownerUserId} (cursor lastTxId=${account.lastTxId})`)
    }
    run.accountId = account.id
    run.userId = account.ownerUserId

    // ---- 2. Seed the lws cursor BEFORE binding any post, so any historical ----
    // tips the worker flushes during the race window have no assignedPostId and
    // are skipped by the indexer's null-assignment guard.
    await seedCursorIfFresh(account.id)

    // ---- 3. Create a fresh post (msats starts at 0) + capture baselines ------
    const title = `test-stagenet-${Date.now()}`
    const inserted = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title) VALUES (${run.userId}::int, ${title}) RETURNING id::int AS id`
    const postId = inserted[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree WHERE id = ${postId}::int`
    run.postId = postId
    console.log(`  created post id=${postId} title="${title}"`)

    // Bind the subaddress to this post + mirror the denorm on Item for realism.
    await prisma.subaddressIndex.update({
      where: { accountId_majorIndex_minorIndex: { accountId: account.id, majorIndex: SUB_MAJOR, minorIndex: SUB_MINOR } },
      data: { assignedPostId: postId }
    })
    await prisma.item.update({
      where: { id: postId },
      data: { subaddressIndexMajor: SUB_MAJOR, subaddressIndexMinor: SUB_MINOR, moneroAccountId: account.id }
    })
    const sub = await prisma.subaddressIndex.findUnique({
      where: { accountId_majorIndex_minorIndex: { accountId: account.id, majorIndex: SUB_MAJOR, minorIndex: SUB_MINOR } }
    })
    const recipientAddress = process.env.STAGENET_AUTHOR_SUBADDRESS || sub.address || address

    const baseItem = await prisma.item.findUnique({ where: { id: postId }, select: { msats: true, ranktop: true, ranklit: true } })
    const baseUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })
    console.log(`  baseline: Item.msats=${baseItem.msats.toString()} ranktop=${baseItem.ranktop} ranklit=${baseItem.ranklit}; User.stackedPiconeros=${baseUser.stackedPiconeros.toString()}`)

    // ---- 4. Send the tip (programmatic by default, manual if no seed env) ----
    const sendMode = process.env.STAGENET_SENDER_SEED ? 'programmatic' : 'manual'
    console.log(`  send mode: ${sendMode} (tip=${TIP_PICONEROS.toString()} piconeros -> ${recipientAddress})`)
    try {
      run.tipHash = sendMode === 'programmatic'
        ? await sendTipProgrammatic(recipientAddress, TIP_PICONEROS)
        : await sendTipManual(recipientAddress, TIP_PICONEROS)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, recipientAddress)
      throw new Error(`send failed (${sendMode} mode): ${err && err.message}`)
    }
    if (run.tipHash) console.log(`  sent tx ${run.tipHash}`)

    // ---- 5. Poll for DETECTED (timeout ~ a few indexer poll intervals) -------
    let detected = null
    try {
      detected = await pollUntil(
        'ObservedTip DETECTED',
        async () => {
          const row = await prisma.observedTip.findFirst({ where: { postId }, orderBy: { detectedAt: 'desc' } })
          return row && row.state === 'DETECTED' ? row : null
        },
        { timeoutMs: DETECT_TIMEOUT_MS, intervalMs: DETECT_POLL_MS, onPoll: async () => `lastTxId=${(await prisma.moneroAccount.findUnique({ where: { id: account.id } })).lastTxId.toString()}` }
      )
    } catch (err) {
      await dumpDiagnostics(postId, account.id, recipientAddress)
      throw err
    }
    console.log(`  DETECTED: tip id=${detected.id} piconeros=${detected.piconeros.toString()} height=${detected.height ?? 'mempool'}`)

    // The actual observed amount is the source of truth for every delta
    // assertion. In manual mode the operator may send a different amount than
    // the configured TIP_PICONEROS; in programmatic mode they must match.
    const tipAmount = detected.piconeros
    if (run.tipHash) {
      try { expect(tipAmount).toBe(TIP_PICONEROS) } catch (err) {
        await dumpDiagnostics(postId, account.id, recipientAddress); throw err
      }
    }

    // ---- 6. Assert DETECTED effects -----------------------------------------
    const detItem = await prisma.item.findUnique({ where: { id: postId }, select: { msats: true, ranktop: true, ranklit: true } })
    const detUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })

    try {
      // Fresh post + cursor seeded => msats delta is exactly this tip.
      expect(detItem.msats - baseItem.msats).toBe(tipAmount)
      // The item_ranking BEFORE UPDATE trigger must have recomputed ranktop/ranklit
      // on the msats delta (the silent-failure risk the brief calls out).
      expect(detItem.ranktop).not.toBe(baseItem.ranktop)
      expect(detItem.ranklit).not.toBe(baseItem.ranklit)
      // Author's lifetime CONFIRMED denorm is unchanged until confirmation flips.
      expect(detUser.stackedPiconeros).toBe(baseUser.stackedPiconeros)
      if (run.tipHash) expect(detected.txHash).toBe(run.tipHash)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, recipientAddress)
      throw err
    }
    console.log('  DETECTED assertions passed (msats + ranking trigger fired; stackedPiconeros unchanged)')

    // ---- 7. Poll for CONFIRMED (timeout ~25 min for 10 stagenet confs) ------
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
      await dumpDiagnostics(postId, account.id, recipientAddress)
      throw err
    }
    console.log(`  CONFIRMED: tip id=${confirmed.id} confirmations=${confirmed.confirmations} confirmedAt=${confirmed.confirmedAt.toISOString()}`)

    // ---- 8. Assert CONFIRMED effects ----------------------------------------
    const confUser = await prisma.user.findUnique({ where: { id: run.userId }, select: { stackedPiconeros: true } })
    try {
      expect(confirmed.confirmedAt).toBeInstanceOf(Date)
      expect(confirmed.confirmations).toBeGreaterThanOrEqual(REQUIRED_CONFIRMATIONS)
      // Author's lifetime CONFIRMED denorm bumps by EXACTLY this tip (baseline
      // captured at run start, so prior-run confirmations are already included).
      expect(confUser.stackedPiconeros - baseUser.stackedPiconeros).toBe(tipAmount)
    } catch (err) {
      await dumpDiagnostics(postId, account.id, recipientAddress)
      throw err
    }
    console.log('  CONFIRMED assertions passed (stackedPiconeros bumped by exactly the tip amount)')
  }, 30 * 60_000)
})

// Generic timeout-bounded poller with progress logging. `condition` returns a
// truthy value when satisfied (returned to the caller) or null/false to retry.
// `onPoll` returns a short status string logged each attempt.
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
