/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { runConfirmFinalizerOnce } from '@/worker/confirmFinalizer'
import { runRewardsWalletObserverOnce } from '@/worker/rewardsWalletObserver'
import { sendPayouts, sweepOpsEarmark } from '@/api/monero/rewards'
import { sendBountyPayments } from '@/api/monero/bounties'
import { readBountySettlement } from '@/api/monero/bountySettlement'
import {
  expectedEscrowMembers,
  prepareEscrowTransaction,
  reconcileEscrowTransactions,
  relayEscrowTransaction
} from '@/api/monero/escrowTransactions'
import {
  prepareWalletTransaction,
  reconcileWalletTransactions,
  relayWalletTransaction
} from '@/api/monero/rewardsTransactions'
import {
  checkPaymentProofInventory,
  rotatePaymentProofs
} from '@/api/monero/paymentProofLifecycle'
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
import { collectPaymentChainEvidence } from '@/api/monero/paymentChainEvidence'
import { verifyPaymentTransaction } from '@/api/monero/paymentVerification'
import { RELAY_PROOF_FIELDS } from '../fixtures/rewards-payment-verification'
import { readNextRewardsPool } from '@/lib/rewardsPool'
import { opsCarry, standingReserve, walletScope } from '@/lib/rewardsAccounting'
import { FI, syntheticRewardsEvidence, withApprovedIncomingClassification } from '../fixtures/rewards-accounting-evidence'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { decodeReceivingIdentity, normalizePaymentClaims } from '@/api/monero/paymentClaims'
import { oneTimeOutputKey, senderPublicPart } from '@/api/monero/paymentKeyStructure'
import { secretBundleHex } from '@/test/fixtures/payment-proof'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'

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

// A closed-shape COMPLETE verifier-result test double for the repair suites
// (final-review I1/I2): safe PaymentVerificationV1 result shape only, closing
// as D = O + F + E. This is an APPLY-gate/coverage test double — never a claim
// that a historical row was a capture-era dispatch (the real verifier fixtures
// live in test/fixtures/rewards-payment-verification.js).
function completeProofVerification ({ hash, scope, members, role = 'REWARDS', fee = '3', owned = '5', observedAt, journalId = null }) {
  const total = members.reduce((acc, member) => acc + BigInt(member.actualPiconeros), 0n)
  return {
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...scope },
    journalRole: role,
    journalId,
    dispatchId: null,
    captureMode: 'LEGACY_SURVIVING_PROOF',
    txHash: hash,
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: ['0'],
    members: members.map((member, index) => ({
      id: member.id ?? String(index + 1),
      leg: member.leg ?? 'PRINCIPAL',
      address: member.address,
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: `identity-${index}`,
      grossPiconeros: member.actualPiconeros,
      actualPiconeros: member.actualPiconeros
    })),
    receivingAggregates: members.map((member, index) => ({
      receivingIdentity: `identity-${index}`,
      amountPiconeros: member.actualPiconeros,
      confirmations: 10
    })),
    ownedAccounting: {
      totalPiconeros: owned,
      outputs: [{ outputIndex: 0, accountIndex: 0, subaddressIndex: 0, amountPiconeros: owned, isSpent: false }]
    },
    totals: {
      D: (BigInt(owned) + BigInt(fee) + total).toString(),
      O: owned,
      F: fee,
      E: total.toString(),
      residual: '0'
    },
    confirmation: { height: 2999990, blockHash: 'b1'.repeat(32), confirmations: 10 },
    observedAt,
    boundary: { height: 2999999, blockHash: 'b1'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'e1'.repeat(32)
  }
}
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

// Checksum-valid, curve-valid STAGENET primary addresses, unique per scenario
// namespace so repeat runs and residue can never collide on the MoneroAccount
// (address, network) unique key. The capture barrier (Task 6/Finding #1)
// decodes every journal member address, so the synthetic identities must be
// real base58/keccak encodings of deterministic throwaway curve points.
const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')
function encodeStagenetPrimaryAddress ({ spendKey, viewKey }) {
  const body = new Uint8Array(65)
  body[0] = 24 // stagenet primary prefix
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}
function addressFor (ns, index) {
  const scalar = 1_000_000n + BigInt(parseInt(ns, 16) % 1_000_000) * 64n + BigInt(index)
  return encodeStagenetPrimaryAddress({ spendKey: point(2n * scalar), viewKey: point(2n * scalar + 1n) }
  )
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
    // Capture-grade built tx: the pair store reads the real fee, the actual
    // destinations, the change fields and the exact key bundle (synthetic
    // 64-hex key material — never real keys).
    const keySeed = BigInt('0x' + hash.slice(0, 12)) + 700n
    return {
      getHash: () => hash,
      getFee: () => BigInt(feePiconeros),
      getOutgoingTransfer: () => ({
        getDestinations: () => destinations.map(d => ({ getAddress: () => d.address, getAmount: () => BigInt(d.amount) }))
      }),
      getChangeAddress: () => null,
      getChangeAmount: () => null,
      // The SDK captures the SECRET-bundle STRING (final-review C1).
      getKey: () => secretBundleHex(keySeed, 2)
    }
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

// --- capture-era regression helpers (Finding #1, Task 9) ---------------------
//
// The scenarios below drive the REAL capture barrier/verifier/lifecycle over
// synthetic throwaway material: explicitly independent audit sessions, fresh
// scalar ranges per chain, no fictional keys on destination-only history.

// Advance the faked scenario clock and return the new time. Real timer APIs
// stay real; only Date is faked inside a scenario.
const advanceClock = ms => {
  const next = new Date(Date.now() + ms)
  jest.setSystemTime(next)
  return next
}

// JSON that tolerates the BigInt ids the DB returns (lifecycle issues carry
// raw BigInt proof/journal ids). Used only for leak scans of SAFE surfaces.
const bigintSafeJson = value => JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry))

// A capture-grade built PAYOUT transaction WITH an owned change output: the
// shape a real hot-wallet payout build produces (external destination vout(s)
// first, the owned change vout LAST, exact key bundle). Without a scan-owned
// output an attempted relay can never be fresh-verified (fail-closed), so the
// promotion scenarios must build this shape explicitly.
// Little-endian secret-scalar hex (the SDK key-bundle string form).
const leHex = value => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex.padStart(64, '0'), 'hex').reverse().toString('hex')
}

// The REAL one-time-key arithmetic binding one built payout to its chain
// facts: slot secrets r_i (main first, then one per output slot), slot
// publics r_i*G (standard destinations), external vouts via the sender path
// Hs(8*r_i*A || i)*G + B against the recipient's PUBLIC keys, and the owned
// change vout via the receiver a*R path against the hot wallet's own spend
// key (final-review C1/I1/I2 — every key below is derivable, never opaque).
function payoutDerivedKeys ({ destinations, changeAddress, scalarBase, hotViewScalar, hotSpendPoint }) {
  const decoded = destinations.map(d => decodeReceivingIdentity(d.address, 'STAGENET'))
  const slots = destinations.length + (changeAddress ? 1 : 0)
  const slotSecrets = Array.from({ length: slots }, (_, i) => scalarBase + BigInt(i))
  const slotPublics = slotSecrets.map(secret => senderPublicPart(secret, null))
  const outputKeys = decoded.map((keys, i) => oneTimeOutputKey({
    publicKey: keys.viewKey,
    secret: leHex(slotSecrets[i]),
    publicSpend: keys.spendKey,
    outputIndex: i
  }))
  if (changeAddress) {
    outputKeys.push(oneTimeOutputKey({
      publicKey: slotPublics[slots - 1],
      secret: leHex(hotViewScalar),
      publicSpend: hotSpendPoint,
      outputIndex: slots - 1
    }))
  }
  return {
    mainSecretHex: leHex(scalarBase),
    additionalSecretHexes: slotSecrets.map(leHex),
    mainPublicKey: senderPublicPart(scalarBase, null),
    additionalPublicKeys: slotPublics,
    outputKeys,
    additionalKeyCount: slots
  }
}

// The hot wallet's view secret for a scenario namespace: addressFor(ns, 0)
// builds the primary from spend point(2*scalar) / view point(2*scalar+1), so
// the PRIVATE view key is the scalar 2*scalar+1.
const hotViewSecretFor = ns => {
  const scalar = 1_000_000n + BigInt(parseInt(ns, 16) % 1_000_000) * 64n
  return 2n * scalar + 1n
}
// The hot wallet's public spend key is point(2*scalar) = point(view secret - 1).
const hotSpendPointFor = ns => point(hotViewSecretFor(ns) - 1n)

function makePayoutBuiltTx ({ hash, fee, destinations, changeAddress, changeAmount, scalarBase, hotViewScalar, hotSpendPoint }) {
  const keys = payoutDerivedKeys({
    destinations,
    changeAddress,
    scalarBase,
    hotViewScalar,
    hotSpendPoint
  })
  return {
    getHash: () => hash,
    getFee: () => fee,
    getOutgoingTransfer: () => ({
      getDestinations: () => destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount }))
    }),
    getChangeAddress: () => changeAddress,
    getChangeAmount: () => changeAmount,
    // The SDK captures the SECRET-bundle STRING (final-review C1); the
    // populated public facts stay available through the optional getters.
    getKey: () => keys.mainSecretHex + keys.additionalSecretHexes.join(''),
    getMainPublicKey: () => keys.mainPublicKey,
    getAdditionalPublicKeys: () => [...keys.additionalPublicKeys],
    getOutputKeys: () => [...keys.outputKeys]
  }
}

// The wallet-owned (major, 0) position identity for a scenario namespace:
// the primary (0,0) is addressFor(ns, 0); fee-account majors 1..5 are
// addressFor(ns, 20 + major). Every subaddress shares the wallet's ONE
// private view key — positions differ only by their public spend key — so
// the raw ownership enumeration (which knows just the ephemeral view secret)
// can re-derive every owned output.
function positionIdentityFor (ns, majorIndex) {
  const base = 1_000_000n + BigInt(parseInt(ns, 16) % 1_000_000) * 64n
  const spendScalar = majorIndex === 0 ? base : base + 20n + BigInt(majorIndex)
  return { viewSecret: hotViewSecretFor(ns), spendPoint: point(2n * spendScalar) }
}

// An explicitly synthetic, independent audit session (fake genesis-restored
// audit wallet + fake daemon) whose raw records mirror ONE built hot-wallet
// transaction byte for byte: one owned coinbase source covering D exactly, the
// scan-owned change/self outputs, and exact confirmed checkTxKey receipts for
// every external destination. Driven through the REAL collector + verifier by
// `reconcileWalletTransactions`' injected-auditWallet seam and by the Task 7
// coordinated repair chain's direct collection. `sourceAccountIndex` names the
// owned source position (a consolidation consolidates account 1).
function paymentAuditChain ({ tx, hot, ns, scalarBase, sourceAccountIndex = 0 }) {
  const tip = { height: 3100000, blockHash: hashFor(ns, 0x50) }
  const fee = tx.getFee()
  const destinations = tx.getOutgoingTransfer().getDestinations().map(d => ({ address: d.getAddress(), amount: d.getAmount() }))
  const changeAmount = tx.getChangeAmount()
  // The raw records carry EXACTLY the built tx's public key slots and one-time
  // output keys, so the collector's raw ownership enumeration agrees with the
  // SDK scan (final-review I2).
  const keys = {
    mainPublicKey: tx.getMainPublicKey(),
    additionalPublicKeys: tx.getAdditionalPublicKeys(),
    outputKeys: tx.getOutputKeys()
  }
  // 21 confirmations TO the boundary: blockHeight + confirmations - 1 must
  // equal the authoritative tip exactly (final-review I4 coherence).
  const auditedHeight = tip.height - 20
  const sourceHeight = tip.height - 1000
  const sourceHash = hashFor(ns, 0xb0 + Number(scalarBase % 97n))
  const dTotal = destinations.reduce((acc, d) => acc + d.amount, 0n) + (changeAmount ?? 0n) + fee
  const audited = {
    txHash: tx.getHash(),
    feePiconeros: fee,
    inputKeyImages: [point(scalarBase + 10n)],
    voutKeys: [...keys.outputKeys],
    outputIndices: keys.outputKeys.map((_, index) => 900 + index),
    blockHeight: auditedHeight,
    blockHash: tip.blockHash,
    confirmations: 21,
    inTxPool: false,
    isCoinbase: false,
    mainPublicKey: keys.mainPublicKey,
    additionalPublicKeys: [...keys.additionalPublicKeys]
  }
  // The coinbase source output is wallet-owned too: derive it on the receiver
  // a*R path under its own main tx key at the source's (major, 0) position.
  const sourceMainKey = senderPublicPart(scalarBase + 500n, null)
  const sourceIdentity = positionIdentityFor(ns, sourceAccountIndex)
  const sourceVout = oneTimeOutputKey({
    publicKey: sourceMainKey,
    secret: leHex(sourceIdentity.viewSecret),
    publicSpend: sourceIdentity.spendPoint,
    outputIndex: 0
  })
  const source = {
    txHash: sourceHash,
    feePiconeros: 0n,
    inputKeyImages: [],
    voutKeys: [sourceVout],
    outputIndices: [800],
    blockHeight: sourceHeight,
    blockHash: tip.blockHash,
    confirmations: tip.height - sourceHeight + 1,
    inTxPool: false,
    isCoinbase: true,
    mainPublicKey: sourceMainKey,
    additionalPublicKeys: []
  }
  const sourceRow = {
    txHash: sourceHash,
    accountIndex: sourceAccountIndex,
    subaddressIndex: 0,
    outputIndex: 0,
    blockHeight: sourceHeight,
    globalIndex: 800,
    amountPiconeros: dTotal,
    stealthPublicKey: sourceVout,
    keyImage: point(scalarBase + 10n),
    isSpent: true
  }
  // Scan-owned outputs: a destination that IS the wallet primary (a
  // consolidation self transfer) is owned at its own vout slot, and the owned
  // change vout is LAST. External destinations are proven by exact checkTxKey
  // receipts instead.
  const ownedRows = destinations.map((d, slot) => d.address === hot
    ? {
        getTx: () => ({ getHash: () => tx.getHash(), getHeight: () => auditedHeight }),
        getAccountIndex: () => 0,
        getSubaddressIndex: () => 0,
        getIndex: () => 900 + slot,
        getAmount: () => d.amount,
        getStealthPublicKey: () => keys.outputKeys[slot],
        getKeyImage: () => null,
        getIsSpent: () => false
      }
    : null).filter(Boolean)
  if (tx.getChangeAddress() != null) {
    const changeSlot = keys.outputKeys.length - 1
    ownedRows.push({
      getTx: () => ({ getHash: () => tx.getHash(), getHeight: () => auditedHeight }),
      getAccountIndex: () => 0,
      getSubaddressIndex: () => 0,
      getIndex: () => 900 + changeSlot, // the change vout is LAST
      getAmount: () => changeAmount,
      getStealthPublicKey: () => keys.outputKeys[changeSlot],
      getKeyImage: () => null,
      getIsSpent: () => false
    })
  }
  const receipts = new Map(destinations.filter(d => d.address !== hot).map(d => [d.address, d.amount]))
  const auditWallet = {
    getOutputs: jest.fn(async () => [...ownedRows, sourceRow].map(row => {
      if ('getTx' in row) return row
      return {
        getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
        getAccountIndex: () => row.accountIndex,
        getSubaddressIndex: () => row.subaddressIndex,
        getIndex: () => row.globalIndex,
        getAmount: () => row.amountPiconeros,
        getStealthPublicKey: () => row.stealthPublicKey,
        getKeyImage: () => ({ getHex: () => row.keyImage }),
        getIsSpent: () => row.isSpent
      }
    })),
    getAccounts: jest.fn(async () => [0, 1, 2, 3, 4, 5].map(index => ({ getIndex: () => index }))),
    getPrimaryAddress: jest.fn(async () => hot),
    getNetworkType: jest.fn(async () => 2),
    // Raw-ownership enumeration seams (final-review I2): ephemeral view access
    // plus the derived address per domain position (primary + majors 1..5).
    getPrivateViewKey: jest.fn(async () => leHex(hotViewSecretFor(ns))),
    getAddress: jest.fn(async (majorIndex, minorIndex) =>
      majorIndex === 0 && minorIndex === 0 ? hot : addressFor(ns, 20 + majorIndex)),
    checkTxKey: jest.fn(async (_hash, _bundle, address) => ({
      getIsGood: () => receipts.has(address),
      getReceivedAmount: () => receipts.get(address) ?? 0n,
      getInTxPool: () => false,
      getNumConfirmations: () => 21
    })),
    getHeight: jest.fn(async () => tip.height + 1),
    sync: jest.fn(async () => {})
  }
  const rawByHash = { [tx.getHash()]: audited, [sourceHash]: source }
  const daemon = {
    getPaymentTransactions: jest.fn(async hashes => (Array.isArray(hashes) ? hashes : []).map(h => rawByHash[h]).filter(Boolean)),
    getHeight: jest.fn(async () => tip.height + 1),
    getBlockHashByHeight: jest.fn(async () => tip.blockHash)
  }
  return { auditWallet, daemon, keyProvider: createPaymentProofKeyProvider(process.env), tip }
}

// A capture-grade fake ESCROW signer for the bounties send path: builds
// (relay:false) subtract the network fee from the subtractFeeFrom legs, expose
// the real fee/change/key bundle, and debit the balance on build (wallet2
// semantics). relayTx records every relay CALL; `relayedTransactions()` is the
// relay-provenance source of truth (a repeated relay is a second call).
function createEscrowWallet ({ address, networkType, ns, netFee, unlocked }) {
  let balance = unlocked
  let hashSeq = 0
  const records = new Map()
  const relayCalls = []
  const nextHash = () => hashFor(ns, 0xc0 + (++hashSeq))
  const wallet = {
    relayCalls,
    records,
    async sync () {},
    async getPrimaryAddress () { return address },
    async getNetworkType () { return networkType },
    async getUnlockedBalance () { return balance },
    async getBalance () { return balance },
    async getHeight () { return 200 },
    async getTx () { return { getHeight: async () => 200 } },
    async createTx (req) {
      const requested = req.destinations
        ? req.destinations.map(d => ({ address: d.address, amount: BigInt(d.amount) }))
        : [{ address: req.address, amount: BigInt(req.amount) }]
      const subtractFrom = req.subtractFeeFrom ?? []
      const destSum = requested.reduce((acc, d) => acc + d.amount, 0n)
      if (balance < destSum + (subtractFrom.length > 0 ? 0n : netFee)) {
        throw new Error('not enough unlocked money')
      }
      balance -= destSum + (subtractFrom.length > 0 ? 0n : netFee)
      const hash = nextHash()
      const actual = requested.map((d, index) => ({
        address: d.address,
        amount: d.amount - (subtractFrom.includes(index) ? netFee : 0n)
      }))
      const keySeed = 3000n + BigInt(hashSeq) * 7n
      records.set(hash, { hash, destinations: actual, feePiconeros: netFee })
      return {
        getHash: () => hash,
        getFee: () => netFee,
        getOutgoingTransfer: () => ({
          getDestinations: () => actual.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount }))
        }),
        getChangeAddress: () => address,
        getChangeAmount: () => destSum - netFee,
        // The SDK captures the SECRET-bundle STRING (final-review C1).
        getKey: () => secretBundleHex(keySeed, 3)
      }
    },
    async relayTx (tx) {
      relayCalls.push(tx)
      return String(await tx.getHash()).toLowerCase()
    },
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
    }
  }
  return wallet
}

// Wrap a Prisma client so bountyPayment.update({ data: { state: 'SENT' } })
// rejects while `injection.active`, simulating a relay whose settlement persist
// fails. Everything else (including the frozen-fee-destination write) passes
// through untouched.
function withBountyPersistFailures (client, injection) {
  const wrapModel = delegate => new Proxy(delegate, {
    get (target, method) {
      const fn = target[method]
      if (method === 'update' && typeof fn === 'function') {
        return (...args) => {
          if (injection.active && args[0]?.data?.state === 'SENT') {
            injection.failures += 1
            return Promise.reject(new Error('injected bounty settlement persist failure'))
          }
          return fn.apply(target, args)
        }
      }
      return typeof fn === 'function' ? fn.bind(target) : fn
    }
  })
  return new Proxy(client, {
    get (target, prop) {
      if (prop === 'bountyPayment') return wrapModel(target.bountyPayment)
      if (prop === '$transaction') return (fn, options) => target.$transaction(fn, options)
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

// Corrupt ONE stored envelope at the DATA layer while respecting the
// rotation guard (any envelope-byte change needs a strictly increasing
// revision) — exactly what a damaged row looks like. Returns the proof id and
// the original ciphertext hex so assertions can prove the bytes were never
// "repaired" by check/rotation.
async function corruptProofEnvelope (db, journalId) {
  const journal = await db.rewardsWalletTransaction.findUnique({ where: { id: journalId } })
  const proof = await db.paymentTransactionProof.findUnique({ where: { id: journal.proofId } })
  const flipped = Buffer.from(proof.ciphertext)
  flipped[0] ^= 0xff
  const updated = await db.paymentTransactionProof.updateMany({
    where: { id: proof.id, revision: proof.revision },
    data: { ciphertext: flipped, revision: proof.revision + 1 }
  })
  if (updated.count !== 1) throw new Error('corruptProofEnvelope: the revisioned corruption CAS did not apply')
  // The STORED (corrupted) bytes: check/rotation must keep THESE exact bytes —
  // never drop the row, never rewrite it into something "repaired".
  return { proofId: proof.id, corruptedCiphertextHex: flipped.toString('hex') }
}

// Seed one FK-safe escrow payout (user + item + BountyPayment) for the
// escrow regression scenarios; rows are registered in the fixture's cleanup
// tracking so even a failing body leaves zero residue.
async function seedEscrowPayoutFixture (fixture, overrides = {}) {
  const { db } = fixture
  const [user] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  fixture.created.users.push(user.id)
  const item = await db.item.create({
    data: { userId: user.id, title: `rewards repair escrow fixture ${fixture.created.items.length + 1}`, status: 'ACTIVE' }
  })
  fixture.created.items.push(item.id)
  const payout = await db.bountyPayment.create({
    data: {
      itemId: item.id,
      winnerUserId: user.id,
      piconeros: 10_000_000_000n,
      feePiconeros: 2_000_000_000n,
      recipientAddress: fixture.address.CURATOR_ONE,
      feeRecipientAddress: fixture.address.COLD,
      kind: 'AWARD',
      state: 'QUEUED',
      ...overrides
    }
  })
  fixture.created.bountyPayments.push(payout.id)
  return payout
}

// Seed one FK-safe distribution + QUEUED payout for the capture-era reward
// scenarios (PAYOUT journal owners need a real distribution/payout pair to
// name). Registered in the fixture's cleanup tracking.
async function seedQueuedPayoutFixture (fixture, { recipientAddress, piconeros }) {
  const { db } = fixture
  const [curator] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  fixture.created.users.push(curator.id)
  let distributionId = fixture._dispatchPoolDistributionId
  if (distributionId == null) {
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - DAY_MS),
        periodEnd: new Date(Date.now() + HOUR_MS),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'PENDING',
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: 0n,
        opsSweptPiconeros: 0n,
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n
      }
    })
    fixture.created.distributions.push(distribution.id)
    fixture._dispatchPoolDistributionId = distribution.id
    distributionId = distribution.id
  }
  const payout = await db.rewardPayout.create({
    data: { distributionId, curatorId: curator.id, recipientAddress, piconeros, txHash: null, state: 'QUEUED' }
  })
  return payout
}

// Seed one FK-safe dedicated distribution for a captured OPS_SWEEP pair: the
// recorded snapshot already carries the swept period's ops inflow/availability
// while the sweep hash itself was never persisted — exactly the promotion
// story under test. Registered in the fixture's cleanup tracking.
async function seedSweepDistributionFixture (fixture, { opsInflowPiconeros }) {
  const distribution = await fixture.db.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + HOUR_MS),
      poolPiconeros: 0n,
      distributedPiconeros: 0n,
      rolledOverPiconeros: 0n,
      payoutCount: 0,
      status: 'PENDING',
      opsInflowPiconeros,
      opsRolledOverPiconeros: 0n,
      opsAvailablePiconeros: opsInflowPiconeros,
      opsSweptPiconeros: 0n,
      opsSweepTxHash: null,
      opsNetworkFeesAccountedPiconeros: 0n
    }
  })
  fixture.created.distributions.push(distribution.id)
  return distribution
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
    PLATFORM_REWARDS_SPEND_KEY: process.env.PLATFORM_REWARDS_SPEND_KEY,
    PLATFORM_REWARDS_VIEW_KEY: process.env.PLATFORM_REWARDS_VIEW_KEY,
    BOUNTY_ESCROW_ADDRESS: process.env.BOUNTY_ESCROW_ADDRESS,
    BOUNTY_ESCROW_SPEND_KEY: process.env.BOUNTY_ESCROW_SPEND_KEY,
    BOUNTY_ESCROW_VIEW_KEY: process.env.BOUNTY_ESCROW_VIEW_KEY,
    MONERO_NETWORK: process.env.MONERO_NETWORK,
    REWARDS_OPS_SWEEP_ENABLED: process.env.REWARDS_OPS_SWEEP_ENABLED,
    REWARDS_COLD_STORAGE_ADDRESS: process.env.REWARDS_COLD_STORAGE_ADDRESS,
    LWS_WEBHOOK_URL: process.env.LWS_WEBHOOK_URL,
    TXPROOF_MASTER_KEYS: process.env.TXPROOF_MASTER_KEYS,
    TXPROOF_MASTER_KEY_CURRENT_VERSION: process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION
  }
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  process.env.PLATFORM_REWARDS_ADDRESS = HOT
  // The dedicated audit wallets are ALWAYS injected explicitly in these
  // scenarios: no env keys may silently open a "real" audit session (neither
  // the rewards one nor the bounty-escrow one).
  delete process.env.PLATFORM_REWARDS_SPEND_KEY
  delete process.env.PLATFORM_REWARDS_VIEW_KEY
  delete process.env.BOUNTY_ESCROW_SPEND_KEY
  delete process.env.BOUNTY_ESCROW_VIEW_KEY
  process.env.MONERO_NETWORK = 'stagenet'
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'true'
  process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD
  process.env.LWS_WEBHOOK_URL = 'http://stub.invalid/api/monero/webhook'
  // Synthetic throwaway TX-proof registry (real Task 2 envelope crypto, never
  // a real secret): the capture barrier seals every prepared pair with it.
  process.env.TXPROOF_MASTER_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 13).toString('base64') })
  process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION = '1'

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

  // The dedicated audit chain for the pending pair's fresh-verification
  // promotion (Task 6): a fake genesis-restored audit wallet + fake daemon
  // whose raw records mirror the captured key bundle byte for byte, one owned
  // coinbase source, the owned change output, and the exact confirmed
  // receipt. The production audit-session builder runs the REAL collector
  // and the REAL verifier over it.
  const pendingAuditChain = () => {
    // 21 confirmations TO the boundary: blockHeight + confirmations - 1 must
    // equal the authoritative boundary height exactly (final-review I4).
    const auditedHeight = BOUNDARY.height - 20
    const sourceHeight = BOUNDARY.height - 1000
    // EXACTLY the built tx's derived key facts (final-review I2).
    const pendingKeys = payoutDerivedKeys({
      destinations: [{ address: CURATOR_ONE }],
      changeAddress: HOT,
      scalarBase: 800n,
      hotViewScalar: hotViewSecretFor(ns),
      hotSpendPoint: hotSpendPointFor(ns)
    })
    const audited = {
      txHash: HASH.PENDING_PAYOUT,
      feePiconeros: 1n,
      inputKeyImages: [point(810n)],
      voutKeys: [...pendingKeys.outputKeys],
      outputIndices: [900n, 901n].map(Number),
      blockHeight: auditedHeight,
      blockHash: BOUNDARY.blockHash,
      confirmations: 21,
      inTxPool: false,
      isCoinbase: false,
      mainPublicKey: pendingKeys.mainPublicKey,
      additionalPublicKeys: [...pendingKeys.additionalPublicKeys]
    }
    // The coinbase source output is wallet-owned: receiver a*R path under its
    // own main tx key.
    const sourceMainKey = senderPublicPart(830n, null)
    const hotSpendPoint = hotSpendPointFor(ns)
    const sourceVout = oneTimeOutputKey({
      publicKey: sourceMainKey,
      secret: leHex(hotViewSecretFor(ns)),
      publicSpend: hotSpendPoint,
      outputIndex: 0
    })
    const source = {
      txHash: hashFor(ns, 0x90),
      feePiconeros: 0n,
      inputKeyImages: [],
      voutKeys: [sourceVout],
      outputIndices: [800],
      blockHeight: sourceHeight,
      blockHash: BOUNDARY.blockHash,
      confirmations: BOUNDARY.height - sourceHeight + 1,
      inTxPool: false,
      isCoinbase: true,
      mainPublicKey: sourceMainKey,
      additionalPublicKeys: []
    }
    const sourceRow = {
      txHash: source.txHash,
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: sourceHeight,
      globalIndex: 800,
      amountPiconeros: 24n,
      stealthPublicKey: sourceVout,
      keyImage: point(810n),
      isSpent: true
    }
    const changeRow = {
      getTx: () => ({ getHash: () => HASH.PENDING_PAYOUT, getHeight: () => auditedHeight }),
      getAccountIndex: () => 0,
      getSubaddressIndex: () => 0,
      getIndex: () => 901,
      getAmount: () => 15n,
      getStealthPublicKey: () => pendingKeys.outputKeys[pendingKeys.outputKeys.length - 1],
      getKeyImage: () => null,
      getIsSpent: () => false
    }
    const auditWallet = {
      getOutputs: jest.fn(async () => [changeRow, sourceRow].map(row => {
        if ('getTx' in row) return row
        return {
          getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
          getAccountIndex: () => row.accountIndex,
          getSubaddressIndex: () => row.subaddressIndex,
          getIndex: () => row.globalIndex,
          getAmount: () => row.amountPiconeros,
          getStealthPublicKey: () => row.stealthPublicKey,
          getKeyImage: () => ({ getHex: () => row.keyImage }),
          getIsSpent: () => row.isSpent
        }
      })),
      getAccounts: jest.fn(async () => [0, 1, 2, 3, 4, 5].map(index => ({ getIndex: () => index }))),
      getPrimaryAddress: jest.fn(async () => HOT),
      getNetworkType: jest.fn(async () => 2),
      // Raw-ownership enumeration seams (final-review I2).
      getPrivateViewKey: jest.fn(async () => leHex(hotViewSecretFor(ns))),
      getAddress: jest.fn(async (majorIndex, minorIndex) =>
        majorIndex === 0 && minorIndex === 0 ? HOT : addressFor(ns, 20 + majorIndex)),
      // The runtime recovery proves the scan covers the boundary block before
      // collecting (scanned block COUNT >= boundary index + 1).
      getHeight: jest.fn(async () => BOUNDARY.height + 1),
      sync: jest.fn(async () => {}),
      checkTxKey: jest.fn(async (_hash, _bundle, address) => ({
        getIsGood: () => address === CURATOR_ONE,
        getReceivedAmount: () => 8n,
        getInTxPool: () => false,
        getNumConfirmations: () => 21
      }))
    }
    const rawByHash = { [HASH.PENDING_PAYOUT]: audited, [source.txHash]: source }
    const daemon = {
      getPaymentTransactions: jest.fn(async hashes => (Array.isArray(hashes) ? hashes : []).map(h => rawByHash[h]).filter(Boolean)),
      // getHeight is the chain LENGTH: the boundary is length − 1.
      getHeight: jest.fn(async () => BOUNDARY.height + 1),
      getBlockHashByHeight: jest.fn(async () => BOUNDARY.blockHash)
    }
    return { auditWallet, daemon, keyProvider: createPaymentProofKeyProvider(process.env) }
  }

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
      // Captured pairs leave TOGETHER in ONE transaction (proofs before
      // owners — the store's delete guard), for BOTH journal roles: the
      // rewards pairs at the hot-wallet scope and the escrow dispatch pairs at
      // the bounty-escrow scope. A proof-era journal's distributionId can
      // never be SET NULL, so the pairs must be gone before any distribution
      // teardown.
      await attempt('journal pairs', () => db.$transaction([
        db.paymentTransactionProof.deleteMany({
          where: { OR: [{ rewardsJournal: { walletAddress: HOT } }, { escrowJournal: { walletAddress: BOUNTY_ESCROW } }] }
        }),
        db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: HOT } }),
        db.escrowWalletTransaction.deleteMany({ where: { walletAddress: BOUNTY_ESCROW } })
      ]))
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
      // The pending relay attempt is a REAL captured pair (capture barrier):
      // one external 8-piconero destination to CURATOR_ONE plus an owned
      // 15-piconero change output back to the primary, fee 1. The attempt is
      // stamped directly; the fresh-verification promotion after the repair
      // resolves it exactly like production would.
      // The pending attempt's keys are REAL derived arithmetic (final-review
      // C1/I1/I2): one external destination via the sender path, the owned
      // change via the receiver a*R path — the audit chain below re-derives
      // the identical facts.
      const pendingKeys = payoutDerivedKeys({
        destinations: [{ address: CURATOR_ONE }],
        changeAddress: HOT,
        scalarBase: 800n,
        hotViewScalar: hotViewSecretFor(ns),
        hotSpendPoint: hotSpendPointFor(ns)
      })
      const pendingBuiltTx = {
        getHash: () => HASH.PENDING_PAYOUT,
        getFee: () => 1n,
        getOutgoingTransfer: () => ({
          getDestinations: () => [{ getAddress: () => CURATOR_ONE, getAmount: () => 8n }]
        }),
        getChangeAddress: () => HOT,
        getChangeAmount: () => 15n,
        getKey: () => pendingKeys.mainSecretHex + pendingKeys.additionalSecretHexes.join(''),
        getMainPublicKey: () => pendingKeys.mainPublicKey,
        getAdditionalPublicKeys: () => [...pendingKeys.additionalPublicKeys],
        getOutputKeys: () => [...pendingKeys.outputKeys]
      }
      const pendingJournal = await prepareWalletTransaction({
        models: db,
        wallet: { getPrimaryAddress: async () => HOT, getNetworkType: async () => 2 },
        scope: { network: 'STAGENET', walletAddress: HOT },
        tx: pendingBuiltTx,
        kind: 'PAYOUT',
        accountIndex: 0,
        distributionId: d0.id,
        principalPiconeros: 8n,
        metadata: { payouts: [{ payoutId: p3.id, recipientAddress: CURATOR_ONE, piconeros: '8' }] },
        keyProvider: createPaymentProofKeyProvider(process.env)
      })
      await db.rewardsWalletTransaction.update({
        where: { id: pendingJournal.id },
        data: { relayAttemptedAt: new Date(FI.DATE.ROLLOVER) }
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
      ns,
      boundary: BOUNDARY,
      address: { HOT, COLD, OPS, CURATOR_ONE, CURATOR_TWO, BOUNTY_ESCROW },
      amounts: { DECLARED_BOUNTY, BOUNTY_FEE, FUNDING_TOTAL, ROLLOVER_NET, ROLLOVER_REWARDS, EXPECTED_D1_OPS_AVAILABLE },
      _state: stateP,
      // Regression-seam surfaces for the capture-era scenarios (Task 9): the
      // cleanup tracking arrays (rows created inside a test body are pushed
      // here so even a failing body cleans them), the namespace for unique
      // synthetic identities, and the configured rewards scope.
      created,
      scope,
      uniqueHash: index => hashFor(ns, 0xa0 + index),
      _dispatchPoolDistributionId: null,

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
      //
      // Final-review I1: the historical destination-only story is first built
      // AS THE OPERATOR FOUND IT — journal-only payout history and
      // history-only escrow legs — and the strict audit must NAME each
      // recorded outflow instead of silently passing (an unresolved manifest
      // is never applicable). Only the explicitly synthetic proof-era
      // extension (complete verifier results for every recorded outflow)
      // authorizes the audited corrections' APPLY.
      async repairHistoricalLedger () {
        if (!withHistoricalRepair) throw new Error('scenario built without the historical repair fixture')
        const ledger = await readRepairLedger(db, scope())
        const buildInput = proofEraEvidence => buildRewardsReconciliation({
          scope: scope(),
          boundary: BOUNDARY,
          evidence: proofEraEvidence,
          ledger,
          decisions: evidence.decisions,
          config: ledger.config,
          reserve: { feeHeadroomPiconeros: FEE_HEADROOM, dustFloorPiconeros: DUST_FLOOR },
          opsCarryProvenance: {}
        })

        // Tier 1 — the unresolved strict audit of the historical story: two
        // recorded payout rows covered only by a RELAYED journal row, and
        // three recorded escrow legs covered only by confirmed escrow history.
        const unresolved = buildInput(evidence.evidence)
        expect(unresolved.issues.map(issue => issue.code).sort()).toEqual([
          'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          'RECORDED_PAYOUT_PROOF_UNSUPPORTED',
          'RECORDED_PAYOUT_PROOF_UNSUPPORTED'
        ])
        for (const issue of unresolved.issues) {
          if (issue.code === 'RECORDED_PAYOUT_PROOF_UNSUPPORTED') {
            expect(issue).toMatchObject({ table: 'RewardPayout', txHash: HASH.PAYOUT })
          } else {
            expect(issue).toMatchObject({ table: 'BountyPayment', leg: 'PRINCIPAL' })
            expect([HASH.AWARD, HASH.ROLLOVER, HASH.CURRENT_ROLLOVER]).toContain(issue.txHash)
          }
        }
        // The recorded debits and reward contracts stay untouched by the naming.
        expect(unresolved.before.totalSentPiconeros).toBe(unresolved.after.totalSentPiconeros)
        expect(unresolved.operations.some(op => op.table === 'RewardPayout' || op.table === 'Earn')).toBe(false)

        // Tier 2 — the proof-era extension: complete verifier results cover
        // the payout batch (REWARDS scope) and every recorded escrow leg
        // (ESCROW scope). Closed safe result shapes only — never a claim that
        // the historical rows were capture-era dispatches.
        const observedAt = new Date(Date.now()).toISOString()
        const proofEra = structuredClone(evidence.evidence)
        proofEra.evidenceVersion = 2
        proofEra.collectionStartedAt = observedAt
        proofEra.observedAt = observedAt
        proofEra.paymentVerifications = [completeProofVerification({
          hash: HASH.PAYOUT,
          scope: { network: 'STAGENET', walletAddress: HOT },
          members: [
            { address: CURATOR_ONE, actualPiconeros: '40' },
            { address: CURATOR_TWO, actualPiconeros: '20' }
          ],
          observedAt
        })]
        proofEra.escrow = {
          ...proofEra.escrow,
          // Honest per-leg doubles (final-review I1 round 3): each leg's proof
          // carries the canonical escrow member — member id = the recorded
          // bounty payment's own id, canonical leg, the recorded recipient —
          // and the current rollover's settled amount IS recorded, so its
          // proof must carry that exact amount.
          paymentVerifications: await Promise.all([
            { txHash: HASH.AWARD, fallbackAddress: CURATOR_ONE, amount: '100' },
            { txHash: HASH.ROLLOVER, fallbackAddress: HOT, amount: '139' },
            { txHash: HASH.CURRENT_ROLLOVER, fallbackAddress: HOT, amount: ROLLOVER_NET.toString() }
          ].map(async leg => {
            const recorded = await db.bountyPayment.findFirst({ where: { txHash: leg.txHash } })
            return completeProofVerification({
              hash: leg.txHash,
              scope: { network: 'STAGENET', walletAddress: ESCROW },
              members: [{
                id: String(recorded.id),
                leg: 'PRINCIPAL',
                address: recorded.recipientAddress ?? leg.fallbackAddress,
                actualPiconeros: leg.amount
              }],
              role: 'ESCROW',
              observedAt
            })
          }))
        }
        const manifest = buildInput(proofEra)
        if (manifest.issues.length > 0) {
          throw new Error(`repair fixture not applicable: ${manifest.issues.map(issue => issue.code).join(', ')}`)
        }
        const applied = await applyRewardsReconciliation({
          models: db,
          manifest,
          confirmedDigest: manifest.digest,
          backupReference: `e2e-isolated-${ns}`,
          writersPaused: true,
          evidence: normalizeEvidence(proofEra)
        }, {
          // Task 5's guarded apply re-verifies with a fresh read-only
          // collection; this scenario injects the same approved collection and
          // the boundary daemon (no live scan in implementation tests).
          collectEvidence: async () => proofEra,
          daemon: {
            getBlockHashByHeight: async height => {
              if (height !== BOUNDARY.height) throw new Error('unknown block height')
              return BOUNDARY.blockHash
            }
          }
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
        // Capture-era contract (Finding #1): the pending attempt's journal is a
        // REAL captured pair whose fee was exact at send time — the repair
        // manifest must make NO fee correction for it (only the genuinely
        // LEGACY pre-capture row's fee is correctable under the amendment).
        const pendingJournalRow = await db.rewardsWalletTransaction.findUnique({
          where: { network_walletAddress_txHash: { network: 'STAGENET', walletAddress: HOT, txHash: HASH.PENDING_PAYOUT } }
        })
        expect(pendingJournalRow).toMatchObject({
          networkFeePiconeros: 1n,
          state: 'PREPARED'
        })
        expect(pendingJournalRow.dispatchId).not.toBeNull()
        expect(pendingJournalRow.claimDigest).not.toBeNull()
        expect(manifest.operations.some(op =>
          op.table === 'RewardsWalletTransaction' && op.txHash === HASH.PENDING_PAYOUT)).toBe(false)
        const d0 = await db.rewardDistribution.findUnique({ where: { id: historical.d0.id } })
        expect(funding.walletReceipt).toBe(false)
        expect(rollover).toMatchObject({ piconeros: 139n, rewardsPiconeros: 100n })
        expect(inserted).toMatchObject({ feeType: 'BOUNTY_FEE', walletReceipt: true, state: 'CONFIRMED', piconeros: 5n })
        expect(payoutJournal.networkFeePiconeros).toBe(7n)
        expect(d0).toMatchObject({ opsInflowPiconeros: 39n, opsRolledOverPiconeros: 0n, opsAvailablePiconeros: 39n, opsSweptPiconeros: 0n, opsSweepTxHash: null })

        const pendingAudit = pendingAuditChain()
        const reconciliation = await reconcileWalletTransactions({
          models: db,
          wallet,
          scope: scope(),
          daemon: pendingAudit.daemon,
          auditWallet: pendingAudit.auditWallet,
          keyProvider: pendingAudit.keyProvider
        })
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

  // ===========================================================================
  // Capture-era regression package (Finding #1, Task 9). Every complete-
  // evidence case uses an explicitly synthetic independent audit session and
  // throwaway keys driven through the trusted verifier; the legacy historical
  // fixture above stays LEGACY (destination-only history never gains captured
  // keys). Fake wallets/isolated DB only.
  // ===========================================================================

  // A key provider bound to a SNAPSHOT of the current registry env, so a later
  // env teardown inside a test cannot invalidate pairs prepared earlier.
  const snapshotKeyProvider = () => createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: process.env.TXPROOF_MASTER_KEYS,
    TXPROOF_MASTER_KEY_CURRENT_VERSION: process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION
  })

  // Prepare one real captured pair through the REAL store for ANY hot kind,
  // naming the recorded rows it belongs to (a live QUEUED payout member for
  // PAYOUT, its distribution for OPS_SWEEP, nothing for a CONSOLIDATION
  // self transfer). PAYOUT and OPS_SWEEP build an owned change output;
  // CONSOLIDATION pays the wallet primary itself (no change).
  const prepareCapturedPayment = async (fixture, {
    kind,
    payout = null,
    hash,
    fee,
    principal,
    destination,
    changeAmount = 15n,
    scalarBase,
    distributionId = null,
    accountIndex = 0
  }) => {
    // The hot wallet's identity mirrors addressFor(ns, 0): spend point(2*s),
    // view point(2*s+1) — the private view key is the scalar 2*s+1.
    const consolidation = kind === 'CONSOLIDATION'
    const tx = makePayoutBuiltTx({
      hash,
      fee,
      destinations: [{ address: destination, amount: principal }],
      changeAddress: consolidation ? null : fixture.address.HOT,
      changeAmount: consolidation ? null : changeAmount,
      scalarBase,
      hotViewScalar: hotViewSecretFor(fixture.ns),
      hotSpendPoint: hotSpendPointFor(fixture.ns)
    })
    const metadata = kind === 'PAYOUT'
      ? { payouts: [{ payoutId: payout.id, recipientAddress: destination, piconeros: principal.toString() }] }
      : kind === 'OPS_SWEEP'
        ? { destination }
        : { selfTransfer: true, destination }
    const journal = await prepareWalletTransaction({
      models: fixture.db,
      wallet: fixture.wallet,
      scope: fixture.scope(),
      tx,
      kind,
      accountIndex: consolidation ? 1 : accountIndex,
      distributionId,
      principalPiconeros: consolidation ? 0n : principal,
      metadata,
      keyProvider: snapshotKeyProvider()
    })
    return { tx, journal }
  }

  // Prepare one real captured PAYOUT pair through the REAL store (naming one
  // live QUEUED payout member) with an owned change output.
  const prepareCapturedPayout = async (fixture, { payout, hash, fee, principal, changeAmount, scalarBase }) =>
    prepareCapturedPayment(fixture, {
      kind: 'PAYOUT',
      payout,
      hash,
      fee,
      principal,
      destination: payout.recipientAddress,
      changeAmount,
      scalarBase,
      distributionId: payout.distributionId
    })

  // Relay ONE prepared pair with an UNCERTAIN outcome (the relay call throws):
  // the attempt is burned, the journal stays PREPARED+attempted, and the
  // wallet's recorded relay set stays empty.
  const relayWithTimeout = async (fixture, { journal, tx }) => {
    const realRelayTx = fixture.wallet.relayTx
    fixture.wallet.relayTx = jest.fn(async () => { throw new Error('relay timeout') })
    try {
      return await relayWalletTransaction({ models: fixture.db, wallet: fixture.wallet, journal, tx, keyProvider: snapshotKeyProvider() })
    } finally {
      fixture.wallet.relayTx = realRelayTx
    }
  }

  test('a payout relay timeout stays uncertain until a fresh confirmed verification proves it — promoted once, never re-relayed', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, wallet, address, uniqueHash, scope } = fixture

      const payout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_ONE, piconeros: 8n })
      const { tx, journal } = await prepareCapturedPayout(fixture, {
        payout, hash: uniqueHash(1), fee: 1n, principal: 8n, changeAmount: 15n, scalarBase: 800n
      })

      // The relay outcome is UNCERTAIN: the attempt CAS is burned but the
      // broadcast result is unknown — PREPARED+attempted, never a relay proof.
      advanceClock(5 * 60 * 1000)
      const outcome = await relayWithTimeout(fixture, { journal, tx })
      expect(outcome).toMatchObject({ txHash: uniqueHash(1), relayed: false, uncertain: true, accountingUnpersisted: 0 })
      expect(wallet.relayedTransactions()).toHaveLength(0)
      const attempted = await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })
      expect(attempted.state).toBe('PREPARED')
      expect(attempted.relayAttemptedAt).not.toBeNull()
      expect(attempted.relayedAt).toBeNull()

      // Without a trusted audit session the attempt stays unresolved: the
      // member is withheld from fresh sends (never FAILED) and nothing moves.
      const unresolved = await reconcileWalletTransactions({ models: db, wallet, scope: scope() })
      expect(unresolved.uncertainPayoutIds).toEqual([payout.id])
      expect(unresolved.accountingUnpersisted).toBe(0)
      expect((await db.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
      expect(wallet.relayedTransactions()).toHaveLength(0)

      // The ONLY resolution is the trusted confirmed whole-payment verifier
      // over an explicitly synthetic independent audit session.
      advanceClock(30 * 60 * 1000)
      const audit = paymentAuditChain({ tx, hot: address.HOT, ns: fixture.ns, scalarBase: 800n })
      const observedAt = advanceClock(0)
      const promoted = await reconcileWalletTransactions({
        models: db,
        wallet,
        scope: scope(),
        daemon: audit.daemon,
        auditWallet: audit.auditWallet,
        keyProvider: snapshotKeyProvider()
      })
      expect(promoted.uncertainPayoutIds).toEqual([])
      expect(promoted.accountingUnpersisted).toBe(0)
      expect(promoted.recoveredPayoutIds.map(entry => entry.id)).toEqual([payout.id])

      const proven = await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })
      expect(proven.state).toBe('RELAYED')
      expect(proven.relayProvenance).toBe('chain-proof-observation')
      // `relayedAt` records when the proof was OBSERVED (this verification's
      // observation time) — never a historical submission time.
      expect(proven.relayedAt.getTime()).toBeGreaterThan(attempted.relayAttemptedAt.getTime())
      expect(proven.relayedAt.getTime()).toBeGreaterThanOrEqual(observedAt.getTime())

      // The durable proof recovers the member — and NOTHING was ever
      // re-relayed: the wallet's recorded relay set is still empty.
      expect(wallet.relayedTransactions()).toHaveLength(0)
      const recovered = await db.rewardPayout.findUnique({ where: { id: payout.id } })
      expect(recovered.state).toBe('SENT')
      expect(recovered.txHash).toBe(uniqueHash(1))

      // A later drive never re-sends the promoted delivery.
      const later = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_TWO, piconeros: 5n })
      const drive = await sendPayouts([later], { models: db, wallet })
      expect(drive.sent).toBe(0)
      expect(wallet.relayedTransactions()).toHaveLength(0)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })).state).toBe('RELAYED')
    })
  })

  test('the captured fee is exact at capture, immutable, and counts as exactly one expense once proven', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, wallet, address, uniqueHash, scope } = fixture

      const payout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_ONE, piconeros: 40n })
      const { tx, journal } = await prepareCapturedPayout(fixture, {
        payout, hash: uniqueHash(2), fee: 7n, principal: 40n, changeAmount: 33n, scalarBase: 900n
      })

      // Exact AT CAPTURE: the journal fee IS the built network fee, captured
      // once inside the authenticated pair (dispatchId/claimDigest non-null).
      expect(journal.networkFeePiconeros).toBe(7n)
      expect(journal.dispatchId).not.toBeNull()
      expect(journal.claimDigest).not.toBeNull()
      // Capture-era rows are fee-immutable: even an approved repair can never
      // rewrite them (the Task 3 trigger, narrowed to proof-era rows by R9).
      await expect(db.rewardsWalletTransaction.update({
        where: { id: journal.id },
        data: { networkFeePiconeros: 8n }
      })).rejects.toThrow(/PAYMENT_PROOF_CAPTURE_IMMUTABLE/)

      // An attempted-but-unproven relay is NOT an expense — it is uncertainty.
      await relayWithTimeout(fixture, { journal, tx })
      const uncertainLedger = await readRewardsWalletLedger(db, { scope: scope() })
      expect(uncertainLedger.totalNetworkFeesPiconeros).toBe(0n)
      expect(uncertainLedger.accountingUncertain).toBe(true)

      // Once PROVEN through the trusted verifier, exactly one expense unit.
      advanceClock(30 * 60 * 1000)
      const audit = paymentAuditChain({ tx, hot: address.HOT, ns: fixture.ns, scalarBase: 900n })
      const promoted = await reconcileWalletTransactions({
        models: db,
        wallet,
        scope: scope(),
        daemon: audit.daemon,
        auditWallet: audit.auditWallet,
        keyProvider: snapshotKeyProvider()
      })
      expect(promoted.uncertainPayoutIds).toEqual([])
      const provenLedger = await readRewardsWalletLedger(db, { scope: scope() })
      expect(provenLedger.totalNetworkFeesPiconeros).toBe(7n)
      expect(provenLedger.accountingUncertain).toBe(false)

      // Reconciliation is idempotent: the fee never double counts.
      await reconcileWalletTransactions({ models: db, wallet, scope: scope() })
      const finalLedger = await readRewardsWalletLedger(db, { scope: scope() })
      expect(finalLedger.totalNetworkFeesPiconeros).toBe(7n)
      expect(finalLedger.accountingUncertain).toBe(false)
    })
  })

  test('an escrow disposition relayed with a failing settlement persist never re-broadcasts; DB-only recovery fills the settlement facts', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, address } = fixture
      const escrowScope = { network: 'STAGENET', walletAddress: address.BOUNTY_ESCROW }
      const escrowWallet = createEscrowWallet({
        address: address.BOUNTY_ESCROW, networkType: 2, ns: fixture.ns, netFee: 40_000n, unlocked: 100_000_000_000n
      })
      const keyProvider = snapshotKeyProvider()
      const payout = await seedEscrowPayoutFixture(fixture)

      // Drive 1: relay PROVEN, then the settlement persist FAILS.
      const injection = { active: true, failures: 0 }
      const summary = await sendBountyPayments(
        [payout],
        { models: withBountyPersistFailures(db, injection), wallet: escrowWallet, keyProvider }
      )
      expect(injection.failures).toBe(1)
      expect(summary.sent).toBe(0)
      expect(escrowWallet.relayedTransactions()).toHaveLength(1)
      const relayedOnce = escrowWallet.relayedTransactions()[0]
      expect(relayedOnce.destinations).toEqual([
        { address: address.CURATOR_ONE, amount: 10_000_000_000n },
        { address: address.COLD, amount: 2_000_000_000n - 40_000n }
      ])
      const unpersisted = await db.bountyPayment.findUnique({ where: { id: payout.id } })
      expect(unpersisted.state).toBe('QUEUED')
      expect(unpersisted.txHash).toBeNull()
      const journal = await db.escrowWalletTransaction.findFirst({ where: { bountyPaymentId: payout.id } })
      expect(journal.state).toBe('RELAYED')
      expect(journal.leg).toBe('DISPOSITION')
      expect(journal.relayProvenance).toBe('direct-relay-observation')

      // Drive 2: the durable dispatch withholds the exact leg AND the DB-only
      // recovery fills the settlement facts — no keys, no chain, no re-send.
      const safety = await reconcileEscrowTransactions({ models: db, wallet: escrowWallet, scope: escrowScope })
      expect(safety.withheldDispositionIds).toEqual([payout.id])
      expect(safety.withheldFeeIds).toEqual([])
      expect(safety.recoveredIds).toEqual([payout.id])
      expect(safety.accountingUnpersisted).toBe(0)
      expect(escrowWallet.relayedTransactions()).toHaveLength(1)
      const recovered = await db.bountyPayment.findUnique({ where: { id: payout.id } })
      expect(recovered.state).toBe('SENT')
      expect(recovered.txHash).toBe(relayedOnce.hash)
      expect(recovered.networkFeePiconeros).toBe(40_000n)
      expect(recovered.recipientReceivedPiconeros).toBe(10_000_000_000n)
      expect(recovered.feeReceivedPiconeros).toBe(2_000_000_000n - 40_000n)

      // Drive 3: even a stale caller-offered QUEUED copy stays withheld — the
      // durable RELAYED dispatch is never rebuilt and never re-relayed.
      const stale = { ...recovered, state: 'QUEUED' }
      const repeatSummary = await sendBountyPayments([stale], { models: db, wallet: escrowWallet, keyProvider })
      expect(repeatSummary.sent).toBe(0)
      expect(escrowWallet.relayedTransactions()).toHaveLength(1)
    })
  })

  test('with the TX-proof registry unconfigured, recorded delivery and DB-only recovery still work while uncertain attempts stay withheld', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, wallet, address, uniqueHash, scope } = fixture
      const keyProvider = snapshotKeyProvider()

      // Rewards: one recorded relay whose member persist never happened, plus
      // one uncertain attempt.
      const recordedPayout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_ONE, piconeros: 12n })
      const recorded = await prepareCapturedPayout(fixture, {
        payout: recordedPayout, hash: uniqueHash(1), fee: 2n, principal: 12n, changeAmount: 20n, scalarBase: 1000n
      })
      // The recovery scenarios below operate on REAL captured pairs, never on
      // fictional legacy rows: the durable pair must exist before the keys go.
      expect(recorded.journal.dispatchId).not.toBeNull()
      expect(recorded.journal.claimDigest).not.toBeNull()
      await relayWalletTransaction({ models: db, wallet, journal: recorded.journal, tx: recorded.tx, keyProvider })

      const uncertainPayout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_TWO, piconeros: 6n })
      const uncertain = await prepareCapturedPayout(fixture, {
        payout: uncertainPayout, hash: uniqueHash(2), fee: 3n, principal: 6n, changeAmount: 10n, scalarBase: 1100n
      })
      expect(uncertain.journal.dispatchId).not.toBeNull()
      expect(uncertain.journal.claimDigest).not.toBeNull()
      await relayWithTimeout(fixture, { journal: uncertain.journal, tx: uncertain.tx })

      // Escrow: one recorded RELAYED disposition whose payout persist is
      // skipped (driven through the barrier directly), plus one uncertain
      // attempt.
      const escrowScope = { network: 'STAGENET', walletAddress: address.BOUNTY_ESCROW }
      const escrowWallet = createEscrowWallet({
        address: address.BOUNTY_ESCROW, networkType: 2, ns: fixture.ns, netFee: 40_000n, unlocked: 100_000_000_000n
      })
      const escrowRecorded = await seedEscrowPayoutFixture(fixture)
      const escrowRecordedTx = await escrowWallet.createTx({
        accountIndex: 0,
        destinations: [
          { address: escrowRecorded.recipientAddress, amount: 10_000_000_000n },
          { address: escrowRecorded.feeRecipientAddress, amount: 2_000_000_000n }
        ],
        subtractFeeFrom: [1],
        relay: false
      })
      const escrowRecordedJournal = await prepareEscrowTransaction({
        models: db,
        wallet: escrowWallet,
        tx: escrowRecordedTx,
        payout: escrowRecorded,
        leg: 'DISPOSITION',
        settlement: await readBountySettlement(escrowRecordedTx, {
          payout: escrowRecorded,
          feeRecipientAddress: escrowRecorded.feeRecipientAddress
        }),
        scope: escrowScope,
        keyProvider
      })
      expect(escrowRecordedJournal.dispatchId).not.toBeNull()
      expect(escrowRecordedJournal.claimDigest).not.toBeNull()
      await relayEscrowTransaction({ models: db, wallet: escrowWallet, journal: escrowRecordedJournal, tx: escrowRecordedTx, keyProvider })

      const escrowUncertain = await seedEscrowPayoutFixture(fixture)
      const escrowUncertainTx = await escrowWallet.createTx({
        accountIndex: 0,
        destinations: [
          { address: escrowUncertain.recipientAddress, amount: 10_000_000_000n },
          { address: escrowUncertain.feeRecipientAddress, amount: 2_000_000_000n }
        ],
        subtractFeeFrom: [1],
        relay: false
      })
      const escrowUncertainJournal = await prepareEscrowTransaction({
        models: db,
        wallet: escrowWallet,
        tx: escrowUncertainTx,
        payout: escrowUncertain,
        leg: 'DISPOSITION',
        settlement: await readBountySettlement(escrowUncertainTx, {
          payout: escrowUncertain,
          feeRecipientAddress: escrowUncertain.feeRecipientAddress
        }),
        scope: escrowScope,
        keyProvider
      })
      expect(escrowUncertainJournal.dispatchId).not.toBeNull()
      expect(escrowUncertainJournal.claimDigest).not.toBeNull()
      const realEscrowRelayTx = escrowWallet.relayTx
      escrowWallet.relayTx = jest.fn(async () => { throw new Error('relay timeout') })
      await relayEscrowTransaction({ models: db, wallet: escrowWallet, journal: escrowUncertainJournal, tx: escrowUncertainTx, keyProvider })
      escrowWallet.relayTx = realEscrowRelayTx

      // The registry disappears (lost keys / unconfigured env).
      delete process.env.TXPROOF_MASTER_KEYS
      delete process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION

      // Rewards: recorded delivery still recovers its member DB-only (no key,
      // no chain); the uncertain attempt stays withheld — never FAILED.
      const rewards = await reconcileWalletTransactions({ models: db, wallet, scope: scope() })
      expect(rewards.recoveredPayoutIds.map(entry => entry.id)).toEqual([recordedPayout.id])
      expect(rewards.uncertainPayoutIds).toEqual([uncertainPayout.id])
      expect((await db.rewardPayout.findUnique({ where: { id: recordedPayout.id } }))).toMatchObject({
        state: 'SENT',
        txHash: uniqueHash(1)
      })
      const uncertainRow = await db.rewardsWalletTransaction.findUnique({ where: { id: uncertain.journal.id } })
      expect(uncertainRow.state).toBe('PREPARED')
      expect(uncertainRow.relayAttemptedAt).not.toBeNull()
      expect((await db.rewardPayout.findUnique({ where: { id: uncertainPayout.id } })).state).toBe('QUEUED')
      expect(wallet.relayedTransactions()).toHaveLength(1)

      // A fresh drive never resends the uncertain member.
      const liveUncertain = await db.rewardPayout.findUnique({ where: { id: uncertainPayout.id } })
      const drive = await sendPayouts([liveUncertain], { models: db, wallet })
      expect(drive.sent).toBe(0)
      expect(drive.accountingUnpersisted).toBeGreaterThanOrEqual(1)
      expect((await db.rewardPayout.findUnique({ where: { id: uncertainPayout.id } })).state).toBe('QUEUED')
      expect(wallet.relayedTransactions()).toHaveLength(1)

      // Escrow: recorded delivery recovers settlement facts DB-only; the
      // uncertain attempt stays withheld (payout QUEUED, never FAILED).
      const escrow = await reconcileEscrowTransactions({ models: db, wallet: escrowWallet, scope: escrowScope })
      expect(escrow.recoveredIds).toEqual([escrowRecorded.id])
      expect(escrow.withheldDispositionIds).toEqual([escrowRecorded.id, escrowUncertain.id].sort((a, b) => a - b))
      expect(escrow.accountingUnpersisted).toBeGreaterThanOrEqual(1)
      expect(await db.bountyPayment.findUnique({ where: { id: escrowRecorded.id } })).toMatchObject({
        state: 'SENT',
        networkFeePiconeros: 40_000n,
        recipientReceivedPiconeros: 10_000_000_000n,
        feeReceivedPiconeros: 2_000_000_000n - 40_000n
      })
      expect((await db.bountyPayment.findUnique({ where: { id: escrowUncertain.id } })).state).toBe('QUEUED')
      expect(escrowWallet.relayedTransactions()).toHaveLength(1)
    })
  })

  test('a corrupt stored proof fails verification, leaves recorded delivery intact, and check/rotation surface it without leaking material', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, wallet, address, uniqueHash, scope } = fixture
      const keyProvider = snapshotKeyProvider()

      // Pair 1: recorded delivery (real relay; member persist never happened).
      const deliveredPayout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_ONE, piconeros: 9n })
      const delivered = await prepareCapturedPayout(fixture, {
        payout: deliveredPayout, hash: uniqueHash(1), fee: 2n, principal: 9n, changeAmount: 20n, scalarBase: 1200n
      })
      await relayWalletTransaction({ models: db, wallet, journal: delivered.journal, tx: delivered.tx, keyProvider })

      // Pair 2: an uncertain attempt whose stored proof then becomes
      // UNREADABLE at the data layer (corruption respecting the revision guard).
      const attemptedPayout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_TWO, piconeros: 6n })
      const attempted = await prepareCapturedPayout(fixture, {
        payout: attemptedPayout, hash: uniqueHash(2), fee: 3n, principal: 6n, changeAmount: 10n, scalarBase: 1300n
      })
      await relayWithTimeout(fixture, { journal: attempted.journal, tx: attempted.tx })

      const corruptDelivered = await corruptProofEnvelope(db, delivered.journal.id)
      const corruptAttempted = await corruptProofEnvelope(db, attempted.journal.id)

      // Verification of the attempted row cannot authenticate its pair:
      // uncertainty is RETAINED (never FAILED, never promoted), while the
      // recorded delivery's DB-only recovery still lands — corruption cannot
      // erase recorded delivery facts.
      advanceClock(30 * 60 * 1000)
      const audit = paymentAuditChain({ tx: attempted.tx, hot: address.HOT, ns: fixture.ns, scalarBase: 1300n })
      const result = await reconcileWalletTransactions({
        models: db,
        wallet,
        scope: scope(),
        daemon: audit.daemon,
        auditWallet: audit.auditWallet,
        keyProvider
      })
      expect(result.uncertainPayoutIds).toEqual([attemptedPayout.id])
      expect(result.recoveredPayoutIds.map(entry => entry.id)).toEqual([deliveredPayout.id])
      const attemptedRow = await db.rewardsWalletTransaction.findUnique({ where: { id: attempted.journal.id } })
      expect(attemptedRow.state).toBe('PREPARED')
      expect(attemptedRow.relayedAt).toBeNull()
      expect(await db.rewardPayout.findUnique({ where: { id: deliveredPayout.id } })).toMatchObject({
        state: 'SENT',
        txHash: uniqueHash(1)
      })

      // check surfaces the corruption as fixed safe issues only.
      const check = await checkPaymentProofInventory({ models: db, keyProvider })
      const mine = check.ownerIssues.filter(issue =>
        [corruptDelivered.proofId, corruptAttempted.proofId].includes(issue.proofId))
      expect(mine).toHaveLength(2)
      for (const issue of mine) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'journalId', 'journalRole', 'proofId'])
        expect(issue.code).toBe('TXPROOF_ENVELOPE_AUTH_FAILED')
        expect(issue.journalRole).toBe('REWARDS')
      }

      // Rotation reports the corrupt rows, rotates nothing, and keeps their
      // exact old bytes — never dropped, never rewritten.
      const rotation = await rotatePaymentProofs({ models: db, keyProvider, targetVersion: 1, writersPaused: true })
      expect(rotation.rotated).toBe(0)
      expect(rotation.issues.map(issue => issue.proofId))
        .toEqual(expect.arrayContaining([corruptDelivered.proofId, corruptAttempted.proofId]))
      expect(rotation.rotated + rotation.skipped + rotation.issues.length).toBe(rotation.counts.proofs)
      for (const corruption of [corruptDelivered, corruptAttempted]) {
        const proof = await db.paymentTransactionProof.findUnique({ where: { id: corruption.proofId } })
        expect(Buffer.from(proof.ciphertext).toString('hex')).toBe(corruption.corruptedCiphertextHex)
      }

      // No key or envelope material reaches any safe surface.
      const serialized = bigintSafeJson({ check, rotation })
      expect(serialized).not.toContain(corruptDelivered.corruptedCiphertextHex.slice(0, 32))
      expect(serialized).not.toContain(corruptAttempted.corruptedCiphertextHex.slice(0, 32))
      expect(serialized).not.toContain(Buffer.alloc(32, 13).toString('base64'))
    })
  })

  // ===========================================================================
  // Coordinated repair chain (rewards reconciliation Task 7). ONE continuous
  // scenario per hot kind: future capture -> possible relay (uncertain
  // outcome) -> fresh confirmed verification (REAL collector + REAL verifier
  // over an explicitly synthetic audit session) -> builder promotion (closed
  // v2 relayProof) -> guarded isolated APPLY -> exact-digest replay no-op ->
  // next payout drive never re-sends -> pool/ops costs counted exactly once.
  // The historical destination-only fixture above stays LEGACY (no verifier
  // checks, no `status:'complete'` constants): only this proof-era chain
  // supplies actual verifier checks.
  // ===========================================================================

  const COORDINATED_KINDS = {
    PAYOUT: { fee: 1n, principal: 8n, changeAmount: 15n, scalarBase: 800n },
    OPS_SWEEP: { fee: 9n, principal: 500n, changeAmount: 15n, scalarBase: 810n },
    CONSOLIDATION: { fee: 4n, principal: 8n, changeAmount: null, scalarBase: 820n }
  }

  // Collect the fresh audit session the way the production audit-session
  // builder does (collectPaymentChainEvidence over the audited wallet, with
  // checkTxKey attached) and verify ONE attempted row through the REAL
  // verifier — without promoting: the promotion authority here is the repair
  // builder plus the guarded APPLY, never the runtime reconcile.
  const collectFreshVerification = async ({ fixture, journal, tx, scalarBase, sourceAccountIndex, observedAt }) => {
    const audit = paymentAuditChain({
      tx, hot: fixture.address.HOT, ns: fixture.ns, scalarBase, sourceAccountIndex
    })
    const derived = [
      { majorIndex: 0, minorIndex: 0, address: fixture.address.HOT },
      ...[1, 2, 3, 4, 5].map(major => ({ majorIndex: major, minorIndex: 0, address: addressFor(fixture.ns, 20 + major) }))
    ]
    const session = await collectPaymentChainEvidence({
      wallet: audit.auditWallet,
      daemon: audit.daemon,
      scope: fixture.scope(),
      derivation: { complete: true, primaryAddress: fixture.address.HOT, derived, mismatches: [] },
      boundary: audit.tip,
      auditedHashes: [tx.getHash()]
    })
    const verification = await verifyPaymentTransaction({
      models: fixture.db,
      journalRole: 'REWARDS',
      journalId: journal.id,
      session: { ...session, checkTxKey: audit.auditWallet.checkTxKey },
      keyProvider: snapshotKeyProvider(),
      observedAt: observedAt.toISOString()
    })
    return { verification, boundary: audit.tip }
  }

  // The protected-contract snapshot for the coordinated chain: payout rows,
  // Earn contracts and every recorded distribution field the repair must
  // never touch (the derived ops inflow/rolled/available triple MAY move).
  const protectedContractSnapshot = async (fixture, distributionIds) => ({
    payouts: await fixture.db.rewardPayout.findMany({
      where: { distributionId: { in: distributionIds } },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, txHash: true, recipientAddress: true, piconeros: true }
    }),
    earns: await fixture.db.earn.findMany({
      where: { distributionId: { in: distributionIds } },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, distributionId: true, piconeros: true }
    }),
    distributions: await fixture.db.rewardDistribution.findMany({
      where: { id: { in: distributionIds } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        poolPiconeros: true,
        distributedPiconeros: true,
        rolledOverPiconeros: true,
        payoutCount: true,
        status: true,
        opsSweptPiconeros: true,
        opsSweepState: true,
        opsSweepTxHash: true
      }
    })
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('coordinated repair chain (%s): capture, uncertain relay, fresh verified promotion, guarded APPLY, replay no-op, no re-send, costs counted once', async kind => {
    const spec = COORDINATED_KINDS[kind]
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, wallet, address, uniqueHash, scope } = fixture

      // --- recorded rows the captured pair belongs to ------------------------
      const distributionIds = []
      let payout = null
      let distributionId = null
      if (kind === 'PAYOUT') {
        payout = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_ONE, piconeros: spec.principal })
        distributionId = payout.distributionId
        distributionIds.push(distributionId)
      } else if (kind === 'OPS_SWEEP') {
        const distribution = await seedSweepDistributionFixture(fixture, { opsInflowPiconeros: 524n })
        distributionId = distribution.id
        distributionIds.push(distributionId)
      }
      const destination = kind === 'OPS_SWEEP'
        ? address.COLD
        : kind === 'CONSOLIDATION' ? address.HOT : address.CURATOR_ONE

      // 1. FUTURE CAPTURE: a real protected pair through the capture barrier.
      const hash = uniqueHash(1)
      const { tx, journal } = await prepareCapturedPayment(fixture, {
        kind,
        payout,
        hash,
        fee: spec.fee,
        principal: spec.principal,
        destination,
        changeAmount: spec.changeAmount,
        scalarBase: spec.scalarBase,
        distributionId
      })
      expect(journal.dispatchId).not.toBeNull()
      expect(journal.claimDigest).not.toBeNull()
      expect(journal.networkFeePiconeros).toBe(spec.fee)

      // 2. POSSIBLE RELAY: the attempt is burned, the outcome stays unknown.
      advanceClock(5 * 60 * 1000)
      const outcome = await relayWithTimeout(fixture, { journal, tx })
      expect(outcome).toMatchObject({ txHash: hash, relayed: false, uncertain: true, accountingUnpersisted: 0 })
      expect(wallet.relayedTransactions()).toHaveLength(0)
      const attempted = await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })
      expect(attempted.state).toBe('PREPARED')
      expect(attempted.relayAttemptedAt).not.toBeNull()
      expect(attempted.relayedAt).toBeNull()

      // Until proven: an attempted relay is NOT an expense and the pool cost
      // stays an outstanding commitment.
      const uncertainLedger = await readRewardsWalletLedger(db, { scope: scope() })
      expect(uncertainLedger.accountingUncertain).toBe(true)
      expect(uncertainLedger.totalNetworkFeesPiconeros).toBe(0n)
      const poolBefore = await db.$transaction(tx => readNextRewardsPool(tx))
      expect(poolBefore.outstandingRewardsPiconeros).toBe(kind === 'PAYOUT' ? spec.principal : 0n)

      // 3. FRESH CONFIRMED VERIFICATION: the REAL collector + verifier over
      // the explicitly synthetic audit session — no promotion happens here.
      advanceClock(30 * 60 * 1000)
      const observedAt = advanceClock(0)
      const { verification, boundary } = await collectFreshVerification({
        fixture, journal, tx, scalarBase: spec.scalarBase, sourceAccountIndex: kind === 'CONSOLIDATION' ? 1 : 0, observedAt
      })
      expect(verification.status).toBe('complete')

      // 4. BUILDER PROMOTION: the v2 evidence collection carries the verified
      // result; the builder emits exactly ONE closed relay operation.
      const evidence = {
        evidenceVersion: 2,
        collectionStartedAt: observedAt.toISOString(),
        observedAt: observedAt.toISOString(),
        scope: scope(),
        boundary,
        daemon: { tipBefore: boundary, tipAfter: boundary },
        restoreHeight: 0,
        restoreProvenance: 'genesis',
        walletHeight: boundary.height + 1,
        derivation: { complete: true, primaryAddress: address.HOT, derived: [], mismatches: [] },
        balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
        incoming: [],
        outgoing: [{
          txHash: hash,
          accountIndex: kind === 'CONSOLIDATION' ? 1 : 0,
          feePiconeros: spec.fee.toString(),
          destinations: [{ address: destination, amountPiconeros: spec.principal.toString() }],
          height: boundary.height - 20,
          inTxPool: false,
          isConfirmed: true,
          isRelayed: true,
          isSelfTransfer: kind === 'CONSOLIDATION',
          relayState: 'confirmed'
        }],
        bridge: { pendingIncoming: [], pendingOutgoing: [] },
        escrow: null,
        paymentVerifications: [verification]
      }
      const ledger = await readRepairLedger(db, scope())
      const manifest = buildRewardsReconciliation({
        scope: scope(),
        boundary,
        evidence,
        ledger,
        decisions: { receipts: {} },
        config: ledger.config,
        reserve: { feeHeadroomPiconeros: FEE_HEADROOM, dustFloorPiconeros: DUST_FLOOR },
        opsCarryProvenance: {}
      })
      expect(manifest.issues).toEqual([])
      expect(manifest.version).toBe(2)
      const promotions = manifest.operations.filter(op =>
        op.table === 'RewardsWalletTransaction' && op.after?.state === 'RELAYED')
      expect(promotions).toHaveLength(1)
      const promotion = promotions[0]
      expect(promotion.txHash).toBe(hash)
      expect(promotion.before).toMatchObject({ state: 'PREPARED', relayedAt: null, relayProvenance: null })
      expect(promotion.after).toMatchObject({ state: 'RELAYED', relayProvenance: 'chain-proof-observation' })
      expect(promotion.after.relayedAt).toBe(observedAt.toISOString())
      expect(promotion.reason).toBe('confirmed-complete-payment')
      expect(Object.keys(promotion.relayProof).sort()).toEqual([...RELAY_PROOF_FIELDS])
      expect(promotion.relayProof.evidenceDigest).toBe(manifest.evidenceDigest)
      expect(promotion.relayProof.observedAt).toBe(observedAt.toISOString())
      // The repair money projection counts the proven cost exactly once.
      expect(BigInt(manifest.after.totalNetworkFeesPiconeros)).toBe(spec.fee)

      // 5. GUARDED ISOLATED APPLY — writers paused, backup named, no wallet.
      const before = await protectedContractSnapshot(fixture, distributionIds)
      const applied = await applyRewardsReconciliation({
        models: db,
        manifest,
        confirmedDigest: manifest.digest,
        backupReference: `coordinated-${fixture.ns}`,
        writersPaused: true,
        evidence
      }, {
        collectEvidence: async () => evidence,
        daemon: {
          getBlockHashByHeight: async height => {
            if (height !== boundary.height) throw new Error('unknown block height')
            return boundary.blockHash
          }
        }
      })
      expect(applied).toMatchObject({ applied: true, digest: manifest.digest })
      // The repair never signs, relays or sweeps: the wallet was never asked.
      expect(wallet.relayedTransactions()).toHaveLength(0)
      const promoted = await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })
      expect(promoted.state).toBe('RELAYED')
      expect(promoted.relayProvenance).toBe('chain-proof-observation')
      expect(promoted.relayedAt.toISOString()).toBe(observedAt.toISOString())
      expect(promoted.networkFeePiconeros).toBe(spec.fee) // captured fee immutable
      expect(promoted.principalPiconeros).toBe(kind === 'CONSOLIDATION' ? 0n : spec.principal)
      // One APPLY audit row; the wrapper binds the untouched manifest.
      const audits = await db.rewardsWalletReconciliation.findMany({ where: { digest: manifest.digest, kind: 'APPLY' } })
      expect(audits).toHaveLength(1)
      expect(audits[0].report.manifest.digest).toBe(manifest.digest)
      // Protected contracts are byte-equal across the apply.
      expect(await protectedContractSnapshot(fixture, distributionIds)).toEqual(before)

      // 6. REPEAT NO-OP: the exact applied digest replays as a no-op even with
      // the proof registry gone, and never writes a second audit row.
      const priorKeys = process.env.TXPROOF_MASTER_KEYS
      const priorVersion = process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION
      delete process.env.TXPROOF_MASTER_KEYS
      delete process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION
      try {
        const replay = await applyRewardsReconciliation({
          models: db,
          manifest,
          confirmedDigest: manifest.digest,
          backupReference: `coordinated-${fixture.ns}`,
          writersPaused: true,
          evidence
        }, {
          collectEvidence: async () => evidence,
          daemon: {
            getBlockHashByHeight: async height => {
              if (height !== boundary.height) throw new Error('unknown block height')
              return boundary.blockHash
            }
          }
        })
        expect(replay).toMatchObject({ applied: false, digest: manifest.digest })
      } finally {
        process.env.TXPROOF_MASTER_KEYS = priorKeys
        process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION = priorVersion
      }
      expect(await db.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)

      // 7. COSTS COUNTED ONCE in the ledger union (and the pool release).
      const provenLedger = await readRewardsWalletLedger(db, { scope: scope() })
      expect(provenLedger.accountingUncertain).toBe(false)
      expect(provenLedger.totalNetworkFeesPiconeros).toBe(spec.fee)
      if (kind === 'OPS_SWEEP') {
        // The proved sweep principal is counted once for its distribution; the
        // RECORDED swept/hash fields stay untouched by the repair.
        expect(provenLedger.sweptByDistribution.get(distributionId)).toBe(spec.principal)
        const recorded = await db.rewardDistribution.findUnique({ where: { id: distributionId } })
        expect(recorded).toMatchObject({ opsSweptPiconeros: 0n, opsSweepTxHash: null })
      }
      if (kind === 'PAYOUT') {
        // The proven delivery releases the pool commitment exactly once — and
        // the payout row itself is never touched by the repair.
        const poolAfter = await db.$transaction(tx => readNextRewardsPool(tx))
        expect(poolAfter.outstandingRewardsPiconeros).toBe(0n)
        expect(provenLedger.payoutSentPiconeros).toBe(spec.principal)
        expect((await db.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
      }

      // 8. NEXT DRIVE: a later payout drive never re-sends the promoted
      // delivery (PAYOUT: the member is recovered DB-only and a fresh payout
      // is the only new relay; other kinds: a later reconcile is a no-op).
      if (kind === 'PAYOUT') {
        const later = await seedQueuedPayoutFixture(fixture, { recipientAddress: address.CURATOR_TWO, piconeros: 5n })
        distributionIds.push(later.distributionId)
        wallet.fund(1000n)
        // A stale caller-offered QUEUED copy of the promoted payout must be
        // recovered, never rebuilt under a new relay.
        const stale = { ...(await db.rewardPayout.findUnique({ where: { id: payout.id } })), state: 'QUEUED' }
        const drive = await sendPayouts([stale, later], { models: db, wallet })
        expect(drive.sent).toBe(2) // recovered delivery + the one fresh payout
        const recovered = await db.rewardPayout.findUnique({ where: { id: payout.id } })
        expect(recovered).toMatchObject({ state: 'SENT', txHash: hash })
        const relays = wallet.relayedTransactions()
        expect(relays).toHaveLength(1) // ONLY the fresh payout was relayed
        expect(relays[0].destinations.some(d => d.address === address.CURATOR_TWO && d.amount === 5n)).toBe(true)
        expect(relays.some(relay => relay.hash === hash)).toBe(false)
        // Counted once across the recovery: totals did not move.
        const finalLedger = await readRewardsWalletLedger(db, { scope: scope() })
        expect(finalLedger.totalNetworkFeesPiconeros).toBe(spec.fee)
        expect(finalLedger.payoutSentPiconeros).toBe(spec.principal + 5n)
        const poolFinal = await db.$transaction(tx => readNextRewardsPool(tx))
        expect(poolFinal.outstandingRewardsPiconeros).toBe(0n)
      } else {
        const reconciled = await reconcileWalletTransactions({ models: db, wallet, scope: scope() })
        expect(reconciled.uncertainPayoutIds).toEqual([])
        expect(reconciled.uncertainSweep).toBe(false)
        const finalLedger = await readRewardsWalletLedger(db, { scope: scope() })
        expect(finalLedger.totalNetworkFeesPiconeros).toBe(spec.fee)
        if (kind === 'OPS_SWEEP') expect(finalLedger.sweptByDistribution.get(distributionId)).toBe(spec.principal)
        expect((await db.rewardsWalletTransaction.findUnique({ where: { id: journal.id } })).state).toBe('RELAYED')
        expect(wallet.relayedTransactions()).toHaveLength(0)
      }
    })
  })

  test('escrow disposition and deferred fee legs are audited row-first through the repair manifest, and a missing leg is named without mutating recorded facts', async () => {
    await withIsolatedScenario({ withHistoricalRepair: false }, async fixture => {
      const { db, address, uniqueHash, boundary } = fixture
      const escrowWallet = createEscrowWallet({
        address: address.BOUNTY_ESCROW, networkType: 2, ns: fixture.ns, netFee: 40_000n, unlocked: 100_000_000_000n
      })
      const keyProvider = snapshotKeyProvider()

      // Modern combined disposition: one real capture-barrier send settles the
      // prize and the ops fee in ONE tx; the settlement facts are recorded.
      const modern = await seedEscrowPayoutFixture(fixture)
      // Frozen item terms that agree with the award being settled (the audit
      // fingerprint binds Item terms through BountyPayment.itemId).
      await db.item.update({
        where: { id: modern.itemId },
        data: { bountyPiconeros: 10_000_000_000n, bountyFeePiconeros: 2_000_000_000n }
      })
      const modernSummary = await sendBountyPayments([modern], { models: db, wallet: escrowWallet, keyProvider })
      expect(modernSummary.sent).toBe(1)
      const modernRow = await db.bountyPayment.findUnique({ where: { id: modern.id } })
      expect(modernRow.state).toBe('SENT')
      expect(modernRow.txHash).toBe(escrowWallet.relayedTransactions()[0].hash)
      expect(modernRow.networkFeePiconeros).toBe(40_000n)
      const modernLeg = escrowWallet.relayedTransactions()[0]

      // Legacy deferred fee (pre-2026-09-18 state): the prize leg is already
      // SENT with only the recipient destination; the fee leg pends and is
      // settled by the real retry branch through the same capture barrier.
      const prizeHash = uniqueHash(2)
      const legacy = await seedEscrowPayoutFixture(fixture, {
        state: 'SENT',
        txHash: prizeHash,
        networkFeePiconeros: 30_000n,
        recipientReceivedPiconeros: 10_000_000_000n,
        feeReceivedPiconeros: 0n,
        feePendingAt: new Date(Date.now() - DAY_MS)
      })
      await db.item.update({
        where: { id: legacy.itemId },
        data: { bountyPiconeros: 10_000_000_000n, bountyFeePiconeros: 2_000_000_000n }
      })
      const settled = await sendBountyPayments([await db.bountyPayment.findUnique({ where: { id: legacy.id } })], { models: db, wallet: escrowWallet, keyProvider })
      expect(settled.settled).toBe(1)
      const legacyRow = await db.bountyPayment.findUnique({ where: { id: legacy.id } })
      expect(legacyRow.feeTxHash).not.toBeNull()
      expect(legacyRow.feePendingAt).toBeNull()
      expect(legacyRow.feeSettlementNetworkFeePiconeros).toBe(40_000n)
      expect(legacyRow.feeReceivedPiconeros).toBe(2_000_000_000n)
      // Both escrow legs are captured proof-era dispatches.
      const feeJournal = await db.escrowWalletTransaction.findFirst({ where: { bountyPaymentId: legacy.id, leg: 'LEGACY_SEPARATE_FEE' } })
      expect(feeJournal).toMatchObject({ state: 'RELAYED', txHash: legacyRow.feeTxHash })
      expect(feeJournal.dispatchId).not.toBeNull()
      expect(feeJournal.claimDigest).not.toBeNull()
      expect(escrowWallet.relayedTransactions()).toHaveLength(2) // never a third

      // The repair manifest at the rewards scope audits BOTH recorded legs
      // row-first against the escrow wallet's own outgoing history.
      const legEntry = (relay, feePiconeros) => ({
        txHash: relay.hash,
        accountIndex: 0,
        feePiconeros: feePiconeros.toString(),
        destinations: relay.destinations.map(d => ({ address: d.address, amountPiconeros: d.amount.toString() })),
        height: 200,
        inTxPool: false,
        isConfirmed: true,
        isRelayed: true,
        isSelfTransfer: false,
        relayState: 'confirmed'
      })
      const escrowEvidence = () => ({
        walletAddress: address.BOUNTY_ESCROW,
        derivation: {
          complete: true,
          primaryAddress: address.BOUNTY_ESCROW,
          derived: [{ majorIndex: 0, minorIndex: 0, address: address.BOUNTY_ESCROW }],
          mismatches: []
        },
        balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
        incoming: [],
        outgoing: [
          // The legacy prize leg: its own tx, only the recipient destination.
          {
            txHash: prizeHash,
            accountIndex: 0,
            feePiconeros: '30000',
            destinations: [{ address: address.CURATOR_ONE, amountPiconeros: '10000000000' }],
            height: 200,
            inTxPool: false,
            isConfirmed: true,
            isRelayed: true,
            isSelfTransfer: false,
            relayState: 'confirmed'
          },
          legEntry(modernLeg, 40_000n),
          legEntry(escrowWallet.relayedTransactions()[1], 40_000n)
        ],
        bridge: { pendingIncoming: [], pendingOutgoing: [] }
      })
      const buildInput = evidenceOverride => {
        const evidence = {
          evidenceVersion: 2,
          collectionStartedAt: new Date(Date.now()).toISOString(),
          observedAt: new Date(Date.now()).toISOString(),
          scope: fixture.scope(),
          boundary,
          daemon: { tipBefore: boundary, tipAfter: boundary },
          restoreHeight: 0,
          restoreProvenance: 'genesis',
          walletHeight: boundary.height + 1,
          derivation: { complete: true, primaryAddress: address.HOT, derived: [], mismatches: [] },
          balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
          incoming: [],
          outgoing: [],
          bridge: { pendingIncoming: [], pendingOutgoing: [] },
          escrow: typeof evidenceOverride === 'function' ? evidenceOverride() : (evidenceOverride ?? escrowEvidence()),
          paymentVerifications: []
        }
        return { evidence, original: structuredClone(evidence) }
      }
      const buildManifest = async evidenceOverride => {
        const override = typeof evidenceOverride === 'function' ? await evidenceOverride() : evidenceOverride
        const { evidence, original } = buildInput(override)
        const ledger = await readRepairLedger(db, fixture.scope())
        const manifest = buildRewardsReconciliation({
          scope: fixture.scope(),
          boundary,
          evidence,
          ledger,
          decisions: { receipts: {} },
          config: ledger.config,
          reserve: { feeHeadroomPiconeros: FEE_HEADROOM, dustFloorPiconeros: DUST_FLOOR },
          opsCarryProvenance: {}
        })
        return { manifest, original, evidence }
      }

      // Final-review I1: strict recorded-outflow coverage is
      // verification-only. History-only escrow coverage (the outgoing entries
      // alone) is an UNRESOLVED strict audit — each recorded leg is named.
      const historyOnly = await buildManifest()
      expect(historyOnly.manifest.issues).toHaveLength(3)
      expect(historyOnly.manifest.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          table: 'BountyPayment',
          id: String(legacy.id),
          leg: 'PRINCIPAL',
          txHash: prizeHash
        }),
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          table: 'BountyPayment',
          id: String(legacy.id),
          leg: 'FEE',
          txHash: legacyRow.feeTxHash
        }),
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          table: 'BountyPayment',
          id: String(modern.id),
          leg: 'PRINCIPAL',
          txHash: modernRow.txHash
        })
      ]))
      expect(historyOnly.manifest.operations).toEqual([]) // the recorded debits stay

      // Covered: a complete ESCROW verification per exact leg hash, HONEST
      // per leg (final-review I1 round 3): each captured leg's proof carries
      // the leg's own frozen member multiset derived from the journal row's
      // authenticated claims (canonical member id/leg/address/exact amount,
      // via the escrow reconcile's derivation), and binds the recorded journal
      // owner; the journal-less legacy prize leg carries its recorded
      // settlement member. The audit then names nothing and records no
      // corrections (the recorded settlement facts already agree).
      const escrowProofs = async () => {
        const escrow = escrowEvidence()
        const journals = await db.escrowWalletTransaction.findMany({
          where: { bountyPaymentId: { in: [legacy.id, modern.id] } }
        })
        const memberByHash = new Map([
          [prizeHash, [{
            id: String(legacy.id),
            leg: 'PRINCIPAL',
            address: legacyRow.recipientAddress,
            actualPiconeros: legacyRow.recipientReceivedPiconeros.toString()
          }]],
          ...journals.map(journal => [journal.txHash,
            expectedEscrowMembers(normalizePaymentClaims(journal.paymentClaims)).map(member => ({
              id: member.id,
              leg: member.leg,
              address: member.address,
              actualPiconeros: member.actual.toString()
            }))])
        ])
        escrow.paymentVerifications = [prizeHash, legacyRow.feeTxHash, modernRow.txHash].map(hash => {
          const journal = journals.find(row => row.txHash === hash)
          return completeProofVerification({
            hash,
            scope: { network: fixture.scope().network, walletAddress: address.BOUNTY_ESCROW },
            members: memberByHash.get(hash),
            role: 'ESCROW',
            journalId: journal == null ? null : String(journal.id),
            observedAt: '2026-10-06T12:00:00.000Z'
          })
        })
        return escrow
      }
      const covered = await buildManifest(escrowProofs)
      expect(covered.manifest.issues).toEqual([])
      expect(covered.manifest.operations).toEqual([])
      expect(covered.evidence).toEqual(covered.original) // the audit is pure

      // The attribution is genuinely exercised (final-review I1 round 3): the
      // same hashes "proved" by complete results paying 1 piconero to a
      // DIFFERENT recipient — and binding no recorded journal owner — name
      // every leg through the exact-membership and owner bindings.
      const bought = await buildManifest(async () => {
        const escrow = escrowEvidence()
        const journals = await db.escrowWalletTransaction.findMany({
          where: { bountyPaymentId: { in: [legacy.id, modern.id] } }
        })
        escrow.paymentVerifications = [prizeHash, legacyRow.feeTxHash, modernRow.txHash].map(hash => {
          const journal = journals.find(row => row.txHash === hash)
          return completeProofVerification({
            hash,
            scope: { network: fixture.scope().network, walletAddress: address.BOUNTY_ESCROW },
            members: [{ id: String(legacy.id), leg: 'PRINCIPAL', address: address.CURATOR_TWO, actualPiconeros: '1' }],
            role: 'ESCROW',
            journalId: journal == null ? null : String(journal.id),
            observedAt: '2026-10-06T12:00:00.000Z'
          })
        })
        return escrow
      })
      const boughtCodes = new Set(bought.manifest.issues.map(issue => issue.code))
      expect([...boughtCodes].every(code => code === 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH' ||
        code === 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toBe(true)
      const boughtHashes = new Set(bought.manifest.issues.map(issue => issue.txHash))
      expect([...boughtHashes].sort()).toEqual([legacyRow.feeTxHash, modernRow.txHash, prizeHash].sort())
      expect(bought.manifest.operations).toEqual([])

      // Drop the deferred FEE leg's history AND its proof: named row-first,
      // never silently accepted; the covered legs stay covered.
      const withoutFee = await buildManifest(async () => {
        const escrow = await escrowProofs()
        escrow.outgoing = escrow.outgoing.filter(entry => entry.txHash !== legacyRow.feeTxHash)
        escrow.paymentVerifications = escrow.paymentVerifications.filter(entry => entry.txHash !== legacyRow.feeTxHash)
        return escrow
      })
      expect(withoutFee.manifest.issues).toEqual([
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          table: 'BountyPayment',
          id: String(legacy.id),
          leg: 'FEE',
          txHash: legacyRow.feeTxHash
        })
      ])
      expect(withoutFee.manifest.operations).toEqual([]) // the recorded debit stays

      // Drop the modern PRINCIPAL leg the same way: named the same way.
      const withoutPrincipal = await buildManifest(async () => {
        const escrow = await escrowProofs()
        escrow.outgoing = escrow.outgoing.filter(entry => entry.txHash !== modernRow.txHash)
        escrow.paymentVerifications = escrow.paymentVerifications.filter(entry => entry.txHash !== modernRow.txHash)
        return escrow
      })
      expect(withoutPrincipal.manifest.issues).toEqual([
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
          table: 'BountyPayment',
          id: String(modern.id),
          leg: 'PRINCIPAL',
          txHash: modernRow.txHash
        })
      ])

      // The audit never mutates the recorded escrow contracts.
      const afterModern = await db.bountyPayment.findUnique({ where: { id: modern.id } })
      expect(afterModern).toMatchObject({
        state: 'SENT',
        txHash: modernRow.txHash,
        networkFeePiconeros: 40_000n,
        recipientReceivedPiconeros: modernRow.recipientReceivedPiconeros,
        feeReceivedPiconeros: modernRow.feeReceivedPiconeros
      })
      const afterLegacy = await db.bountyPayment.findUnique({ where: { id: legacy.id } })
      expect(afterLegacy).toMatchObject({
        state: 'SENT',
        txHash: prizeHash,
        feeTxHash: legacyRow.feeTxHash,
        feeSettlementNetworkFeePiconeros: 40_000n
      })
    })
  })
})
