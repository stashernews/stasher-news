/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { preparePaymentDispatch } from '@/api/monero/paymentProofStore'
import { collectPaymentChainEvidence, paymentEvidenceError } from '@/api/monero/paymentChainEvidence'
import { decodeReceivingIdentity } from '@/api/monero/paymentClaims'
import { oneTimeOutputKey, publicKeyForScalar } from '@/api/monero/paymentKeyStructure'
import {
  paymentVerificationFacts,
  validatePaymentVerification,
  verifyLegacyPaymentTransaction,
  verifyPaymentTransaction
} from '@/api/monero/paymentVerification'
import { leHex, ownedVoutForPosition, paymentChainFixture, paymentFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'

jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Whole-payment verification tests (Finding #1, Task 5), against the dedicated
// isolated database with REAL store rows + REAL envelope crypto (Tasks 2/3),
// the Task 1 fixture family and the REAL Task 4 chain collector. Every call
// runs the real verifier; no test ever asserts a fabricated verified flag.
// Runs only when DATABASE_URL points at /stasher_rewards_repair_test; skipped
// everywhere else. Run ONLY via the guarded isolated runner.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const OBSERVED_AT = '2026-10-06T12:00:00.000Z'
const CONSOLIDATION_HASH = 'c1'.repeat(32)
const REPEATED_HASH = 'c2'.repeat(32)
const SELF_PAYOUT_HASH = 'c3'.repeat(32)

// Synthetic throwaway master key (never a real secret).
const keyProvider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
})
// A registry that "lost" every key version: durable rows stay, proofs unreadable.
const lostKeyProvider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 9: Buffer.alloc(32, 9).toString('base64') }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '9'
})

const baseFixture = paymentFixture()
const SCOPE = baseFixture.scope
const ADDRESS_A = baseFixture.members[0].address
const ADDRESS_B = baseFixture.members[1].address
const IDENTITY_A = baseFixture.members[0].receivingIdentity
const IDENTITY_B = baseFixture.members[1].receivingIdentity
const IDENTITY_WALLET = decodeReceivingIdentity(SCOPE.walletAddress, SCOPE.network).identity

const rewardOwner = (overrides = {}) => ({
  journalRole: 'REWARDS',
  kind: 'PAYOUT',
  accountIndex: 0,
  distributionId: null,
  principalPiconeros: 60n,
  metadata: {
    payouts: [
      { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n },
      { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: 20n }
    ]
  },
  ...overrides
})

const consolidationOwner = () => ({
  journalRole: 'REWARDS',
  kind: 'CONSOLIDATION',
  accountIndex: 0,
  distributionId: null,
  principalPiconeros: 0n,
  metadata: { destination: SCOPE.walletAddress, selfTransfer: true }
})

const makeWallet = () => ({
  getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
  getNetworkType: jest.fn(async () => 2),
  relayTx: jest.fn(async () => { throw new Error('verifier tests must never relay') })
})

// --- real-chain session helpers (Task 4 collector over hand-built facts) -----

const sdkRow = row => ({
  getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
  getAccountIndex: () => row.accountIndex,
  getSubaddressIndex: () => row.subaddressIndex,
  getIndex: () => row.globalIndex,
  getAmount: () => row.amountPiconeros,
  getStealthPublicKey: () => row.stealthPublicKey,
  getKeyImage: () => ({ getHex: () => row.keyImage }),
  getIsSpent: () => row.isSpent
})

// Builds a REAL Task 4 session (never a canned one) from plain facts, then
// attaches the receipt checker exactly as the production collector does. The
// wallet proves the ephemeral view access the raw ownership enumeration
// requires (final-review I2), and the derivation must be the PREPARED full
// domain (primary + majors 1..5) unless the caller narrows it deliberately.
async function realSession ({
  rawRecords,
  scanRows,
  derivation,
  privateViewKey = null,
  checkTxKey = jest.fn(async () => null)
}) {
  const wallet = {
    getOutputs: jest.fn(async () => scanRows.map(sdkRow)),
    getAccounts: jest.fn(async () =>
      [...new Set(derivation.derived.map(entry => entry.majorIndex))]
        .map(index => ({ getIndex: () => index, getPrimaryAddress: () => SCOPE.walletAddress }))),
    getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
    getNetworkType: jest.fn(async () => 2),
    ...(privateViewKey === null ? {} : { getPrivateViewKey: jest.fn(async () => privateViewKey) }),
    checkTxKey
  }
  const daemon = {
    getPaymentTransactions: jest.fn(async hashes => hashes.map(hash => rawRecords[hash]).filter(Boolean))
  }
  const session = await collectPaymentChainEvidence({
    wallet,
    daemon,
    scope: SCOPE,
    derivation,
    boundary: { height: 3000000, blockHash: 'd4'.repeat(32) }
  })
  return { ...session, checkTxKey }
}

const fullDerivation = () => paymentChainFixture().collectOptions.derivation

;(ISOLATED_DB ? describe : describe.skip)('verifyPaymentTransaction (isolated DB only)', () => {
  let db

  const cleanFixtureRows = async () => {
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.paymentTransactionProof.deleteMany({ where: { escrowJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.escrowWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } })
    ])
  }

  // The pinned fixture test addresses journal id 1 verbatim. Restarting the
  // journal/proof identity makes the next natural create land on id 1 (no
  // fixed-id update — the capture immutability triggers rightly forbid one).
  const buildPinnedPair = async () => {
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      owner: rewardOwner(),
      keyProvider
    })
    if (Number(prepared.journal.id) !== 1) {
      throw new Error(`pinned pair must occupy journal id 1, got ${prepared.journal.id}`)
    }
    return prepared
  }

  beforeEach(async () => {
    db = new PrismaClient()
    await db.$executeRawUnsafe(
      'TRUNCATE "PaymentTransactionProof", "RewardsWalletTransaction", "EscrowWalletTransaction" RESTART IDENTITY CASCADE')
    await buildPinnedPair()
  })

  afterEach(async () => {
    await cleanFixtureRows()
    await db.$disconnect()
  })

  const verifyFixture = async (f, overrides = {}) => verifyPaymentTransaction({
    ...f.verifyOptions,
    observedAt: f.observedAt,
    models: db,
    keyProvider,
    ...overrides
  })

  test('listed checks passing do not hide an extra external payment', async () => {
    const f = paymentChainFixture({ ownedAmount: 22n })
    const result = await verifyPaymentTransaction({ ...f.verifyOptions, observedAt: f.observedAt, models: db, keyProvider })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('UNCLAIMED_EXTERNAL_RESIDUAL')
    expect(result.totals).toEqual({ D: '100', O: '22', F: '7', E: '60', residual: '11' })
  })

  test('missing authoritative session boundary cannot be reconstructed from transaction confirmations', async () => {
    const f = paymentChainFixture()
    delete f.verifyOptions.session.boundary
    const result = await verifyFixture(f)
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('BOUNDARY_INCONSISTENT')
  })

  test('missing authoritative session scope cannot produce complete verification', async () => {
    const f = paymentChainFixture()
    delete f.verifyOptions.session.scope
    const result = await verifyFixture(f)
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('CHAIN_EVIDENCE_INCOMPLETE')
  })

  test('maturity uses authoritative checked heights when raw confirmation counts are unavailable', async () => {
    const f = paymentChainFixture()
    for (const raw of Object.values(f.verifyOptions.session.rawByHash)) raw.confirmations = null
    const complete = await verifyFixture(f)
    expect(complete.status).toBe('complete')
    expect(complete.confirmation.confirmations).toBe(21)
    f.verifyOptions.session.boundary.height = f.verifyOptions.session.rawByHash[f.txHash].blockHeight
    const immature = await verifyFixture(f)
    expect(immature.status).toBe('unresolved')
    expect(immature.issues).toContain('CONFIRMATION_REQUIRED')
  })

  test.each(['blockHeight', 'blockHash'])('missing checked audited %s prevents complete maturity', async field => {
    const f = paymentChainFixture()
    f.verifyOptions.session.rawByHash[f.txHash][field] = null
    const result = await verifyFixture(f)
    expect(result.status).not.toBe('complete')
    expect(result.issues).toContain('CHAIN_EVIDENCE_INCOMPLETE')
  })

  test('verifies a closed captured payout end to end with safe facts', async () => {
    const f = paymentChainFixture()
    const result = await verifyFixture(f)
    expect(result.status).toBe('complete')
    expect(result.issues).toEqual([])
    expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
    expect(result.verificationVersion).toBe('1')
    expect(result.verifierVersion).toBe('1')
    expect(result.sdkVersion).toBe('0.11.12')
    expect(result.provenance).toBe('restored-owned-outputs/raw-chain/check-tx-key')
    expect(result.captureMode).toBe('CAPTURE_V1')
    expect(result.journalRole).toBe('REWARDS')
    expect(result.journalId).toBe('1')
    expect(result.dispatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.claimDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.survivingEvidenceDigest).toBeNull()
    expect(result.proofInventory).toMatchObject({
      revision: 1,
      masterKeyVersion: 1,
      bindingVersion: 1,
      envelopeVersion: 1,
      payloadVersion: 1
    })
    expect(result.proofInventory.proofId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.scope).toEqual(SCOPE)
    expect(result.txHash).toBe(f.txHash)
    expect(result.sourceAccounts).toEqual(['0'])
    expect(result.members.map(member => member.id)).toEqual(['11', '12'])
    expect(result.receivingAggregates).toEqual([
      { receivingIdentity: IDENTITY_A, amountPiconeros: '40', confirmations: 21 },
      { receivingIdentity: IDENTITY_B, amountPiconeros: '20', confirmations: 21 }
    ])
    expect(result.ownedAccounting.totalPiconeros).toBe('33')
    expect(result.ownedAccounting.outputs).toEqual([
      { outputIndex: 1, accountIndex: 0, subaddressIndex: 0, amountPiconeros: '33', isSpent: false }
    ])
    expect(result.confirmation).toEqual({ height: 2999980, blockHash: 'd4'.repeat(32), confirmations: 21 })
    expect(result.boundary).toEqual({ height: 3000000, blockHash: 'd4'.repeat(32) })
    expect(result.observedAt).toBe(OBSERVED_AT)
    expect(validatePaymentVerification(result)).toBe(true)
    expect(f.session.checkTxKey).toHaveBeenCalledWith(f.txHash, expect.any(String), ADDRESS_A)
    expect(f.session.checkTxKey).toHaveBeenCalledWith(f.txHash, expect.any(String), ADDRESS_B)
  })

  test('the real Task 4 collector session verifies identically to the canned stand-in', async () => {
    const f = paymentChainFixture()
    // The fixture wallet and daemon are exactly what collectPaymentChainEvidence
    // consumes; attach the receipt checker exactly as the collector will.
    const collected = await collectPaymentChainEvidence(f.collectOptions)
    const session = { ...collected, checkTxKey: f.wallet.checkTxKey }
    const result = await verifyFixture(f, { session })
    expect(result.status).toBe('complete')
    expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
  })

  test('repeated recipients aggregate per receiving identity and are checked once per address', async () => {
    const f = paymentChainFixture({ txHash: REPEATED_HASH, repeatedRecipient: true })
    const aliasAddress = f.chain.externalReceipts[1].address
    // The captured pair must carry the same alias membership as the session.
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: REPEATED_HASH, repeatedRecipient: true }),
      owner: rewardOwner({
        metadata: {
          payouts: [
            { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n },
            { payoutId: 12, recipientAddress: aliasAddress, piconeros: 20n }
          ]
        }
      }),
      keyProvider
    })
    const calls = []
    const checker = jest.fn(async (hash, bundle, address) => {
      calls.push(address)
      return f.wallet.checkTxKey(hash, bundle, address)
    })
    const result = await verifyPaymentTransaction({
      ...f.verifyOptions,
      journalId: prepared.journal.id,
      observedAt: f.observedAt,
      models: db,
      keyProvider,
      session: { ...f.session, checkTxKey: checker }
    })
    // Amount/alias handling works; the payment-ID claim itself stays unprovable.
    expect(result.status).toBe('unsupported')
    expect(result.issues).toContain('PAYMENT_ID_UNSUPPORTED')
    expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
    // One aggregate per receiving identity, checked once per distinct address.
    expect(calls.sort()).toEqual([ADDRESS_A, aliasAddress].sort())
    expect(result.receivingAggregates).toEqual([
      { receivingIdentity: IDENTITY_A, amountPiconeros: '60', confirmations: 21 }
    ])
  })

  test('refuses a wrongly targeted consolidation at zero cash residual', async () => {
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({
        txHash: CONSOLIDATION_HASH,
        members: [{
          id: '1',
          leg: 'PRINCIPAL',
          address: SCOPE.walletAddress,
          type: 'PRIMARY',
          paymentId: null,
          receivingIdentity: IDENTITY_WALLET,
          grossPiconeros: '40',
          actualPiconeros: '40'
        }]
      }),
      owner: consolidationOwner(),
      keyProvider
    })
    // Final-review I6 model: the wallet primary is (0,0), and the capture
    // binds its owned target there. The tx actually paid the wallet-owned
    // ACCOUNT 1 primary — still an internal (owned) output, so cash closes at
    // zero residual, but the scanned owned output sits at a DIFFERENT derived
    // position than the captured target → OWNED_PARTITION_MISMATCH. Every
    // key below is real arithmetic: the owned output is derived on the
    // receiver a*R path through the raw's own additional slot key to
    // account 1's spend key, so the collector's raw ownership enumeration
    // agrees with the scan at (1,0).
    const leHex = value => {
      const buffer = Buffer.alloc(32)
      buffer.writeBigUInt64LE(BigInt(value))
      return buffer.toString('hex')
    }
    const misdirectedVout = ownedVoutForPosition({ majorIndex: 1, slotScalar: 103n, outputIndex: 1 })
    const auditedKeys = paymentChainFixture().chain
    const raw = {
      txHash: CONSOLIDATION_HASH,
      feePiconeros: 7n,
      inputKeyImages: [auditedKeys.keyImages.source],
      voutKeys: [auditedKeys.audited.voutKeys[0], misdirectedVout, auditedKeys.audited.voutKeys[2]],
      outputIndices: [917, 701, 719],
      blockHeight: 2999980,
      blockHash: 'd4'.repeat(32),
      confirmations: 21,
      inTxPool: false,
      isCoinbase: false,
      mainPublicKey: auditedKeys.mainPublicKey,
      additionalPublicKeys: [...auditedKeys.additionalPublicKeys]
    }
    const sourcePrior = {
      txHash: 'e1'.repeat(32),
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: 2999000,
      globalIndex: 690,
      amountPiconeros: 100n,
      stealthPublicKey: auditedKeys.sourceScan.stealthPublicKey,
      keyImage: auditedKeys.keyImages.source,
      isSpent: true
    }
    const wrongTargetRow = {
      txHash: CONSOLIDATION_HASH,
      accountIndex: 1,
      subaddressIndex: 0,
      outputIndex: 1,
      blockHeight: 2999980,
      globalIndex: 701,
      amountPiconeros: 93n,
      stealthPublicKey: misdirectedVout,
      keyImage: 'dd'.repeat(32),
      isSpent: false
    }
    const session = await realSession({
      rawRecords: {
        [CONSOLIDATION_HASH]: raw,
        ['e1'.repeat(32)]: auditedKeys.source
      },
      scanRows: [wrongTargetRow, sourcePrior],
      derivation: fullDerivation(),
      privateViewKey: leHex(6)
    })
    const result = await verifyPaymentTransaction({
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      session,
      models: db,
      keyProvider,
      observedAt: OBSERVED_AT
    })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
    expect(result.issues).not.toContain('UNCLAIMED_EXTERNAL_RESIDUAL')
    expect(result.totals.residual).toBe('0')
  })

  test('rejects a raw fee that differs from the captured fee', async () => {
    const f = paymentChainFixture()
    const audited = { ...f.session.rawByHash[f.txHash], feePiconeros: 8n }
    const session = { ...f.session, rawByHash: { ...f.session.rawByHash, [f.txHash]: audited } }
    const result = await verifyFixture(f, { session })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('FEE_MISMATCH')
  })

  test('rejects a source-account capture mismatch and refuses mixed sources', async () => {
    const f = paymentChainFixture()
    // The restored prior sits at account 1 while the capture declares ['0'].
    const shiftedPrior = { ...f.chain.sourceScan, accountIndex: 1 }
    const mismatched = await verifyFixture(f, {
      session: {
        ...f.session,
        ownershipFor: hash => (hash === f.txHash
          ? { owned: f.session.ownedOutputs, inputSources: [shiftedPrior] }
          : { owned: [], inputSources: [] })
      }
    })
    expect(mismatched.status).toBe('rejected')
    expect(mismatched.issues).toContain('SOURCE_ACCOUNT_MISMATCH')

    const second = {
      ...f.chain.sourceScan,
      accountIndex: 1,
      keyImage: 'ab'.repeat(32),
      amountPiconeros: 50n
    }
    const mixed = await verifyFixture(f, {
      session: {
        ...f.session,
        ownershipFor: hash => (hash === f.txHash
          ? { owned: f.session.ownedOutputs, inputSources: [f.chain.sourceScan, second] }
          : { owned: [], inputSources: [] })
      }
    })
    expect(mixed.status).toBe('unsupported')
    expect(mixed.issues).toContain('MIXED_SOURCE_UNSUPPORTED')
  })

  test('rejects an owned output outside the captured change/owned-target positions', async () => {
    const f = paymentChainFixture()
    const crossAccount = {
      ...f.chain.ownedScan[0],
      accountIndex: 1,
      globalIndex: 4314211
    }
    const session = {
      ...f.session,
      ownedOutputs: [crossAccount],
      ownershipFor: hash => (hash === f.txHash
        ? { owned: [crossAccount], inputSources: f.session.ownershipFor(f.txHash).inputSources }
        : { owned: [], inputSources: [] })
    }
    const result = await verifyFixture(f, { session })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
  })

  test('rejects populated captured change amount differing from independently restored change', async () => {
    const hash = 'a6'.repeat(32)
    const tx = paymentTxFixture({ txHash: hash })
    tx.getChangeAmount = () => 34n
    const prepared = await preparePaymentDispatch({ models: db, wallet: makeWallet(), tx, owner: rewardOwner(), keyProvider })
    const f = paymentChainFixture({ txHash: hash })
    const result = await verifyFixture(f, { journalId: prepared.journal.id })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
    expect(result.totals.residual).toBe('0')
  })

  test('a true no-change captured payout completes through the real collector', async () => {
    const hash = 'a7'.repeat(32)
    const tx = paymentTxFixture({ txHash: hash })
    tx.getKey = () => leHex(101n) + leHex(102n) + leHex(104n)
    tx.getChangeAddress = () => undefined
    tx.getChangeAmount = () => undefined
    tx.getOutgoingTransfer = () => ({
      getDestinations: () => [
        { getAddress: () => ADDRESS_A, getAmount: () => 40n },
        { getAddress: () => ADDRESS_B, getAmount: () => 53n }
      ]
    })
    const owner = rewardOwner({
      principalPiconeros: 93n,
      metadata: {
        payouts: [
          { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n },
          { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: 53n }
        ]
      }
    })
    const prepared = await preparePaymentDispatch({ models: db, wallet: makeWallet(), tx, owner, keyProvider })
    const f = paymentChainFixture({ txHash: hash })
    const raw = f.session.rawByHash[hash]
    const decoded = decodeReceivingIdentity(ADDRESS_B, SCOPE.network)
    raw.voutKeys = [raw.voutKeys[0], oneTimeOutputKey({ publicKey: decoded.viewKey, secret: leHex(104n), publicSpend: decoded.spendKey, outputIndex: 1 })]
    raw.additionalPublicKeys = [raw.additionalPublicKeys[0], raw.additionalPublicKeys[2]]
    raw.outputIndices = [917, 919]
    const sourceRows = (await f.wallet.getOutputs()).filter(row => row.getTx().getHash() !== hash)
    f.wallet.getOutputs.mockResolvedValue(sourceRows)
    f.viewWallet.getOutputs.mockResolvedValue(sourceRows)
    const session = await collectPaymentChainEvidence({ ...f.collectOptions, auditedHashes: [hash] })
    const result = await verifyFixture(f, {
      journalId: prepared.journal.id,
      session: { ...session, checkTxKey: async (_hash, _bundle, address) => ({ getIsGood: () => true, getReceivedAmount: () => address === ADDRESS_A ? 40n : 53n, getInTxPool: () => false, getNumConfirmations: () => 21 }) }
    })
    expect(result.status).toBe('complete')
    expect(result.totals).toEqual({ D: '100', O: '0', F: '7', E: '93', residual: '0' })
  })

  test.each(['absent', 'null', 'undefined'])('missing %s owned address correspondence cannot complete', async mode => {
    const f = paymentChainFixture()
    const session = { ...f.session, addressForPosition: mode === 'absent' ? undefined : () => mode === 'null' ? null : undefined }
    const result = await verifyFixture(f, { session })
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('CHAIN_EVIDENCE_INCOMPLETE')
  })

  test('refuses an owned recipient sharing the change identity', async () => {
    const walletMember = [{
      id: '11',
      leg: 'PRINCIPAL',
      address: ADDRESS_A,
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: IDENTITY_A,
      grossPiconeros: '40',
      actualPiconeros: '40'
    }, {
      id: '12',
      leg: 'PRINCIPAL',
      address: SCOPE.walletAddress,
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: IDENTITY_WALLET,
      grossPiconeros: '20',
      actualPiconeros: '20'
    }]
    const f = paymentChainFixture({ txHash: SELF_PAYOUT_HASH, members: walletMember })
    // The captured pair must carry the same self-paying membership.
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: SELF_PAYOUT_HASH, members: walletMember }),
      owner: rewardOwner({
        metadata: {
          payouts: [
            { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n },
            { payoutId: 12, recipientAddress: SCOPE.walletAddress, piconeros: 20n }
          ]
        }
      }),
      keyProvider
    })
    const result = await verifyPaymentTransaction({
      ...f.verifyOptions,
      journalId: prepared.journal.id,
      observedAt: f.observedAt,
      models: db,
      keyProvider
    })
    expect(result.status).toBe('unsupported')
    expect(result.issues).toContain('OWNED_CHANGE_SPLIT_UNSUPPORTED')
  })

  test('rejects a key-structure mismatch between the captured bundle and the raw chain', async () => {
    // The capture populates its optional public built facts (the test opt-in
    // path), so the raw chain's swapped main tx key is caught by the
    // byte-for-byte binding (final-review I1 keeps this corroboration).
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: 'bb'.repeat(32), populatedPublicKeys: true }),
      owner: rewardOwner(),
      keyProvider
    })
    const f = paymentChainFixture()
    const audited = { ...f.session.rawByHash[f.txHash], txHash: 'bb'.repeat(32), mainPublicKey: 'ee'.repeat(32) }
    const session = {
      ...f.session,
      rawByHash: { ...f.session.rawByHash, ['bb'.repeat(32)]: audited },
      // The canned resolver only knows the fixture hash: teach it the capture
      // hash (same facts — only the main tx key is swapped).
      ownershipFor: hash => (hash === 'bb'.repeat(32)
        ? { owned: [], inputSources: [f.chain.sourceScan] }
        : f.session.ownershipFor(hash))
    }
    const result = await verifyPaymentTransaction({
      ...f.verifyOptions,
      session,
      journalId: prepared.journal.id,
      observedAt: f.observedAt,
      models: db,
      keyProvider
    })
    expect(result.status).toBe('rejected')
    expect(result.issues).toContain('KEY_STRUCTURE_MISMATCH')
  })

  test('unresolved facts: missing input ownership, missing receipts, missing indexes', async () => {
    // Missing input ownership through the REAL collector: the scan lost the
    // 100n source row, so the audited key image resolves to nothing. Both the
    // full and the view-only scan must drop the row (exact scan agreement).
    const missingInput = paymentChainFixture()
    const rows = await missingInput.wallet.getOutputs()
    const filteredRows = rows.filter(row => row.getAmount() !== missingInput.chain.D)
    missingInput.wallet.getOutputs.mockResolvedValue(filteredRows)
    missingInput.viewWallet.getOutputs.mockResolvedValue(filteredRows)
    const collected = await collectPaymentChainEvidence(missingInput.collectOptions)
    const missingResult = await verifyFixture(missingInput, {
      session: { ...collected, checkTxKey: missingInput.wallet.checkTxKey }
    })
    expect(missingResult.status).toBe('unresolved')
    expect(missingResult.issues).toContain('INPUT_NOT_OWNED_OR_MISSING')

    // Missing receipt: the checker answers isGood:false for recipient B.
    const noReceipt = paymentChainFixture()
    const missingChecker = jest.fn(async (hash, bundle, address) =>
      address === ADDRESS_B ? null : noReceipt.wallet.checkTxKey(hash, bundle, address))
    const noReceiptResult = await verifyFixture(noReceipt, {
      session: { ...noReceipt.session, checkTxKey: missingChecker }
    })
    expect(noReceiptResult.status).toBe('unresolved')
    expect(noReceiptResult.issues).toContain('RECEIPT_UNAVAILABLE')
    expect(noReceiptResult.totals.E).toBeNull()
    expect(noReceiptResult.totals.residual).toBeNull()

    // Missing index join through the REAL collector: a scan stealth key that
    // hits no vout refuses collection.
    const badIndex = paymentChainFixture()
    const scanRows = await badIndex.wallet.getOutputs()
    const broken = scanRows.map(row => ({ ...row, getStealthPublicKey: () => 'ff'.repeat(32) }))
    badIndex.wallet.getOutputs.mockResolvedValue(broken)
    badIndex.viewWallet.getOutputs.mockResolvedValue(broken)
    await expect(collectPaymentChainEvidence(badIndex.collectOptions))
      .rejects.toMatchObject({ code: 'OWNED_OUTPUT_JOIN_FAILED' })

    // A checker that throws is an unavailable receipt, never a crash.
    const throwing = paymentChainFixture()
    const throwingResult = await verifyFixture(throwing, {
      session: {
        ...throwing.session,
        checkTxKey: jest.fn(async () => { throw new Error('sdk hiccup') })
      }
    })
    expect(throwingResult.status).toBe('unresolved')
    expect(throwingResult.issues).toContain('RECEIPT_UNAVAILABLE')
  })

  test('isGood:true with a wrong or zero amount refuses as a conflicting observation', async () => {
    const zero = paymentChainFixture()
    const zeroChecker = jest.fn(async (hash, bundle, address) =>
      address === ADDRESS_A
        ? { getIsGood: () => true, getReceivedAmount: () => 0n, getInTxPool: () => false, getNumConfirmations: () => 21 }
        : zero.wallet.checkTxKey(hash, bundle, address))
    const zeroResult = await verifyFixture(zero, { session: { ...zero.session, checkTxKey: zeroChecker } })
    expect(zeroResult.status).toBe('rejected')
    expect(zeroResult.issues).toContain('RECEIPT_AMOUNT_MISMATCH')

    const wrong = paymentChainFixture()
    const wrongChecker = jest.fn(async (hash, bundle, address) =>
      address === ADDRESS_B
        ? { getIsGood: () => true, getReceivedAmount: () => 21n, getInTxPool: () => false, getNumConfirmations: () => 21 }
        : wrong.wallet.checkTxKey(hash, bundle, address))
    const wrongResult = await verifyFixture(wrong, { session: { ...wrong.session, checkTxKey: wrongChecker } })
    expect(wrongResult.status).toBe('rejected')
    expect(wrongResult.issues).toContain('RECEIPT_AMOUNT_MISMATCH')
  })

  test('pool and insufficient confirmations stay unresolved with CONFIRMATION_REQUIRED', async () => {
    const pooled = paymentChainFixture()
    const pooledChecker = jest.fn(async (hash, bundle, address) =>
      address === ADDRESS_A
        ? { getIsGood: () => true, getReceivedAmount: () => 40n, getInTxPool: () => true, getNumConfirmations: () => 0 }
        : pooled.wallet.checkTxKey(hash, bundle, address))
    const pooledResult = await verifyFixture(pooled, { session: { ...pooled.session, checkTxKey: pooledChecker } })
    expect(pooledResult.status).toBe('unresolved')
    expect(pooledResult.issues).toContain('CONFIRMATION_REQUIRED')

    const young = paymentChainFixture()
    const youngChecker = jest.fn(async (hash, bundle, address) =>
      address === ADDRESS_B
        ? { getIsGood: () => true, getReceivedAmount: () => 20n, getInTxPool: () => false, getNumConfirmations: () => 3 }
        : young.wallet.checkTxKey(hash, bundle, address))
    const youngResult = await verifyFixture(young, { session: { ...young.session, checkTxKey: youngChecker } })
    expect(youngResult.status).toBe('unresolved')
    expect(youngResult.issues).toContain('CONFIRMATION_REQUIRED')
  })

  test('a session without a receipt checker stays explicitly unresolved', async () => {
    const f = paymentChainFixture()
    const { checkTxKey, ...sessionWithoutChecker } = f.session
    const result = await verifyFixture(f, { session: sessionWithoutChecker })
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('RECEIPT_CHECK_UNAVAILABLE')
  })

  test('a corrupted capture is rejected, lost keys leave delivery intact but unresolved', async () => {
    const f = paymentChainFixture()
    // Corruption: flip one ciphertext byte out of band.
    const proof = await db.paymentTransactionProof.findFirstOrThrow({
      where: { rewardsJournal: { id: 1 } }
    })
    const damaged = Buffer.from(proof.ciphertext)
    damaged[0] ^= 0x01
    await db.paymentTransactionProof.update({
      where: { id: proof.id },
      data: { ciphertext: damaged, revision: { increment: 1 } }
    })
    const corruptResult = await verifyFixture(f)
    expect(corruptResult.status).toBe('rejected')
    expect(corruptResult.issues).toContain('CAPTURE_CORRUPT')

    // Lost keys: a registry without the envelope's master-key version must
    // leave the recorded delivery intact and report verification unresolved.
    const intact = paymentChainFixture()
    const lostResult = await verifyFixture(intact, { keyProvider: lostKeyProvider })
    expect(lostResult.status).toBe('unresolved')
    expect(lostResult.issues).toContain('PROOF_KEY_UNAVAILABLE')
    const row = await db.rewardsWalletTransaction.findUniqueOrThrow({ where: { id: 1 } })
    expect(row.dispatchId).not.toBeNull()
    expect(row.proofId).not.toBeNull()
    expect(row.claimDigest).not.toBeNull()
  })

  test('paymentVerificationFacts drops operation versions, observation time and advancing confirmations', async () => {
    const f = paymentChainFixture()
    const result = await verifyFixture(f)
    const facts = paymentVerificationFacts(result)
    expect(facts.verifierVersion).toBeUndefined()
    expect(facts.sdkVersion).toBeUndefined()
    expect(facts.verificationVersion).toBeUndefined()
    expect(facts.observedAt).toBeUndefined()
    expect(facts.survivingEvidenceDigest).toBeUndefined()
    expect(facts.confirmation).toEqual({ height: 2999980, blockHash: 'd4'.repeat(32) })
    expect(facts.totals).toEqual(result.totals)
    expect(facts.status).toBe('complete')
  })

  test('ordinary tip advancement changes no substantive paymentVerificationFacts', async () => {
    const f = paymentChainFixture()
    const before = await verifyFixture(f)
    f.session.boundary.height += 1
    f.session.boundary.blockHash = 'a9'.repeat(32)
    for (const raw of Object.values(f.session.rawByHash)) raw.confirmations += 1
    const after = await verifyFixture(f)
    expect(after.status).toBe('complete')
    expect(after.confirmation.confirmations).toBe(before.confirmation.confirmations + 1)
    expect(paymentVerificationFacts(after)).toEqual(paymentVerificationFacts(before))
    expect(paymentVerificationFacts(after).confirmation).toEqual(before.confirmation && { height: before.confirmation.height, blockHash: before.confirmation.blockHash })
  })

  test('validatePaymentVerification refuses fabricated or malformed results', async () => {
    const f = paymentChainFixture()
    const result = await verifyFixture(f)
    expect(validatePaymentVerification(result)).toBe(true)

    const fabricated = { ...result, totals: { ...result.totals, residual: '0' }, status: 'complete' }
    expect(validatePaymentVerification({
      ...fabricated,
      totals: { D: '100', O: '33', F: '7', E: '60', residual: '11' }
    })).toBe(false)

    expect(validatePaymentVerification({ ...result, extraField: 1 })).toBe(false)
    expect(validatePaymentVerification({ ...result, sdkVersion: '9.9.9' })).toBe(false)
    expect(validatePaymentVerification({ ...result, issues: ['B_AFTER_A', 'A_FIRST'] })).toBe(false)
    expect(validatePaymentVerification({ ...result, status: 'complete', issues: ['FEE_MISMATCH'] })).toBe(false)
    expect(validatePaymentVerification({
      ...result,
      captureMode: 'CAPTURE_V1',
      survivingEvidenceDigest: 'ff'.repeat(32)
    })).toBe(false)
    expect(validatePaymentVerification({
      ...result,
      confirmation: { height: 2999980, blockHash: null, confirmations: -1 }
    })).toBe(false)
    expect(validatePaymentVerification(null)).toBe(false)
  })

  test.each([
    ['disjoint equal-cardinality identities', result => { result.receivingAggregates = result.receivingAggregates.map(group => ({ ...group, receivingIdentity: `other/${group.receivingIdentity}` })) }],
    ['nonzero E with empty aggregates', result => { result.members = []; result.receivingAggregates = [] }],
    ['nonzero O with empty owned outputs', result => { result.ownedAccounting.outputs = [] }],
    ['immature complete evidence', result => { result.confirmation.confirmations = 1; result.boundary.height = result.confirmation.height }],
    ['boundary before inclusion', result => { result.boundary.height = result.confirmation.height - 1 }],
    ['confirmation arithmetic mismatch', result => { result.confirmation.confirmations += 1 }],
    ['legacy complete without surviving provenance', result => { result.captureMode = 'LEGACY_SURVIVING_PROOF'; result.dispatchId = null; result.claimDigest = null; result.proofInventory = null }]
  ])('validator refuses %s', async (_label, mutate) => {
    const result = await verifyFixture(paymentChainFixture())
    expect(validatePaymentVerification(result)).toBe(true)
    mutate(result)
    expect(validatePaymentVerification(result)).toBe(false)
  })
})

;(ISOLATED_DB ? describe : describe.skip)('verifyLegacyPaymentTransaction (isolated DB only)', () => {
  let db

  const legacyContract = (overrides = {}) => ({
    scope: SCOPE,
    txHash: paymentFixture().txHash,
    journalRole: 'REWARDS',
    journalId: null,
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
    recordedFeePiconeros: '7',
    ...overrides
  })

  beforeEach(async () => {
    db = new PrismaClient()
  })

  afterEach(async () => {
    await db.$disconnect()
  })

  const legacyFixtureSession = () => {
    const f = paymentChainFixture()
    return { f, session: { ...f.session } }
  }

  test.each(['misdirected', 'unmapped'])('legacy %s change must satisfy independent source-primary policy', async mode => {
    const { f } = legacyFixtureSession()
    const original = f.session.ownershipFor(f.txHash)
    const session = mode === 'unmapped'
      ? { ...f.session, addressForPosition: undefined }
      : { ...f.session, ownershipFor: () => ({ ...original, owned: original.owned.map(row => ({ ...row, accountIndex: 1 })) }) }
    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract(),
      session,
      observedAt: OBSERVED_AT,
      survivingProofProvider: async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'synthetic-policy-test' })
    })
    expect(result.status).toBe(mode === 'unmapped' ? 'unresolved' : 'rejected')
    expect(result.issues).toContain(mode === 'unmapped' ? 'CHAIN_EVIDENCE_INCOMPLETE' : 'OWNED_PARTITION_MISMATCH')
  })

  test.each([null, 'UNKNOWN'])('legacy unavailable policy kind %p remains explicitly unresolved', async kind => {
    const { f } = legacyFixtureSession()
    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ owner: { ...legacyContract().owner, kind } }),
      session: f.session,
      observedAt: OBSERVED_AT,
      survivingProofProvider: async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'synthetic-unavailable-policy' })
    })
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('CHAIN_EVIDENCE_INCOMPLETE')
  })

  test.each([0, 1])('legacy consolidation independently requires target primary account 0, actual account %p', async major => {
    const f = paymentChainFixture()
    const hash = 'a8'.repeat(32)
    const output = ownedVoutForPosition({ majorIndex: major, slotScalar: 101n, outputIndex: 0 })
    const raw = { ...f.chain.audited, txHash: hash, voutKeys: [output], outputIndices: [918], mainPublicKey: publicKeyForScalar(101n), additionalPublicKeys: [] }
    const owned = { ...f.chain.ownedScan[0], txHash: hash, stealthPublicKey: output, outputIndex: 0, accountIndex: major, amountPiconeros: 93n }
    const session = await realSession({ rawRecords: { [hash]: raw, [f.chain.sourceScan.txHash]: f.chain.source }, scanRows: [owned, f.chain.sourceScan], derivation: fullDerivation(), privateViewKey: leHex(6n) })
    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ txHash: hash, owner: { kind: 'CONSOLIDATION', distributionId: null, bountyPaymentId: null, itemId: null }, members: [] }),
      session,
      observedAt: OBSERVED_AT,
      survivingProofProvider: async () => ({ keyBundleHex: leHex(101n), source: 'sender-cache', provenanceId: 'synthetic-consolidation-policy' })
    })
    expect(result.status).toBe(major === 0 ? 'complete' : 'rejected')
    if (major === 1) expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
  })

  test('without surviving proof material the legacy row stays unresolved', async () => {
    const { f } = legacyFixtureSession()
    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract(),
      session: f.session,
      observedAt: OBSERVED_AT
    })
    expect(result.status).toBe('unresolved')
    expect(result.issues).toContain('LEGACY_PROOF_MISSING')
    expect(result.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    expect(result.dispatchId).toBeNull()
    expect(result.proofInventory).toBeNull()
    expect(result.claimDigest).toBeNull()
    expect(result.survivingEvidenceDigest).toBeNull()
    expect(result.journalId).toBeNull()
    expect(validatePaymentVerification(result)).toBe(true)
  })

  test('the synthetic surviving proof passes the same raw/owned/receipt gates and corrects the recorded fee', async () => {
    const { f } = legacyFixtureSession()
    const bundle = paymentTxFixture().keyBundleHex
    const provider = jest.fn(async () => ({
      keyBundleHex: bundle,
      source: 'sender-cache',
      provenanceId: 'test-cache-entry-1'
    }))
    // The recorded fee (5) is wrong on purpose; the raw fee is 7.
    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ recordedFeePiconeros: '5' }),
      session: f.session,
      survivingProofProvider: provider,
      observedAt: OBSERVED_AT
    })
    expect(result.status).toBe('complete')
    expect(result.issues).toContain('LEGACY_RECORDED_FEE_MISMATCH')
    expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
    expect(result.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    expect(result.dispatchId).toBeNull()
    expect(result.proofInventory).toBeNull()
    expect(result.claimDigest).toBeNull()
    expect(result.survivingEvidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(validatePaymentVerification(result)).toBe(true)
    expect(f.session.checkTxKey).toHaveBeenCalledWith(f.txHash, bundle, ADDRESS_A)
    // The digest is scoped to the surviving material + provenance, and moves
    // with the provenance id, never leaking the bundle itself.
    const otherProvenance = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ recordedFeePiconeros: '5' }),
      session: f.session,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: bundle,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-2'
      })),
      observedAt: OBSERVED_AT
    })
    expect(otherProvenance.survivingEvidenceDigest).not.toBe(result.survivingEvidenceDigest)
    expect(JSON.stringify(result)).not.toContain(bundle)
  })

  test('a missing recorded fee is not a drift and a wrong surviving bundle is rejected', async () => {
    const { f } = legacyFixtureSession()
    const bundle = paymentTxFixture().keyBundleHex
    const clean = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ recordedFeePiconeros: null }),
      session: f.session,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: bundle,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(clean.status).toBe('complete')
    expect(clean.issues).toEqual([])

    const wrongBundle = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ recordedFeePiconeros: null }),
      session: f.session,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: 'ee'.repeat(32) + paymentTxFixture().additionalPublicKeys.join(''),
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(wrongBundle.status).toBe('rejected')
    expect(wrongBundle.issues).toContain('KEY_STRUCTURE_MISMATCH')

    const malformed = await verifyLegacyPaymentTransaction({
      contract: legacyContract({ recordedFeePiconeros: null }),
      session: f.session,
      survivingProofProvider: jest.fn(async () => ({ keyBundleHex: bundle, source: 'db-config' })),
      observedAt: OBSERVED_AT
    })
    expect(malformed.status).toBe('unresolved')
    expect(malformed.issues).toContain('SURVIVING_PROOF_INVALID')
  })

  test('legacy payment-id claims and self-paying members are declared unsupported boundaries', async () => {
    const { f } = legacyFixtureSession()
    const bundle = paymentTxFixture({ repeatedRecipient: true }).keyBundleHex
    const aliasFixture = paymentChainFixture({ repeatedRecipient: true })
    const aliasResult = await verifyLegacyPaymentTransaction({
      contract: legacyContract({
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
            address: aliasFixture.chain.externalReceipts[1].address,
            type: 'INTEGRATED',
            paymentId: 'a1b2c3d4e5f60718',
            grossPiconeros: '20',
            actualPiconeros: '20'
          }
        ]
      }),
      session: aliasFixture.session,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: bundle,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(aliasResult.status).toBe('unsupported')
    expect(aliasResult.issues).toContain('PAYMENT_ID_UNSUPPORTED')

    const selfResult = await verifyLegacyPaymentTransaction({
      contract: legacyContract({
        members: [
          legacyContract().members[0],
          {
            id: '12',
            leg: 'PRINCIPAL',
            address: SCOPE.walletAddress,
            type: 'PRIMARY',
            paymentId: null,
            grossPiconeros: '20',
            actualPiconeros: '20'
          }
        ]
      }),
      session: f.session,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: paymentTxFixture().keyBundleHex,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(selfResult.status).toBe('unsupported')
    expect(selfResult.issues).toContain('OWNED_CHANGE_SPLIT_UNSUPPORTED')
  })

  test('a single-secret legacy bundle with a scan-owned change output is not falsely refused (I2)', async () => {
    // Build a genuinely classifiable legacy session: main tx secret r = 21,
    // a scan-owned change output derived on the receiver path (a*R with the
    // wallet view key 6), and one external output to recipient A derived on
    // the sender path. All points are deterministic synthetic scalars.
    const leHex = value => {
      const buffer = Buffer.alloc(32)
      buffer.writeBigUInt64LE(BigInt(value))
      return buffer.toString('hex')
    }
    const rHex = leHex(21)
    const walletViewHex = leHex(6)
    const walletSpend = publicKeyForScalar(5n)
    const mainPublicKey = publicKeyForScalar(21n)
    // Receiver path: Hs(8*6*main || 0)*G + walletSpend — scan-owned change.
    const ownedChangeKey = oneTimeOutputKey({
      publicKey: mainPublicKey,
      secret: walletViewHex,
      publicSpend: walletSpend,
      outputIndex: 0
    })
    // Sender path: Hs(8*21*A_view || 1)*G + A_spend — external recipient A.
    // Identity format is <network>/<spendKey>/<viewKey>.
    const externalKey = oneTimeOutputKey({
      publicKey: baseFixture.members[0].receivingIdentity.split('/')[2],
      secret: rHex,
      publicSpend: baseFixture.members[0].receivingIdentity.split('/')[1],
      outputIndex: 1
    })

    const legacyHash = 'c4'.repeat(32)
    const sourcePrior = {
      txHash: 'e1'.repeat(32),
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: 2999000,
      globalIndex: 690,
      amountPiconeros: 100n,
      stealthPublicKey: paymentChainFixture().chain.sourceScan.stealthPublicKey,
      keyImage: '10'.repeat(32),
      isSpent: true
    }
    const ownedRow = {
      txHash: legacyHash,
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: 2999980,
      globalIndex: 700,
      amountPiconeros: 33n,
      stealthPublicKey: ownedChangeKey,
      keyImage: '0f'.repeat(32),
      isSpent: false
    }
    const raw = {
      txHash: legacyHash,
      feePiconeros: 7n,
      inputKeyImages: [sourcePrior.keyImage],
      voutKeys: [ownedChangeKey, externalKey],
      outputIndices: [700, 701],
      blockHeight: 2999980,
      blockHash: 'd4'.repeat(32),
      confirmations: 21,
      inTxPool: false,
      isCoinbase: false,
      mainPublicKey,
      additionalPublicKeys: []
    }
    const checkTxKey = jest.fn(async (hash, bundle, address) => {
      const receipts = {
        [ADDRESS_A]: { getIsGood: () => true, getReceivedAmount: () => 60n, getInTxPool: () => false, getNumConfirmations: () => 21 }
      }
      return receipts[address] ?? null
    })
    const session = await realSession({
      rawRecords: {
        [legacyHash]: raw,
        ['e1'.repeat(32)]: paymentChainFixture().chain.source
      },
      scanRows: [ownedRow, sourcePrior],
      derivation: fullDerivation(),
      privateViewKey: walletViewHex,
      checkTxKey
    })

    const result = await verifyLegacyPaymentTransaction({
      contract: legacyContract({
        txHash: legacyHash,
        recordedFeePiconeros: null,
        members: [{
          id: '11',
          leg: 'PRINCIPAL',
          address: ADDRESS_A,
          type: 'PRIMARY',
          paymentId: null,
          grossPiconeros: '60',
          actualPiconeros: '60'
        }]
      }),
      session,
      // Single secret-scalar bundle (additionalKeyCount derived from the raw
      // chain keys): correspondence holds via the derived publics.
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: rHex,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(result.issues).not.toContain('KEY_PUBLIC_STRUCTURE_UNSUPPORTED')
    expect(result.issues).not.toContain('KEY_STRUCTURE_MISMATCH')
    expect(result.status).toBe('complete')
    expect(result.issues).toEqual([])
    expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })

    // The false-negative guard stays: an extra UNOWNED, unclassifiable output
    // is still refused — only scan-owned indexes are exempt.
    const withExtra = {
      ...raw,
      voutKeys: [ownedChangeKey, externalKey, 'ee'.repeat(32)],
      outputIndices: [700, 701, 702]
    }
    const extraSession = await realSession({
      rawRecords: {
        [legacyHash]: withExtra,
        ['e1'.repeat(32)]: paymentChainFixture().chain.source
      },
      scanRows: [ownedRow, sourcePrior],
      derivation: fullDerivation(),
      privateViewKey: walletViewHex,
      checkTxKey
    })
    const refused = await verifyLegacyPaymentTransaction({
      contract: legacyContract({
        txHash: legacyHash,
        recordedFeePiconeros: null,
        members: [{
          id: '11',
          leg: 'PRINCIPAL',
          address: ADDRESS_A,
          type: 'PRIMARY',
          paymentId: null,
          grossPiconeros: '60',
          actualPiconeros: '60'
        }]
      }),
      session: extraSession,
      survivingProofProvider: jest.fn(async () => ({
        keyBundleHex: rHex,
        source: 'sender-cache',
        provenanceId: 'test-cache-entry-1'
      })),
      observedAt: OBSERVED_AT
    })
    expect(refused.status).toBe('rejected')
    expect(refused.issues).toContain('KEY_PUBLIC_STRUCTURE_UNSUPPORTED')
  })
})

describe('paymentVerification request validation', () => {
  test('refuses invalid requests before touching anything', async () => {
    await expect(verifyPaymentTransaction({
      models: {},
      journalRole: 'REWARDS',
      journalId: '1',
      session: {},
      keyProvider,
      observedAt: 'not-a-timestamp'
    })).rejects.toThrow(/VERIFICATION_REQUEST_INVALID|PAYMENT_VERIFICATION/)
    await expect(verifyPaymentTransaction({
      models: {},
      journalRole: 'REWARDS',
      journalId: '1',
      session: null,
      keyProvider,
      observedAt: OBSERVED_AT
    })).rejects.toThrow(/VERIFICATION_REQUEST_INVALID|PAYMENT_VERIFICATION/)
  })

  test('evidence refusals carry fixed codes (helper sanity)', () => {
    expect(paymentEvidenceError('RAW_TX_MISSING').code).toBe('RAW_TX_MISSING')
  })
})
