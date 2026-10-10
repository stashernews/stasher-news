/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { readPaymentProofInventory } from '@/api/monero/paymentProofStore'
import { collectPaymentChainEvidence } from '@/api/monero/paymentChainEvidence'
import { prepareWalletTransaction } from '@/api/monero/rewardsTransactions'
import {
  verifyLegacyPaymentTransaction,
  verifyPaymentTransaction
} from '@/api/monero/paymentVerification'
import { decodeReceivingIdentity } from '@/api/monero/paymentClaims'
import { oneTimeOutputKey, senderPublicPart } from '@/api/monero/paymentKeyStructure'
import { leHex, paymentChainFixture, paymentFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'

// Evidence-bound relay-repair fixtures (rewards reconciliation plan, Task 3).
//
// `verifiedRepairFixture({ kind, state, attempted })` builds ONE protected
// journal/proof pair through the REAL #1 store (isolated DB, real envelope
// crypto, throwaway synthetic master key), verifies it with the REAL #1
// verifier over a FAKE read-only chain session, and returns
// `{ input, verification, approvedEvidence }` where `input` is the complete
// `buildRewardsReconciliation` input whose evidence carries the verified
// result (`paymentVerifications`), `evidenceVersion: 2` and the explicit
// collection observation. Nothing here signs, relays or writes outside the
// throwaway proof/journal pair.
//
// Fixture chronology (the plan's exact values): preparation 11:58, relay
// attempt 11:59, collection + facts-checked-at (observedAt) 12:00.
//
// The pre-proof-era synthetic story stays in
// test/fixtures/rewards-accounting-evidence.js and remains unresolved by
// default; only this fixture supplies verifier-checked evidence.

export const VERIFIED_OBSERVED_AT = '2026-10-06T12:00:00.000Z'
export const VERIFIED_COLLECTION_STARTED_AT = '2026-10-06T12:00:00.000Z'
export const VERIFIED_PREPARED_AT = '2026-10-06T11:58:00.000Z'
export const VERIFIED_ATTEMPTED_AT = '2026-10-06T11:59:00.000Z'

// Closed v2 relayProof field contract (the plan's exact list).
export const RELAY_PROOF_FIELDS = Object.freeze([
  'version', 'evidenceDigest', 'verificationVersion', 'scope', 'journalRole',
  'journalId', 'dispatchId', 'captureMode', 'txHash', 'claimDigest',
  'proofInventory', 'sourceAccounts', 'members', 'receivingAggregates',
  'ownedAccounting', 'totals', 'confirmation', 'verifierVersion', 'sdkVersion',
  'provenance', 'survivingEvidenceDigest', 'observedAt'
].sort())

// --- deterministic synthetic addresses/points (throwaway, Task 1 style) ------
// Scalar space starts at 300 to stay clear of the shared payment fixture
// scalars (1..106) and the rewards-transaction suite space (n <= 100).

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

const base = paymentFixture()
const SCOPE = base.scope
const ADDRESS_A = base.members[0].address
const ADDRESS_B = base.members[1].address
const IDENTITY_A = base.members[0].receivingIdentity
const IDENTITY_B = base.members[1].receivingIdentity
const IDENTITY_WALLET = decodeReceivingIdentity(SCOPE.walletAddress, SCOPE.network).identity

const COLD = makeAddress(303)
const SWEEP_HASH = 'ba'.repeat(32)
const CONSOLIDATION_HASH = 'bb'.repeat(32)
const LEGACY_HASH = 'bc'.repeat(32)
const REPEATED_PAYOUT_HASH = 'bd'.repeat(32)

// Synthetic throwaway TX-proof registry (never a real secret).
const keyProvider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 11).toString('base64') }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
})

// --- local audit chain for single-destination / self payments ----------------
// The rewards-transaction suite's audited-chain pattern: a fake audit wallet +
// fake daemon whose raw records mirror a built key bundle byte for byte, with
// one owned coinbase source and exact confirmed receipts. The REAL collector
// builds the session from it.

const LOCAL_TIP = Object.freeze({ height: 2999999, blockHash: 'cd'.repeat(32) })
const LOCAL_SOURCE_HASH = 'be'.repeat(32)

// Real one-time-key arithmetic for one built tx: external vouts via the
// sender path against the recipients' PUBLIC keys, the change vout via the
// receiver a*R path against the hot wallet's own spend key (view secret 6).
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

function makeBuiltTx ({ hash, fee, destinations, changeAddress = null, changeAmount = 0n, keySeed }) {
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
    getChangeAmount: async () => (changeAddress === null ? null : changeAmount),
    // The SDK captures the SECRET-bundle STRING (main secret + one additional
    // secret per output, little-endian hex).
    getKey: () => keys.mainSecretHex + keys.additionalSecretHexes.join(''),
    getMainPublicKey: () => keys.mainPublicKey,
    getAdditionalPublicKeys: () => [...keys.additionalPublicKeys],
    getOutputKeys: () => [...keys.outputKeys]
  }
}

const preparedDerivation = () => ({
  complete: true,
  primaryAddress: SCOPE.walletAddress,
  derived: [
    { majorIndex: 0, minorIndex: 0, address: SCOPE.walletAddress },
    ...[1, 2, 3, 4, 5].map(majorIndex => ({ majorIndex, minorIndex: 0, address: makeAddress(301) }))
  ],
  mismatches: []
})

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
  // The coinbase source output is wallet-owned: derived on the receiver a*R
  // path under its own main tx key. A source at account 1 is owned at (1,0) —
  // that position's spend key is the wallet-owned makeAddress(301) primary.
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
  const scanOutput = row => ({
    getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
    getAccountIndex: () => row.accountIndex,
    getSubaddressIndex: () => row.subaddressIndex,
    getIndex: () => row.globalIndex,
    getAmount: () => row.amountPiconeros,
    getStealthPublicKey: () => row.stealthPublicKey,
    getKeyImage: () => (row.keyImage == null ? null : { getHex: () => row.keyImage }),
    getIsSpent: () => row.isSpent === true
  })
  const wallet = {
    getOutputs: jest.fn(async () => [...ownedOutputs.map(scanOutput), scanOutput(sourceRow)]),
    getAccounts: jest.fn(async () => [0, 1, 2, 3, 4, 5].map(index => ({
      getIndex: () => index,
      getPrimaryAddress: () => SCOPE.walletAddress
    }))),
    getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
    getNetworkType: jest.fn(async () => 2),
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
    getPaymentTransactions: jest.fn(async hashes =>
      (Array.isArray(hashes) ? hashes : []).map(h => rawByHash[h]).filter(Boolean)),
    getHeight: jest.fn(async () => LOCAL_TIP.height + 1),
    getBlockHashByHeight: jest.fn(async () => LOCAL_TIP.blockHash)
  }
  return { wallet, daemon, auditedHeight }
}

async function collectedSession ({ wallet, daemon, hash }) {
  const session = await collectPaymentChainEvidence({
    wallet,
    daemon,
    scope: SCOPE,
    derivation: preparedDerivation(),
    boundary: { height: LOCAL_TIP.height, blockHash: LOCAL_TIP.blockHash },
    auditedHashes: [hash]
  })
  return { ...session, checkTxKey: wallet.checkTxKey }
}

// --- shared DB lifecycle ------------------------------------------------------

let sharedDb = null
const dbFor = () => {
  if (!sharedDb) sharedDb = new PrismaClient()
  return sharedDb
}

// Distribution rows this fixture seeded (the sweep journal's FK target).
const createdDistributionIds = []

const cleanFixtureRows = async db => {
  await db.$transaction([
    db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } } }),
    db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
    db.rewardDistribution.deleteMany({ where: { id: { in: [...createdDistributionIds] } } })
  ])
  createdDistributionIds.length = 0
}

// A real distribution row so a distribution-bound sweep journal satisfies its
// foreign key; ids are registered for the fixture cleanup. The recorded
// snapshot already carries the swept period's ops inflow/availability (the
// sweep spent it) while the sweep hash itself was never persisted — exactly
// the promotion story under test.
async function seedDistribution (db) {
  const distribution = await db.rewardDistribution.create({
    data: {
      periodStart: new Date('2026-10-06T00:00:00.000Z'),
      periodEnd: new Date('2026-10-13T00:00:00.000Z'),
      poolPiconeros: 500n,
      opsInflowPiconeros: 524n,
      opsAvailablePiconeros: 524n
    }
  })
  createdDistributionIds.push(distribution.id)
  return distribution
}

/**
 * Release the fixture's shared isolated-DB connection and remove its rows.
 * Call once from the consuming suite's `afterAll`.
 */
export async function closeVerifiedRepairFixtures () {
  if (!sharedDb) return
  const db = sharedDb
  sharedDb = null
  try {
    await cleanFixtureRows(db)
  } finally {
    await db.$disconnect()
  }
}

const makeWallet = () => ({
  getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
  getNetworkType: jest.fn(async () => 2)
})

// --- per-kind captured payments ----------------------------------------------

const PAYOUT_MEMBERS = [
  { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: '40' },
  { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: '20' }
]

// The repeated-recipient variant: ONE curator's address is paid twice
// (payoutId 11 -> 40, payoutId 12 -> 20). Member identity is per PAYOUT ROW
// (id, leg), never per address, so the captured members and the journal
// multiset both carry the address twice — the case that distinguishes
// multiset matching from naive per-address set matching.
const REPEATED_PAYOUT_MEMBERS = [
  { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: '40' },
  { payoutId: 12, recipientAddress: ADDRESS_A, piconeros: '20' }
]

async function payoutFixture ({ db, state, attempted, rawFeePiconeros, repeatedRecipient = false }) {
  const members = repeatedRecipient ? REPEATED_PAYOUT_MEMBERS : PAYOUT_MEMBERS

  // Repeated recipients: the shared two-destination tx fixture derives each
  // external vout against a FIXED recipient slot, so a second leg to the SAME
  // address needs real per-recipient key arithmetic — the same built-tx
  // derivation the single-destination kinds use, plus the local audit chain
  // whose raw records mirror the built bundle byte for byte. The receipt gate
  // checks ONE address once for the SUM of its legs (40 + 20 = 60).
  if (repeatedRecipient) {
    const tx = makeBuiltTx({
      hash: REPEATED_PAYOUT_HASH,
      fee: 7n,
      destinations: [
        { address: ADDRESS_A, amount: 40n },
        { address: ADDRESS_A, amount: 20n }
      ],
      changeAddress: SCOPE.walletAddress,
      changeAmount: 33n,
      keySeed: 95n
    })
    const journal = await prepareWalletTransaction({
      models: db,
      wallet: makeWallet(),
      scope: SCOPE,
      tx,
      kind: 'PAYOUT',
      accountIndex: 0,
      distributionId: null,
      principalPiconeros: 60n,
      metadata: { payouts: members },
      keyProvider
    })
    const keys = {
      mainPublicKey: tx.getMainPublicKey(),
      additionalPublicKeys: tx.getAdditionalPublicKeys(),
      outputKeys: tx.getOutputKeys()
    }
    const changeOutput = {
      txHash: REPEATED_PAYOUT_HASH,
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 2,
      blockHeight: LOCAL_TIP.height - 19,
      globalIndex: 902,
      amountPiconeros: 33n,
      stealthPublicKey: keys.outputKeys[2],
      keyImage: null,
      isSpent: false
    }
    const chain = localAuditChain({
      hash: REPEATED_PAYOUT_HASH,
      fee: 7n,
      sourceAmount: 100n,
      sourceAccountIndex: 0,
      keys,
      receipts: new Map([[ADDRESS_A, { amount: 60n, confirmations: 20 }]]),
      ownedOutputs: [changeOutput]
    })
    const session = await collectedSession({ wallet: chain.wallet, daemon: chain.daemon, hash: REPEATED_PAYOUT_HASH })
    const verification = await verifyPaymentTransaction({
      models: db,
      journalRole: 'REWARDS',
      journalId: journal.id,
      session,
      keyProvider,
      observedAt: VERIFIED_OBSERVED_AT
    })
    const entry = {
      txHash: REPEATED_PAYOUT_HASH,
      accountIndex: 0,
      feePiconeros: '7',
      destinations: members.map(member => ({ address: member.recipientAddress, amountPiconeros: member.piconeros })),
      height: chain.auditedHeight,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    }
    return {
      journal,
      verification,
      chainFacts: { outgoing: [entry], boundary: { ...LOCAL_TIP }, derivation: preparedDerivation() },
      payoutRows: members.map(member => ({
        id: member.payoutId,
        distributionId: null,
        curatorId: 7,
        recipientAddress: member.recipientAddress,
        piconeros: BigInt(member.piconeros),
        txHash: null,
        state: 'QUEUED'
      })),
      journalFeePiconeros: 7n,
      state,
      attempted
    }
  }

  const chain = paymentChainFixture()
  // A tampered RAW fee (never the captured claims) drives the REAL verifier
  // through its rejection gate: FEE_MISMATCH with arithmetic that still closes.
  if (rawFeePiconeros != null) {
    chain.session.rawByHash[chain.txHash].feePiconeros = BigInt(rawFeePiconeros)
  }
  const journal = await prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx: paymentTxFixture(),
    kind: 'PAYOUT',
    accountIndex: 0,
    // The captured pair is distribution-unbound (the store's frozen
    // participant contract would demand real QUEUED payout rows); the
    // builder-side ledger projection models the recorded payouts itself.
    distributionId: null,
    principalPiconeros: 60n,
    metadata: { payouts: members },
    keyProvider
  })
  const verification = await verifyPaymentTransaction({
    models: db,
    journalRole: 'REWARDS',
    journalId: journal.id,
    session: chain.session,
    keyProvider,
    observedAt: VERIFIED_OBSERVED_AT
  })
  const entry = {
    txHash: chain.txHash,
    accountIndex: 0,
    feePiconeros: '7',
    destinations: members.map(member => ({ address: member.recipientAddress, amountPiconeros: member.piconeros })),
    height: chain.chain.audited.blockHeight,
    inTxPool: false,
    isConfirmed: true,
    isRelayed: true,
    isSelfTransfer: false,
    relayState: 'confirmed'
  }
  return {
    journal,
    verification,
    chainFacts: {
      outgoing: [entry],
      boundary: { height: 3000000, blockHash: 'd4'.repeat(32) },
      derivation: chain.collectOptions.derivation
    },
    payoutRows: members.map(member => ({
      id: member.payoutId,
      distributionId: null,
      curatorId: member.payoutId,
      recipientAddress: member.recipientAddress,
      piconeros: BigInt(member.piconeros),
      txHash: null,
      state: 'QUEUED'
    })),
    journalFeePiconeros: 7n,
    state,
    attempted
  }
}

async function sweepFixture ({ db, state, attempted }) {
  const distribution = await seedDistribution(db)
  const tx = makeBuiltTx({
    hash: SWEEP_HASH,
    fee: 9n,
    destinations: [{ address: COLD, amount: 500n }],
    changeAddress: SCOPE.walletAddress,
    changeAmount: 15n,
    keySeed: 90n
  })
  const journal = await prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx,
    kind: 'OPS_SWEEP',
    accountIndex: 0,
    // A production sweep is recorded against its distribution; the promoted
    // journal fact must resolve to that recorded distribution row.
    distributionId: distribution.id,
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
    txHash: SWEEP_HASH,
    accountIndex: 0,
    subaddressIndex: 0,
    outputIndex: 1,
    blockHeight: LOCAL_TIP.height - 19,
    globalIndex: 901,
    amountPiconeros: 15n,
    stealthPublicKey: keys.outputKeys[1],
    keyImage: null,
    isSpent: false
  }
  const chain = localAuditChain({
    hash: SWEEP_HASH,
    fee: 9n,
    sourceAmount: 524n,
    sourceAccountIndex: 0,
    keys,
    receipts: new Map([[COLD, { amount: 500n, confirmations: 20 }]]),
    ownedOutputs: [changeOutput]
  })
  const session = await collectedSession({ wallet: chain.wallet, daemon: chain.daemon, hash: SWEEP_HASH })
  const verification = await verifyPaymentTransaction({
    models: db,
    journalRole: 'REWARDS',
    journalId: journal.id,
    session,
    keyProvider,
    observedAt: VERIFIED_OBSERVED_AT
  })
  const entry = {
    txHash: SWEEP_HASH,
    accountIndex: 0,
    feePiconeros: '9',
    destinations: [{ address: COLD, amountPiconeros: '500' }],
    height: chain.auditedHeight,
    inTxPool: false,
    isConfirmed: true,
    isRelayed: true,
    isSelfTransfer: false,
    relayState: 'confirmed'
  }
  return {
    journal,
    verification,
    chainFacts: { outgoing: [entry], boundary: { ...LOCAL_TIP }, derivation: preparedDerivation() },
    payoutRows: [],
    distributionId: distribution.id,
    distributionOverrides: {
      poolPiconeros: 500n,
      opsInflowPiconeros: 524n,
      opsAvailablePiconeros: 524n
    },
    journalFeePiconeros: 9n,
    state,
    attempted
  }
}

async function consolidationFixture ({ db, state, attempted }) {
  const tx = makeBuiltTx({
    hash: CONSOLIDATION_HASH,
    fee: 4n,
    destinations: [{ address: SCOPE.walletAddress, amount: 8n }],
    changeAddress: null,
    keySeed: 92n
  })
  const journal = await prepareWalletTransaction({
    models: db,
    wallet: makeWallet(),
    scope: SCOPE,
    tx,
    kind: 'CONSOLIDATION',
    accountIndex: 1,
    distributionId: null,
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
  // DESTINATION's derived position (0,0) — the captured owned target binds
  // there and the sender/receiver paths agree on the one-time key.
  const ownedOutput = {
    txHash: CONSOLIDATION_HASH,
    accountIndex: 0,
    subaddressIndex: 0,
    outputIndex: 0,
    blockHeight: LOCAL_TIP.height - 19,
    globalIndex: 900,
    amountPiconeros: 8n,
    stealthPublicKey: keys.outputKeys[0],
    keyImage: null,
    isSpent: false
  }
  const chain = localAuditChain({
    hash: CONSOLIDATION_HASH,
    fee: 4n,
    sourceAmount: 12n,
    sourceAccountIndex: 1,
    keys,
    receipts: new Map(),
    ownedOutputs: [ownedOutput]
  })
  const session = await collectedSession({ wallet: chain.wallet, daemon: chain.daemon, hash: CONSOLIDATION_HASH })
  const verification = await verifyPaymentTransaction({
    models: db,
    journalRole: 'REWARDS',
    journalId: journal.id,
    session,
    keyProvider,
    observedAt: VERIFIED_OBSERVED_AT
  })
  const entry = {
    txHash: CONSOLIDATION_HASH,
    accountIndex: 1,
    feePiconeros: '4',
    destinations: [{ address: SCOPE.walletAddress, amountPiconeros: '8' }],
    height: chain.auditedHeight,
    inTxPool: false,
    isConfirmed: true,
    isRelayed: true,
    isSelfTransfer: true,
    relayState: 'confirmed'
  }
  return {
    journal,
    verification,
    chainFacts: { outgoing: [entry], boundary: { ...LOCAL_TIP }, derivation: preparedDerivation() },
    payoutRows: [],
    journalFeePiconeros: 4n,
    state,
    attempted
  }
}

const FIXTURES_BY_KIND = { PAYOUT: payoutFixture, OPS_SWEEP: sweepFixture, CONSOLIDATION: consolidationFixture }

// --- complete audit-shape ledger around one journal row -----------------------

function auditLedgerAround (built) {
  const journal = built.journal
  const row = {
    ...journal,
    id: Number(journal.id),
    state: built.state ?? 'PREPARED',
    preparedAt: new Date(VERIFIED_PREPARED_AT),
    relayAttemptedAt: built.attempted === false ? null : new Date(VERIFIED_ATTEMPTED_AT),
    relayedAt: built.state === 'RELAYED' ? new Date(VERIFIED_OBSERVED_AT) : null,
    relayProvenance: null
  }
  const scope = { ...SCOPE }
  const boundary = built.chainFacts.boundary
  const ledger = {
    accounts: [
      { id: 1, label: 'platform_rewards', network: scope.network, address: scope.walletAddress }
    ],
    subaddresses: [
      { id: 11, accountId: 1, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }
    ],
    receipts: [],
    downvotes: [],
    payouts: built.payoutRows.map(row2 => ({ ...row2 })),
    distributions: [
      {
        id: built.distributionId ?? 1,
        status: 'COMPLETION_UNKNOWN',
        periodStart: new Date('2026-10-06T00:00:00.000Z'),
        periodEnd: new Date('2026-10-13T00:00:00.000Z'),
        poolPiconeros: 60n,
        distributedPiconeros: 60n,
        rolledOverPiconeros: 0n,
        payoutCount: built.payoutRows.length,
        opsInflowPiconeros: 0n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: 0n,
        opsSweptPiconeros: 0n,
        opsSweepState: 'NONE',
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n,
        ...built.distributionOverrides
      }
    ],
    transactions: [row],
    escrowTransactions: [],
    bountyPayments: [],
    observedBounties: [],
    observedBountyReceipts: [],
    items: [],
    earns: built.payoutRows.map(payout => ({
      id: 500 + payout.id,
      userId: payout.curatorId,
      distributionId: 1,
      piconeros: payout.piconeros
    })),
    proofInventory: built.proofInventory
  }
  const config = {
    downvoteRewardsPct: 100,
    postingFeeRewardsPct: 70,
    territoryFeeRewardsPct: 30,
    boostRewardsPct: 30,
    walletlessTipRewardsPct: 70
  }
  const reserve = { feeHeadroomPiconeros: 1000000000n, dustFloorPiconeros: 1000000000n }
  return {
    scope,
    boundary,
    evidence: {
      evidenceVersion: 2,
      collectionStartedAt: VERIFIED_COLLECTION_STARTED_AT,
      observedAt: VERIFIED_OBSERVED_AT,
      scope,
      boundary,
      daemon: {
        tipBefore: { height: boundary.height, blockHash: boundary.blockHash },
        tipAfter: { height: boundary.height, blockHash: boundary.blockHash }
      },
      restoreHeight: 0,
      restoreProvenance: 'genesis',
      walletHeight: boundary.height + 1,
      derivation: {
        complete: true,
        primaryAddress: scope.walletAddress,
        derived: built.chainFacts.derivation.derived.map(entry => ({ ...entry })),
        mismatches: []
      },
      balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
      incoming: [],
      outgoing: built.chainFacts.outgoing.map(entry => ({ ...entry })),
      bridge: { pendingIncoming: [], pendingOutgoing: [] },
      escrow: null,
      paymentVerifications: [built.verification]
    },
    // The repair reader's flat shape (readRepairLedger): the audited groups
    // plus the shared config/reserve/scope identity fields.
    ledger: { ...ledger, scope, config, reserve },
    decisions: { receipts: {} },
    config,
    reserve,
    opsCarryProvenance: {}
  }
}

async function proofInventoryFor (db, journal) {
  const selectors = [{ journalRole: 'REWARDS', journalId: journal.id }]
  const inventory = await readPaymentProofInventory(db, selectors)
  return selectors.map((selector, index) => ({
    owner: { journalRole: selector.journalRole, journalId: Number(journal.id) },
    reference: {
      txHash: journal.txHash,
      kind: journal.kind,
      dispatchId: journal.dispatchId,
      leg: null,
      bountyPaymentId: null,
      itemId: null
    },
    proof: inventory[index]
  }))
}

/**
 * One verified protected pair and the complete reconciliation input whose
 * approved evidence carries the verifier-checked result.
 *
 * @param {{kind?: 'PAYOUT'|'OPS_SWEEP'|'CONSOLIDATION', state?: string,
 *   attempted?: boolean}} [options]
 * @returns {Promise<{input: object, verification: object, approvedEvidence:
 *   object, journal: object}>}
 */
export async function verifiedRepairFixture (options = {}) {
  const {
    kind = 'PAYOUT',
    state = 'PREPARED',
    attempted = true,
    rawFeePiconeros,
    repeatedRecipient = false,
    expectIncomplete = false
  } = options
  const build = FIXTURES_BY_KIND[kind]
  if (!build) throw new Error(`verifiedRepairFixture: unsupported kind ${kind}`)
  if (repeatedRecipient && kind !== 'PAYOUT') {
    throw new Error('verifiedRepairFixture: repeatedRecipient applies to the PAYOUT kind')
  }
  const db = dbFor()
  await cleanFixtureRows(db)
  const built = await build({ db, state, attempted, rawFeePiconeros, repeatedRecipient })
  if (expectIncomplete) {
    if (built.verification.status === 'complete') {
      throw new Error('verifiedRepairFixture: expected an incomplete verification')
    }
  } else if (built.verification.status !== 'complete') {
    throw new Error(`verifiedRepairFixture: expected a complete verification for ${kind}, got ${built.verification.status}: ${built.verification.issues.join(',')}`)
  }
  built.proofInventory = await proofInventoryFor(db, built.journal)
  const input = auditLedgerAround(built)
  return { input, verification: built.verification, approvedEvidence: input.evidence, journal: built.journal }
}

/**
 * A legacy PREPARED journal row (no capture tuple) verified through #1's
 * legacy seam: real fake-chain gates plus an in-memory surviving key provider.
 * `withSurvivingProof: false` keeps the row unresolved (LEGACY_PROOF_MISSING).
 * DB-free by construction: the legacy verifier consumes a closed contract,
 * never the proof store.
 */
export async function legacyRepairFixture ({ withSurvivingProof = true, recordedFeePiconeros = null } = {}) {
  const chain = paymentChainFixture()
  const contract = {
    scope: SCOPE,
    txHash: LEGACY_HASH,
    journalRole: 'REWARDS',
    journalId: 901,
    owner: { kind: 'PAYOUT', distributionId: '1', bountyPaymentId: null, itemId: null },
    members: [
      {
        id: '11',
        leg: 'PRINCIPAL',
        address: ADDRESS_A,
        type: 'PRIMARY',
        paymentId: null,
        grossPiconeros: '40',
        actualPiconeros: '40'
      },
      {
        id: '12',
        leg: 'PRINCIPAL',
        address: ADDRESS_B,
        type: 'SUBADDRESS',
        paymentId: null,
        grossPiconeros: '20',
        actualPiconeros: '20'
      }
    ],
    recordedFeePiconeros
  }
  // The legacy raw must mirror the contract hash; the fixture session's other
  // facts (keys, source, receipts) already verify COMPLETE for this payment.
  const session = {
    ...chain.session,
    rawByHash: {
      ...chain.session.rawByHash,
      [LEGACY_HASH]: { ...chain.session.rawByHash[chain.txHash], txHash: LEGACY_HASH }
    },
    ownershipFor: hash => (hash === LEGACY_HASH
      ? { owned: chain.session.ownedOutputs, inputSources: chain.session.ownershipFor(chain.txHash).inputSources }
      : { owned: [], inputSources: [] })
  }
  const verification = await verifyLegacyPaymentTransaction({
    contract,
    session,
    observedAt: VERIFIED_OBSERVED_AT,
    survivingProofProvider: withSurvivingProof
      ? async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'relay-repair-fixture' })
      : null
  })
  const legacyRow = {
    id: 901,
    network: SCOPE.network,
    walletAddress: SCOPE.walletAddress,
    txHash: LEGACY_HASH,
    kind: 'PAYOUT',
    state: 'PREPARED',
    accountIndex: 0,
    distributionId: 1,
    principalPiconeros: 60n,
    networkFeePiconeros: recordedFeePiconeros == null ? null : BigInt(recordedFeePiconeros),
    metadata: { payouts: PAYOUT_MEMBERS },
    preparedAt: new Date(VERIFIED_PREPARED_AT),
    relayAttemptedAt: new Date(VERIFIED_ATTEMPTED_AT),
    relayedAt: null,
    relayProvenance: null,
    dispatchId: null,
    captureContractVersion: null,
    claimDigest: null,
    paymentClaims: null,
    proofId: null
  }
  const boundary = { height: 3000000, blockHash: 'd4'.repeat(32) }
  const scope = { ...SCOPE }
  const input = {
    scope,
    boundary,
    evidence: {
      evidenceVersion: 2,
      collectionStartedAt: VERIFIED_COLLECTION_STARTED_AT,
      observedAt: VERIFIED_OBSERVED_AT,
      scope,
      boundary,
      daemon: {
        tipBefore: { height: boundary.height, blockHash: boundary.blockHash },
        tipAfter: { height: boundary.height, blockHash: boundary.blockHash }
      },
      restoreHeight: 0,
      restoreProvenance: 'genesis',
      walletHeight: boundary.height + 1,
      derivation: {
        complete: true,
        primaryAddress: scope.walletAddress,
        derived: chain.collectOptions.derivation.derived.map(entry => ({ ...entry })),
        mismatches: []
      },
      balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
      incoming: [],
      outgoing: [{
        txHash: LEGACY_HASH,
        accountIndex: 0,
        feePiconeros: '7',
        destinations: [
          { address: ADDRESS_A, amountPiconeros: '40' },
          { address: ADDRESS_B, amountPiconeros: '20' }
        ],
        height: chain.chain.audited.blockHeight,
        inTxPool: false,
        isConfirmed: true,
        isRelayed: true,
        isSelfTransfer: false,
        relayState: 'confirmed'
      }],
      bridge: { pendingIncoming: [], pendingOutgoing: [] },
      escrow: null,
      paymentVerifications: [verification]
    },
    ledger: {
      accounts: [
        { id: 1, label: 'platform_rewards', network: scope.network, address: scope.walletAddress }
      ],
      subaddresses: [
        { id: 11, accountId: 1, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }
      ],
      receipts: [],
      downvotes: [],
      payouts: PAYOUT_MEMBERS.map(member => ({
        id: member.payoutId,
        distributionId: 1,
        curatorId: member.payoutId,
        recipientAddress: member.recipientAddress,
        piconeros: BigInt(member.piconeros),
        txHash: null,
        state: 'QUEUED'
      })),
      distributions: [
        {
          id: 1,
          status: 'COMPLETION_UNKNOWN',
          periodStart: new Date('2026-10-06T00:00:00.000Z'),
          periodEnd: new Date('2026-10-13T00:00:00.000Z'),
          poolPiconeros: 60n,
          distributedPiconeros: 60n,
          rolledOverPiconeros: 0n,
          payoutCount: 2,
          opsInflowPiconeros: 0n,
          opsRolledOverPiconeros: 0n,
          opsAvailablePiconeros: 0n,
          opsSweptPiconeros: 0n,
          opsSweepState: 'NONE',
          opsSweepTxHash: null,
          opsNetworkFeesAccountedPiconeros: 0n
        }
      ],
      transactions: [legacyRow],
      escrowTransactions: [],
      bountyPayments: [],
      observedBounties: [],
      observedBountyReceipts: [],
      items: [],
      earns: [
        { id: 511, userId: 11, distributionId: 1, piconeros: 40n },
        { id: 512, userId: 12, distributionId: 1, piconeros: 20n }
      ],
      proofInventory: []
    },
    decisions: { receipts: {} },
    config: {
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      boostRewardsPct: 30,
      walletlessTipRewardsPct: 70
    },
    reserve: { feeHeadroomPiconeros: 1000000000n, dustFloorPiconeros: 1000000000n },
    opsCarryProvenance: {}
  }
  if (verification.status !== 'complete' && withSurvivingProof) {
    throw new Error(`legacyRepairFixture: expected a complete surviving-proof verification, got ${verification.status}: ${verification.issues.join(',')}`)
  }
  return { input, verification, approvedEvidence: input.evidence, journal: legacyRow }
}

export const verifiedFixtureIds = { SCOPE, ADDRESS_A, ADDRESS_B, IDENTITY_A, IDENTITY_B, IDENTITY_WALLET, COLD, LEGACY_HASH }
