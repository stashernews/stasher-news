/* eslint-env jest */

// =============================================================================
// Phase 3 exit-gate integration test — POSTING + TERRITORY FEES on STAGENET.
//
// Verifies the Phase 3 fee pipeline against the REAL monerod + monero-lws + app +
// worker stack:
//   - reserve a rewards-wallet fee subaddress and seed a PENDING_FEE Item/Sub + PayIn
//   - send a REAL stagenet fee to that subaddress
//   - the penaltyIndexer observes it -> FeeObservation DETECTED + Item.feeStatus
//     FEE_PAID (post goes live) / Sub.billingStatus PAID
//   - confirmFinalizer matures FeeObservation -> CONFIRMED at 10 confs
//
// The tip (100%-to-author, webhook) flow is the Phase 2 exit gate
// (test/integration/tip-stagenet.test.js); this gate covers the NEW Phase 3 fee
// flows. Finding 3 is asserted implicitly: fees land in the rewards wallet (its
// balance rises), whereas tips never touch it.
//
// -----------------------------------------------------------------------------
// SKIP GUARD: NEVER runs under `./sndev test`. Gated on RUN_STAGENET_INTEGRATION=1
// (needs a live stagenet stack + a registered rewards wallet + derived fee pool +
// stagenet funds + ~20 min for confirmation).
// -----------------------------------------------------------------------------
//
// PREREQUISITES (operator):
// 1. Stack up + synced:  COMPOSE_PROFILES=minimal,monero ./sndev start; ./sndev monero status
// 2. Register + derive the rewards fee pool (real stagenet keys in .env.local):
//      ./sndev monero register-rewards-wallet
//      ./sndev monero derive-fee-pool
//      ./sndev monero status   (rewards-wallet fee pool levels > 0)
// 3. Environment:
//      RUN_STAGENET_INTEGRATION=1
//      STAGENET_SENDER_SEED     funded stagenet wallet mnemonic (sends the fees)
//      STAGENET_DAEMON_URI      optional (default http://127.0.0.1:38081)
//      VIEWKEY_MASTER_KEY       must match the app/worker process
//      STAGENET_FEE_PICONEROS   optional (default 1000000000 = 0.001 XMR posting fee)
//
// HOW TO RUN:
//   RUN_STAGENET_INTEGRATION=1 STAGENET_SENDER_SEED=... VIEWKEY_MASTER_KEY=... \
//   ./sndev test test/integration/phase3-tipping-posting-fees-stagenet.test.js
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { reserveFeeSubaddress, getRewardsWalletId } from '@/api/monero/feePool'
import { daemonClient } from '@/api/monero/daemonClient'

process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'
const FEE_PICONEROS = BigInt(process.env.STAGENET_FEE_PICONEROS || '1000000000')

const DETECT_TIMEOUT_MS = 600_000
const DETECT_POLL_MS = 10_000
const CONFIRM_TIMEOUT_MS = 25 * 60_000
const CONFIRM_POLL_MS = 30_000
const RESTORE_HEIGHT_MARGIN = 1000

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

async function sendFeeProgrammatic (recipientAddress, amountPiconeros) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  // The fee lands in a block AFTER this wallet is created, so start scanning a
  // few blocks back instead of from genesis (a from-genesis scan of stagenet is
  // ~2.1M blocks of WASM work and would add many minutes per send). The margin
  // must also cover the sender's OWN funding tx, which arrives before the test
  // starts — 1000 blocks (~33h of stagenet) keeps that safe for a freshly funded
  // disposable wallet while keeping the scan fast.
  let restoreHeight = 0
  try {
    restoreHeight = Math.max(0, await daemonClient.getHeight() - RESTORE_HEIGHT_MARGIN)
  } catch {
    // daemon unreachable -> wallet falls back to a from-genesis scan and the
    // send fails loudly anyway
  }
  const wallet = await api.createWalletFull({
    password: 'sndev-phase3-integration',
    networkType: api.MoneroNetworkType.STAGENET,
    seed: requireEnv('STAGENET_SENDER_SEED'),
    restoreHeight,
    server: { uri: process.env.STAGENET_DAEMON_URI || 'http://127.0.0.1:38081' },
    proxyToWorker: false
  })
  try {
    await wallet.sync()
    const tx = await wallet.createTx({ accountIndex: 0, address: recipientAddress, amount: amountPiconeros, relay: true })
    const hash = tx.getHash()
    return Array.isArray(hash) ? hash[0] : hash
  } finally {
    await wallet.close()
  }
}

// =============================================================================
;(STAGENET_ENABLED ? describe : describe.skip)('Phase 3 stagenet exit gate (posting + territory fees)', () => {
  const created = { users: [], items: [], payIns: [], subs: [] }

  beforeAll(async () => {
    // Prerequisite guard: the rewards wallet must be registered + fee pool derived.
    await getRewardsWalletId(prisma)
  })

  afterAll(async () => {
    await prisma.feeObservation.deleteMany({ where: { payInId: { in: created.payIns } } })
    for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
    for (const id of created.items) {
      await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
      await prisma.item.deleteMany({ where: { id } })
    }
    await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
    for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
    await prisma.$disconnect()
  })

  async function createUser () {
    const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(rows[0].id)
    return rows[0].id
  }

  test('posting fee: a PENDING_FEE post goes live (FEE_PAID) once the penaltyIndexer observes the fee', async () => {
    // 1. reserve a real rewards-wallet posting-fee subaddress (major 1) + seed a
    //    PENDING_FEE Item + its PayIn watching that subaddress (mirrors itemCreate).
    const sub = await reserveFeeSubaddress(prisma, 'POSTING')
    const userId = await createUser()
    const payIn = await prisma.payIn.create({
      data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n, moneroSubaddressMajor: sub.major, moneroSubaddressMinor: sub.minor }
    })
    created.payIns.push(payIn.id)
    const item = await prisma.item.create({
      data: { userId, title: 'phase3 posting-fee gate', status: 'ACTIVE', feeStatus: 'PENDING_FEE', feePayInId: payIn.id }
    })
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    created.items.push(item.id)

    expect(item.feeStatus).toBe('PENDING_FEE')

    // 2. send a REAL stagenet fee to the reserved subaddress
    await sendFeeProgrammatic(sub.address, FEE_PICONEROS)

    // 3. poll for the penaltyIndexer to flip feeStatus -> FEE_PAID (post goes live)
    await pollUntil('posting-fee FEE_PAID', async () => {
      const row = await prisma.item.findUnique({ where: { id: item.id }, select: { feeStatus: true } })
      return row?.feeStatus === 'FEE_PAID' ? row : null
    })

    // 4. a FeeObservation DETECTED row exists for this PayIn
    const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
    expect(obs).toBeTruthy()
    expect(obs.state).toBe('DETECTED')
    expect(obs.piconeros).toBeGreaterThanOrEqual(FEE_PICONEROS)
    expect(obs.feeType).toBe('POSTING')
  }, CONFIRM_TIMEOUT_MS + DETECT_TIMEOUT_MS)

  test('FeeObservation matures to CONFIRMED at REQUIRED_CONFIRMATIONS', async () => {
    await pollUntil('FeeObservation CONFIRMED', async () => {
      const rows = await prisma.feeObservation.findMany({ where: { payInId: { in: created.payIns } } })
      return rows.length && rows.every(r => r.state === 'CONFIRMED') ? rows : null
    }, { timeoutMs: CONFIRM_TIMEOUT_MS, pollMs: CONFIRM_POLL_MS })
  }, CONFIRM_TIMEOUT_MS + 60_000)

  test('territory fee: a PENDING_FEE territory goes PAID once the penaltyIndexer observes the renewal fee', async () => {
    const sub = await reserveFeeSubaddress(prisma, 'TERRITORY_CREATE')
    const userId = await createUser()
    const payIn = await prisma.payIn.create({
      data: { userId, payInType: 'TERRITORY_CREATE', payInState: 'PAID', piconeros: 0n, moneroSubaddressMajor: sub.major, moneroSubaddressMinor: sub.minor }
    })
    created.payIns.push(payIn.id)
    const name = `_phase3territory_${payIn.id}`
    const territory = await prisma.sub.create({
      data: { name, userId, billingType: 'MONTHLY', billingCost: 1, baseCost: 1, replyCost: 1, rankingType: 'WOT', billingStatus: 'PENDING_FEE', billingPayInId: payIn.id }
    })
    created.subs.push(territory.name)

    await sendFeeProgrammatic(sub.address, BigInt(process.env.STAGENET_TERRITORY_FEE_PICONEROS || '200000000000'))

    await pollUntil('territory-fee PAID', async () => {
      const row = await prisma.sub.findUnique({ where: { name }, select: { billingStatus: true } })
      return row?.billingStatus === 'PAID' ? row : null
    })

    const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
    expect(obs).toBeTruthy()
    expect(obs.feeType).toBe('TERRITORY_CREATE')
  }, CONFIRM_TIMEOUT_MS + DETECT_TIMEOUT_MS)
})
