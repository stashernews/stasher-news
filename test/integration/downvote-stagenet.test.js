/* eslint-env jest */

// =============================================================================
// Phase 4 exit-gate integration test — REWARDS-FUNDED DOWNVOTE on STAGENET.
//
// Verifies the downvote backend (Tasks 1-5) against the REAL monerod +
// monero-lws + app + worker stack end to end:
//   - create a post + a downvote INTEGRATED address (rewards primary + payment_id)
//     + seed its DownvotePidMap reverse map (calling the helpers directly, NOT the
//     full payIn engine — the unit under test is the rewardsWalletObserver detection +
//     ranking, mirroring how phase3 calls reserveFeeSubaddress directly)
//   - send a REAL stagenet downvote to the integrated address
//   - the rewardsWalletObserver observes it -> ObservedDownvote DETECTED + Item.downPiconeros +
//     weightedDownVotes (LOG ranking penalty applied at DETECTION)
//   - confirmFinalizer matures ObservedDownvote -> CONFIRMED at 10 confs
//
// The exit-gate invariants asserted:
//   1. ObservedDownvote appears DETECTED then CONFIRMED (within the poll timeouts).
//   2. Item.downPiconeros increases by exactly the sent piconeros (PRIMARY, unconditional).
//   3. The post AUTHOR is NOT charged: stackedPiconeros unchanged at DETECTION and
//      again at CONFIRMATION (downvotes fund the rewards pool, never the poster).
//   4. ObservedDownvote.piconeros === the sent amount (the rewards pool accrual record).
//   5. weightedDownVotes increases: the downvoter is seeded a nonzero zapPostTrust
//      for the post's territory so the LOG penalty registers a real ranking weight.
//      (A trust-less downvoter correctly yields 0 — SN semantics — and is NOT a
//      gate failure; downPiconeros (invariant 2) is the reliable primary.)
//
// -----------------------------------------------------------------------------
// SKIP GUARD: NEVER runs under `./sndev test`. Gated on RUN_STAGENET_INTEGRATION=1
// (needs a live stagenet stack + a registered rewards wallet + stagenet funds +
// ~20 min for confirmation).
// -----------------------------------------------------------------------------
//
// PREREQUISITES (operator):
// 1. Stack up + synced:  COMPOSE_PROFILES=minimal,monero ./sndev start; ./sndev monero status
// 2. Register + derive the rewards wallet (real stagenet keys in .env.local):
//      ./sndev monero register-rewards-wallet
//      ./sndev monero status   (platform_rewards wallet ACTIVE)
// 3. Environment:
//      RUN_STAGENET_INTEGRATION=1
//      STAGENET_SENDER_SEED     funded stagenet wallet mnemonic (sends the downvote)
//      STAGENET_DAEMON_URI      optional (default http://127.0.0.1:38081)
//      VIEWKEY_MASTER_KEY       must match the app/worker process
//      STAGENET_DOWNVOTE_PICONEROS  optional (default 1000000000 = 0.001 XMR)
//    PLATFORM_REWARDS_ADDRESS is derived at runtime from the registered rewards
//    wallet so the integrated-address base is exactly what the rewardsWalletObserver polls.
//
// HOW TO RUN:
//   RUN_STAGENET_INTEGRATION=1 STAGENET_SENDER_SEED=... VIEWKEY_MASTER_KEY=... \
//   ./sndev test test/integration/downvote-stagenet.test.js
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { makeDownvoteAddress } from '@/api/monero/penalty'
import { getRewardsWalletId } from '@/api/monero/feePool'
import { daemonClient } from '@/api/monero/daemonClient'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'
const DOWNVOTE_PICONEROS = BigInt(process.env.STAGENET_DOWNVOTE_PICONEROS || '1000000000')

const DETECT_TIMEOUT_MS = 600_000
const DETECT_POLL_MS = 10_000
const CONFIRM_TIMEOUT_MS = 25 * 60_000
const CONFIRM_POLL_MS = 30_000
const RESTORE_HEIGHT_MARGIN = 1000
// A reused stagenet sender wallet carries a maturing CHANGE output after each
// send (Monero locks change for 10 blocks). If a prior run spent from the
// sender recently, its whole balance is briefly "locked" (getUnlockedBalance()
// == 0) even though getBalance() is large. Wait for the change to mature before
// constructing the downvote tx, else monero-ts throws "not enough unlocked money".
const SEND_WAIT_UNLOCK_MS = 20 * 60_000
const SEND_WAIT_POLL_MS = 30_000
const SEND_FEE_MARGIN_PICONEROS = 100_000_000n // 0.0001 XMR; observed stagenet fee ~0.000044

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function requireEnv (name) {
  const v = process.env[name]
  if (!v) throw new Error(`integration test requires ${name} (see prerequisites at the top of this file)`)
  return v
}

async function pollUntil (label, pred, { timeoutMs = DETECT_TIMEOUT_MS, pollMs = DETECT_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = await pred()
      if (out) return out
    } catch (err) {
      console.log(`  poll(${label}) transient error: ${err && err.message}`)
    }
    await sleep(pollMs)
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms`)
}

// Reused from phase3-tipping-posting-fees-stagenet.test.js: opens the funded
// stagenet sender wallet, scans from (tip - RESTORE_HEIGHT_MARGIN) for speed,
// and relays a tx to `recipientAddress` — here the 106-char downvote INTEGRATED
// address (rewards primary + payment_id). monero-ts createTx accepts integrated
// addresses and embeds the payment_id automatically. Returns the tx hash.
async function sendDownvote (recipientAddress, amountPiconeros) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  let restoreHeight = 0
  try {
    restoreHeight = Math.max(0, await daemonClient.getHeight() - RESTORE_HEIGHT_MARGIN)
  } catch {
    // daemon unreachable -> wallet falls back to a from-genesis scan and the
    // send fails loudly anyway
  }
  const wallet = await api.createWalletFull({
    password: 'sndev-phase4-downvote-integration',
    networkType: api.MoneroNetworkType.STAGENET,
    seed: requireEnv('STAGENET_SENDER_SEED'),
    restoreHeight,
    server: { uri: process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081' },
    proxyToWorker: false
  })
  try {
    await wallet.sync()
    // Wait until the sender has enough UNLOCKED balance. Monero locks change
    // outputs for 10 blocks; a freshly reused sender can report balance > 0 but
    // unlocked == 0 right after a prior send. Polling here makes the gate
    // resilient to that maturation window instead of failing with a misleading
    // "not enough unlocked money".
    const need = amountPiconeros + SEND_FEE_MARGIN_PICONEROS
    const unlockDeadline = Date.now() + SEND_WAIT_UNLOCK_MS
    while (Date.now() < unlockDeadline) {
      const unlocked = await wallet.getUnlockedBalance()
      if (unlocked >= need) break
      const bal = await wallet.getBalance()
      console.log(`  sendDownvote: waiting for sender change to mature (balance=${bal.toString()} unlocked=${unlocked.toString()} need=${need.toString()}); retry in ${SEND_WAIT_POLL_MS / 1000}s`)
      await wallet.sync()
      await sleep(SEND_WAIT_POLL_MS)
    }
    const unlocked = await wallet.getUnlockedBalance()
    if (unlocked < need) {
      throw new Error(`sender has insufficient unlocked balance (${unlocked.toString()} < ${need.toString()}); fund STAGENET_SENDER_SEED or wait for change to mature`)
    }
    const tx = await wallet.createTx({ accountIndex: 0, address: recipientAddress, amount: amountPiconeros, relay: true })
    const hash = tx.getHash()
    return Array.isArray(hash) ? hash[0] : hash
  } finally {
    await wallet.close()
  }
}

async function chainHeight () {
  try { return await daemonClient.getHeight() } catch { return 0 }
}

// =============================================================================
;(STAGENET_ENABLED ? describe : describe.skip)('Phase 4 stagenet exit gate (downvote ranking penalty + pool accrual)', () => {
  const created = { users: [], items: [], subs: [], maps: [] }

  beforeAll(async () => {
    requireEnv('VIEWKEY_MASTER_KEY')
    // makeDownvoteAddress reads PLATFORM_REWARDS_ADDRESS; derive it from the
    // registered rewards wallet so the integrated-address base is exactly the
    // wallet the rewardsWalletObserver polls (no env-var mismatch possible).
    const rewardsId = await getRewardsWalletId(prisma)
    const rewards = await prisma.moneroAccount.findUnique({ where: { id: rewardsId } })
    process.env.PLATFORM_REWARDS_ADDRESS = rewards.address
  })

  afterAll(async () => {
    // FK-safe order: ObservedDownvote -> ItemUserAgg -> DownvotePidMap -> Item ->
    // UserSubTrust -> Sub -> users.
    await prisma.observedDownvote.deleteMany({ where: { postId: { in: created.items } } })
    await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } })
    for (const pid of created.maps) await prisma.downvotePidMap.deleteMany({ where: { paymentId: pid } })
    for (const id of created.items) await prisma.item.deleteMany({ where: { id } })
    for (const name of created.subs) {
      await prisma.userSubTrust.deleteMany({ where: { subName: name } })
      await prisma.sub.deleteMany({ where: { name } })
    }
    for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
    await prisma.$disconnect()
  })

  async function createUser () {
    const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(rows[0].id)
    return rows[0].id
  }

  test('downvote -> ObservedDownvote DETECTED (downPiconeros + weightedDownVotes; poster NOT charged) -> CONFIRMED', async () => {
    // ---- 1. seed a poster, a downvoter, a territory + the downvoter's trust ---
    const posterId = await createUser()
    const downvoterId = await createUser()
    const subName = `_p4downvote_${Date.now()}`
    await prisma.sub.create({
      data: { name: subName, userId: posterId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0 }
    })
    created.subs.push(subName)
    // nonzero zapPostTrust => weightedDownVotes receives a real LOG delta (a
    // trust-less downvoter correctly yields 0; downPiconeros is the primary invariant).
    await prisma.userSubTrust.create({
      data: { subName, userId: downvoterId, zapPostTrust: 1.0, subZapPostTrust: 1.0 }
    })

    // ---- 2. create the target root post in that territory --------------------
    const inserted = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title) VALUES (${posterId}::int, ${'phase4 stagenet downvote gate'})
      RETURNING id::int AS id`
    const postId = inserted[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree, "subNames" = ARRAY[${subName}]::CITEXT[] WHERE id = ${postId}::int`
    created.items.push(postId)

    // ---- 3. downvote integrated address + payment_id reverse map (direct) ----
    const nonce = 12345
    const { integratedAddress, paymentId } = makeDownvoteAddress(postId, nonce)
    expect(integratedAddress.length).toBe(106) // guard: bad base address => fail fast
    await prisma.downvotePidMap.create({
      data: { paymentId, postId, nonce, userId: downvoterId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
    })
    created.maps.push(paymentId)
    console.log(`  downvote: postId=${postId} paymentId=${paymentId} downvoterId=${downvoterId} integrated=${integratedAddress.slice(0, 16)}...(${integratedAddress.length})`)

    // ---- 4. baselines --------------------------------------------------------
    const baseItem = await prisma.item.findUnique({ where: { id: postId }, select: { downPiconeros: true, weightedDownVotes: true } })
    const basePoster = await prisma.user.findUnique({ where: { id: posterId }, select: { stackedPiconeros: true } })
    console.log(`  baseline: downPiconeros=${baseItem.downPiconeros.toString()} weightedDownVotes=${baseItem.weightedDownVotes} poster.stackedPiconeros=${basePoster.stackedPiconeros.toString()}`)

    // ---- 5. send a REAL stagenet downvote to the integrated rewards address --
    const hash = await sendDownvote(integratedAddress, DOWNVOTE_PICONEROS)
    console.log(`  sent downvote tx ${hash} (${DOWNVOTE_PICONEROS.toString()} piconeros)`)

    // ---- 6. poll for ObservedDownvote DETECTED -----------------------------------
    const detected = await pollUntil('ObservedDownvote DETECTED', async () => {
      const downvote = await prisma.observedDownvote.findFirst({ where: { paymentId } })
      if (downvote && downvote.state === 'DETECTED') return downvote
      console.log(`    [DETECTED] chain=${await chainHeight()}; not yet`)
      return null
    })
    console.log(`  DETECTED: downvote id=${detected.id} piconeros=${detected.piconeros.toString()} downvoterId=${detected.downvoterId} height=${detected.height ?? 'mempool'}`)

    // ---- 7. assert DETECTED effects -----------------------------------------
    expect(detected.paymentId).toBe(paymentId)
    expect(detected.piconeros).toBe(DOWNVOTE_PICONEROS) // rewards pool accrual record
    expect(detected.downvoterId).toBe(downvoterId)

    const detItem = await prisma.item.findUnique({ where: { id: postId }, select: { downPiconeros: true, weightedDownVotes: true } })
    expect(detItem.downPiconeros - baseItem.downPiconeros).toBe(DOWNVOTE_PICONEROS) // PRIMARY invariant
    expect(detItem.weightedDownVotes).toBeGreaterThan(baseItem.weightedDownVotes) // trust-seeded LOG penalty

    // poster NOT charged: downvotes fund the rewards pool, never the poster
    const detPoster = await prisma.user.findUnique({ where: { id: posterId }, select: { stackedPiconeros: true } })
    expect(detPoster.stackedPiconeros).toBe(basePoster.stackedPiconeros)
    console.log('  DETECTED assertions passed (downPiconeros + weightedDownVotes bumped; poster stackedPiconeros unchanged)')

    // ---- 8. poll for ObservedDownvote CONFIRMED ----------------------------------
    const confirmed = await pollUntil('ObservedDownvote CONFIRMED', async () => {
      const downvote = await prisma.observedDownvote.findUnique({ where: { id: detected.id }, select: { state: true, height: true, confirmations: true, confirmedAt: true } })
      if (downvote && downvote.state === 'CONFIRMED') return downvote
      const chain = await chainHeight()
      const downvoteH = downvote?.height ?? null
      const confs = downvoteH != null ? chain - downvoteH + 1 : 0
      console.log(`    [CONFIRMED] chain=${chain} downvoteHeight=${downvoteH ?? 'mempool'} confs=${confs}/${REQUIRED_CONFIRMATIONS}`)
      return null
    }, { timeoutMs: CONFIRM_TIMEOUT_MS, pollMs: CONFIRM_POLL_MS })
    console.log(`  CONFIRMED: downvote id=${detected.id} confirmations=${confirmed.confirmations} confirmedAt=${confirmed.confirmedAt.toISOString()}`)

    // ---- 9. assert CONFIRMED effects ----------------------------------------
    expect(confirmed.state).toBe('CONFIRMED')
    expect(confirmed.confirmations).toBeGreaterThanOrEqual(REQUIRED_CONFIRMATIONS)
    expect(confirmed.confirmedAt).toBeInstanceOf(Date)
    // poster STILL not charged at finality (downvotes never reach the author)
    const confPoster = await prisma.user.findUnique({ where: { id: posterId }, select: { stackedPiconeros: true } })
    expect(confPoster.stackedPiconeros).toBe(basePoster.stackedPiconeros)
    console.log('  CONFIRMED assertions passed (poster stackedPiconeros unchanged at finality)')
  }, DETECT_TIMEOUT_MS + CONFIRM_TIMEOUT_MS + SEND_WAIT_UNLOCK_MS + 60_000)
})
