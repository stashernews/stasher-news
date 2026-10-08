/* eslint-env jest */
import * as util from 'node:util'
import { PrismaClient } from '@prisma/client'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { alert } from '@/lib/alert'
import { logError, logWarn } from '@/lib/logger'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { loadPaymentProof } from '@/api/monero/paymentProofStore'
import {
  assertWalletScope,
  prepareWalletTransaction,
  reconcileWalletTransactions,
  relayWalletTransaction
} from '@/api/monero/rewardsTransactions'
import { paymentChainFixture, paymentFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'
import { decodeReceivingIdentity } from '@/api/monero/paymentClaims'
import { oneTimeOutputKey, senderPublicPart } from '@/api/monero/paymentKeyStructure'

// lib/alert and lib/logger are mocked (same pattern as
// test/worker/rewardsDistributor.test.js): operator pages are assertable
// without a network side effect, and every log call this module makes is
// captured so nothing sensitive can hide in pino output.
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Isolated real-DB tests for the rewards-wallet capture barrier (Finding #1,
// Task 6). Every payout batch, ops sweep and consolidation follows the same
// boundary: build(relay:false) -> durable journal+proof PAIR (atomic store) ->
// fresh pair authentication -> locked attempt CAS -> relayTx(the SAME object)
// -> RELAYED with direct-relay-observation provenance. Only a durable,
// authenticated pair authorizes the single attempt; an unknown preparation or
// claim acknowledgement prevents the broadcast; a relay exception keeps
// PREPARED+attempted. Attempted rows are resolved ONLY by a fresh CONFIRMED
// whole-payment verification from a dedicated audit session (fake audit
// wallet + fake daemon through the real collector/verifier seam) — never from
// destination-shaped wallet history.
//
// The wallet here is a fake; the database is the dedicated isolated one.
// Runs only when DATABASE_URL points at /stasher_rewards_repair_test (the
// isolated runner); skipped everywhere else so ordinary dev-DB collection
// neither crashes nor touches that database. Run ONLY via the guarded
// isolated runner.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// The closed diagnostic label set the module may emit. Duplicated here on
// purpose: if the module's label set ever changes, this suite fails loudly.
const ERROR_LABELS = ['timeout', 'connection', 'rpc', 'unknown']

// --- deterministic synthetic address/point helpers (throwaway, Task 1 style)
// Scalar space starts at 100 to stay clear of the shared fixture scalars.

const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')

const STAGENET_PRIMARY_PREFIX = 24
function encodeStagenetPrimaryAddress ({ spendKey, viewKey }) {
  const body = new Uint8Array(65)
  body[0] = STAGENET_PRIMARY_PREFIX
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}

const makeAddress = n => encodeStagenetPrimaryAddress({ spendKey: point(2n * BigInt(n)), viewKey: point(2n * BigInt(n) + 1n) })
// Little-endian secret-scalar hex (the SDK key-bundle string form).
const leHex = value => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex.padStart(64, '0'), 'hex').reverse().toString('hex')
}

;(ISOLATED_DB ? describe : describe.skip)('rewards wallet capture barrier (isolated DB only)', () => {
  // The Task 1 fixture's synthetic STAGENET payment: the fixture wallet
  // address is the scope, and the fixture transaction (hash f1…, fee 7,
  // destinations recipientA 40 + recipientB 20, change 33 at the primary) is
  // the canonical PAYOUT capture its chain fixture verifies COMPLETE.
  const base = paymentFixture()
  const SCOPE = base.scope
  const ADDRESS_A = base.members[0].address
  const ADDRESS_B = base.members[1].address
  const COLD = makeAddress(101)
  const HASH = base.txHash
  const OTHER_HASH = 'e9'.repeat(32)
  const SWEEP_HASH = 'e5'.repeat(32)
  const SWEEP_AUDIT_HASH = 'e7'.repeat(32)
  const CONSOLIDATION_HASH = 'e6'.repeat(32)

  // Synthetic throwaway TX-proof registry (never a real secret). The "lost
  // keys" registry holds a DIFFERENT current version, so envelopes sealed
  // with one provider cannot be opened with the other — the production
  // fail-closed path, exercised through real crypto.
  const keyProvider = createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
  })
  const lostKeyProvider = createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 2: Buffer.alloc(32, 9).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
  })

  let db
  let seededDistributionIds

  beforeAll(async () => {
    db = new PrismaClient()
    // Purge any residue from an interrupted earlier run of this suite (the
    // scope is owned by this suite). Proofs and owners leave TOGETHER.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } })
    ])
  })

  beforeEach(() => {
    seededDistributionIds = []
  })

  afterEach(async () => {
    jest.clearAllMocks()
    // Fixture-owned cleanup: the pair leaves in ONE transaction (proofs before
    // owners, the store's delete guard passes for a deliberate teardown),
    // then the seeded distribution/payout rows.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.rewardPayout.deleteMany({ where: { distributionId: { in: seededDistributionIds } } }),
      db.rewardDistribution.deleteMany({ where: { id: { in: seededDistributionIds } } })
    ])
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  // --- local helpers (R6: defined here, never shared test modules) -------------

  const makeWallet = (overrides = {}) => ({
    getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
    getNetworkType: jest.fn(async () => 2),
    relayTx: jest.fn(async tx => String(await tx.getHash()).toLowerCase()),
    ...overrides
  })

  // A complete capture-grade built transaction: hash, real fee, actual
  // post-subtraction destinations, change fields and the exact key bundle,
  // all through SDK-shaped getters (what the pair store reads). The built
  // key bundle lists one output key per chain vout: destinations plus the
  // change output (a populated changeAddress implies a change vout).
  // Real one-time-key arithmetic for one built tx: external vouts via the
  // sender path against the recipients' PUBLIC keys, the change vout via the
  // receiver a*R path against the hot wallet's own spend key (final-review
  // C1/I1/I2). The hot wallet is the fixture wallet (view secret 6).
  function builtTxKeys ({ destinations, changeAddress, keySeed }) {
    const decoded = destinations.map(d => decodeReceivingIdentity(d.address, 'STAGENET'))
    const slots = destinations.length + (changeAddress ? 1 : 0)
    const slotSecrets = Array.from({ length: slots }, (_, i) => keySeed + BigInt(i))
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
        secret: leHex(6n),
        publicSpend: point(5n),
        outputIndex: slots - 1
      }))
    }
    return {
      mainSecretHex: leHex(keySeed),
      additionalSecretHexes: slotSecrets.map(leHex),
      mainPublicKey: senderPublicPart(keySeed, null),
      additionalPublicKeys: slotPublics,
      outputKeys,
      additionalKeyCount: slots
    }
  }

  function makeBuiltTx ({ hash, fee, destinations, changeAddress = null, changeAmount = 0n, keySeed = 40n }) {
    const keys = builtTxKeys({ destinations, changeAddress, keySeed })
    return {
      getHash: () => hash,
      getFee: async () => fee,
      getOutgoingTransfer: () => ({
        getDestinations: () => destinations.map(destination => ({
          getAddress: () => destination.address,
          getAmount: () => destination.amount
        }))
      }),
      getChangeAddress: () => changeAddress,
      // Unavailable change is explicit null and pairs with a null address (C1).
      getChangeAmount: async () => (changeAddress === null ? null : changeAmount),
      // The SDK captures the SECRET-bundle STRING (final-review C1); populated
      // public facts ride the optional getters.
      getKey: () => keys.mainSecretHex + keys.additionalSecretHexes.join(''),
      getMainPublicKey: () => keys.mainPublicKey,
      getAdditionalPublicKeys: () => [...keys.additionalPublicKeys],
      getOutputKeys: () => [...keys.outputKeys]
    }
  }

  const fixturePayoutTx = (overrides = {}) => paymentTxFixture(overrides)

  const PAYOUT_METADATA = {
    payouts: [
      { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: '40' },
      { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: '20' }
    ]
  }

  const consolidationTx = (overrides = {}) => makeBuiltTx({
    hash: CONSOLIDATION_HASH,
    fee: 17n,
    destinations: [{ address: SCOPE.walletAddress, amount: 5n }],
    ...overrides
  })

  const sweepTx = (overrides = {}) => makeBuiltTx({
    hash: SWEEP_HASH,
    fee: 9n,
    destinations: [{ address: COLD, amount: 500n }],
    ...overrides
  })

  const preparePayout = (overrides = {}) => prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx: fixturePayoutTx(),
    kind: 'PAYOUT',
    accountIndex: 0,
    distributionId: null,
    principalPiconeros: 60n,
    metadata: PAYOUT_METADATA,
    keyProvider,
    ...overrides
  })

  const prepareConsolidation = (overrides = {}) => prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx: consolidationTx(),
    kind: 'CONSOLIDATION',
    accountIndex: 1,
    principalPiconeros: 0n,
    metadata: { selfTransfer: true, destination: SCOPE.walletAddress },
    keyProvider,
    ...overrides
  })

  const prepareSweep = (overrides = {}) => prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx: sweepTx(),
    kind: 'OPS_SWEEP',
    accountIndex: 0,
    principalPiconeros: 500n,
    metadata: { destination: COLD },
    keyProvider,
    ...overrides
  })

  // Seed real QUEUED payout rows for a distribution (FK-safe user), with its
  // ids registered for the suite cleanup.
  const seedQueuedPayouts = async members => {
    const [user] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    const distribution = await db.rewardDistribution.create({
      data: { periodStart: new Date(0), periodEnd: new Date(1), poolPiconeros: members.reduce((acc, m) => acc + m.piconeros, 0n) }
    })
    seededDistributionIds.push(distribution.id)
    const payouts = []
    for (const member of members) {
      payouts.push(await db.rewardPayout.create({
        data: {
          distributionId: distribution.id,
          curatorId: user.id,
          recipientAddress: member.address,
          piconeros: member.piconeros,
          state: 'QUEUED'
        }
      }))
    }
    return { user, distribution, payouts }
  }

  const markAttempted = id => db.rewardsWalletTransaction.update({ where: { id }, data: { relayAttemptedAt: new Date() } })
  const loadRow = id => db.rewardsWalletTransaction.findUnique({ where: { id } })

  // Wrap the real Prisma client so ONE matching model call fails (R6 pattern:
  // proxy only the injected fault; $transaction hands its callback a wrapped
  // client so in-transaction store writes hit the fault too). `match(prop,
  // args)` selects the faulted calls.
  const withFault = (match, impl) => {
    const wrapModel = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === 'create' || prop === 'updateMany' || prop === 'update') {
          const fn = Reflect.get(inner, prop, inner)
          return (...args) => (match(prop, args) ? impl(...args) : fn.apply(inner, args))
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    const wrap = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return (fn, options) => transactional.call(inner, client => fn(wrap(client)), options)
        }
        if (prop === 'paymentTransactionProof' || prop === 'rewardsWalletTransaction') {
          return wrapModel(Reflect.get(inner, prop, inner))
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return wrap(db)
  }

  const failProofInsert = () => withFault(
    prop => prop === 'create',
    async () => { throw new Error('PAYMENT_PROOF_TEST_PROOF_INSERT_FAILED') }
  )

  const failRelayedPersist = () => withFault(
    (prop, args) => prop === 'updateMany' && args?.[0]?.data?.state === 'RELAYED',
    async () => { throw new Error('journal db down') }
  )

  // An UNKNOWN preparation commit outcome: the pair transaction actually
  // commits, then the await throws as if the connection dropped. The throw
  // happens on the first transaction CALL (the preparation), never on the
  // mere typeof guard access.
  const withUnknownPrepareCommit = () => {
    let thrown = false
    return new Proxy(db, {
      get (inner, prop) {
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return (fn, options) => {
            if (thrown) return transactional.call(inner, fn, options)
            thrown = true
            return (async () => {
              await transactional.call(inner, fn, options)
              throw new Error('connection reset after commit')
            })()
          }
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
  }

  // One send-path drive per kind: capture (prepare) then barrier (relay) —
  // the same sequence relayBucketTx / consolidateFeeAccounts / sweepOpsEarmark
  // run in production. `models`/`keyProvider`/`relayKeyProvider` are
  // injectable per drive.
  const drive = {
    PAYOUT: ({ models = db, wallet = makeWallet(), keyProvider: keys = keyProvider, relayKeyProvider = keys } = {}) =>
      prepareWalletTransaction({
        models,
        wallet,
        scope: SCOPE,
        tx: fixturePayoutTx(),
        kind: 'PAYOUT',
        accountIndex: 0,
        distributionId: null,
        principalPiconeros: 60n,
        metadata: PAYOUT_METADATA,
        keyProvider: keys
      }).then(journal => relayWalletTransaction({ models, wallet, journal, tx: fixturePayoutTx(), keyProvider: relayKeyProvider })),
    OPS_SWEEP: ({ models = db, wallet = makeWallet(), keyProvider: keys = keyProvider, relayKeyProvider = keys } = {}) =>
      prepareWalletTransaction({
        models,
        wallet,
        scope: SCOPE,
        tx: sweepTx(),
        kind: 'OPS_SWEEP',
        accountIndex: 0,
        principalPiconeros: 500n,
        metadata: { destination: COLD },
        keyProvider: keys
      }).then(journal => relayWalletTransaction({ models, wallet, journal, tx: sweepTx(), keyProvider: relayKeyProvider })),
    CONSOLIDATION: ({ models = db, wallet = makeWallet(), keyProvider: keys = keyProvider, relayKeyProvider = keys } = {}) =>
      prepareWalletTransaction({
        models,
        wallet,
        scope: SCOPE,
        tx: consolidationTx(),
        kind: 'CONSOLIDATION',
        accountIndex: 1,
        principalPiconeros: 0n,
        metadata: { selfTransfer: true, destination: SCOPE.walletAddress },
        keyProvider: keys
      }).then(journal => relayWalletTransaction({ models, wallet, journal, tx: consolidationTx(), keyProvider: relayKeyProvider }))
  }

  // --- dedicated audit sessions (promotion tests) ------------------------------

  // PAYOUT promotion uses the Task 1 fixture's fake audit wallet + fake daemon
  // THROUGH the production audit-session builder: the real collector builds
  // the session from the fixture scan, and the real verifier gates the
  // captured pair against it (the fixture payment verifies COMPLETE by
  // construction).
  const payoutAudit = () => {
    const chain = paymentChainFixture()
    return { daemon: chain.daemon, auditWallet: chain.wallet }
  }

  test('pending recorded rewards candidate does not poison confirmed payout recovery', async () => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    const pending = 'b4'.repeat(32)
    await preparePayout({ tx: fixturePayoutTx({ txHash: pending }) })
    const { daemon, auditWallet } = payoutAudit()
    const original = daemon.getPaymentTransactions.getMockImplementation()
    daemon.getPaymentTransactions.mockImplementation(async hashes => {
      if (hashes.includes(pending)) { const err = new Error('synthetic pool refusal'); err.code = 'RAW_TX_IN_POOL'; throw err }
      return original(hashes)
    })
    await reconcileWithPayoutAudit({ daemon, auditWallet })
    expect((await loadRow(journal.id)).state).toBe('RELAYED')
  })

  test.each(['receipt', 'promotion'])('moving tip during rewards %s refuses or rolls back promotion', async phase => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    const { daemon, auditWallet } = payoutAudit()
    const height = await daemon.getHeight()
    let moved = false
    daemon.getHeight.mockImplementation(async () => height + (moved ? 1 : 0))
    const oldCheck = auditWallet.checkTxKey
    auditWallet.checkTxKey = async (...args) => {
      const receipt = await oldCheck(...args)
      if (phase === 'receipt') moved = true
      return receipt
    }
    const models = new Proxy(db, {
      get: (target, property) => property === '$transaction'
        ? (callback, options) => target.$transaction(client => callback(new Proxy(client, {
            get: (tx, key) => key === 'rewardsWalletTransaction'
              ? new Proxy(tx[key], {
                get: (model, method) => method === 'updateMany'
                  ? async (...args) => { const result = await model.updateMany(...args); if (phase === 'promotion') moved = true; return result }
                  : model[method]
              })
              : tx[key]
          })), options)
        : target[property]
    })
    const result = await reconcileWithPayoutAudit({ models, daemon, auditWallet })
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
    expect(result.uncertainPayoutIds.sort()).toEqual([11, 12])
  })

  test('runtime rewards requests audited payout hash with no owned payment outputs', async () => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    const chain = paymentChainFixture()
    const rows = await chain.wallet.getOutputs()
    chain.wallet.getOutputs.mockResolvedValue(rows.filter(row => row.getTx().getHash() !== journal.txHash))
    chain.session.rawByHash[journal.txHash].voutKeys[1] = point(1400n)
    await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, daemon: chain.daemon, auditWallet: chain.wallet, keyProvider })
    expect(chain.daemon.getPaymentTransactions.mock.calls.flatMap(([hashes]) => hashes)).toContain(journal.txHash)
  })

  const reconcileWithPayoutAudit = (overrides = {}) => {
    const { daemon, auditWallet } = payoutAudit()
    return reconcileWalletTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon, auditWallet, keyProvider, ...overrides
    })
  }

  test('derives recorded unexposed account-0 minor before runtime rewards scan', async () => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    const { daemon, auditWallet } = payoutAudit()
    const minorAddress = makeAddress(401)
    let derived = false
    const oldAddress = auditWallet.getAddress
    auditWallet.getAddress = async (major, minor) => major === 0 && minor === 1
      ? (derived ? minorAddress : undefined)
      : oldAddress(major, minor)
    auditWallet.getSubaddresses = async major => Array.from({ length: major === 0 && derived ? 2 : 1 }, (_, minor) => ({ getAddress: () => major === 0 && minor === 1 ? minorAddress : null }))
    auditWallet.createSubaddress = async major => { if (major === 0) derived = true }
    const oldOutputs = auditWallet.getOutputs
    auditWallet.getOutputs = async () => {
      expect(derived).toBe(true)
      return oldOutputs()
    }
    const models = new Proxy(db, {
      get: (target, property) => property === 'subaddressIndex'
        ? { findMany: async () => [{ majorIndex: 0, minorIndex: 1, address: minorAddress }] }
        : target[property]
    })
    const result = await reconcileWithPayoutAudit({ models, daemon, auditWallet })
    expect(derived).toBe(true)
    expect(result.uncertainPayoutIds).toEqual([])
    expect((await loadRow(journal.id)).state).toBe('RELAYED')
  })

  // The local audit chain for single-destination payments (OPS_SWEEP) and
  // single-owned-target self transfers (CONSOLIDATION): a fake audit wallet
  // + fake daemon whose raw records mirror the built key bundle byte for
  // byte, with one owned coinbase source and exact confirmed receipts. The
  // production builder runs the REAL collector over it.
  const LOCAL_TIP = { height: 2999999, blockHash: 'cd'.repeat(32) }
  const LOCAL_SOURCE_HASH = 'e1'.repeat(32)

  function localAuditChain ({ hash, fee, sourceAmount, sourceAccountIndex, keys, receipts, ownedOutputs }) {
    const auditedHeight = LOCAL_TIP.height - 19 // 20 confirmations
    const sourceHeight = LOCAL_TIP.height - 999 // 1000 confirmations
    const audited = {
      txHash: hash,
      feePiconeros: fee,
      inputKeyImages: [point(70n)],
      voutKeys: keys.outputKeys,
      outputIndices: keys.outputKeys.map((_, index) => 900 + index),
      blockHeight: auditedHeight,
      blockHash: LOCAL_TIP.blockHash,
      confirmations: 20,
      inTxPool: false,
      isCoinbase: false,
      mainPublicKey: keys.mainPublicKey,
      additionalPublicKeys: [...keys.additionalPublicKeys]
    }
    // The coinbase source output is wallet-owned: derive it on the receiver
    // a*R path under its own main tx key (final-review I2 enumeration). A
    // source at account 1 is owned at (1,0) — that position's spend key is
    // wallet-owned by construction of the prepared domain (makeAddress(301)).
    const sourceMainKey = senderPublicPart(70n, null)
    const sourcePositionSpend = point(sourceAccountIndex === 0 ? 5n : 2n * 301n)
    const sourceVout = oneTimeOutputKey({
      publicKey: sourceMainKey,
      secret: leHex(6n),
      publicSpend: sourcePositionSpend,
      outputIndex: 0
    })
    const source = {
      txHash: LOCAL_SOURCE_HASH,
      feePiconeros: 0n,
      inputKeyImages: [],
      voutKeys: [sourceVout],
      outputIndices: [700],
      blockHeight: sourceHeight,
      blockHash: LOCAL_TIP.blockHash,
      confirmations: 1000,
      inTxPool: false,
      isCoinbase: true,
      mainPublicKey: sourceMainKey,
      additionalPublicKeys: []
    }
    const sourceRow = {
      txHash: LOCAL_SOURCE_HASH,
      accountIndex: sourceAccountIndex,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: sourceHeight,
      globalIndex: 700,
      amountPiconeros: sourceAmount,
      stealthPublicKey: sourceVout,
      keyImage: point(70n),
      isSpent: true
    }
    const wallet = {
      getOutputs: jest.fn(async () => [
        ...ownedOutputs,
        {
          getTx: () => ({ getHash: () => sourceRow.txHash, getHeight: () => sourceRow.blockHeight }),
          getAccountIndex: () => sourceRow.accountIndex,
          getSubaddressIndex: () => sourceRow.subaddressIndex,
          getIndex: () => sourceRow.globalIndex,
          getAmount: () => sourceRow.amountPiconeros,
          getStealthPublicKey: () => sourceRow.stealthPublicKey,
          getKeyImage: () => ({ getHex: () => sourceRow.keyImage }),
          getIsSpent: () => true
        }
      ]),
      getAccounts: jest.fn(async () => [0, 1, 2, 3, 4, 5].map(index => ({ getIndex: () => index }))),
      getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
      getNetworkType: jest.fn(async () => 2),
      // Raw-ownership enumeration seams (final-review I2): ephemeral view
      // access (the fixture wallet's view secret 6) plus the derived address
      // per domain position (the scope primary at (0,0), makeAddress(301)
      // for the fee-account primaries).
      getPrivateViewKey: jest.fn(async () => leHex(6n)),
      getAddress: jest.fn(async (majorIndex, minorIndex) =>
        majorIndex === 0 && minorIndex === 0 ? SCOPE.walletAddress : makeAddress(301)),
      checkTxKey: jest.fn(async (_hash, _bundle, address) => {
        const receipt = receipts.get(address)
        if (!receipt) return null
        return {
          getIsGood: () => true,
          getReceivedAmount: () => receipt.amount,
          getInTxPool: () => false,
          getNumConfirmations: () => receipt.confirmations
        }
      }),
      getHeight: jest.fn(async () => LOCAL_TIP.height + 1)
    }
    const rawByHash = { [hash]: audited, [LOCAL_SOURCE_HASH]: source }
    const daemon = {
      getPaymentTransactions: jest.fn(async hashes => (Array.isArray(hashes) ? hashes : []).map(h => rawByHash[h]).filter(Boolean)),
      getHeight: jest.fn(async () => LOCAL_TIP.height + 1),
      getBlockHashByHeight: jest.fn(async () => LOCAL_TIP.blockHash)
    }
    return { wallet, daemon }
  }

  // OPS_SWEEP audit: one external COLD receipt of 500, an owned 15-piconero
  // change output back to the account-0 primary (the scan row that lets the
  // collector fetch the audited raw), fee 9, D = 524 from an account-0
  // coinbase source. Prepares the exact matching pair itself.
  const sweepAudit = async () => {
    const tx = sweepTx({ hash: SWEEP_AUDIT_HASH, changeAddress: SCOPE.walletAddress, changeAmount: 15n })
    const journal = await prepareWalletTransaction({
      models: db,
      wallet: makeWallet(),
      scope: SCOPE,
      tx,
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      principalPiconeros: 500n,
      metadata: { destination: COLD },
      keyProvider
    })
    const keys = {
      mainPublicKey: tx.getMainPublicKey(),
      additionalPublicKeys: tx.getAdditionalPublicKeys(),
      outputKeys: tx.getOutputKeys()
    }
    const changeOutput = {
      getTx: () => ({ getHash: () => SWEEP_AUDIT_HASH, getHeight: () => LOCAL_TIP.height - 19 }),
      getAccountIndex: () => 0,
      getSubaddressIndex: () => 0,
      getIndex: () => 901,
      getAmount: () => 15n,
      getStealthPublicKey: () => keys.outputKeys[1],
      getKeyImage: () => null,
      getIsSpent: () => false
    }
    const { wallet, daemon } = localAuditChain({
      hash: SWEEP_AUDIT_HASH,
      fee: 9n,
      sourceAmount: 524n,
      sourceAccountIndex: 0,
      keys,
      receipts: new Map([[COLD, { amount: 500n, confirmations: 20 }]]),
      ownedOutputs: [changeOutput]
    })
    return { journal, wallet, daemon }
  }

  const reconcileWithSweepAudit = async ({ journal, wallet, daemon, attempt = false }) => {
    if (attempt) await markAttempted(journal.id)
    const result = await reconcileWalletTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon, auditWallet: wallet, keyProvider
    })
    return { journal, result }
  }
  // CONSOLIDATION audit: an 8-piconero owned self transfer back to the
  // primary address of account 1, fee 4, D = 12 from an account-1 coinbase
  // source, the audited output scan-owned at (1, 0) — exactly the captured
  // owned target. Prepares the exact matching pair itself.
  const consolidationAudit = async () => {
    const tx = consolidationTx({ fee: 4n, destinations: [{ address: SCOPE.walletAddress, amount: 8n }], keySeed: 55n })
    const journal = await prepareWalletTransaction({
      models: db,
      wallet: makeWallet(),
      scope: SCOPE,
      tx,
      kind: 'CONSOLIDATION',
      accountIndex: 1,
      principalPiconeros: 0n,
      metadata: { selfTransfer: true, destination: SCOPE.walletAddress },
      keyProvider
    })
    const keys = {
      mainPublicKey: tx.getMainPublicKey(),
      additionalPublicKeys: tx.getAdditionalPublicKeys(),
      outputKeys: tx.getOutputKeys()
    }
    // The consolidation pays the wallet primary: the owned output sits at the
    // DESTINATION's derived position (0,0) — final-review I6 (the captured
    // owned target binds there, and the sender/receiver paths agree on the
    // one-time key for a self-payment).
    const ownedOutput = {
      getTx: () => ({ getHash: () => CONSOLIDATION_HASH, getHeight: () => LOCAL_TIP.height - 19 }),
      getAccountIndex: () => 0,
      getSubaddressIndex: () => 0,
      getIndex: () => 900,
      getAmount: () => 8n,
      getStealthPublicKey: () => keys.outputKeys[0],
      getKeyImage: () => null,
      getIsSpent: () => false
    }
    const { wallet, daemon } = localAuditChain({
      hash: CONSOLIDATION_HASH,
      fee: 4n,
      sourceAmount: 12n,
      sourceAccountIndex: 1,
      keys,
      receipts: new Map(),
      ownedOutputs: [ownedOutput]
    })
    return { journal, wallet, daemon }
  }

  const reconcileWithConsolidationAudit = async ({ journal, wallet, daemon, attempt = false }) => {
    if (attempt) await markAttempted(journal.id)
    const result = await reconcileWalletTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon, auditWallet: wallet, keyProvider
    })
    return { journal, result }
  }

  // --- the capture barrier (PAYOUT / OPS_SWEEP / CONSOLIDATION) ----------------

  test('PAYOUT: pair visible from another committed DB read before relayTx; the SAME object relays exactly once', async () => {
    const wallet = makeWallet()
    const tx = fixturePayoutTx()
    const journal = await preparePayout({ wallet, tx })
    expect(journal.state).toBe('PREPARED')
    expect(journal.dispatchId).not.toBeNull()
    expect(journal.claimDigest).not.toBeNull()

    // The pinned barrier probe (from the approved plan, verbatim): inside
    // relayTx the acknowledged attempt is durably visible to a fresh
    // committed pair read, and the inventory binding matches the journal.
    wallet.relayTx.mockImplementation(async object => {
      expect(object).toBe(tx)
      const pair = await loadPaymentProof({ models: db, journalRole: 'REWARDS', journalId: journal.id, keyProvider })
      expect(pair.journal.relayAttemptedAt).not.toBeNull()
      expect(pair.inventory.claimDigest).toBe(pair.journal.claimDigest)
      return pair.journal.txHash
    })

    const sent = await relayWalletTransaction({ models: db, wallet, journal, tx, keyProvider })
    expect(sent).toMatchObject({ relayed: true, uncertain: false, accountingUnpersisted: 0, txHash: HASH })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(wallet.relayTx).toHaveBeenCalledWith(tx)

    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayAttemptedAt).not.toBeNull()
    expect(stored.relayedAt).not.toBeNull()
    expect(stored.relayProvenance).toBe('direct-relay-observation')
    expect(stored.networkFeePiconeros).toBe(7n)
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: a complete pair is required before any relay, and the same object is relayed once', async kind => {
    const wallet = makeWallet()
    const driveResult = await drive[kind]({ wallet })
    expect(driveResult.relayed).toBe(true)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)

    // The second drive of the same dispatch cannot exist: preparation returns
    // the RELAYED pair and the attempt CAS refuses a second claim.
    await expect(drive[kind]({ wallet: makeWallet() })).rejects.toThrow(/attempt|PAYMENT_PROOF/i)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: a pre-commit preparation failure relays nothing; the second drive relays once', async kind => {
    const models = failProofInsert()
    const wallet = makeWallet()
    // The pair never landed: the dispatch is withheld, nothing was broadcast.
    await expect(drive[kind]({ models, wallet })).rejects.toThrow(/PAYMENT_PROOF_TEST_PROOF_INSERT_FAILED/)
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(0)

    // Second drive: fresh preparation lands the pair and relays exactly once.
    const result = await drive[kind]({ wallet })
    expect(result.relayed).toBe(true)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: an unknown preparation commit relays nothing; a fresh pair read re-authorizes the same drive', async kind => {
    const wallet = makeWallet()
    // The pair COMMITS, then the await throws — the caller must not treat the
    // throw as "no journal exists" and must not broadcast.
    await expect(drive[kind]({ models: withUnknownPrepareCommit(), wallet })).rejects.toThrow(/connection reset after commit/)
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(1)

    // Second drive: the fresh idempotent preparation re-reads the durable
    // pair and re-authorizes the attempt — still exactly one relay.
    const result = await drive[kind]({ wallet })
    expect(result.relayed).toBe(true)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: an unavailable proof key stops the FRESH relay while the pair stays unattempted', async kind => {
    const wallet = makeWallet()
    // Prepare with the good registry, then relay-authenticate with the WRONG
    // registry: the pair cannot be opened, so the attempt never happens.
    await expect(drive[kind]({ wallet, relayKeyProvider: lostKeyProvider })).rejects.toThrow(/TXPROOF|PAYMENT_PROOF/i)
    expect(wallet.relayTx).not.toHaveBeenCalled()

    const rows = await db.rewardsWalletTransaction.findMany({ where: { walletAddress: SCOPE.walletAddress } })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('PREPARED')
    expect(rows[0].relayAttemptedAt).toBeNull()

    // Second drive with the right key: exactly one relay.
    const result = await drive[kind]({ wallet })
    expect(result.relayed).toBe(true)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: an attempt CAS conflict blocks the relay and stays withheld on the second drive', async kind => {
    const journal = await { PAYOUT: preparePayout, OPS_SWEEP: prepareSweep, CONSOLIDATION: prepareConsolidation }[kind]()
    await markAttempted(journal.id)
    const wallet = makeWallet()

    await expect(drive[kind]({ wallet })).rejects.toThrow(/attempt|PAYMENT_PROOF/i)
    expect(wallet.relayTx).not.toHaveBeenCalled()

    // A second drive performs NO new relay: uncertainty is retained.
    await expect(drive[kind]({ wallet: makeWallet() })).rejects.toThrow(/attempt|PAYMENT_PROOF/i)
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: a transport timeout keeps PREPARED+attempted and never re-relays', async kind => {
    const journal = await { PAYOUT: preparePayout, OPS_SWEEP: prepareSweep, CONSOLIDATION: prepareConsolidation }[kind]()
    const wallet = makeWallet({ relayTx: jest.fn(async () => { throw new Error('timeout after submission') }) })

    const result = await relayWalletTransaction({ models: db, wallet, journal, tx: { PAYOUT: fixturePayoutTx, OPS_SWEEP: sweepTx, CONSOLIDATION: consolidationTx }[kind](), keyProvider })
    expect(result).toMatchObject({ relayed: false, uncertain: true, accountingUnpersisted: 0 })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)

    await expect(relayWalletTransaction({ models: db, wallet, journal, tx: { PAYOUT: fixturePayoutTx, OPS_SWEEP: sweepTx, CONSOLIDATION: consolidationTx }[kind](), keyProvider }))
      .rejects.toThrow(/attempt|PAYMENT_PROOF/i)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)

    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()
    expect(stored.relayedAt).toBeNull()
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: a relay whose RELAYED-state persist fails stays resumable without a second relay', async kind => {
    const journal = await { PAYOUT: preparePayout, OPS_SWEEP: prepareSweep, CONSOLIDATION: prepareConsolidation }[kind]()
    const models = failRelayedPersist()
    const wallet = makeWallet()

    const sent = await relayWalletTransaction({ models, wallet, journal, tx: { PAYOUT: fixturePayoutTx, OPS_SWEEP: sweepTx, CONSOLIDATION: consolidationTx }[kind](), keyProvider })
    expect(sent).toMatchObject({ relayed: true, uncertain: false, accountingUnpersisted: 1 })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect((await loadRow(journal.id)).state).toBe('PREPARED')

    // The second drive must NOT relay again; reconciliation (durable or fresh)
    // resolves the state instead.
    await expect(relayWalletTransaction({ models: db, wallet: makeWallet(), journal, tx: { PAYOUT: fixturePayoutTx, OPS_SWEEP: sweepTx, CONSOLIDATION: consolidationTx }[kind](), keyProvider }))
      .rejects.toThrow(/attempt|PAYMENT_PROOF/i)
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
  })

  // --- preparation refusals -----------------------------------------------------

  test.each([
    ['missing', { getHash: () => HASH, getFee: async () => null }, /unknown money value|money|fee/i],
    ['unsafe', makeBuiltTx({ hash: HASH, fee: 2 ** 53, destinations: [{ address: ADDRESS_A, amount: 40n }] }), /unsafe/i],
    ['negative', makeBuiltTx({ hash: HASH, fee: -1n, destinations: [{ address: ADDRESS_A, amount: 40n }] }), /PAYMENT_PROOF_TX_INVALID/]
  ])('refuses a %s network fee before any journal write', async (_label, tx, pattern) => {
    await expect(preparePayout({ tx })).rejects.toThrow(pattern)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(0)
  })

  test.each([
    ['missing', null],
    ['invalid', 'zz'.repeat(32)]
  ])('refuses a %s transaction hash', async (_label, hash) => {
    await expect(preparePayout({ tx: fixturePayoutTx({ txHash: hash }) })).rejects.toThrow(/PAYMENT_PROOF_TX_INVALID/)
  })

  test('normalizes the transaction hash to lowercase', async () => {
    const a = await prepareConsolidation({ tx: consolidationTx({ hash: CONSOLIDATION_HASH.toUpperCase() }) })
    expect(a.txHash).toBe(CONSOLIDATION_HASH)
    expect((await loadRow(a.id)).txHash).toBe(CONSOLIDATION_HASH)
  })

  test('conflicting immutable facts for one hash are refused by the store', async () => {
    await preparePayout()
    await expect(preparePayout({ accountIndex: 1 })).rejects.toThrow(/conflict|PAYMENT_PROOF/i)
    await expect(preparePayout({
      principalPiconeros: 74n,
      metadata: { payouts: [{ payoutId: 11, recipientAddress: ADDRESS_A, piconeros: '74' }] }
    })).rejects.toThrow(/conflict|PAYMENT_PROOF/i)
    expect(await db.rewardsWalletTransaction.count({ where: { txHash: HASH, walletAddress: SCOPE.walletAddress } })).toBe(1)
  })

  test('metadata is a validated closed union', async () => {
    await expect(prepareConsolidation({ principalPiconeros: 1n })).rejects.toThrow(/principal/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: false, destination: SCOPE.walletAddress } })).rejects.toThrow(/self/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: true, destination: makeAddress(110) } })).rejects.toThrow(/primary/i)
    await expect(prepareConsolidation({ metadata: { selfTransfer: true, destination: SCOPE.walletAddress, extra: 1 } })).rejects.toThrow(/metadata/i)
    await expect(preparePayout({ principalPiconeros: 74n })).rejects.toThrow(/principal|conflict|PAYMENT_PROOF/i)
    await expect(preparePayout({
      metadata: { payouts: [{ payoutId: 11, recipientAddress: ADDRESS_A, piconeros: '75', extra: true }] }
    })).rejects.toThrow(/metadata/i)
    await expect(preparePayout({
      metadata: { payouts: [{ payoutId: 4, recipientAddress: ADDRESS_A, piconeros: '30' }, { payoutId: 4, recipientAddress: ADDRESS_B, piconeros: '45' }] }
    })).rejects.toThrow(/duplicate|conflict|PAYMENT_PROOF/i)
    await expect(prepareSweep({ metadata: { destination: '' } })).rejects.toThrow(/metadata|destination|PAYMENT_PROOF/i)
    await expect(prepareSweep({ metadata: { destination: COLD, extra: true } })).rejects.toThrow(/metadata/i)
    // A consolidation that pays an external address is refused by the capture
    // store (never journalized, never relayed).
    await expect(prepareConsolidation({
      tx: consolidationTx({ destinations: [{ address: makeAddress(111), amount: 5n }] })
    })).rejects.toThrow(/conflict|PAYMENT_PROOF/i)
  })

  test('payout metadata is normalized to exact decimal strings and stored canonically', async () => {
    const a = await preparePayout({
      metadata: {
        payouts: [
          { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: 20n },
          { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n }
        ]
      }
    })
    expect((await loadRow(a.id)).metadata).toEqual(PAYOUT_METADATA)
    // The same facts in another member order are still the same immutable row.
    const b = await preparePayout()
    expect(b.id).toBe(a.id)
  })

  test('a differing distribution binding conflicts for one hash', async () => {
    const { distribution, payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const tx = fixturePayoutTx()
    const metadata = {
      payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
    }
    const a = await preparePayout({ tx, distributionId: distribution.id, metadata })
    expect(a.distributionId).toBe(distribution.id)
    await expect(preparePayout({ tx, distributionId: null, metadata })).rejects.toThrow(/conflict|PAYMENT_PROOF/i)
  })

  test('a PAYOUT owner whose named participants are not QUEUED rows of the distribution is refused', async () => {
    const { distribution, payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    await db.rewardPayout.update({ where: { id: payouts[0].id }, data: { state: 'SENT' } })
    await expect(preparePayout({
      distributionId: distribution.id,
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })).rejects.toThrow(/conflict|PAYMENT_PROOF/i)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(0)
  })

  // --- reconciliation: fresh confirmed verification promotion -------------------

  test('an attempted PAYOUT row is promoted ONLY by a fresh complete verification, with chain-proof provenance and the observation time', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const journal = await preparePayout({
      distributionId: null,
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })
    await markAttempted(journal.id)
    const before = new Date()
    const result = await reconcileWithPayoutAudit()
    const after = new Date()

    expect(result.uncertainPayoutIds).toEqual([])
    expect(result.uncertainSweep).toBe(false)
    expect(result.recoveredPayoutIds.map(recovery => recovery.id).sort((a, b) => a - b)).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayProvenance).toBe('chain-proof-observation')
    expect(stored.relayedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(stored.relayedAt.getTime()).toBeLessThanOrEqual(after.getTime())

    // The in-pass promotion flows into the durable participant recovery.
    for (const payout of payouts) {
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'SENT', txHash: HASH })
    }

    // A second pass is idempotent and never re-relays anything.
    const again = await reconcileWithPayoutAudit()
    expect(again).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
  })

  test('an attempted OPS_SWEEP row is promoted by a fresh complete verification and stops blocking sweeps', async () => {
    const prepared = await sweepAudit()
    await markAttempted(prepared.journal.id)

    // Until a fresh verification resolves the attempt, sweeping stays blocked.
    const blocked = await reconcileWithPayoutAudit()
    expect(blocked.uncertainSweep).toBe(true)
    expect((await loadRow(prepared.journal.id)).state).toBe('PREPARED')

    const { journal, result } = await reconcileWithSweepAudit(prepared)
    expect(result.uncertainSweep).toBe(false)
    expect(result.accountingUnpersisted).toBe(0)
    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayProvenance).toBe('chain-proof-observation')
  })

  test('an attempted CONSOLIDATION row is promoted by a fresh complete verification', async () => {
    const prepared = await consolidationAudit()
    const { journal, result } = await reconcileWithConsolidationAudit({ ...prepared, attempt: true })
    expect(result.uncertainSweep).toBe(false)
    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayProvenance).toBe('chain-proof-observation')
    expect(stored.relayedAt).not.toBeNull()
  })

  test('a fresh verification that is not COMPLETE retains uncertainty (hidden extra residual)', async () => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    // The same captured payment scanned with an 11-piconero hidden extra
    // output: D != O + F + E — a material contradiction, never a promotion.
    const chain = paymentChainFixture({ ownedAmount: 22n })
    const result = await reconcileWalletTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon: chain.daemon, auditWallet: chain.wallet, keyProvider
    })
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
    expect(result.uncertainPayoutIds.sort()).toEqual([11, 12])
  })

  test('a hash unknown to the fresh audit chain retains uncertainty', async () => {
    const journal = await preparePayout({ tx: fixturePayoutTx({ txHash: OTHER_HASH }) })
    await markAttempted(journal.id)
    const result = await reconcileWithPayoutAudit()
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
    expect(result.uncertainPayoutIds.sort()).toEqual([11, 12])
    expect(result.uncertainSweep).toBe(false)
  })

  test('an unavailable audit session retains uncertainty for every attempted row (fail closed)', async () => {
    const payout = await preparePayout()
    await markAttempted(payout.id)
    const sweep = await prepareSweep()
    await markAttempted(sweep.id)

    // No injected audit wallet and no configured platform keys: the dedicated
    // genesis audit wallet cannot be opened, so nothing is promoted.
    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result.uncertainSweep).toBe(true)
    expect(result.uncertainPayoutIds.sort()).toEqual([11, 12])
    expect((await loadRow(payout.id)).state).toBe('PREPARED')
    expect((await loadRow(sweep.id)).state).toBe('PREPARED')
  })

  test('lost proof keys retain uncertainty (PROOF_KEY_UNAVAILABLE is not a promotion)', async () => {
    const journal = await preparePayout()
    await markAttempted(journal.id)
    const { daemon, auditWallet } = payoutAudit()
    const result = await reconcileWalletTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon, auditWallet, keyProvider: lostKeyProvider
    })
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
    expect(result.uncertainPayoutIds.sort()).toEqual([11, 12])
  })

  test('an attempted row whose fresh verification cannot exactly match the row stays uncertain', async () => {
    // The sweep pair authenticates, but the payout-shaped audit chain cannot
    // complete it (no raw record for its hash under the fixture session) and
    // an OPS_SWEEP promoted against a session for a different kind would fail
    // the exact participant match — both outcomes retain uncertainty.
    const sweep = await prepareSweep()
    await markAttempted(sweep.id)
    const result = await reconcileWithPayoutAudit()
    expect((await loadRow(sweep.id)).state).toBe('PREPARED')
    expect(result.uncertainSweep).toBe(true)
  })

  test('a fresh verification whose journal persist fails is reported, then recovered', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const journal = await preparePayout({
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })
    await markAttempted(journal.id)
    const models = failRelayedPersist()
    const { daemon, auditWallet } = payoutAudit()

    const result = await reconcileWalletTransactions({
      models, wallet: makeWallet(), scope: SCOPE, daemon, auditWallet, keyProvider
    })
    expect(result).toMatchObject({ uncertainSweep: false, accountingUnpersisted: 1 })
    expect(result.uncertainPayoutIds.sort()).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    expect((await loadRow(journal.id)).state).toBe('PREPARED')
    expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining(HASH))

    const recovered = await reconcileWithPayoutAudit()
    expect(recovered.accountingUnpersisted).toBe(0)
    expect((await loadRow(journal.id)).state).toBe('RELAYED')
  })

  // --- durable-but-unattempted pairs: reserved from rebuilding (Finding #1) -----

  test('an unattempted captured pair reserves its payouts from rebuilding and alerts operators with a stable per-hash dedupeKey', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const journal = await preparePayout({
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })
    // Unattempted: the prepare→claim window was interrupted. The pair is
    // provably unbroadcast, yet its payouts stay reserved.
    const result = await reconcileWithPayoutAudit()
    expect(result.uncertainPayoutIds.sort()).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    const dedupeKey = `rewards-pair-unattempted-${HASH}`
    expect(alert).toHaveBeenCalledWith('critical', 'Rewards wallet pair reserved (durable but unattempted)',
      expect.stringContaining(HASH), expect.objectContaining({ dedupeKey }))
    // The pair itself is untouched: PREPARED, never attempted.
    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).toBeNull()
    // The reserved alert key is STABLE across passes (the alert transport
    // dedupes on it — one operator page per stale hash).
    await reconcileWithPayoutAudit()
    const reservedAlerts = alert.mock.calls.filter(call => call[3]?.dedupeKey === dedupeKey)
    expect(reservedAlerts).toHaveLength(2)
    expect(reservedAlerts[0][3].dedupeKey).toBe(reservedAlerts[1][3].dedupeKey)

    // Operator-style verified teardown (proof-then-owner in ONE transaction):
    // the reservation lifts and the members become sendable again.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournalId: journal.id } }),
      db.rewardsWalletTransaction.deleteMany({ where: { id: journal.id } })
    ])
    const after = await reconcileWithPayoutAudit()
    expect(after.uncertainPayoutIds).toEqual([])
    // A fresh drive rebuilds freely under a NEW pair and relays exactly once.
    const sent = await drive.PAYOUT()
    expect(sent.relayed).toBe(true)
    const reservedAfterRebuild = alert.mock.calls.filter(call => call[3]?.dedupeKey === dedupeKey)
    expect(reservedAfterRebuild).toHaveLength(2) // no new reservation alert
  })

  test('an unattempted captured OPS_SWEEP pair blocks sweeping until operator resolution', async () => {
    const journal = await prepareSweep()
    const result = await reconcileWithPayoutAudit()
    expect(result.uncertainSweep).toBe(true)
    expect(alert).toHaveBeenCalledWith('critical', 'Rewards wallet pair reserved (durable but unattempted)',
      expect.stringContaining(SWEEP_HASH), expect.objectContaining({ dedupeKey: `rewards-pair-unattempted-${SWEEP_HASH}` }))
    expect((await loadRow(journal.id)).state).toBe('PREPARED')

    // Verified teardown lifts the block without any relay.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournalId: journal.id } }),
      db.rewardsWalletTransaction.deleteMany({ where: { id: journal.id } })
    ])
    const after = await reconcileWithPayoutAudit()
    expect(after.uncertainSweep).toBe(false)
  })

  test('a normal drive whose pair is claimed and relayed never trips the stale-pair alert', async () => {
    await drive.PAYOUT()
    const result = await reconcileWithPayoutAudit()
    expect(result.uncertainPayoutIds).toEqual([])
    expect(result.uncertainSweep).toBe(false)
    expect(alert.mock.calls.some(call => String(call[3]?.dedupeKey ?? '').startsWith('rewards-pair-unattempted-'))).toBe(false)
  })

  // --- durable RELAYED participant recovery (DB-only, unchanged semantics) ------

  test('a durable RELAYED payout proof recovers a QUEUED member without any history read or proof key', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const journal = await preparePayout({
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })
    const tx = fixturePayoutTx()
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet(), journal, tx, keyProvider })
    expect(sent.relayed).toBe(true)
    for (const payout of payouts) {
      expect((await db.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
    }

    // The durable recovery is DB-only: no audit session is available (nothing
    // injected, no platform keys) and the recorded delivery still settles.
    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result).toEqual({
      uncertainPayoutIds: [],
      recoveredPayoutIds: payouts.map(p => ({ id: p.id, txHash: HASH })).sort((a, b) => a.id - b.id),
      uncertainSweep: false,
      accountingUnpersisted: 0
    })
    for (const payout of payouts) {
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'SENT', txHash: HASH })
    }

    // A second reconciliation is idempotent (nothing recovered again).
    const again = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(again).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
  })

  test('a durable RELAYED proof that disagrees with the live payout is withheld with an alert', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 75n }])
    const journal = await preparePayout({
      principalPiconeros: 74n,
      tx: makeBuiltTx({ hash: HASH, fee: 7n, destinations: [{ address: ADDRESS_A, amount: 74n }] }),
      metadata: { payouts: [{ payoutId: payouts[0].id, recipientAddress: ADDRESS_A, piconeros: '74' }] }
    })
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet(), journal, tx: makeBuiltTx({ hash: HASH, fee: 7n, destinations: [{ address: ADDRESS_A, amount: 74n }] }), keyProvider })
    expect(sent.relayed).toBe(true)

    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result.uncertainPayoutIds).toEqual([payouts[0].id])
    expect(result.recoveredPayoutIds).toEqual([])
    expect((await db.rewardPayout.findUnique({ where: { id: payouts[0].id } }))).toMatchObject({ state: 'QUEUED', txHash: null })
    expect(alert).toHaveBeenCalledWith('critical', 'rewards payout journal proof unresolved',
      expect.stringContaining(String(payouts[0].id)), expect.anything())
  })

  test('an in-pass PREPARED promotion immediately recovers its live members', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const journal = await preparePayout({
      metadata: {
        payouts: payouts.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
      }
    })
    await markAttempted(journal.id)
    const result = await reconcileWithPayoutAudit()
    expect((await loadRow(journal.id)).state).toBe('RELAYED')
    expect(result.recoveredPayoutIds.map(recovery => recovery.id).sort((a, b) => a - b)).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    expect(result.uncertainPayoutIds).toEqual([])
    for (const payout of payouts) {
      expect(await db.rewardPayout.findUnique({ where: { id: payout.id } })).toMatchObject({ state: 'SENT', txHash: HASH })
    }
  })

  test('an attempted conflicting second proof stays uncertain while the durable first proof recovers its member', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }, { address: ADDRESS_B, piconeros: 20n }])
    const metadata = amounts => ({
      payouts: [
        { payoutId: payouts[0].id, recipientAddress: ADDRESS_A, piconeros: amounts[0] },
        { payoutId: payouts[1].id, recipientAddress: ADDRESS_B, piconeros: amounts[1] }
      ]
    })
    const first = await preparePayout({ metadata: metadata(['40', '20']) })
    await db.rewardsWalletTransaction.update({ where: { id: first.id }, data: { state: 'RELAYED', relayedAt: new Date() } })

    // A second, CONFLICTING capture for the same members under a different
    // hash: attempted, unresolvable by the fresh audit chain — it stays
    // PREPARED+attempted and its members stay excluded from new sends.
    const conflictingHash = OTHER_HASH
    const second = await preparePayout({
      tx: fixturePayoutTx({ txHash: conflictingHash }),
      metadata: metadata(['40', '20'])
    })
    await markAttempted(second.id)

    const result = await reconcileWithPayoutAudit()
    expect(result.uncertainPayoutIds.sort()).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    expect((await loadRow(second.id)).state).toBe('PREPARED')
    expect((await loadRow(second.id)).relayAttemptedAt).not.toBeNull()
    // The durable first proof is the only complete fact and recovers the
    // member to its own hash; no second send is ever manufactured.
    expect(await db.rewardPayout.findUnique({ where: { id: payouts[0].id } })).toMatchObject({ state: 'SENT', txHash: HASH })
  })

  test('an existing conflicting payout hash is not overwritten by recovery', async () => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }])
    const recordedHash = 'eb'.repeat(32)
    await db.rewardPayout.update({ where: { id: payouts[0].id }, data: { txHash: recordedHash } })
    const journal = await preparePayout({
      tx: makeBuiltTx({ hash: HASH, fee: 7n, destinations: [{ address: ADDRESS_A, amount: 40n }] }),
      principalPiconeros: 40n,
      metadata: { payouts: [{ payoutId: payouts[0].id, recipientAddress: ADDRESS_A, piconeros: '40' }] }
    })
    await db.rewardsWalletTransaction.update({ where: { id: journal.id }, data: { state: 'RELAYED', relayedAt: new Date() } })
    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result.uncertainPayoutIds).toEqual([payouts[0].id])
    expect(result.recoveredPayoutIds).toEqual([])
    expect(await db.rewardPayout.findUnique({ where: { id: payouts[0].id } })).toMatchObject({ state: 'QUEUED', txHash: recordedHash })
    expect(alert).toHaveBeenCalled()
  })

  test.each([
    ['recipient', { recipientAddress: makeAddress(120) }],
    ['amount', { piconeros: 41n }],
    ['hash', { txHash: 'ec'.repeat(32) }],
    ['completed recipient', { state: 'SENT', txHash: HASH, recipientAddress: makeAddress(120) }],
    ['completed amount', { state: 'CONFIRMED', txHash: HASH, piconeros: 41n }]
  ])('a concurrent %s change cannot authorize recovery or overwrite facts', async (_label, changed) => {
    const { payouts } = await seedQueuedPayouts([{ address: ADDRESS_A, piconeros: 40n }])
    const journal = await preparePayout({
      tx: makeBuiltTx({ hash: HASH, fee: 7n, destinations: [{ address: ADDRESS_A, amount: 40n }] }),
      principalPiconeros: 40n,
      metadata: { payouts: [{ payoutId: payouts[0].id, recipientAddress: ADDRESS_A, piconeros: '40' }] }
    })
    await db.rewardsWalletTransaction.update({ where: { id: journal.id }, data: { state: 'RELAYED', relayedAt: new Date() } })
    const models = {
      rewardsWalletTransaction: db.rewardsWalletTransaction,
      rewardPayout: {
        findMany: args => db.rewardPayout.findMany(args),
        findUnique: args => db.rewardPayout.findUnique(args),
        updateMany: async args => {
          await db.rewardPayout.update({ where: { id: payouts[0].id }, data: changed })
          return db.rewardPayout.updateMany(args)
        }
      }
    }
    const result = await reconcileWalletTransactions({ models, wallet: makeWallet(), scope: SCOPE })
    expect(result.uncertainPayoutIds).toEqual([payouts[0].id])
    expect(result.recoveredPayoutIds).toEqual([])
    expect(await db.rewardPayout.findUnique({ where: { id: payouts[0].id } })).toMatchObject({ state: 'QUEUED', txHash: null, ...changed })
    expect(alert).toHaveBeenCalled()
  })

  test('a RELAYED journal row stays proven when the recipient persist is missing', async () => {
    const journal = await preparePayout()
    const tx = fixturePayoutTx()
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet(), journal, tx, keyProvider })
    expect(sent.relayed).toBe(true)

    // The caller may not have persisted recipient rows yet; reconciliation must
    // not manufacture new uncertainty about an already-proven relay, and it
    // must never re-relay.
    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    expect((await loadRow(journal.id)).state).toBe('RELAYED')
  })

  test('a relay proven directly stays proven when a later verification pass never ran', async () => {
    // Direct-relay provenance is durable bookkeeping, independent of the
    // fresh-verification path.
    const sweep = await prepareSweep()
    const tx = sweepTx()
    const sent = await relayWalletTransaction({ models: db, wallet: makeWallet(), journal: sweep, tx, keyProvider })
    expect(sent.relayed).toBe(true)
    const result = await reconcileWalletTransactions({ models: db, wallet: makeWallet(), scope: SCOPE })
    expect(result).toEqual({ uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 })
    const stored = await loadRow(sweep.id)
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayProvenance).toBe('direct-relay-observation')
  })

  // --- scope and diagnostics ----------------------------------------------------

  test('a different wallet identity is refused before it is read as an authority', async () => {
    const journal = await prepareConsolidation()
    await markAttempted(journal.id)

    await expect(assertWalletScope(makeWallet({ getPrimaryAddress: async () => makeAddress(130) }), SCOPE)).rejects.toThrow(/mismatch/i)
    await expect(assertWalletScope(makeWallet({ getNetworkType: async () => 0 }), SCOPE)).rejects.toThrow(/mismatch/i)
    await expect(assertWalletScope({}, SCOPE)).rejects.toThrow(/mismatch/i)
    await expect(reconcileWalletTransactions({
      models: db, wallet: makeWallet({ getPrimaryAddress: async () => makeAddress(130) }), scope: SCOPE
    })).rejects.toThrow(/mismatch/i)
    await expect(reconcileWalletTransactions({
      models: db, wallet: makeWallet({ getNetworkType: async () => 0 }), scope: SCOPE
    })).rejects.toThrow(/mismatch/i)
    await expect(relayWalletTransaction({
      models: db, wallet: makeWallet({ getNetworkType: async () => 0 }), journal, tx: consolidationTx()
    })).rejects.toThrow(/mismatch/i)

    // Nothing was relayed or burned on the mismatched wallet.
    const stored = await loadRow(journal.id)
    expect(stored.state).toBe('PREPARED')
    expect(stored.relayAttemptedAt).not.toBeNull()

    // The installed library's network constants: MAINNET=0, STAGENET=2.
    await assertWalletScope(makeWallet({ getNetworkType: async () => 2 }), SCOPE)
  })

  test.each([null, false, '', '0', 1, undefined, '2'])('refuses a malformed wallet network value %p', async value => {
    await expect(assertWalletScope(makeWallet({ getNetworkType: async () => value }), SCOPE)).rejects.toThrow(/mismatch/i)
  })

  test('sensitive wallet exceptions never reach the logs', async () => {
    const privateKeyName = 'a'.repeat(64)
    const credentialCode = 'cr_live_1a2b3c4d5e6f'
    const sensitive = Object.assign(new Error('seed absorb abandon ability'), {
      name: privateKeyName,
      code: credentialCode,
      privateSpendKey: 'f'.repeat(64),
      signedTxBlob: 'deadbeef'.repeat(8)
    })
    const wallet = makeWallet({
      relayTx: jest.fn(async () => { throw sensitive })
    })
    const journal = await prepareConsolidation()
    const relay = await relayWalletTransaction({ models: db, wallet, journal, tx: consolidationTx(), keyProvider })
    expect(relay).toMatchObject({ relayed: false, uncertain: true })
    const result = await reconcileWalletTransactions({ models: db, wallet, scope: SCOPE })
    expect(result.uncertainSweep).toBe(true)

    expect(logError).toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
    const logged = util.inspect([...logError.mock.calls, ...logWarn.mock.calls], { depth: 8, maxStringLength: Infinity })
    expect(logged).not.toContain(privateKeyName)
    expect(logged).not.toContain(credentialCode)
    expect(logged).not.toContain('seed absorb abandon')
    expect(logged).not.toContain('f'.repeat(64))
    expect(logged).not.toContain('deadbeef')
    // Every emitted diagnostic that classifies an exception carries one of the
    // fixed, code-defined labels.
    const labeled = [...logError.mock.calls, ...logWarn.mock.calls].filter(call => call[0]?.errorClass !== undefined)
    expect(labeled.length).toBeGreaterThan(0)
    for (const call of labeled) {
      expect(ERROR_LABELS).toContain(call[0].errorClass)
    }
  })

  test('a real timeout classifies as the fixed timeout label, not its text', async () => {
    const timeoutText = 'sensitive timeout detail seed'
    const cases = [
      typeof DOMException !== 'undefined' ? new DOMException(timeoutText, 'TimeoutError') : Object.assign(new Error(timeoutText), { errno: 110 }),
      Object.assign(new Error(timeoutText), { errno: 110 })
    ]
    for (const thrown of cases) {
      jest.clearAllMocks()
      const wallet = makeWallet({ relayTx: jest.fn(async () => { throw thrown }) })
      const journal = await prepareConsolidation()
      const result = await relayWalletTransaction({ models: db, wallet, journal, tx: consolidationTx(), keyProvider })
      expect(result.uncertain).toBe(true)
      const call = logError.mock.calls.find(args => String(args[1]).includes('relay outcome uncertain'))
      expect(call[0]).toMatchObject({ errorClass: 'timeout' })
      expect(util.inspect(call, { depth: 8 })).not.toContain(timeoutText)
      await db.$transaction([
        db.paymentTransactionProof.deleteMany({ where: { rewardsJournalId: journal.id } }),
        db.rewardsWalletTransaction.deleteMany({ where: { id: journal.id } })
      ])
    }
  })

  test.each([
    { label: 'network errno', markers: { errno: 111 }, expected: 'connection' },
    { label: 'numeric rpc code', markers: { code: -17 }, expected: 'rpc' },
    { label: 'unrecognized shape', markers: { message: 'credential-like text' }, expected: 'unknown' }
  ])('classifies a $label structurally as $expected', async ({ markers, expected }) => {
    const wallet = makeWallet({ relayTx: jest.fn(async () => { throw Object.assign(new Error('ignored'), markers) }) })
    const journal = await prepareConsolidation()
    await relayWalletTransaction({ models: db, wallet, journal, tx: consolidationTx(), keyProvider })
    const call = logError.mock.calls.find(args => String(args[1]).includes('relay outcome uncertain'))
    expect(call[0]).toMatchObject({ errorClass: expected })
  })

  test('concurrent identical preparations settle on one journal row', async () => {
    const results = await Promise.all([0, 1, 2, 3].map(() => prepareConsolidation()))
    expect(new Set(results.map(r => String(r.id))).size).toBe(1)
    expect(await db.rewardsWalletTransaction.count({ where: { txHash: CONSOLIDATION_HASH, walletAddress: SCOPE.walletAddress } })).toBe(1)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress, state: 'PREPARED' } })).toBe(1)
  })
})
