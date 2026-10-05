/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { runConfirmFinalizerOnce } from '@/worker/confirmFinalizer'
import { runRewardsWalletObserverOnce } from '@/worker/rewardsWalletObserver'
import { sendPayouts, sweepOpsEarmark } from '@/api/monero/rewards'
import { reconcileWalletTransactions } from '@/api/monero/rewardsTransactions'
import {
  bountyReceiptSplit,
  reconcileBountyReceipts,
  __resetBountyRecoveryCursor
} from '@/api/monero/bountyReceipts'
import { initiateBountyFundingCore } from '@/api/resolvers/bounty'
import { driveBountyFunding, recordBountyReceipt } from '@/api/monero/bountyFunding'
import {
  buildRewardsReconciliation,
  normalizeEvidence,
  readRepairLedger
} from '@/api/monero/rewardsReconciliation'
import { applyRewardsReconciliation } from '@/api/monero/applyRewardsReconciliation'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'
import { readNextRewardsPool } from '@/lib/rewardsPool'
import { opsCarry, standingReserve, walletScope } from '@/lib/rewardsAccounting'
import { FI, syntheticRewardsEvidence, withApprovedIncomingClassification } from '../fixtures/rewards-accounting-evidence'

// End-to-end money regression for the rewards hot-wallet accounting repair
// (Task 14). ONE isolated scenario drives the REAL product functions through
// the complete 2026-10-05 spec flow:
//
//   funding (frozen fee, zero funding cash) -> confirmed net rollover receipt ->
//   audited historical repair (build + apply) -> reward-contract snapshot ->
//   10%-short largest-first partial delivery with an explicit QUEUED remainder ->
//   same-week resume -> exactly one relay per payout -> Earn contracts intact ->
//   delayed ops-sweep enqueue -> protected sweep -> next weekly allocation carry.
//
// Everything runs against the dedicated `stasher_rewards_repair_test` database
// (self-gated, skipped everywhere else) with FAKE wallets only: no keys, no
// network transport, no real XMR. The fake wallet's balances change ONLY when a
// relay happens (a build never debits), so every shortage/resume assertion is a
// real accounting fact, not a stub side effect.
//
// Extra cases: (1) a relay proven on-chain whose payout persist fails is
// recovered on the same-week re-drive by exact hash without another relay;
// (2) a failed ops-sweep enqueue leaves the COMPLETE distribution intact and
// repeating the eligible run schedules the job.
//
// Run via:
//   docker exec stasher-rewards-repair-runner npm run test -- \
//     --runInBand --runTestsByPath test/isolated/rewards-accounting-repair.test.js

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// Operator paging/log volume is not part of this regression: keep the output
// pristine and assert the money instead of Discord/Telegram side effects.
jest.mock(`${process.cwd()}/lib/alert`, () => ({ alert: jest.fn() }))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

jest.setTimeout(240000)

// --- story constants (piconeros) ---------------------------------------------
//
//   declared bounty B        100e9
//   frozen fee f = 10e9       max(min 10e9, 1% of B) capped at 20% of B
//   funding total B + f      110e9
//   escrow network fee e      1e9   (subtracted from the rollover destination)
//   rollover net R           109e9  booked as one BOUNTY_ROLLOVER receipt
//   rollover rewards         min(B, R) = 100e9; rollover ops = 9e9
//
// The historical era is Task 12's synthetic fixture (remapped to unique values):
// corrected D0 ops available 39, proven swept 10, cumulative RELAYED fees at
// D1 creation 13 -> D1 opening ops carry 16. D1's own ops inflow is the
// rollover ops 9e9 plus the repaired 5-piconero unbooked incoming (100% ops):
// D1 ops available = 9e9 + 21, and the protected sweep is ROOM-bound well
// below that carry (the historical distribution still holds a 2e9 undelivered
// reward commitment), so 5e9 may leave and 4e9 + 21 correctly rolls forward.
const DECLARED_BOUNTY = 100_000_000_000n
const BOUNTY_FEE = 10_000_000_000n
const FUNDING_TOTAL = DECLARED_BOUNTY + BOUNTY_FEE
const ESCROW_NETWORK_FEE = 1_000_000_000n
const ROLLOVER_NET = FUNDING_TOTAL - ESCROW_NETWORK_FEE
const ROLLOVER_REWARDS = DECLARED_BOUNTY
const ROLLOVER_OPS = ROLLOVER_NET - ROLLOVER_REWARDS
// D1 ops: this-cycle ops (rollover 9e9 + repaired incoming 5) + repaired carry 16
const EXPECTED_D1_OPS_AVAILABLE = ROLLOVER_OPS + 5n + 16n
// The historical distribution's undelivered commitment (no journal proof): the
// sweep may never touch it, only the room left above it.
const HISTORICAL_OUTSTANDING = 2_000_000_000n
const SWEEP_ROOM = 5_000_000_000n
const FEE_HEADROOM = BigInt(process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS || '1000000000')
const DUST_FLOOR = BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')
const SIGNER_ACCOUNTS = [0, 1, 2, 3, 4, 5]
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// The rollover receipt is confirmed at the scenario's "now"; the distribution
// runs six hours later so the receipt is strictly inside the next period.
const CONFIRM_TO_DISTRIBUTION_MS = 6 * HOUR_MS
const NEXT_WEEK_MS = 8 * DAY_MS

// --- helpers -----------------------------------------------------------------

const REAL_TIMER_APIS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'nextTick', 'hrtime', 'performance', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'
]

// 95-char base58-safe address: '5' + 8 hex (0 -> 9) + one letter + padding.
// Unique per scenario namespace so repeat runs and residue can never collide on
// the MoneroAccount (address, network) unique key, and valid for the
// integrated-address encoder used by the real funding core on the escrow row.
const ADDRESS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function addressFor (ns, index) {
  const base58 = ('5' + ns.repeat(1)).replace(/0/g, '9')
  return base58 + ADDRESS_CHARS[index % ADDRESS_CHARS.length] + 'A'.repeat(95 - base58.length - 1)
}

function hashFor (ns, index) {
  return (ns + index.toString(16).padStart(2, '0') + '0'.repeat(64)).slice(0, 64)
}

// Fake restricted monerod surface. The real client batches at 50 hashes
// (monerod restricted mode rejects >100 with no `txs` key); every fake daemon
// request enforces the same cap so no regression can hide an unrestricted batch.
function createFakeDaemon (height) {
  const assertBatch = hashes => {
    if (Array.isArray(hashes) && hashes.length > 50) {
      throw new Error('fake daemon: more than 50 transaction hashes requested')
    }
  }
  return {
    getHeight: async () => height,
    getTransactions: async (hashes) => { assertBatch(hashes); return { txs: [] } },
    getTransactionPool: async () => ({ transactions: [] })
  }
}

// Deep string translation (values AND object keys) used to remap the shared
// synthetic fixture to this scenario's unique hashes/addresses.
function translateStrings (value, map) {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map(entry => translateStrings(entry, map))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[translateStrings(key, map)] = translateStrings(entry, map)
    return out
  }
  return value
}

// A wallet whose balances move ONLY on relay. createTx({ relay: false })
// validates destination-sum + fee against the account's current unlocked
// balance and records the built transaction without spending anything;
// relayTx spends exactly once; getOutgoingTransfers exposes built-not-relayed
// entries with relayed=false (never relay evidence) and the scenario's static
// pre-existing history entries.
function createFakeWallet ({ address, networkType, ns }) {
  const balances = new Map()
  const records = new Map()
  const relayCalls = []
  const fixtures = []
  let hashSeq = 0
  const nextHash = () => hashFor(ns, 0x80 + (++hashSeq)) // reserved range

  const unlocked = idx => balances.get(idx) ?? 0n
  const recordTx = (accountIndex, destinations, feePiconeros) => {
    const hash = nextHash()
    records.set(hash, {
      hash,
      accountIndex,
      feePiconeros: BigInt(feePiconeros),
      destinations: destinations.map(d => ({ address: d.address, amount: BigInt(d.amount) })),
      relayed: false
    })
    return { getHash: () => hash, getFee: () => BigInt(feePiconeros) }
  }

  const wallet = {
    relayCalls,
    records,
    fixtures,
    // Model a confirmed on-chain arrival of liquidity. This is the ONLY way a
    // balance is created (as on-chain); the send path itself mutates balances
    // exclusively through relayTx.
    fund (amount) { balances.set(0, BigInt(amount)) },
    unlocked,
    async sync () {},
    async getPrimaryAddress () { return address },
    async getNetworkType () { return networkType },
    async getUnlockedBalance (idx) { return unlocked(idx) },
    async getBalance (idx) { return unlocked(idx) },
    async getHeight () { return 0 },
    async createTx (req) {
      const accountIndex = req.accountIndex ?? 0
      const fee = 0n
      const destinations = req.destinations ?? [{ address: req.address, amount: req.amount }]
      const sum = destinations.reduce((acc, d) => acc + BigInt(d.amount), 0n)
      if (req.relay === false && sum + fee > unlocked(accountIndex)) {
        throw new Error('not enough unlocked money')
      }
      return recordTx(accountIndex, destinations, fee)
    },
    async relayTx (tx) {
      relayCalls.push(tx)
      const hash = String(tx.getHash()).toLowerCase()
      const record = records.get(hash)
      if (record && !record.relayed) {
        record.relayed = true
        const spend = record.destinations.reduce((acc, d) => acc + d.amount, 0n) + record.feePiconeros
        balances.set(record.accountIndex, unlocked(record.accountIndex) - spend)
      }
      return hash
    },
    // Every relay CALL the wallet actually received, with the exact
    // destinations that transaction paid. This — not the journal — is the
    // relay-provenance source of truth: a repeated relay of the same hash is a
    // second recorded call even though the balance dedupe above debits once.
    relayedTransactions () {
      return relayCalls.map(tx => {
        const hash = String(tx.getHash()).toLowerCase()
        const record = records.get(hash)
        return {
          hash,
          destinations: (record?.destinations ?? []).map(d => ({ address: d.address, amount: d.amount })),
          feePiconeros: record?.feePiconeros ?? 0n
        }
      })
    },
    async getOutgoingTransfers () {
      const built = [...records.values()].map(record => ({
        getDestinations: () => record.destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount })),
        getTx: () => ({
          getHash: () => record.hash,
          getIsRelayed: () => record.relayed,
          getIsConfirmed: () => false,
          getFee: () => record.feePiconeros
        })
      }))
      return [...fixtures, ...built]
    },
    async sweepUnlocked ({ accountIndex = 0, address: destination, relay } = {}) {
      const balance = unlocked(accountIndex)
      if (balance <= 0n) return []
      const tx = recordTx(accountIndex, [{ address: destination, amount: balance }], 0n)
      if (relay === true) await wallet.relayTx(tx)
      return [tx]
    }
  }
  return wallet
}

// Wrap a Prisma client so rewardPayout.update({ data: { state: 'SENT' } })
// rejects while `injection.active`, simulating a relay whose recipient persist
// fails (both attempts). Everything else is untouched.
function withPayoutPersistFailures (client, injection) {
  const wrapPayout = delegate => new Proxy(delegate, {
    get (target, method) {
      const fn = target[method]
      if (method === 'update' && typeof fn === 'function') {
        return (...args) => {
          if (injection.active && args[0]?.data?.state === 'SENT') {
            injection.failures += 1
            return Promise.reject(new Error('injected payout persist failure'))
          }
          return fn.apply(target, args)
        }
      }
      return typeof fn === 'function' ? fn.bind(target) : fn
    }
  })
  return new Proxy(client, {
    get (target, prop) {
      if (prop === 'rewardPayout') return wrapPayout(target.rewardPayout)
      if (prop === '$transaction') return (fn, options) => target.$transaction(fn, options)
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

// Combine a scenario-body failure with a cleanup failure without losing
// either: the original failure stays first (and is attached as `cause`).
// Cleanup failing alone is returned unchanged.
function scenarioFailure (bodyError, cleanupError) {
  if (!bodyError) return cleanupError
  if (!cleanupError) return bodyError
  const combined = new Error([
    'isolated scenario failed and cleanup also reported errors.',
    '',
    '--- original failure ---',
    String(bodyError.stack || bodyError.message || bodyError),
    '',
    '--- cleanup failure ---',
    String(cleanupError.stack || cleanupError.message || cleanupError)
  ].join('\n'))
  combined.cause = bodyError
  return combined
}

/**
 * Test-local isolated accounting scenario. Seeds FK-safe config/users/content/
 * curation/bounty + matching wallet evidence and delegates every money step to
 * the real functions. Public helpers are assertion seams only:
 *   - explicit contractual fields (payout/Earn id, recipient, amount), kept
 *     separate from the state transitions the drive is allowed to perform;
 *   - the enqueue payload the operation actually scheduled.
 */
async function createIsolatedAccountingScenario ({ withHistoricalRepair = true } = {}) {
  const ns = randomBytes(4).toString('hex')
  const db = new PrismaClient()
  const created = {
    users: [],
    items: [],
    accounts: [],
    distributions: [],
    receipts: [],
    bountyPayments: [],
    earns: [],
    bounties: [],
    tipIds: []
  }

  // Identity addresses (all namespace-unique).
  const HOT = addressFor(ns, 0)
  const COLD = addressFor(ns, 1)
  const OPS = addressFor(ns, 2)
  const CURATOR_ONE = addressFor(ns, 3)
  const CURATOR_TWO = addressFor(ns, 4)
  const ESCROW = addressFor(ns, 5)
  const ESCROW_SUB = addressFor(ns, 6)
  const POSTING_SUB = addressFor(ns, 7)
  const PAYER = addressFor(ns, 8)
  const BOUNTY_ESCROW = addressFor(ns, 9)
  const TIP_RECIPIENT = addressFor(ns, 10)
  const CURATOR_ONE_PAYOUT = addressFor(ns, 11)
  const CURATOR_TWO_PAYOUT = addressFor(ns, 12)
  const BOUNDARY = { height: 3000000, blockHash: hashFor(ns, 0x40) }
  const HEIGHT = {
    FUNDING: 2999000,
    AWARD: 2999200,
    PAYOUT: 2999300,
    ROLLOVER: 2999500,
    CONSOLIDATION: 2999600,
    SWEEP: 2999700,
    INCOMING: 2999900,
    CURRENT_FUNDING: 2999970,
    CURRENT_ROLLOVER: 2999985
  }
  const HASH = {
    FUNDING: hashFor(ns, 1),
    AWARD: hashFor(ns, 2),
    ROLLOVER: hashFor(ns, 3),
    PAYOUT: hashFor(ns, 4),
    CONSOLIDATION: hashFor(ns, 5),
    SWEEP: hashFor(ns, 6),
    PENDING_PAYOUT: hashFor(ns, 7),
    INCOMING: hashFor(ns, 8),
    BRIDGE_INCOMING: hashFor(ns, 9),
    CURRENT_FUNDING: hashFor(ns, 0x0a),
    CURRENT_ROLLOVER: hashFor(ns, 0x0b)
  }

  // --- environment + config snapshots (restored in finally) ------------------
  const priorEnv = {
    PLATFORM_REWARDS_ADDRESS: process.env.PLATFORM_REWARDS_ADDRESS,
    MONERO_NETWORK: process.env.MONERO_NETWORK,
    REWARDS_OPS_SWEEP_ENABLED: process.env.REWARDS_OPS_SWEEP_ENABLED,
    REWARDS_COLD_STORAGE_ADDRESS: process.env.REWARDS_COLD_STORAGE_ADDRESS,
    LWS_WEBHOOK_URL: process.env.LWS_WEBHOOK_URL
  }
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  process.env.PLATFORM_REWARDS_ADDRESS = HOT
  process.env.MONERO_NETWORK = 'stagenet'
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'true'
  process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD
  process.env.LWS_WEBHOOK_URL = 'http://stub.invalid/api/monero/webhook'

  // Fake time: the scenario's "now" is captured once, then advanced by the
  // explicit steps below (confirmation -> distribution -> next week). Real
  // timer APIs stay real so Prisma's driver is unaffected; only Date is faked.
  const realNow = Date.now()
  jest.useFakeTimers({ doNotFake: REAL_TIMER_APIS })
  const scenarioNow = realNow + HOUR_MS
  jest.setSystemTime(new Date(scenarioNow))
  const nowMs = () => Date.now()

  const wallet = createFakeWallet({ address: HOT, networkType: 2, ns })

  // The historical mempool attempt (fixture PENDING_PAYOUT) is proven by the
  // wallet's own exact-hash history after the repair: relayed + confirmed,
  // exact fee 1 and destination {CURATOR_ONE, 8}.
  wallet.fixtures.push({
    getDestinations: () => [{ getAddress: () => CURATOR_ONE, getAmount: () => 8n }],
    getTx: () => ({
      getHash: () => HASH.PENDING_PAYOUT,
      getIsRelayed: () => true,
      getIsConfirmed: () => true,
      getFee: () => 1n
    })
  })

  const boss = { send: jest.fn().mockResolvedValue('job-id') }

  // --- FK-safe seeds ----------------------------------------------------------
  const createUser = async () => {
    const [row] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(row.id)
    return row.id
  }
  const createAccount = async ({ ownerUserId = null, address, label, id }) => {
    const account = await db.moneroAccount.create({
      data: { ...(id != null ? { id } : {}), ownerUserId, address, label, network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    return account
  }
  const createItem = async (userId, { title, bountyPiconeros = null, bountyStatus = 'UNFUNDED', weightedVotes = null, createdAt = null } = {}) => {
    const [row] = await db.$queryRaw`
      INSERT INTO "Item" ("userId", title, "weightedVotes", "created_at", "bountyPiconeros", "bountyStatus")
      VALUES (${userId}::int, ${title}, COALESCE(${weightedVotes}::float, 0), COALESCE(${createdAt}, now()), COALESCE(${bountyPiconeros}, 0), ${bountyStatus}::"BountyStatus")
      RETURNING id::int AS id`
    created.items.push(row.id)
    await db.$executeRaw`UPDATE "Item" SET path = ${String(row.id)}::ltree WHERE id = ${row.id}::int`
    return row.id
  }

  // Singleton snapshot completion flags. Cleanup may only restore/delete a
  // row after the corresponding snapshot read actually completed: a setup
  // failure before a read must never let cleanup delete a row this test never
  // inspected (and, for the fee config, never created).
  let configBefore = null
  let configSnapshotTaken = false
  let configCreatedByTest = false
  let chainStateBefore = null
  let chainStateSnapshotTaken = false
  let healthBefore = null
  let healthSnapshotTaken = false

  const cleanup = async () => {
    // Each statement is best-effort AND its failure is collected: cleanup
    // always finishes, and the caller turns any collected error into a test
    // failure (an otherwise-passing test must fail on cleanup errors) without
    // masking an original failure.
    const cleanupErrors = []
    const attempt = async (label, fn) => {
      try {
        await fn()
      } catch (err) {
        cleanupErrors.push({ label, err })
      }
    }
    try {
      await attempt('audits', () => db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: HOT } }))
      await attempt('journal', () => db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: HOT } }))
      if (created.tipIds.length) await attempt('tips', () => db.observedTip.deleteMany({ where: { id: { in: created.tipIds } } }))
      if (created.bounties.length) await attempt('bounties', () => db.observedBounty.deleteMany({ where: { id: { in: created.bounties } } }))
      if (created.items.length) await attempt('pid maps', () => db.bountyPidMap.deleteMany({ where: { postId: { in: created.items } } }))
      if (created.distributions.length) {
        await attempt('earns by distribution', () => db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } }))
        await attempt('payouts by distribution', () => db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } }))
      }
      if (created.earns.length) await attempt('earns by id', () => db.earn.deleteMany({ where: { id: { in: created.earns } } }))
      if (created.receipts.length) await attempt('receipts', () => db.feeObservation.deleteMany({ where: { id: { in: created.receipts } } }))
      if (created.bountyPayments.length) await attempt('bounty payments', () => db.bountyPayment.deleteMany({ where: { id: { in: created.bountyPayments } } }))
      if (created.distributions.length) await attempt('distributions', () => db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } }))
      if (created.items.length) {
        for (const id of created.items) await attempt('item aggregates', () => db.itemUserAgg.deleteMany({ where: { itemId: id } }))
        await attempt('items', () => db.item.deleteMany({ where: { id: { in: created.items } } }))
      }
      if (created.accounts.length) await attempt('accounts', () => db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } }))
      if (created.users.length) await attempt('users', () => db.user.deleteMany({ where: { id: { in: created.users } } }))
      // Restore shared singletons only when the pre-change snapshot actually
      // completed, so cleanup can never delete a row the test never inspected:
      // restored when one existed, deleted only when this test created it (the
      // fee config) or the scenario's driven code created it (chain state /
      // health snapshot).
      if (configSnapshotTaken) {
        if (configBefore) {
          await attempt('fee config restore', () => db.platformFeeConfig.update({
            where: { id: 1 },
            data: {
              bountyFeeMinPiconeros: configBefore.bountyFeeMinPiconeros,
              bountyFeePct: configBefore.bountyFeePct,
              downvoteRewardsPct: configBefore.downvoteRewardsPct,
              postingFeeRewardsPct: configBefore.postingFeeRewardsPct,
              territoryFeeRewardsPct: configBefore.territoryFeeRewardsPct,
              boostRewardsPct: configBefore.boostRewardsPct,
              walletlessTipRewardsPct: configBefore.walletlessTipRewardsPct,
              distributionMinPayoutPiconeros: configBefore.distributionMinPayoutPiconeros,
              distributionTopN: configBefore.distributionTopN,
              curatorTrustWeightFloor: configBefore.curatorTrustWeightFloor
            }
          }))
        } else if (configCreatedByTest) {
          await attempt('fee config delete', () => db.platformFeeConfig.deleteMany({ where: { id: 1 } }))
        }
      }
      if (chainStateSnapshotTaken) {
        if (chainStateBefore) await attempt('chain state restore', () => db.chainState.update({ where: { id: 1 }, data: { chainHeight: chainStateBefore.chainHeight } }))
        else await attempt('chain state delete', () => db.chainState.deleteMany({ where: { id: 1 } }))
      }
      if (healthSnapshotTaken) {
        if (healthBefore) {
          await attempt('health snapshot restore', () => db.healthSnapshot.update({
            where: { id: 1 },
            data: { balancePiconeros: healthBefore.balancePiconeros, balanceUpdatedAt: healthBefore.balanceUpdatedAt }
          }))
        } else {
          await attempt('health snapshot delete', () => db.healthSnapshot.deleteMany({ where: { id: 1 } }))
        }
      }
    } finally {
      for (const [label, fn] of [
        ['env restore', restoreEnv],
        ['bounty recovery cursor reset', () => __resetBountyRecoveryCursor()],
        ['real timers restore', () => jest.useRealTimers()]
      ]) {
        try { fn() } catch (err) { cleanupErrors.push({ label, err }) }
      }
      try { await db.$disconnect() } catch (err) { cleanupErrors.push({ label: 'prisma disconnect', err }) }
    }
    if (cleanupErrors.length > 0) {
      const details = cleanupErrors
        .map(({ label, err }, i) => `[${i + 1}] ${label}: ${String((err && err.stack) || err)}`)
        .join('\n')
      const combined = new Error(`scenario cleanup failed (${cleanupErrors.length} step(s)):\n${details}`)
      combined.cleanupErrors = cleanupErrors.map(({ err }) => err)
      throw combined
    }
  }

  const fail = async (err) => {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw scenarioFailure(err, cleanupError)
    }
    throw err
  }

  try {
    // --- singleton config: deterministic fee/allocation terms -----------------
    configBefore = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    configSnapshotTaken = true
    const configData = {
      bountyFeeMinPiconeros: 10_000_000_000n,
      bountyFeePct: 1,
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      boostRewardsPct: 30,
      walletlessTipRewardsPct: 70,
      distributionMinPayoutPiconeros: 1_000_000_000n,
      distributionTopN: 10,
      curatorTrustWeightFloor: 1.0
    }
    if (configBefore) {
      await db.platformFeeConfig.update({ where: { id: 1 }, data: configData })
    } else {
      await db.platformFeeConfig.create({ data: { id: 1, ...configData } })
      configCreatedByTest = true
    }

    chainStateBefore = await db.chainState.findUnique({ where: { id: 1 } })
    chainStateSnapshotTaken = true
    healthBefore = await db.healthSnapshot.findUnique({ where: { id: 1 } })
    healthSnapshotTaken = true

    // --- participants ---------------------------------------------------------
    const authorId = await createUser()
    const curatorOne = await createUser()
    const curatorTwo = await createUser()
    await createAccount({ ownerUserId: authorId, address: PAYER, label: 'author' })
    // The funding core resolves the escrow account lowest-id-first; take the
    // id below any residue so the scenario's own row is deterministic.
    const lowestAccount = await db.moneroAccount.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
    await createAccount({
      id: lowestAccount ? lowestAccount.id - 1 : undefined,
      address: BOUNTY_ESCROW,
      label: 'bounty_escrow'
    })
    const rewardsAccount = await createAccount({ address: HOT, label: 'platform_rewards' })
    const tipRecipient = await createAccount({ address: TIP_RECIPIENT, label: 'tip-recipient' })
    await createAccount({ ownerUserId: curatorOne, address: CURATOR_ONE_PAYOUT, label: 'curator-payout' })
    await createAccount({ ownerUserId: curatorTwo, address: CURATOR_TWO_PAYOUT, label: 'curator-payout' })

    // --- current-era bounty + content/curation --------------------------------
    const bountyItemId = await createItem(authorId, {
      title: 'rewards e2e bounty',
      bountyPiconeros: DECLARED_BOUNTY
    })
    const contentItemId = await createItem(authorId, {
      title: 'rewards e2e content',
      weightedVotes: 100,
      createdAt: new Date(scenarioNow - 2 * HOUR_MS)
    })
    const seedTip = async (tipperId, piconeros, confirmedAt, suffix) => {
      const tip = await db.observedTip.create({
        data: {
          txHash: hashFor(ns, 0x20 + suffix),
          postId: contentItemId,
          tipperId,
          recipientAccountId: tipRecipient.id,
          recipientMajor: 0,
          recipientMinor: 0,
          paymentId: `${ns}${suffix.toString(16).padStart(8, '0')}`,
          piconeros,
          height: 2999900,
          confirmations: 10,
          state: 'CONFIRMED',
          confirmedAt,
          amountVerifiedAt: confirmedAt
        }
      })
      created.tipIds.push(tip.id)
      return tip
    }
    await seedTip(curatorOne, 2_000_000_000n, new Date(scenarioNow - 90 * 60 * 1000), 1)
    await seedTip(curatorTwo, 2_000_000_000n, new Date(scenarioNow - 60 * 60 * 1000), 2)

    // --- historical era (Task 12 synthetic fixture, remapped + unique) ---------
    const historical = { d0: null }
    const evidence = (() => {
      const map = new Map([
        [FI.SCOPE.walletAddress, HOT],
        [FI.ADDRESS.COLD, COLD],
        [FI.ADDRESS.OPS, OPS],
        [FI.ADDRESS.CURATOR_ONE, CURATOR_ONE],
        [FI.ADDRESS.CURATOR_TWO, CURATOR_TWO],
        [FI.ADDRESS.ESCROW, ESCROW],
        [FI.ADDRESS.ESCROW_SUB, ESCROW_SUB],
        ['5RewardsPostingFeeSubaddress', POSTING_SUB],
        [FI.BOUNDARY.blockHash, BOUNDARY.blockHash],
        ...Object.entries(FI.TX).map(([key, value]) => [value, HASH[key]])
      ])
      const input = translateStrings(withApprovedIncomingClassification(syntheticRewardsEvidence()), map)
      // The current rollover is a chain fact from the same boundary scan: the
      // hot wallet's confirmed net receipt and the escrow wallet's outgoing leg.
      input.evidence.incoming.push({
        txHash: HASH.CURRENT_ROLLOVER,
        accountIndex: 0,
        subaddressIndex: 0,
        amountPiconeros: ROLLOVER_NET.toString(),
        height: HEIGHT.CURRENT_ROLLOVER,
        inTxPool: false,
        isConfirmed: true,
        fromOwnTransaction: false,
        isSelfTransfer: false
      })
      input.evidence.escrow.outgoing.push({
        txHash: HASH.CURRENT_ROLLOVER,
        accountIndex: 0,
        feePiconeros: ESCROW_NETWORK_FEE.toString(),
        destinations: [{ address: HOT, amountPiconeros: ROLLOVER_NET.toString() }],
        height: HEIGHT.CURRENT_ROLLOVER,
        inTxPool: false,
        isConfirmed: true,
        isRelayed: true,
        isSelfTransfer: false,
        relayState: 'confirmed'
      })
      const walletTotal = 62n + ROLLOVER_NET
      input.evidence.balances.totalPiconeros = walletTotal.toString()
      input.evidence.balances.unlockedPiconeros = (52n + ROLLOVER_NET).toString()
      input.evidence.balances.accounts = { 0: walletTotal.toString() }
      return input
    })()

    if (withHistoricalRepair) {
      const historicalUsers = [await createUser(), await createUser(), await createUser()]
      const awardItemId = await createItem(historicalUsers[0], { title: 'repair fixture award item' })
      const rolloverItemId = await createItem(historicalUsers[0], { title: 'repair fixture rollover item', bountyPiconeros: 100n })
      // The MIGRATION HANDOFF is exercised here, not recreated: the identified
      // funding-time accrual below is already noncash (walletReceipt=false), as
      // the real migration leaves it. This ObservedBounty row is the funding
      // evidence the mandated identification predicate re-derives, so the
      // repair manifest must still remove the phantom contribution from the
      // stored D0 snapshot.
      const awardBounty = await db.observedBounty.create({
        data: {
          txHash: HASH.FUNDING,
          postId: awardItemId,
          recipientAccountId: rewardsAccount.id,
          paymentId: `${ns}aa`,
          piconeros: FUNDING_TOTAL,
          state: 'CONFIRMED'
        }
      })
      created.bounties.push(awardBounty.id)

      const d0 = await db.rewardDistribution.create({
        data: {
          periodStart: new Date(FI.DATE.DIST_START),
          periodEnd: new Date(FI.DATE.DIST_END),
          poolPiconeros: 140n,
          distributedPiconeros: 60n,
          rolledOverPiconeros: 0n,
          payoutCount: 4,
          status: 'COMPLETE',
          opsInflowPiconeros: 20n,
          opsRolledOverPiconeros: 0n,
          opsAvailablePiconeros: 20n,
          opsSweptPiconeros: 0n,
          opsSweepTxHash: null,
          opsNetworkFeesAccountedPiconeros: 0n
        }
      })
      historical.d0 = d0
      created.distributions.push(d0.id)

      const p1 = await db.rewardPayout.create({
        data: { distributionId: d0.id, curatorId: historicalUsers[0], recipientAddress: CURATOR_ONE, piconeros: 40n, txHash: HASH.PAYOUT, state: 'CONFIRMED' }
      })
      const p2 = await db.rewardPayout.create({
        data: { distributionId: d0.id, curatorId: historicalUsers[1], recipientAddress: CURATOR_TWO, piconeros: 20n, txHash: HASH.PAYOUT, state: 'SENT' }
      })
      const p3 = await db.rewardPayout.create({
        data: { distributionId: d0.id, curatorId: historicalUsers[2], recipientAddress: CURATOR_ONE, piconeros: 8n, txHash: null, state: 'QUEUED' }
      })
      // A second, deliberately undelivered commitment with NO journal proof:
      // it must survive every sweep untouched (the sweep's room subtracts it).
      await db.rewardPayout.create({
        data: { distributionId: d0.id, curatorId: historicalUsers[1], recipientAddress: CURATOR_TWO, piconeros: HISTORICAL_OUTSTANDING, txHash: null, state: 'QUEUED' }
      })

      const fundingReceipt = await db.feeObservation.create({
        data: {
          txHash: HASH.FUNDING,
          feeType: 'BOUNTY_FEE',
          // Post-migration state: the identified funding accrual was moved out
          // of cash by the schema migration before this repair runs.
          walletReceipt: false,
          state: 'CONFIRMED',
          piconeros: 20n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          recipientMajor: 0,
          recipientMinor: 0,
          height: HEIGHT.FUNDING,
          confirmedAt: new Date(FI.DATE.FUNDING),
          postId: awardItemId,
          payInId: null
        }
      })
      const rolloverReceipt = await db.feeObservation.create({
        data: {
          txHash: HASH.ROLLOVER,
          feeType: 'BOUNTY_ROLLOVER',
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 140n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          recipientMajor: 0,
          recipientMinor: 0,
          height: HEIGHT.ROLLOVER,
          confirmedAt: new Date(FI.DATE.ROLLOVER),
          postId: rolloverItemId,
          payInId: null
        }
      })
      created.receipts.push(fundingReceipt.id, rolloverReceipt.id)

      const journalBase = {
        network: 'STAGENET',
        walletAddress: HOT,
        relayAttemptedAt: new Date(FI.DATE.ROLLOVER)
      }
      await db.rewardsWalletTransaction.create({
        data: {
          ...journalBase,
          txHash: HASH.PAYOUT,
          kind: 'PAYOUT',
          state: 'RELAYED',
          accountIndex: 0,
          distributionId: d0.id,
          principalPiconeros: 60n,
          networkFeePiconeros: 0n,
          metadata: {
            payouts: [
              { payoutId: p1.id, recipientAddress: CURATOR_ONE, piconeros: '40' },
              { payoutId: p2.id, recipientAddress: CURATOR_TWO, piconeros: '20' }
            ]
          },
          relayedAt: new Date(FI.DATE.ROLLOVER)
        }
      })
      await db.rewardsWalletTransaction.create({
        data: {
          ...journalBase,
          txHash: HASH.CONSOLIDATION,
          kind: 'CONSOLIDATION',
          state: 'RELAYED',
          accountIndex: 1,
          distributionId: d0.id,
          principalPiconeros: 0n,
          networkFeePiconeros: 3n,
          metadata: { destination: HOT, selfTransfer: true },
          relayedAt: new Date(FI.DATE.ROLLOVER)
        }
      })
      await db.rewardsWalletTransaction.create({
        data: {
          ...journalBase,
          txHash: HASH.SWEEP,
          kind: 'OPS_SWEEP',
          state: 'RELAYED',
          accountIndex: 0,
          distributionId: d0.id,
          principalPiconeros: 10n,
          networkFeePiconeros: 2n,
          metadata: { destination: OPS },
          relayedAt: new Date(FI.DATE.ROLLOVER)
        }
      })
      await db.rewardsWalletTransaction.create({
        data: {
          ...journalBase,
          txHash: HASH.PENDING_PAYOUT,
          kind: 'PAYOUT',
          state: 'PREPARED',
          accountIndex: 0,
          distributionId: d0.id,
          principalPiconeros: 8n,
          networkFeePiconeros: 1n,
          metadata: { payouts: [{ payoutId: p3.id, recipientAddress: CURATOR_ONE, piconeros: '8' }] },
          relayedAt: null
        }
      })

      const awardPayment = await db.bountyPayment.create({
        data: {
          itemId: awardItemId,
          winnerUserId: historicalUsers[0],
          piconeros: 100n,
          feePiconeros: 20n,
          recipientAddress: CURATOR_ONE,
          kind: 'AWARD',
          txHash: HASH.AWARD,
          state: 'CONFIRMED'
        }
      })
      const rolloverPayment = await db.bountyPayment.create({
        data: {
          itemId: rolloverItemId,
          winnerUserId: historicalUsers[0],
          piconeros: 140n,
          feePiconeros: 0n,
          recipientAddress: HOT,
          kind: 'ROLLOVER',
          txHash: HASH.ROLLOVER,
          state: 'CONFIRMED'
        }
      })
      created.bountyPayments.push(awardPayment.id, rolloverPayment.id)

      const e1 = await db.earn.create({ data: { userId: historicalUsers[0], distributionId: d0.id, piconeros: 40n } })
      const e2 = await db.earn.create({ data: { userId: historicalUsers[1], distributionId: d0.id, piconeros: 20n } })
      created.earns.push(e1.id, e2.id)
    }

    // --- assertion seams -------------------------------------------------------
    const scope = () => walletScope()
    const freshDistribution = async (id = stateP.distributionId) => {
      if (id == null) return null
      return await db.rewardDistribution.findUnique({ where: { id }, include: { payouts: { orderBy: { id: 'asc' } } } })
    }
    const distributionTotal = async () => {
      const d = await freshDistribution()
      return (d?.payouts || []).reduce((acc, p) => acc + p.piconeros, 0n)
    }
    const realSigner = async (payouts, { models } = {}) => await sendPayouts(payouts, { models: models ?? db, wallet })
    const stateP = {
      distributionId: null,
      originalEarnContracts: null,
      distributionPayouts: null,
      sweep: null,
      nextDistributionId: null
    }

    // Lazily creates the current-era distribution through the REAL distributor
    // with a deferring signer (the documented injection seam): D1 exists, its
    // reward contracts are frozen, and nothing has been relayed yet.
    const ensureDistribution = async () => {
      if (stateP.distributionId != null) return await freshDistribution()
      const priorMax = await db.rewardDistribution.findFirst({ orderBy: { id: 'desc' }, select: { id: true } })
      const deferringSigner = async (payouts) => ({
        sent: 0,
        failed: 0,
        skipped: (payouts || []).length,
        unpersisted: 0,
        accountingUnpersisted: 0
      })
      await runDistributionOnce({ models: db, sendPayouts: deferringSigner, scheduleOpsSweep: false })
      const latest = await db.rewardDistribution.findFirst({
        where: { id: { gt: priorMax?.id ?? 0 } },
        orderBy: { id: 'desc' },
        include: { payouts: true }
      })
      stateP.distributionId = latest.id
      created.distributions.push(latest.id)
      stateP.distributionPayouts = latest.payouts.map(p => ({ id: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros }))
      return latest
    }

    return {
      db,
      wallet,
      boss,
      hash: HASH,
      address: { HOT, COLD, OPS, CURATOR_ONE, CURATOR_TWO },
      amounts: { DECLARED_BOUNTY, BOUNTY_FEE, FUNDING_TOTAL, ROLLOVER_NET, ROLLOVER_REWARDS, EXPECTED_D1_OPS_AVAILABLE },
      _state: stateP,

      // 1. Funding: the frozen disposition fee is booked on the Item and NO
      // hot-wallet cash row exists (the coins are still in escrow).
      async confirmFrozenBounty () {
        const funding = await initiateBountyFundingCore({
          postId: bountyItemId,
          models: db,
          monero: { addWebhook: jest.fn().mockResolvedValue({ event_id: `evt-${ns}` }) },
          me: { id: authorId }
        })
        expect(funding.feePiconeros).toBe(BOUNTY_FEE)
        expect(funding.expectedPiconeros).toBe(FUNDING_TOTAL)
        const bounty = await db.observedBounty.findFirst({ where: { postId: bountyItemId }, orderBy: { id: 'desc' } })
        created.bounties.push(bounty.id)
        await db.$transaction(async tx => {
          await recordBountyReceipt(tx, bounty, { txHash: HASH.CURRENT_FUNDING, piconeros: FUNDING_TOTAL, height: HEIGHT.CURRENT_FUNDING })
          await driveBountyFunding(tx, bounty, { txHash: HASH.CURRENT_FUNDING, height: HEIGHT.CURRENT_FUNDING, confirmations: 10 })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        const item = await db.item.findUnique({ where: { id: bountyItemId } })
        expect(item).toMatchObject({ bountyStatus: 'FUNDED', bountyPiconeros: DECLARED_BOUNTY, bountyFeePiconeros: BOUNTY_FEE })
        const confirmed = await db.observedBounty.findUnique({ where: { id: bounty.id } })
        expect(confirmed.state).toBe('CONFIRMED')
        return { funding, item, bounty: confirmed }
      },

      // The funding flow books no FeeObservation for the funding tx/item.
      async fundingCashRows () {
        return await db.feeObservation.findMany({
          where: { OR: [{ txHash: HASH.CURRENT_FUNDING }, { postId: bountyItemId, feeType: 'BOUNTY_FEE' }] }
        })
      },

      // 2. The escrow rollover arrives at the hot wallet and is booked through
      // the real receipt attribution + confirmation paths: the exact net amount
      // with the frozen-prize reward split.
      async receiveAndConfirmNetRollover () {
        const payment = await db.bountyPayment.create({
          data: {
            itemId: bountyItemId,
            winnerUserId: authorId,
            piconeros: FUNDING_TOTAL,
            feePiconeros: 0n,
            recipientAddress: HOT,
            kind: 'ROLLOVER',
            txHash: HASH.CURRENT_ROLLOVER,
            state: 'CONFIRMED',
            height: HEIGHT.CURRENT_ROLLOVER,
            confirmedAt: new Date(nowMs()),
            networkFeePiconeros: ESCROW_NETWORK_FEE,
            recipientReceivedPiconeros: ROLLOVER_NET,
            feeReceivedPiconeros: 0n
          }
        })
        created.bountyPayments.push(payment.id)
        const scanned = {
          hash: HASH.CURRENT_ROLLOVER,
          recipient: { maj_i: 0, min_i: 0 },
          piconeros: ROLLOVER_NET,
          height: HEIGHT.CURRENT_ROLLOVER
        }
        // Full-history receipt recovery (the forward cursor can miss a
        // settlement whose sender persist raced the scan).
        const attributed = await reconcileBountyReceipts({ models: db, account: rewardsAccount, transactions: [scanned] })
        expect(attributed).toBe(1)
        // Ordinary confirmation safety: the finalizer matures DETECTED -> CONFIRMED.
        const daemon = createFakeDaemon(HEIGHT.CURRENT_ROLLOVER + 20)
        await runConfirmFinalizerOnce({
          models: db,
          daemonClient: daemon,
          lwsClient: { getAddressTxs: async () => ({ transactions: [] }) },
          detectReorg: () => {}
        })
        // The fake daemon mirrors monerod's restricted batch cap: an
        // unrestricted request can never be hidden behind the fakes.
        await expect(daemon.getTransactions(Array.from({ length: 51 }, (_, i) => hashFor(ns, 0x60 + i))))
          .rejects.toThrow(/more than 50 transaction hashes/)
        expect((await daemon.getTransactions(Array.from({ length: 50 }, (_, i) => hashFor(ns, 0x60 + i)))).txs).toEqual([])
        const receipt = await db.feeObservation.findFirst({
          where: { txHash: HASH.CURRENT_ROLLOVER, recipientMajor: 0, recipientMinor: 0 }
        })
        if (receipt) created.receipts.push(receipt.id)
        // A re-scan of the same output must never double-book.
        await runRewardsWalletObserverOnce({ models: db, account: rewardsAccount, txs: [scanned] })
        expect(receipt).toMatchObject({ feeType: 'BOUNTY_ROLLOVER', walletReceipt: true, state: 'CONFIRMED', piconeros: ROLLOVER_NET, rewardsPiconeros: ROLLOVER_REWARDS })
        expect(bountyReceiptSplit({ kind: 'ROLLOVER', receivedPiconeros: ROLLOVER_NET, bountyPiconeros: DECLARED_BOUNTY }))
          .toEqual({ piconeros: ROLLOVER_NET, rewardsPiconeros: ROLLOVER_REWARDS })
        expect(await db.feeObservation.count({ where: { txHash: HASH.CURRENT_ROLLOVER } })).toBe(1)
        // The next distribution must fall strictly after the confirmed receipt.
        jest.setSystemTime(new Date(nowMs() + CONFIRM_TO_DISTRIBUTION_MS))
        return receipt
      },

      // 3. Audited historical repair: build the manifest from the REAL scoped
      // ledger, apply it atomically, then resolve the historical mempool attempt
      // from exact-hash wallet history (no blind re-relay).
      async repairHistoricalLedger () {
        if (!withHistoricalRepair) throw new Error('scenario built without the historical repair fixture')
        const ledger = await readRepairLedger(db, scope())
        const manifest = buildRewardsReconciliation({
          scope: scope(),
          boundary: BOUNDARY,
          evidence: evidence.evidence,
          ledger,
          decisions: evidence.decisions,
          config: ledger.config,
          reserve: { feeHeadroomPiconeros: FEE_HEADROOM, dustFloorPiconeros: DUST_FLOOR },
          opsCarryProvenance: {}
        })
        if (manifest.issues.length > 0) {
          throw new Error(`repair fixture not applicable: ${manifest.issues.map(issue => issue.code).join(', ')}`)
        }
        const applied = await applyRewardsReconciliation({
          models: db,
          manifest,
          confirmedDigest: manifest.digest,
          backupReference: `e2e-isolated-${ns}`,
          writersPaused: true,
          evidence: normalizeEvidence(evidence.evidence)
        })
        expect(applied).toMatchObject({ applied: true, digest: manifest.digest })

        // The audited corrections are exact and separate from state fields:
        // the funding accrual is no longer cash, the rollover is the net 139
        // with the frozen-prize split, the unbooked 5 is booked, the journal's
        // real fee is recorded and the D0 ops snapshot is rebuilt.
        const inserted = await db.feeObservation.findFirst({ where: { txHash: HASH.INCOMING, recipientMajor: 0, recipientMinor: 0 } })
        if (inserted) created.receipts.push(inserted.id)
        const funding = await db.feeObservation.findFirst({ where: { txHash: HASH.FUNDING, recipientMajor: 0, recipientMinor: 0 } })
        const rollover = await db.feeObservation.findFirst({ where: { txHash: HASH.ROLLOVER, recipientMajor: 0, recipientMinor: 0 } })
        const payoutJournal = await db.rewardsWalletTransaction.findUnique({
          where: { network_walletAddress_txHash: { network: 'STAGENET', walletAddress: HOT, txHash: HASH.PAYOUT } }
        })
        const d0 = await db.rewardDistribution.findUnique({ where: { id: historical.d0.id } })
        expect(funding.walletReceipt).toBe(false)
        expect(rollover).toMatchObject({ piconeros: 139n, rewardsPiconeros: 100n })
        expect(inserted).toMatchObject({ feeType: 'BOUNTY_FEE', walletReceipt: true, state: 'CONFIRMED', piconeros: 5n })
        expect(payoutJournal.networkFeePiconeros).toBe(7n)
        expect(d0).toMatchObject({ opsInflowPiconeros: 39n, opsRolledOverPiconeros: 0n, opsAvailablePiconeros: 39n, opsSweptPiconeros: 0n, opsSweepTxHash: null })

        const reconciliation = await reconcileWalletTransactions({ models: db, wallet, scope: scope() })
        const pending = await db.rewardsWalletTransaction.findUnique({
          where: { network_walletAddress_txHash: { network: 'STAGENET', walletAddress: HOT, txHash: HASH.PENDING_PAYOUT } }
        })
        const ledgerAfter = await readRewardsWalletLedger(db, { scope: scope() })
        expect(reconciliation).toMatchObject({ uncertainPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
        expect(pending.state).toBe('RELAYED')
        expect(ledgerAfter.accountingUncertain).toBe(false)
        return { manifest, applied, reconciliation }
      },

      // Explicit contractual fields only: payout id/recipient/amount and Earn
      // id/user/distribution/amount. Payout STATES are allowed to transition.
      async rewardContracts () {
        const d1 = await ensureDistribution()
        const payouts = await db.rewardPayout.findMany({
          where: { distributionId: d1.id },
          orderBy: { id: 'asc' },
          select: { id: true, recipientAddress: true, piconeros: true }
        })
        const earns = await db.earn.findMany({
          where: { distributionId: d1.id },
          orderBy: { id: 'asc' },
          select: { id: true, userId: true, distributionId: true, piconeros: true }
        })
        if (stateP.originalEarnContracts == null) stateP.originalEarnContracts = earns
        stateP.distributionPayouts = payouts
        return { payouts, earns }
      },

      get originalEarnContracts () { return stateP.originalEarnContracts },

      async earnContracts () {
        const d1 = await freshDistribution()
        return await db.earn.findMany({
          where: { distributionId: d1.id },
          orderBy: { id: 'asc' },
          select: { id: true, userId: true, distributionId: true, piconeros: true }
        })
      },

      // 4. 10%-short drive: exactly 90% of the drive's whole-payout obligations
      // available, so the largest-first plan sends a subset and leaves an
      // explicit QUEUED remainder.
      async driveWithTenPercentShortage () {
        const d1 = await ensureDistribution()
        const total = await distributionTotal()
        wallet.fund(total * 9n / 10n)
        const funded = wallet.unlocked(0)
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        const fresh = await freshDistribution()
        // The fake balance moved ONLY by the relayed principal: building and
        // dropping the unaffordable remainder debited nothing.
        const relayed = fresh.payouts.filter(p => p.state === 'SENT').reduce((acc, p) => acc + p.piconeros, 0n)
        expect(wallet.unlocked(0)).toBe(funded - relayed)
        const sent = fresh.payouts.filter(p => p.state === 'SENT')
        const queued = fresh.payouts.filter(p => p.state === 'QUEUED')
        return { distributionId: d1.id, status: fresh.status, sent: sent.length, skipped: queued.length, largestId: fresh.payouts.reduce((max, p) => (max == null || p.piconeros > max.piconeros ? p : max), null)?.id, sentIds: sent.map(p => p.id), queuedIds: queued.map(p => p.id) }
      },

      // 5. Same-week resume with sufficient funds: the remainder is delivered,
      // each payout exactly once, and the eligible COMPLETE schedules the sweep.
      async resumeWithSufficientFunds () {
        const d1 = await freshDistribution()
        const remaining = d1.payouts.filter(p => p.state === 'QUEUED').reduce((acc, p) => acc + p.piconeros, 0n)
        // After delivering the remainder the wallet must still hold, on top of
        // the undelivered historical commitment and the next pool, the standing
        // reserve plus the protected room the sweep is allowed to consume.
        wallet.fund(remaining + HISTORICAL_OUTSTANDING + d1.rolledOverPiconeros + FEE_HEADROOM + SWEEP_ROOM)
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        const fresh = await freshDistribution()
        expect(fresh.status).toBe('COMPLETE')
        expect(fresh.payouts.every(p => p.state === 'SENT' || p.state === 'CONFIRMED')).toBe(true)
        return fresh
      },

      // Exactly-once relay provenance from the WALLET, not the journal: count
      // every recorded relay CALL whose transaction destinations actually paid
      // the payout (address + exact principal). A repeated relay of the same
      // hash is a second recorded call and is therefore counted again, even
      // though the fake wallet's balance only debits once per hash.
      relayCountsByPayout () {
        const payouts = stateP.distributionPayouts || []
        const counts = Object.fromEntries(payouts.map(p => [p.id, 0]))
        for (const relayed of wallet.relayedTransactions()) {
          for (const payout of payouts) {
            if (relayed.destinations.some(d => d.address === payout.recipientAddress && d.amount === payout.piconeros)) {
              counts[payout.id] += 1
            }
          }
        }
        return counts
      },
      oneRelayPerPayout () {
        return Object.fromEntries((stateP.distributionPayouts || []).map(p => [p.id, 1]))
      },

      // 6. Protected ops sweep: only the corrected ops carry may leave, bounded
      // by unlocked - outstanding rewards - next pool - standing reserve.
      async runProtectedSweep () {
        const d1 = await freshDistribution()
        stateP.sweep = await sweepOpsEarmark({ distribution: d1, models: db, wallet })
        return stateP.sweep
      },

      // The room the sweep's own bound protects (same formula): the wallet's
      // unlocked total less every outstanding reward, the next pool and the
      // standing fee reserve. Must never go negative.
      async protectedRewardRoom () {
        const balances = {}
        let total = 0n
        for (const idx of SIGNER_ACCOUNTS) {
          balances[idx] = wallet.unlocked(idx)
          total += balances[idx]
        }
        const pool = await db.$transaction(tx => readNextRewardsPool(tx))
        const reserve = standingReserve(balances, { feeHeadroom: FEE_HEADROOM, dustFloor: DUST_FLOOR })
        return total - pool.outstandingRewardsPiconeros - pool.poolPiconeros - reserve
      },

      // 7. The next weekly allocation (8 days later) picks up whatever carry the
      // sweep left (room-bound: the D1 ops carry minus the sweep room).
      async nextWeeklyAllocation () {
        jest.setSystemTime(new Date(nowMs() + NEXT_WEEK_MS))
        // Nothing new arrives this week: the next pool is the prior rollover.
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        const latest = await db.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' }, include: { payouts: true } })
        stateP.nextDistributionId = latest.id
        created.distributions.push(latest.id)
        return latest
      },

      async correctedOpsCarry () {
        const ledger = await readRewardsWalletLedger(db, { scope: scope() })
        const d2 = await db.rewardDistribution.findUnique({ where: { id: stateP.nextDistributionId } })
        return opsCarry({
          distribution: d2,
          totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
          provenSweptPiconeros: ledger.sweptByDistribution.get(d2.id) ?? 0n
        })
      },

      expectedOpsCarry () {
        // The protected sweep is ROOM-bound (the historical commitment plus the
        // next pool and reserve leave exactly SWEEP_ROOM above them), so the
        // residual unswept ops carried into the next allocation are the D1 ops
        // available 9e9 + 21 minus the 5e9 swept.
        return EXPECTED_D1_OPS_AVAILABLE - SWEEP_ROOM
      },

      expectedSweptOps () {
        return SWEEP_ROOM
      },

      // --- extra regression cases ---------------------------------------------
      // A relay proven on-chain whose recipient persist fails twice: the row
      // stays QUEUED with no hash; the same-week re-drive recovers it from the
      // wallet's own exact-hash history and never relays again.
      async driveWithUnpersistedRelay () {
        const d1 = await ensureDistribution()
        const total = await distributionTotal()
        wallet.fund(total * 2n)
        const injection = { active: true, failures: 0 }
        await runDistributionOnce({
          models: withPayoutPersistFailures(db, injection),
          sendPayouts: realSigner,
          boss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        injection.active = false
        const fresh = await freshDistribution()
        const relayed = wallet.relayedTransactions()
        return {
          distributionId: d1.id,
          status: fresh.status,
          states: fresh.payouts.map(p => ({ id: p.id, state: p.state, txHash: p.txHash })),
          persistFailures: injection.failures,
          relayCalls: relayed.length,
          relayedHashes: relayed.map(tx => tx.hash)
        }
      },

      async recoverUnpersistedRelay () {
        const relaysBefore = wallet.relayedTransactions().length
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        const fresh = await freshDistribution()
        const relayed = wallet.relayedTransactions()
        return {
          status: fresh.status,
          states: fresh.payouts.map(p => ({ id: p.id, state: p.state, txHash: p.txHash })),
          relaysBefore,
          relayCalls: relayed.length,
          relayedHashes: relayed.map(tx => tx.hash)
        }
      },

      // A failed ops-sweep enqueue must never revert the committed COMPLETE;
      // repeating the eligible run schedules the job.
      async driveWithFailingEnqueue () {
        await ensureDistribution()
        const total = await distributionTotal()
        wallet.fund(total * 2n)
        const failingBoss = { send: jest.fn().mockRejectedValue(new Error('queue down')) }
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss: failingBoss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        const fresh = await freshDistribution()
        return { fresh, boss: failingBoss }
      },

      async repeatEligibleCompletion () {
        const goodBoss = { send: jest.fn().mockResolvedValue('job-2') }
        await runDistributionOnce({
          models: db,
          sendPayouts: realSigner,
          boss: goodBoss,
          scheduleOpsSweep: true,
          getWallet: async () => wallet
        })
        return { fresh: await freshDistribution(), boss: goodBoss }
      },

      cleanup
    }
  } catch (err) {
    await fail(err)
  }
}

// Run one scenario body and guarantee BOTH failure paths surface: cleanup
// always runs after the body, a cleanup failure fails an otherwise-passing
// test, and when the body also failed the original failure is preserved (first
// in the combined message and as `cause`).
async function withIsolatedScenario (options, body) {
  const fixture = await createIsolatedAccountingScenario(options)
  let bodyError = null
  try {
    await body(fixture)
  } catch (err) {
    bodyError = err
  }
  let cleanupError = null
  try {
    await fixture.cleanup()
  } catch (err) {
    cleanupError = err
  }
  const failure = scenarioFailure(bodyError, cleanupError)
  if (failure) throw failure
}

// =============================================================================
// Everything below runs only against the dedicated isolated database. Skipped
// (not thrown) elsewhere: the describe callback only registers tests and the
// scenario's PrismaClient is created inside the test bodies.
// =============================================================================
;(ISOLATED_DB ? describe : describe.skip)('rewards accounting repair end to end (isolated DB only)', () => {
  test('repair remains consistent through partial delivery, same-week resume and next-cycle carry', async () => {
    await withIsolatedScenario({}, async fixture => {
      await fixture.confirmFrozenBounty()
      expect(await fixture.fundingCashRows()).toHaveLength(0)
      await fixture.receiveAndConfirmNetRollover()
      await fixture.repairHistoricalLedger()
      const originalRewards = await fixture.rewardContracts()
      const shortRun = await fixture.driveWithTenPercentShortage()
      expect(shortRun.sent).toBeGreaterThan(0)
      expect(shortRun.skipped).toBeGreaterThan(0)
      // Largest-first: the biggest whole obligation is delivered on the short drive.
      expect(shortRun.sentIds).toEqual([shortRun.largestId])
      expect(await fixture.rewardContracts()).toEqual(originalRewards)
      await fixture.resumeWithSufficientFunds()
      expect(await fixture.relayCountsByPayout()).toEqual(await fixture.oneRelayPerPayout())
      expect(await fixture.earnContracts()).toEqual(fixture.originalEarnContracts)
      expect(fixture.boss.send).toHaveBeenCalledWith('opsSweep', expect.any(Object),
        expect.objectContaining({ startAfter: 3600, singletonKey: expect.stringMatching(/^opsSweep-/) }))
      const sweep = await fixture.runProtectedSweep()
      expect(sweep.state).toBe('SWEPT')
      expect(sweep.swept).toBe(fixture.expectedSweptOps())
      expect(sweep.swept).toBeLessThan(fixture.amounts.EXPECTED_D1_OPS_AVAILABLE)
      expect(await fixture.protectedRewardRoom()).toBeGreaterThanOrEqual(0n)
      expect(await fixture.protectedRewardRoom()).toBe(0n)
      await fixture.nextWeeklyAllocation()
      expect(await fixture.correctedOpsCarry()).toBe(fixture.expectedOpsCarry())
    })
  })

  test('a relay proven but unpersisted is recovered by exact hash with no extra relay', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      await fixture.confirmFrozenBounty()
      await fixture.receiveAndConfirmNetRollover()
      const first = await fixture.driveWithUnpersistedRelay()
      // The relay left the wallet, but BOTH payout rows failed to persist.
      expect(first.persistFailures).toBeGreaterThan(0)
      expect(first.status).toBe('FAILED')
      expect(first.relayCalls).toBe(1)
      expect(first.relayedHashes).toHaveLength(1)
      const originalRelayHash = first.relayedHashes[0]
      expect(first.states.every(s => s.state === 'QUEUED' && s.txHash === null)).toBe(true)
      const recovered = await fixture.recoverUnpersistedRelay()
      expect(recovered.status).toBe('COMPLETE')
      // No extra relay: the wallet's recorded relay set is unchanged...
      expect(recovered.relayCalls).toBe(recovered.relaysBefore)
      expect(recovered.relayedHashes).toEqual(first.relayedHashes)
      // ...and every recovered row carries the hash of the transaction the
      // wallet actually relayed — not merely some shared hash.
      expect(recovered.states.every(s => s.state === 'SENT' && s.txHash === originalRelayHash)).toBe(true)
      expect(new Set(recovered.states.map(s => s.txHash)).size).toBe(1)
    })
  })

  test('a failed sweep enqueue leaves COMPLETE intact; the repeated eligible run schedules it', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      await fixture.confirmFrozenBounty()
      await fixture.receiveAndConfirmNetRollover()
      const failed = await fixture.driveWithFailingEnqueue()
      expect(failed.fresh.status).toBe('COMPLETE')
      expect(failed.fresh.opsSweepState).not.toBe('SWEPT')
      expect(failed.fresh.opsSweptPiconeros).toBe(0n)
      expect(failed.boss.send).toHaveBeenCalledTimes(1)
      const repeated = await fixture.repeatEligibleCompletion()
      expect(repeated.fresh.status).toBe('COMPLETE')
      expect(repeated.boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: repeated.fresh.id },
        { startAfter: 3600, singletonKey: `opsSweep-${repeated.fresh.id}` })
    })
  })
})
