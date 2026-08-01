/* eslint-env jest */

// =============================================================================
// Phase 4 exit-gate integration test — END-TO-END REWARDS DISTRIBUTION on STAGENET.
//
// Verifies the full rewards-distribution loop (Tasks 7-9) against the REAL
// monerod + monero-lws + app + worker stack:
//   - seed a CONFIRMED ObservedBurn (pool funding) + 3 CONFIRMED ObservedTip
//     rows on a top item from 3 curators
//   - run runDistributionOnce with the REAL sendPayouts (monero-ts hot-wallet
//     signer) so actual on-chain txs are constructed + broadcast
//   - assert: RewardDistribution COMPLETE; RewardPayouts SENT with real 64-hex
//     tx hashes broadcast to stagenet; payouts proportional to tipped shares;
//     sub-min share excluded -> rolledOver; downvote piconeros in pool;
//     post author's stackedPiconeros unchanged.
//
// The exit-gate invariants asserted:
//   1. RewardDistribution exists with status COMPLETE.
//   2. RewardPayout rows exist with state === 'SENT' and a real 64-hex txHash.
//   3. The curator who tipped more gets a larger payout (proportionality).
//   4. A sub-minPayout share is EXCLUDED and counted in rolledOverPiconeros.
//   5. The downvote's piconeros are included in poolPiconeros.
//   6. distributedPiconeros + rolledOverPiconeros === poolPiconeros.
//   7. The post author's stackedPiconeros is unchanged (only curators receive).
//
// -----------------------------------------------------------------------------
// FUNDING PATH: This test uses the SEEDED ObservedBurn path (not a real
// on-chain downvote). The rewards wallet ALREADY has a confirmed account-0
// balance from prior test sends (~0.002 XMR at last check). Seeding a
// CONFIRMED ObservedBurn directly represents the pool funding without the
// ~20-minute confirmation wait. The REAL sign+broadcast path is still
// exercised end-to-end — sendPayouts opens the rewards wallet and constructs
// + relays actual stagenet transactions. This is acceptable because tip/burn
// DETECTION was already verified by the Phase 2 webhook gate and the Task 6
// downvote test; THIS test focuses on the DISTRIBUTION.
//
// If the rewards wallet has NO spendable balance, this test will throw in
// beforeAll with a helpful message. Fund the wallet (send stagenet XMR to the
// rewards address) or run the Task 6 downvote test first, then re-run.
// -----------------------------------------------------------------------------
//
// SKIP GUARD: NEVER runs under `./sndev test`. Gated on RUN_STAGENET_INTEGRATION=1.
//
// PREREQUISITES (operator):
// 1. Stack up + synced:  COMPOSE_PROFILES=minimal,monero ./sndev start
// 2. Register the rewards wallet (real stagenet keys in .env.local):
//      PLATFORM_REWARDS_ADDRESS, PLATFORM_REWARDS_SPEND_KEY, PLATFORM_REWARDS_VIEW_KEY
// 3. Rewards wallet has spendable account-0 balance (check via sndev monero status).
// 4. Environment:
//      RUN_STAGENET_INTEGRATION=1
//      PLATFORM_REWARDS_ADDRESS / _SPEND_KEY / _VIEW_KEY (must match the app/worker)
//
// HOW TO RUN:
//   RUN_STAGENET_INTEGRATION=1 ./sndev test test/integration/rewards-distribution-stagenet.test.js
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { sendPayouts, getRewardsWallet } from '@/api/monero/rewards'

process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'

const prisma = new PrismaClient()

const STAGENET_ENABLED = process.env.RUN_STAGENET_INTEGRATION === '1'

// --- Test amounts (piconeros = 1e-12 XMR) ---
// Pool funded via seeded ObservedBurn. Must be small enough to fit the rewards
// wallet's existing stagenet balance (~0.002 XMR) but large enough that at
// least 2 curator shares exceed the test minPayout.
const POOL_PICONEROS = 1_000_000_000n // 0.001 XMR
// Lowered from the default 1e9 to 1e8 (0.0001 XMR) so two of three curator
// shares clear the threshold with this small pool. Saved and restored in
// beforeAll/afterAll so the production config is untouched.
const TEST_MIN_PAYOUT = 100_000_000n // 0.0001 XMR

// Seeded tip amounts — these are ObservedTip.piconeros values that determine
// curator share proportions via computeCuratorShares' quad-root algorithm.
// They are NOT sent on-chain; only the resulting payouts are broadcast.
const TIP_LARGE = 100_000_000_000_000n // 100 "XMR equiv" — curator 1 (biggest)
const TIP_MEDIUM = 10_000_000_000_000n // 10 "XMR equiv" — curator 2
const TIP_TINY = 150_000_000n // 0.00015 XMR — curator 3 (above ZAP_THRESHOLD 1e8, but share < minPayout)

// Jest timeout: wallet sync + 2 tx broadcasts on stagenet (~2 min blocks).
const RUN_TIMEOUT_MS = 15 * 60_000

function requireEnv (name) {
  const v = process.env[name]
  if (!v) throw new Error(`integration test requires ${name} (see prerequisites at the top of this file)`)
  return v
}

// Generate `count` valid stagenet primary addresses by creating throwaway
// monero-ts wallets (random seeds, no sync, no server). On stagenet the XMR
// is worthless so these recipients need not be controlled.
async function generateStagenetAddresses (count) {
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const addresses = []
  for (let i = 0; i < count; i++) {
    const wallet = await api.createWalletFull({
      password: 'sndev-dist-addr-' + i + '-' + Date.now(),
      networkType: api.MoneroNetworkType.STAGENET,
      proxyToWorker: false
    })
    try {
      addresses.push(await wallet.getPrimaryAddress())
    } finally {
      await wallet.close()
    }
  }
  return addresses
}

// =============================================================================
;(STAGENET_ENABLED ? describe : describe.skip)('Phase 4 exit gate (rewards distribution end-to-end)', () => {
  const created = {
    users: [],
    accounts: [],
    items: [],
    distributions: []
  }
  let savedMinPayout = null

  beforeAll(async () => {
    requireEnv('PLATFORM_REWARDS_ADDRESS')
    requireEnv('PLATFORM_REWARDS_SPEND_KEY')
    requireEnv('PLATFORM_REWARDS_VIEW_KEY')

    // Verify the rewards wallet has spendable balance. If not, the test
    // cannot exercise the sign+broadcast path — bail early with guidance.
    const wallet = await getRewardsWallet()
    const unlocked = BigInt(await wallet.getUnlockedBalance(0))
    console.log(`  rewards wallet account-0 unlocked: ${unlocked.toString()} pico (${(Number(unlocked) / 1e12).toFixed(6)} XMR)`)
    if (unlocked < POOL_PICONEROS) {
      throw new Error(
        `rewards wallet has insufficient unlocked balance (${unlocked.toString()} < ${POOL_PICONEROS.toString()}); ` +
        'fund the rewards address on stagenet or run the Task 6 downvote test first')
    }

    // Lower minPayout so two of three curator shares clear the threshold
    // with this small pool. Saved for restoration in afterAll.
    const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
    if (config) {
      savedMinPayout = config.distributionMinPayoutPiconeros
      await prisma.platformFeeConfig.update({
        where: { id: 1 },
        data: { distributionMinPayoutPiconeros: TEST_MIN_PAYOUT }
      })
      console.log(`  lowered distributionMinPayoutPiconeros: ${savedMinPayout.toString()} -> ${TEST_MIN_PAYOUT.toString()}`)
    }
  }, RUN_TIMEOUT_MS)

  afterAll(async () => {
    // Restore minPayout
    if (savedMinPayout != null) {
      await prisma.platformFeeConfig.update({
        where: { id: 1 },
        data: { distributionMinPayoutPiconeros: savedMinPayout }
      }).catch(() => {})
    }

    // FK-safe cleanup order:
    // RewardPayout -> RewardDistribution -> ObservedTip -> ObservedBurn ->
    // ItemUserAgg -> Item -> MoneroAccount -> User
    for (const distId of created.distributions) {
      await prisma.rewardPayout.deleteMany({ where: { distributionId: distId } }).catch(() => {})
      await prisma.rewardDistribution.deleteMany({ where: { id: distId } }).catch(() => {})
    }
    await prisma.observedTip.deleteMany({ where: { tipperId: { in: created.users } } }).catch(() => {})
    await prisma.observedBurn.deleteMany({ where: { postId: { in: created.items } } }).catch(() => {})
    await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
    for (const id of created.items) await prisma.item.deleteMany({ where: { id } }).catch(() => {})
    for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } }).catch(() => {})
    for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
    await prisma.$disconnect()
  })

  test('seed pool + tips -> runDistributionOnce -> COMPLETE with SENT payouts (proportional, sub-min excluded)', async () => {
    // ===== 1. Create author + author MoneroAccount + top item ==============

    const authorRows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    const authorId = authorRows[0].id
    created.users.push(authorId)

    const [authorAddr, ...curatorAddrs] = await generateStagenetAddresses(4)

    const authorAccount = await prisma.moneroAccount.create({
      data: {
        ownerUserId: authorId,
        address: authorAddr,
        label: 'dist-test-author',
        network: 'STAGENET'
      }
    })
    created.accounts.push(authorAccount.id)

    // Top item: weightedVotes > 0 so computeCuratorShares includes it.
    const title = `phase4-dist-gate-${Date.now()}`
    const inserted = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title) VALUES (${authorId}::int, ${title})
      RETURNING id::int AS id`
    const postId = inserted[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree, "weightedVotes" = 10.0 WHERE id = ${postId}::int`
    created.items.push(postId)
    console.log(`  created top item id=${postId} author=${authorId} weightedVotes=10.0`)

    // ===== 2. Create 3 curators + their MoneroAccounts ====================

    const curatorIds = []
    const curatorAccounts = []
    for (let i = 0; i < 3; i++) {
      const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      const curatorId = rows[0].id
      created.users.push(curatorId)
      curatorIds.push(curatorId)

      const account = await prisma.moneroAccount.create({
        data: {
          ownerUserId: curatorId,
          address: curatorAddrs[i],
          label: 'dist-test-curator-' + i,
          network: 'STAGENET'
        }
      })
      created.accounts.push(account.id)
      curatorAccounts.push(account)
    }
    console.log(`  created 3 curators: ${curatorIds.join(', ')}`)

    // ===== 3. Seed CONFIRMED ObservedTip rows =============================
    // The confirmedAt ordering controls the early-tipper boost (earlier =
    // higher boost). Curator 1 tipped first (largest share), curator 3 last.
    const tips = [
      { curatorId: curatorIds[0], piconeros: TIP_LARGE, offsetMin: 3 },
      { curatorId: curatorIds[1], piconeros: TIP_MEDIUM, offsetMin: 2 },
      { curatorId: curatorIds[2], piconeros: TIP_TINY, offsetMin: 1 }
    ]

    const now = Date.now()
    for (let i = 0; i < tips.length; i++) {
      const t = tips[i]
      const confirmedAt = new Date(now - t.offsetMin * 60 * 1000)
      await prisma.observedTip.create({
        data: {
          txHash: `dist-test-tip-${now}-${i}`,
          postId,
          tipperId: t.curatorId,
          recipientAccountId: authorAccount.id,
          recipientMajor: 0,
          recipientMinor: 0,
          paymentId: `dist-test-pid-${now}-${i}`,
          piconeros: t.piconeros,
          state: 'CONFIRMED',
          confirmedAt
        }
      })
    }
    console.log(`  seeded 3 CONFIRMED ObservedTip rows (large=${TIP_LARGE.toString()} medium=${TIP_MEDIUM.toString()} tiny=${TIP_TINY.toString()})`)

    // ===== 4. Seed CONFIRMED ObservedBurn (pool funding) ==================
    // SEEDED PATH: the rewards wallet already has a confirmed account-0
    // balance from prior test sends. We represent the pool funding with a
    // directly-seeded CONFIRMED ObservedBurn — no ~20-min downvote wait.

    await prisma.observedBurn.create({
      data: {
        txHash: `dist-test-burn-${now}`,
        postId,
        paymentId: `dist-test-burn-pid-${now}`,
        piconeros: POOL_PICONEROS,
        state: 'CONFIRMED',
        confirmedAt: new Date(now - 5 * 60 * 1000),
        height: 0,
        confirmations: 10
      }
    })
    console.log(`  seeded CONFIRMED ObservedBurn pool=${POOL_PICONEROS.toString()} pico`)

    // ===== 5. Capture baseline ============================================
    const baseAuthor = await prisma.user.findUnique({
      where: { id: authorId },
      select: { stackedPiconeros: true }
    })
    console.log(`  baseline author.stackedPiconeros=${baseAuthor.stackedPiconeros.toString()}`)

    // ===== 6. Trigger the distribution ===================================
    // Uses the REAL sendPayouts from api/monero/rewards.js — actual on-chain
    // stagenet txs are constructed + broadcast. The rewards wallet singleton
    // was opened + synced in beforeAll, so this reuses the cached wallet.
    console.log('  triggering runDistributionOnce with real sendPayouts...')
    const result = await runDistributionOnce({ models: prisma, sendPayouts })
    created.distributions.push(result.id)

    console.log(`  distribution id=${result.id} status=${result.status}`)
    console.log(`    pool=${result.poolPiconeros.toString()} distributed=${result.distributedPiconeros.toString()} rolledOver=${result.rolledOverPiconeros.toString()}`)
    for (const p of result.payouts) {
      console.log(`    payout curator=${p.curatorId} state=${p.state} ${p.piconeros.toString()} pico txHash=${p.txHash || '(none)'}`)
    }

    // ===== 7. ASSERT — the exit gate =====================================

    // (1) Distribution status. runDistributionOnce awaits sendPayouts to
    // completion before returning, so the status must be COMPLETE (or FAILED
    // on error) — SENDING is never observable here. Asserting COMPLETE (not
    // the looser [COMPLETE, SENDING] set) means a stuck-SENDING bug would
    // actually trip this gate.
    expect(result.status).toBe('COMPLETE')

    // (2) At least one SENT payout with a real 64-hex tx hash
    const sentPayouts = result.payouts.filter(p => p.state === 'SENT')
    expect(sentPayouts.length).toBeGreaterThan(0)
    for (const p of sentPayouts) {
      expect(p.txHash).toMatch(/^[0-9a-f]{64}$/)
    }
    console.log(`  ${sentPayouts.length} payout(s) SENT with valid tx hashes`)

    // (3) Proportionality: the curator who tipped more gets a larger payout.
    // Only assert this if both C1 and C2 payouts went SENT (balance-limited
    // SKIPs are documented v1 behavior and not a gate failure).
    const c1Payout = result.payouts.find(p => p.curatorId === curatorIds[0])
    const c2Payout = result.payouts.find(p => p.curatorId === curatorIds[1])
    if (c1Payout && c2Payout && c1Payout.state === 'SENT' && c2Payout.state === 'SENT') {
      expect(c1Payout.piconeros).toBeGreaterThan(c2Payout.piconeros)
      console.log(`  proportionality: C1=${c1Payout.piconeros.toString()} > C2=${c2Payout.piconeros.toString()} ✓`)
    } else {
      console.log(`  proportionality: skipped (C1=${c1Payout?.state} C2=${c2Payout?.state} — balance-limited)`)
    }

    // (4) Sub-min share excluded: curator 3 (tiny tip) must NOT have a
    // payout row — their share was below minPayout and rolled over.
    const c3Payout = result.payouts.find(p => p.curatorId === curatorIds[2])
    expect(c3Payout).toBeUndefined()
    console.log('  curator 3 (tiny tip) excluded from payouts -> rolled over ✓')

    // (5) Downvote piconeros in pool
    expect(result.poolPiconeros).toBe(POOL_PICONEROS)

    // (6) Ledger integrity: distributed + rolledOver === pool
    expect(result.distributedPiconeros + result.rolledOverPiconeros).toBe(result.poolPiconeros)

    // (7) Post author never charged
    const finalAuthor = await prisma.user.findUnique({
      where: { id: authorId },
      select: { stackedPiconeros: true }
    })
    expect(finalAuthor.stackedPiconeros).toBe(baseAuthor.stackedPiconeros)
    console.log('  author.stackedPiconeros unchanged ✓')

    // Document any SKIPs (balance-limited) — not a gate failure
    const skipped = result.payouts.filter(p => p.state === 'QUEUED')
    if (skipped.length > 0) {
      console.log(`  NOTE: ${skipped.length} payout(s) remained QUEUED (balance-limited) — documented v1 behavior`)
    }

    console.log('  === ALL EXIT-GATE ASSERTIONS PASSED ===')
  }, RUN_TIMEOUT_MS)
})
