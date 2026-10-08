/* eslint-env jest */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { PrismaClient } from '@prisma/client'
import { canonicalPaymentJson } from '@/api/monero/paymentClaims'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import {
  loadPaymentProof,
  preparePaymentDispatch,
  readPaymentProofInventory
} from '@/api/monero/paymentProofStore'
import {
  checkPaymentProofInventory,
  rotatePaymentProofs
} from '@/api/monero/paymentProofLifecycle'
import { runRotationCli } from '@/scripts/rotate-payment-proofs'
import { backupPaymentProofRegistry } from '@/scripts/backup-payment-proof-keys'
import { paymentFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'

jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Payment-proof lifecycle tests (Finding #1, Task 8): paused-writer inventory
// check + key-version rotation, the rotation CLI, and the separately encrypted
// full-registry escrow backup.
//
// DB parts run against the dedicated isolated database with REAL Task 2
// crypto, REAL Task 3 store rows (pairs prepared through preparePaymentDispatch
// with in-memory test master versions) and are gated on the isolated runner
// exactly like the other payment suites. The CLI and backup suites are pure
// (fake models / fake GPG child process / injected clock) and run everywhere.
//
// Secrecy: no key material, envelope bytes or registry values may appear in
// any log, error, argv or pre-encryption file — sentinel scans assert this.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// --- synthetic throwaway registry (never a real secret) -----------------------

const KEY_V1 = Buffer.alloc(32, 11).toString('base64')
const KEY_V2 = Buffer.alloc(32, 13).toString('base64')
const REGISTRY_ENV = {
  TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1, 2: KEY_V2 }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
}
// The rotation provider retains BOTH versions (retention is the whole point).
const provider = createPaymentProofKeyProvider(REGISTRY_ENV)
// Sealing providers pin the version the ORIGINAL capture used; getCurrentVersion
// decides what sealPaymentProof wraps under, so a v1 capture is seeded through a
// registry view whose CURRENT is 1 while both keys stay registered.
const v1Provider = createPaymentProofKeyProvider({
  ...REGISTRY_ENV,
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
})
// A registry that LOST version 1 (key-loss semantics).
const lostV1Provider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 2: KEY_V2 }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
})

// --- shared fixture facts ------------------------------------------------------

const base = paymentFixture()
const SCOPE = base.scope
const ADDRESS_A = base.members[0].address
const ADDRESS_B = base.members[1].address

const HASHES = Object.freeze({
  v1a: 'b1'.repeat(32),
  v1b: 'b2'.repeat(32),
  v1c: 'b3'.repeat(32),
  atTarget: 'b4'.repeat(32),
  corrupt: 'b5'.repeat(32),
  escrow: 'b6'.repeat(32),
  delivery: 'b7'.repeat(32)
})

const journalByHash = async (db, txHash) =>
  db.rewardsWalletTransaction.findUnique({
    where: { network_walletAddress_txHash: { network: SCOPE.network, walletAddress: SCOPE.walletAddress, txHash } }
  })

const fixtureProofScope = () => ({
  OR: [
    { rewardsJournal: { walletAddress: SCOPE.walletAddress } },
    { escrowJournal: { walletAddress: SCOPE.walletAddress } }
  ]
})

// Capture-grade corrupt row: the rotation guard refuses ANY envelope-byte
// change without a strictly increasing revision, so the corruption is shaped
// as a legitimate revisioned update — exactly what a damaged row looks like.
const corruptProofOf = async (db, txHash) => {
  const journal = await journalByHash(db, txHash)
  const proof = await db.paymentTransactionProof.findUnique({ where: { id: journal.proofId } })
  const flipped = Buffer.from(proof.ciphertext)
  flipped[0] ^= 0xff
  await db.paymentTransactionProof.updateMany({
    where: { id: proof.id, revision: proof.revision },
    data: { ciphertext: flipped, revision: proof.revision + 1 }
  })
  return proof.id
}

// Version-attributed counts scoped to THIS suite's fixture rows (never global).
const versionCounts = async db => {
  const rows = await db.paymentTransactionProof.findMany({
    where: fixtureProofScope(),
    select: { masterKeyVersion: true }
  })
  const byVersion = {}
  for (const row of rows) byVersion[row.masterKeyVersion] = (byVersion[row.masterKeyVersion] ?? 0) + 1
  return byVersion
}

// Envelope byte fingerprint (safe digests + hex) used to prove that skipped
// rows are NOT rewrapped and corrupt rows keep their exact old bytes.
const envelopeFingerprint = async (db, txHash, journalRole = 'REWARDS') => {
  const journal = journalRole === 'REWARDS'
    ? await journalByHash(db, txHash)
    : await db.escrowWalletTransaction.findUnique({
      where: { network_walletAddress_txHash: { network: SCOPE.network, walletAddress: SCOPE.walletAddress, txHash } }
    })
  const proof = await db.paymentTransactionProof.findUnique({ where: { id: journal.proofId } })
  const [inventory] = await readPaymentProofInventory(db, { journalRole, journalId: journal.id })
  return {
    proofId: proof.id,
    revision: proof.revision,
    masterKeyVersion: proof.masterKeyVersion,
    ciphertextHex: Buffer.from(proof.ciphertext).toString('hex'),
    dataNonceHex: Buffer.from(proof.dataNonce).toString('hex'),
    wrapNonceHex: Buffer.from(proof.wrapNonce).toString('hex'),
    claimDigest: proof.claimDigest,
    integrity: inventory === null ? null : inventory.envelopeIntegrityDigest
  }
}

const makeLog = () => ({ log: jest.fn(), error: jest.fn() })
const collectedExit = codes => code => { codes.push(code) }
const joinedLogs = log => [...log.log.mock.calls, ...log.error.mock.calls].map(call => call.join(' ')).join('\n')

// Wrap the real client so the transaction-scoped proof CAS can be observed or
// faulted (R6 pattern: proxy ONLY the matching model call, wrapping every
// transaction-scoped client).
const wrapProofCas = (client, around) => {
  const wrapProofModel = model => new Proxy(model, {
    get (target, prop) {
      if (prop === 'updateMany') {
        return async (...args) => {
          await around()
          return Reflect.get(target, prop).apply(target, args)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const wrap = target => new Proxy(target, {
    get (inner, prop) {
      if (prop === 'paymentTransactionProof') return wrapProofModel(Reflect.get(inner, prop, inner))
      if (prop === '$transaction') {
        const transactional = Reflect.get(inner, prop, inner)
        return (callback, options) => transactional.call(inner, scoped => callback(wrap(scoped)), options)
      }
      const value = Reflect.get(inner, prop, inner)
      return typeof value === 'function' ? value.bind(inner) : value
    }
  })
  return wrap(client)
}

// ---------------------------------------------------------------------------
// Pure lifecycle refusals (fake models — no DB)
// ---------------------------------------------------------------------------

describe('payment proof lifecycle request refusals (pure)', () => {
  const emptyModels = {
    paymentTransactionProof: { findMany: async () => [] }
  }

  test('the lifecycle refuses a provider without the locked interface', async () => {
    await expect(checkPaymentProofInventory({ models: emptyModels, keyProvider: {} }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_PROVIDER_INVALID$/)
    await expect(checkPaymentProofInventory({ models: emptyModels, keyProvider: null }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_PROVIDER_INVALID$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: { getMasterKey: () => null, getCurrentVersion: () => 1 }, targetVersion: 1, writersPaused: true }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_PROVIDER_INVALID$/)
  })

  test('an unsupported provider backend stays a fixed refusal', () => {
    expect(() => createPaymentProofKeyProvider({ TXPROOF_MASTER_KEY_PROVIDER: 'kms' }))
      .toThrow(/^TXPROOF_PROVIDER_UNSUPPORTED$/)
  })

  test('rotation requires writersPaused === true', async () => {
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 2 }))
      .rejects.toThrow(/^PROOF_ROTATION_WRITERS_REQUIRED$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 2, writersPaused: false }))
      .rejects.toThrow(/^PROOF_ROTATION_WRITERS_REQUIRED$/)
  })

  test('rotation refuses a target version that is not a provisioned positive integer', async () => {
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 3, writersPaused: true }))
      .rejects.toThrow(/^PROOF_ROTATION_TARGET_NOT_PROVISIONED$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 0, writersPaused: true }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_INVALID$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: -1, writersPaused: true }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_INVALID$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 1.5, writersPaused: true }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_INVALID$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: '2', writersPaused: true }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_INVALID$/)
    await expect(rotatePaymentProofs({ models: emptyModels, keyProvider: provider, targetVersion: 2, writersPaused: true, batchSize: 0 }))
      .rejects.toThrow(/^PROOF_LIFECYCLE_INVALID$/)
  })

  test('check on an empty inventory reports nothing required (safe shape only)', async () => {
    const result = await checkPaymentProofInventory({ models: emptyModels, keyProvider: provider })
    expect(result).toEqual({
      requiredVersions: [],
      missingVersions: [],
      currentVersion: 2,
      ownerIssues: [],
      counts: { proofs: 0, byVersion: {} }
    })
  })

  test('check reports missing owner rows and backlink conflicts without leaking bytes', async () => {
    const proofRow = {
      id: '00000000-0000-4000-8000-00000000aa01',
      revision: 1,
      masterKeyVersion: 1,
      bindingVersion: 1,
      envelopeVersion: 1,
      payloadVersion: 1,
      claimDigest: 'a'.repeat(64),
      bindingDigest: 'b'.repeat(64),
      dataNonce: Buffer.alloc(12, 1),
      dataTag: Buffer.alloc(16, 2),
      ciphertext: Buffer.alloc(32, 3),
      wrapNonce: Buffer.alloc(12, 4),
      wrapTag: Buffer.alloc(16, 5),
      wrappedDek: Buffer.alloc(32, 6),
      rewardsJournalId: 7n,
      escrowJournalId: null
    }
    const ownerlessModels = {
      paymentTransactionProof: { findMany: async () => [proofRow] },
      rewardsWalletTransaction: { findUnique: async () => null },
      escrowWalletTransaction: { findUnique: async () => null }
    }
    const ownerless = await checkPaymentProofInventory({ models: ownerlessModels, keyProvider: provider })
    expect(ownerless.requiredVersions).toEqual([1])
    expect(ownerless.missingVersions).toEqual([])
    expect(ownerless.ownerIssues).toEqual([{
      proofId: proofRow.id,
      journalRole: 'REWARDS',
      journalId: '7',
      code: 'PAYMENT_PROOF_OWNER_MISSING'
    }])

    const mismatchedModels = {
      paymentTransactionProof: { findMany: async () => [proofRow] },
      rewardsWalletTransaction: {
        // The journal points back at a DIFFERENT proof: broken backlink.
        findUnique: async () => ({ id: 7n, proofId: '00000000-0000-4000-8000-00000000aa02', claimDigest: proofRow.claimDigest })
      },
      escrowWalletTransaction: { findUnique: async () => null }
    }
    const mismatched = await checkPaymentProofInventory({ models: mismatchedModels, keyProvider: provider })
    expect(mismatched.ownerIssues).toEqual([{
      proofId: proofRow.id,
      journalRole: 'REWARDS',
      journalId: '7',
      code: 'PAYMENT_PROOF_OWNER_CONFLICT'
    }])
  })
})

// ---------------------------------------------------------------------------
// Rotation / check against the isolated database (real crypto, real store rows)
// ---------------------------------------------------------------------------

;(ISOLATED_DB ? describe : describe.skip)('payment proof lifecycle rotation (isolated DB only)', () => {
  let db
  let seeded

  const makeWallet = () => ({
    getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
    getNetworkType: jest.fn(async () => 2)
  })

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

  const escrowFrozenTerms = () => ({
    recipientAddress: ADDRESS_A,
    prizePiconeros: '40',
    feePiconeros: '20',
    feeRecipientAddress: ADDRESS_B
  })

  const escrowOwner = (bountyPaymentId, itemId) => ({
    journalRole: 'ESCROW',
    kind: 'AWARD',
    bountyPaymentId,
    itemId,
    leg: 'DISPOSITION',
    frozenTerms: escrowFrozenTerms(),
    settlement: null
  })

  const escrowFixtureOverrides = () => ({
    journalRole: 'ESCROW',
    kind: 'AWARD',
    distributionId: null,
    feeSubtractedFromLast: true,
    frozenTerms: escrowFrozenTerms()
  })

  const seedPair = async (tag, sealProvider, overrides = {}) => {
    const tx = paymentTxFixture({ txHash: HASHES[tag], ...overrides.fixture })
    const { journal } = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx,
      owner: rewardOwner(overrides.owner),
      keyProvider: sealProvider
    })
    return journal
  }

  const seedEscrowPair = async (tag, sealProvider) => {
    const user = await db.user.create({ data: { subs: [] } })
    const item = await db.item.create({
      data: { userId: user.id, subNames: ['prooffifecycle'], bountyPiconeros: 0n, bountyStatus: 'AWARDED' }
    })
    const bounty = await db.bountyPayment.create({
      data: {
        itemId: item.id,
        winnerUserId: user.id,
        piconeros: 40n,
        feePiconeros: 20n,
        recipientAddress: ADDRESS_A,
        feeRecipientAddress: ADDRESS_B,
        kind: 'AWARD',
        state: 'QUEUED'
      }
    })
    seeded.bounties.push(bounty.id)
    seeded.items.push(item.id)
    seeded.users.push(user.id)
    const tx = paymentTxFixture({ txHash: HASHES[tag], ...escrowFixtureOverrides() })
    const { journal } = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx,
      owner: escrowOwner(Number(bounty.id), item.id),
      keyProvider: sealProvider
    })
    return journal
  }

  // A distribution-backed pair whose payouts were already PAID (one SENT, one
  // CONFIRMED) and whose relay was durably observed: the recorded delivery the
  // lifecycle must never touch.
  const seedDeliveryPair = async (tag, sealProvider) => {
    const user = await db.user.create({ data: { subs: [] } })
    const distribution = await db.rewardDistribution.create({
      data: { periodStart: new Date(0), periodEnd: new Date(1), poolPiconeros: 60n }
    })
    const payoutA = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: user.id, recipientAddress: ADDRESS_A, piconeros: 40n, state: 'QUEUED' }
    })
    const payoutB = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: user.id, recipientAddress: ADDRESS_B, piconeros: 20n, state: 'QUEUED' }
    })
    seeded.payouts.push(payoutA.id, payoutB.id)
    seeded.distributions.push(distribution.id)
    seeded.users.push(user.id)
    const journal = await seedPair(tag, sealProvider, {
      owner: {
        distributionId: Number(distribution.id),
        metadata: {
          payouts: [
            { payoutId: Number(payoutA.id), recipientAddress: ADDRESS_A, piconeros: 40n },
            { payoutId: Number(payoutB.id), recipientAddress: ADDRESS_B, piconeros: 20n }
          ]
        }
      }
    })
    await db.rewardPayout.updateMany({
      where: { id: { in: [payoutA.id, payoutB.id] } },
      data: { state: 'SENT' }
    })
    await db.rewardPayout.update({ where: { id: payoutB.id }, data: { state: 'CONFIRMED' } })
    await db.rewardsWalletTransaction.update({
      where: { id: journal.id },
      data: { state: 'RELAYED', relayedAt: new Date(2), relayProvenance: 'direct-relay-observation' }
    })
    return journal
  }

  // The full mixed-version fixture from the brief: several valid v1 rows, one
  // already-at-target v2 row, one deliberately corrupt v1 row, an escrow row,
  // and the recorded-delivery row.
  const seedMixedFixture = async () => {
    await seedPair('v1a', v1Provider)
    await seedPair('v1b', v1Provider)
    await seedPair('v1c', v1Provider)
    await seedPair('atTarget', provider)
    await seedPair('corrupt', v1Provider)
    await corruptProofOf(db, HASHES.corrupt)
    await seedEscrowPair('escrow', v1Provider)
    await seedDeliveryPair('delivery', v1Provider)
  }

  // Recorded delivery + principal facts: journal rows (state, principal, fee,
  // metadata, capture tuple, relay bookkeeping) and payout rows (recorded
  // SENT/CONFIRMED delivery). BigInt-safe deep snapshot.
  const protectedDeliverySnapshot = async () => {
    const rows = {
      journals: await db.rewardsWalletTransaction.findMany({
        where: { walletAddress: SCOPE.walletAddress },
        orderBy: { id: 'asc' }
      }),
      escrow: await db.escrowWalletTransaction.findMany({
        where: { walletAddress: SCOPE.walletAddress },
        orderBy: { id: 'asc' }
      }),
      payouts: await db.rewardPayout.findMany({
        where: { distributionId: { in: seeded.distributions } },
        orderBy: { id: 'asc' }
      })
    }
    return JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  }

  const fixtureJournals = async () => {
    const journals = await db.rewardsWalletTransaction.findMany({ where: { walletAddress: SCOPE.walletAddress } })
    const escrow = await db.escrowWalletTransaction.findMany({ where: { walletAddress: SCOPE.walletAddress } })
    return { journals, escrow }
  }

  beforeAll(() => {
    db = new PrismaClient()
  })

  beforeEach(() => {
    seeded = { users: [], items: [], bounties: [], payouts: [], distributions: [] }
  })

  afterEach(async () => {
    jest.clearAllMocks()
    // Fixture-owned cleanup: proofs before owners (Restrict FKs + delete
    // guard); every pair torn down together in one transaction.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: fixtureProofScope() }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.escrowWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.rewardPayout.deleteMany({ where: { distributionId: { in: seeded.distributions } } }),
      db.rewardDistribution.deleteMany({ where: { id: { in: seeded.distributions } } }),
      db.bountyPayment.deleteMany({ where: { id: { in: seeded.bounties } } }),
      db.item.deleteMany({ where: { id: { in: seeded.items } } }),
      db.user.deleteMany({ where: { id: { in: seeded.users } } })
    ])
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  test('check reports required/missing versions, the corrupt row and counts — read-only', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()
    const proofCountBefore = await db.paymentTransactionProof.count({ where: fixtureProofScope() })

    const result = await checkPaymentProofInventory({ models: db, keyProvider: provider })

    expect(result.currentVersion).toBe(2)
    expect(result.requiredVersions).toEqual([1, 2])
    expect(result.missingVersions).toEqual([])
    expect(result.counts.proofs).toBe(proofCountBefore)
    expect(result.counts.byVersion).toEqual({ 1: 6, 2: 1 })
    expect(result.ownerIssues).toHaveLength(1)
    expect(result.ownerIssues[0].code).toBe('TXPROOF_ENVELOPE_AUTH_FAILED')
    expect(result.ownerIssues[0].journalRole).toBe('REWARDS')
    expect(typeof result.ownerIssues[0].proofId).toBe('string')
    // Read-only: no delivery/principal fact moved, and no row changed version.
    expect(await protectedDeliverySnapshot()).toEqual(before)
    expect(await versionCounts(db)).toEqual({ 1: 6, 2: 1 })

    // A registry that lost v1 sees every v1 row as unresolved and reports the
    // missing version — the key-loss inventory story.
    const lost = await checkPaymentProofInventory({ models: db, keyProvider: lostV1Provider })
    expect(lost.requiredVersions).toEqual([1, 2])
    expect(lost.missingVersions).toEqual([1])
    expect(lost.ownerIssues).toHaveLength(6)
    for (const issue of lost.ownerIssues) expect(issue.code).toBe('TXPROOF_KEY_VERSION_MISSING')
    expect(await protectedDeliverySnapshot()).toEqual(before)
  })

  test('interrupted rotation is resumable and leaves old-version corrupt rows intact', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()
    await rotatePaymentProofs({ models: db, keyProvider: provider, targetVersion: 2, writersPaused: true, batchSize: 1 })
    await rotatePaymentProofs({ models: db, keyProvider: provider, targetVersion: 2, writersPaused: true, batchSize: 1 })
    expect(await protectedDeliverySnapshot()).toEqual(before)
    expect((await checkPaymentProofInventory({ models: db, keyProvider: provider })).requiredVersions).toContain(1)
  })

  test('v1→v2 rotation re-seals every row under the target, keeps identity, and reports the corrupt row', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()
    // Fingerprints and journal identity captured BEFORE the rotation.
    const fingerprintsBefore = {}
    for (const tag of ['v1a', 'v1b', 'v1c', 'delivery', 'corrupt', 'atTarget']) {
      fingerprintsBefore[tag] = await envelopeFingerprint(db, HASHES[tag])
    }
    const escrowBefore = await envelopeFingerprint(db, HASHES.escrow, 'ESCROW')
    const journalsBefore = await fixtureJournals()

    const result = await rotatePaymentProofs({
      models: db,
      keyProvider: provider,
      targetVersion: 2,
      writersPaused: true,
      batchSize: 2
    })

    expect(result.rotated).toBe(5)
    expect(result.skipped).toBe(1)
    expect(result.conflicts).toBe(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].code).toBe('TXPROOF_ENVELOPE_AUTH_FAILED')
    expect(result.counts.proofs).toBe(7)
    expect(result.counts.byVersionAfter).toEqual({ 1: 1, 2: 6 })
    expect(await versionCounts(db)).toEqual({ 1: 1, 2: 6 })

    // The corrupt row kept its exact old bytes and version — never dropped,
    // never re-sealed, never counted as rotated or skipped.
    expect(await envelopeFingerprint(db, HASHES.corrupt)).toEqual(fingerprintsBefore.corrupt)

    // The already-at-target row was skipped WITHOUT rewrap: byte-identical.
    expect(await envelopeFingerprint(db, HASHES.atTarget)).toEqual(fingerprintsBefore.atTarget)

    // Rotated rows: version 2, revision +1 exactly, same claim digest, and the
    // journal identity/claim linkage untouched.
    const journalsAfter = await fixtureJournals()
    expect(journalsAfter.journals.map(row => [row.id, row.claimDigest, row.dispatchId, row.proofId]))
      .toEqual(journalsBefore.journals.map(row => [row.id, row.claimDigest, row.dispatchId, row.proofId]))
    for (const tag of ['v1a', 'v1b', 'v1c', 'delivery']) {
      const rowAfter = await envelopeFingerprint(db, HASHES[tag])
      const rowBefore = fingerprintsBefore[tag]
      expect(rowAfter.masterKeyVersion).toBe(2)
      expect(rowAfter.revision).toBe(rowBefore.revision + 1)
      expect(rowAfter.claimDigest).toBe(rowBefore.claimDigest)
      expect(rowAfter.ciphertextHex).not.toBe(rowBefore.ciphertextHex)
      expect(rowAfter.dataNonceHex).not.toBe(rowBefore.dataNonceHex)
    }
    const escrowAfter = await envelopeFingerprint(db, HASHES.escrow, 'ESCROW')
    expect(escrowAfter.masterKeyVersion).toBe(2)
    expect(escrowAfter.revision).toBe(escrowBefore.revision + 1)
    expect(escrowAfter.claimDigest).toBe(escrowBefore.claimDigest)

    // Recorded delivery and principal facts untouched by the whole rotation.
    expect(await protectedDeliverySnapshot()).toEqual(before)

    // The provider still retains BOTH versions — rotation never drops a key.
    expect(provider.getRegisteredVersions()).toEqual([1, 2])

    // Every ROTATED pair still authenticates through the real store, now
    // under the target version — even with a registry that lost v1. (The
    // corrupt fixture row stays v1 and is exercised by the full provider
    // elsewhere; a lost-v1 registry correctly cannot open it.)
    for (const row of journalsAfter.journals) {
      if (row.dispatchId === null) continue
      const proof = await db.paymentTransactionProof.findUnique({ where: { id: row.proofId } })
      if (proof.masterKeyVersion !== 2) continue
      const loaded = await loadPaymentProof({
        models: db,
        journalRole: 'REWARDS',
        journalId: row.id,
        keyProvider: lostV1Provider
      })
      expect(loaded.inventory.masterKeyVersion).toBe(2)
      expect(loaded.claims.dispatchId).toBe(row.dispatchId)
    }
    const escrowRow = journalsAfter.escrow[0]
    const escrowLoaded = await loadPaymentProof({
      models: db,
      journalRole: 'ESCROW',
      journalId: escrowRow.id,
      keyProvider: lostV1Provider
    })
    expect(escrowLoaded.inventory.masterKeyVersion).toBe(2)
  })

  test('an interrupted (killed) rotation aborts fail-closed and resumes cleanly', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()

    let casCalls = 0
    const killer = wrapProofCas(db, async () => {
      casCalls += 1
      if (casCalls === 2) throw new Error('PAYMENT_PROOF_TEST_KILLED_MID_ROTATION')
    })
    await expect(rotatePaymentProofs({
      models: killer,
      keyProvider: provider,
      targetVersion: 2,
      writersPaused: true,
      batchSize: 2
    })).rejects.toThrow('PAYMENT_PROOF_TEST_KILLED_MID_ROTATION')

    // Exactly the first row landed; the interrupted transaction left nothing.
    expect(await versionCounts(db)).toEqual({ 1: 5, 2: 2 })
    expect(await protectedDeliverySnapshot()).toEqual(before)

    // Resume: the run skips the already-rotated row, finishes the rest, and
    // still reports the corrupt v1 row.
    const result = await rotatePaymentProofs({
      models: db,
      keyProvider: provider,
      targetVersion: 2,
      writersPaused: true,
      batchSize: 2
    })
    expect(result.rotated).toBe(4)
    expect(result.skipped).toBe(2)
    expect(result.conflicts).toBe(0)
    expect(result.issues).toHaveLength(1)
    expect(await versionCounts(db)).toEqual({ 1: 1, 2: 6 })
    expect(await protectedDeliverySnapshot()).toEqual(before)
  })

  test('a row whose revision changed under the rotation is a PROOF_ROTATION_CONFLICT and is never touched', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()
    // A VALID row is the conflict target (the corrupt fixture row fails
    // authentication before it could ever reach a CAS).
    const targetJournal = await journalByHash(db, HASHES.v1b)

    // A concurrent writer wins the race exactly once, before our first CAS:
    // a legitimate revisioned envelope change on the conflict target.
    let touched = false
    const racing = wrapProofCas(db, async () => {
      if (touched) return
      touched = true
      const proof = await db.paymentTransactionProof.findUnique({ where: { id: targetJournal.proofId } })
      const flipped = Buffer.from(proof.ciphertext)
      flipped[0] ^= 0x55
      await db.paymentTransactionProof.updateMany({
        where: { id: proof.id, revision: proof.revision },
        data: { ciphertext: flipped, revision: proof.revision + 1 }
      })
    })

    const result = await rotatePaymentProofs({
      models: racing,
      keyProvider: provider,
      targetVersion: 2,
      writersPaused: true,
      batchSize: 3
    })

    expect(result.conflicts).toBe(1)
    expect(result.issues).toHaveLength(2) // the conflict + the corrupt fixture row
    const conflictIssue = result.issues.find(issue => issue.code === 'PROOF_ROTATION_CONFLICT')
    expect(conflictIssue.proofId).toBe(targetJournal.proofId)
    expect(result.rotated).toBe(4)
    expect(result.skipped).toBe(1)
    expect(await versionCounts(db)).toEqual({ 1: 2, 2: 5 })
    // The concurrent writer's state stands; our run did not clobber it.
    const proof = await db.paymentTransactionProof.findUnique({ where: { id: targetJournal.proofId } })
    expect(proof.masterKeyVersion).toBe(1)
    expect(proof.revision).toBe(2)
    expect(await protectedDeliverySnapshot()).toEqual(before)
  })

  test('rotation with a registry that lost the old key rotates nothing and retains every v1 row', async () => {
    await seedMixedFixture()
    const before = await protectedDeliverySnapshot()
    const fingerprints = {}
    for (const tag of ['v1a', 'v1b', 'v1c', 'corrupt', 'delivery']) {
      fingerprints[tag] = await envelopeFingerprint(db, HASHES[tag])
    }

    const result = await rotatePaymentProofs({
      models: db,
      keyProvider: lostV1Provider,
      targetVersion: 2,
      writersPaused: true
    })

    expect(result.rotated).toBe(0)
    expect(result.skipped).toBe(1) // the already-at-target v2 row still verifies
    expect(result.conflicts).toBe(0)
    expect(result.issues).toHaveLength(6)
    for (const issue of result.issues) expect(issue.code).toBe('TXPROOF_KEY_VERSION_MISSING')
    for (const tag of Object.keys(fingerprints)) {
      expect(await envelopeFingerprint(db, HASHES[tag])).toEqual(fingerprints[tag])
    }
    expect(await protectedDeliverySnapshot()).toEqual(before)
    // Structural retention: the lifecycle never mutates the registry.
    expect(lostV1Provider.getRegisteredVersions()).toEqual([2])
    expect(provider.getRegisteredVersions()).toEqual([1, 2])
  })

  test('the rotation CLI drives the same locked path and never prints key material', async () => {
    await seedMixedFixture()
    const log = makeLog()
    const exits = []
    const before = await protectedDeliverySnapshot()

    // --check is the DEFAULT and is read-only. On the mixed fixture it
    // reports the corrupt row (exit 2 — never silent about corruption).
    await runRotationCli({
      argv: [],
      env: REGISTRY_ENV,
      models: db,
      keyProvider: provider,
      log,
      exit: collectedExit(exits)
    })
    expect(exits).toEqual([2])
    expect(joinedLogs(log)).toContain('tx-proof-check')
    expect(joinedLogs(log)).toContain('TXPROOF_ENVELOPE_AUTH_FAILED')
    expect(await protectedDeliverySnapshot()).toEqual(before)

    // Mutation refuses without ALL FOUR flags and on any mismatch.
    for (const argv of [
      ['--rotate'],
      ['--rotate', '--target-version', '2', '--writers-paused'],
      ['--rotate', '--target-version', '2', '--confirm-version', '2'],
      ['--rotate', '--writers-paused', '--confirm-version', '2'],
      ['--rotate', '--target-version', '2', '--writers-paused', '--confirm-version', '3'],
      ['--rotate', '--target-version', 'x', '--writers-paused', '--confirm-version', '2'],
      ['--rotate', '--target-version', '0', '--writers-paused', '--confirm-version', '0'],
      ['--check', '--rotate'],
      ['--bogus']
    ]) {
      const refusalExits = []
      await runRotationCli({
        argv,
        env: REGISTRY_ENV,
        models: db,
        keyProvider: provider,
        log,
        exit: collectedExit(refusalExits)
      })
      expect(refusalExits).toEqual([1])
    }
    expect(await protectedDeliverySnapshot()).toEqual(before)

    // The real mutation path through the CLI seam: same counts as the direct
    // call; the corrupt row makes the run report issues (exit 2, never 0).
    const mutationLog = makeLog()
    const mutationExits = []
    await runRotationCli({
      argv: ['--rotate', '--target-version', '2', '--writers-paused', '--confirm-version', '2'],
      env: REGISTRY_ENV,
      models: db,
      keyProvider: provider,
      log: mutationLog,
      exit: collectedExit(mutationExits)
    })
    expect(mutationExits).toEqual([2])
    const output = joinedLogs(mutationLog)
    expect(output).toContain('rotated=5')
    expect(output).toContain('skipped=1')
    expect(output).toContain('conflicts=0')
    expect(output).toContain('issues=1')
    expect(await versionCounts(db)).toEqual({ 1: 1, 2: 6 })
    expect(await protectedDeliverySnapshot()).toEqual(before)

    // Sentinel scan: no key material anywhere in CLI output or errors.
    const everything = joinedLogs(log) + '\n' + joinedLogs(mutationLog)
    expect(everything).not.toContain(KEY_V1)
    expect(everything).not.toContain(KEY_V2)
    expect(everything).not.toContain('TXPROOF_MASTER_KEYS')
  })
})

// ---------------------------------------------------------------------------
// Rotation CLI (pure — fake models, no DB)
// ---------------------------------------------------------------------------

describe('rotate-payment-proofs CLI argument surface (pure)', () => {
  const emptyModels = { paymentTransactionProof: { findMany: async () => [] } }

  test('a misconfigured registry env refuses with the provider fixed code and exit 1', async () => {
    const log = makeLog()
    const exits = []
    await runRotationCli({ argv: [], env: {}, models: emptyModels, log, exit: collectedExit(exits) })
    expect(exits).toEqual([1])
    expect(joinedLogs(log)).toContain('TXPROOF_REGISTRY_INVALID')
  })

  test('an unexpected model failure exits with the fixed failed label (exit 3)', async () => {
    const log = makeLog()
    const exits = []
    const brokenModels = {
      paymentTransactionProof: {
        findMany: async () => { throw new Error('ECONNRESET driver text that must never be printed') }
      }
    }
    await runRotationCli({ argv: [], env: REGISTRY_ENV, models: brokenModels, log, exit: collectedExit(exits) })
    expect(exits).toEqual([3])
    const output = joinedLogs(log)
    expect(output).not.toContain('ECONNRESET')
    expect(output).not.toContain('driver text')
    expect(output).toContain('PROOF_ROTATION_CLI_FAILED')
  })

  test('check issues exit 2; clean checks exit 0', async () => {
    const issueRow = {
      id: '00000000-0000-4000-8000-00000000bb01',
      revision: 1,
      masterKeyVersion: 9,
      bindingVersion: 1,
      envelopeVersion: 1,
      payloadVersion: 1,
      claimDigest: 'c'.repeat(64),
      bindingDigest: 'd'.repeat(64),
      dataNonce: Buffer.alloc(12, 1),
      dataTag: Buffer.alloc(16, 2),
      ciphertext: Buffer.alloc(32, 3),
      wrapNonce: Buffer.alloc(12, 4),
      wrapTag: Buffer.alloc(16, 5),
      wrappedDek: Buffer.alloc(32, 6),
      rewardsJournalId: 3n,
      escrowJournalId: null
    }
    const missingOwnerModels = {
      paymentTransactionProof: { findMany: async () => [issueRow] },
      rewardsWalletTransaction: { findUnique: async () => null },
      escrowWalletTransaction: { findUnique: async () => null }
    }
    const log = makeLog()
    const exits = []
    await runRotationCli({
      argv: ['--check'],
      env: REGISTRY_ENV,
      models: missingOwnerModels,
      keyProvider: provider,
      log,
      exit: collectedExit(exits)
    })
    expect(exits).toEqual([2])
    expect(joinedLogs(log)).toContain('PAYMENT_PROOF_OWNER_MISSING')
  })
})

// ---------------------------------------------------------------------------
// backup-payment-proof-keys (pure — fake GPG process, injected clock)
// ---------------------------------------------------------------------------

describe('backup-payment-proof-keys registry escrow (pure, fake gpg)', () => {
  let workDir
  let backupDir
  let elsewhereDir
  const backupParent = () => path.dirname(backupDir)

  const baseEnv = () => ({
    TXPROOF_MASTERKEY_BACKUP_DIR: backupDir,
    BACKUP_PUBLIC_KEY: 'ops@example',
    BACKUP_DIR: elsewhereDir,
    TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1, 2: KEY_V2 }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '2',
    PATH: '/usr/bin:/bin',
    HOME: path.dirname(backupDir),
    AMBIENT_SECRET_SENTINEL: 'AMBIENT_SECRET_SENTINEL-value'
  })

  const now = () => new Date('2026-10-07T01:02:03.000Z')
  const finalName = 'txproof-keys-v2-20261007T010203Z.gpg'

  const makeSpawnGpg = ({ exitCode = 0, ciphertext = Buffer.from('GPG-CIPHERTEXT-OUTPUT'), stderrText = '', spawnError = null } = {}) => {
    const spawnGpg = (args, options) => {
      spawnGpg.calls.push({ args, options })
      const stdin = new PassThrough()
      const stdinChunks = []
      stdin.on('data', chunk => stdinChunks.push(chunk))
      const stdout = new Readable({ read () {} })
      const stderr = new PassThrough()
      stderr.on('data', () => {}) // drained; production must never echo it
      const child = new EventEmitter()
      child.stdin = stdin
      child.stdout = stdout
      child.stderr = stderr
      process.nextTick(() => {
        stdout.push(ciphertext)
        stdout.push(null)
        if (stderrText !== '') stderr.write(stderrText)
        if (spawnError !== null) child.emit('error', spawnError)
        else child.emit('exit', exitCode, null)
      })
      spawnGpg.stdinChunks = stdinChunks
      return child
    }
    spawnGpg.calls = []
    spawnGpg.stdinChunks = []
    return spawnGpg
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txproof-backup-'))
    backupDir = path.join(workDir, 'tx-escrow')
    elsewhereDir = path.join(workDir, 'db-backups')
    fs.mkdirSync(elsewhereDir)
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  test('encrypts the COMPLETE registry to gpg stdin and publishes exclusive 0600 ciphertext', async () => {
    const spawnGpg = makeSpawnGpg()
    const result = await backupPaymentProofRegistry({ env: baseEnv(), spawnGpg, now })

    expect(result.file).toBe(path.join(backupDir, finalName))
    expect(result.versions).toBe(2)
    expect(result.currentVersion).toBe(2)

    // Exactly one file: the published ciphertext (the partial is gone).
    expect(fs.readdirSync(backupDir)).toEqual([finalName])
    expect(fs.readFileSync(result.file)).toEqual(Buffer.from('GPG-CIPHERTEXT-OUTPUT'))
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600)

    // gpg was spawned WITHOUT a shell, with the exact pinned arguments, a
    // bounded lifetime and a MINIMAL environment (final-review M4): ambient
    // secrets never reach the crypto child — only PATH and HOME cross.
    expect(spawnGpg.calls).toHaveLength(1)
    expect(spawnGpg.calls[0].args).toEqual([
      '--batch', '--yes', '--trust-model', 'always',
      '--recipient', 'ops@example', '--encrypt'
    ])
    expect(spawnGpg.calls[0].options).toEqual({
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: backupParent() },
      timeout: expect.any(Number)
    })
    // Ambient secrets (a loader-exported sentinel) never reach the child env.
    const childEnvJson = JSON.stringify(spawnGpg.calls[0].options.env)
    expect(childEnvJson).not.toContain('AMBIENT_SECRET_SENTINEL')

    // The document is closed, carries EVERY version + the current mapping, and
    // reaches gpg ONLY through stdin in canonical form.
    const stdinText = Buffer.concat(spawnGpg.stdinChunks).toString('utf8')
    const document = JSON.parse(stdinText)
    expect(document).toEqual({
      registry: 'tx-proof',
      backupVersion: 1,
      currentVersion: 2,
      keys: [
        { version: 1, masterKey: KEY_V1 },
        { version: 2, masterKey: KEY_V2 }
      ],
      formats: { binding: 1, envelope: 1, payload: 1 }
    })
    expect(stdinText).toBe(canonicalPaymentJson(document))

    // No key material in argv or spawn options; the sentinel base64 never
    // reaches the command line or any pre-encryption file.
    const leakScan = JSON.stringify(spawnGpg.calls[0])
    expect(leakScan).not.toContain(KEY_V1)
    expect(leakScan).not.toContain(KEY_V2)
    expect(fs.readFileSync(result.file, 'utf8')).not.toContain(KEY_V1)
  })

  test('a non-zero gpg exit removes ONLY this run\'s partial and never echoes stderr', async () => {
    const spawnGpg = makeSpawnGpg({ exitCode: 2, stderrText: 'gpg: SECRET-STDERR-DETAIL' })
    await expect(backupPaymentProofRegistry({ env: baseEnv(), spawnGpg, now }))
      .rejects.toThrow(/^PROOF_BACKUP_GPG_FAILED$/)
    expect(fs.readdirSync(backupDir)).toEqual([])
  })

  test('a spawn failure (error event) fails closed with the same fixed code', async () => {
    const spawnGpg = makeSpawnGpg({ spawnError: new Error('spawn gpg ENOENT') })
    await expect(backupPaymentProofRegistry({ env: baseEnv(), spawnGpg, now }))
      .rejects.toThrow(/^PROOF_BACKUP_GPG_FAILED$/)
    expect(fs.readdirSync(backupDir)).toEqual([])
  })

  test('an existing backup can never be overwritten', async () => {
    fs.mkdirSync(backupDir)
    const existing = path.join(backupDir, finalName)
    fs.writeFileSync(existing, 'EXISTING-BYTES')
    const spawnGpg = makeSpawnGpg()
    await expect(backupPaymentProofRegistry({ env: baseEnv(), spawnGpg, now }))
      .rejects.toThrow(/^PROOF_BACKUP_EXISTS$/)
    expect(fs.readFileSync(existing, 'utf8')).toBe('EXISTING-BYTES')
    expect(fs.readdirSync(backupDir)).toEqual([finalName])
  })

  test('missing env, invalid registries and unvalidatable keys refuse with fixed codes', async () => {
    const spawnGpg = makeSpawnGpg()
    await expect(backupPaymentProofRegistry({
      env: { ...baseEnv(), TXPROOF_MASTERKEY_BACKUP_DIR: '' },
      spawnGpg,
      now
    })).rejects.toThrow(/^PROOF_BACKUP_ENV_MISSING$/)
    await expect(backupPaymentProofRegistry({
      env: { ...baseEnv(), BACKUP_PUBLIC_KEY: undefined },
      spawnGpg,
      now
    })).rejects.toThrow(/^PROOF_BACKUP_ENV_MISSING$/)
    await expect(backupPaymentProofRegistry({
      env: { TXPROOF_MASTERKEY_BACKUP_DIR: backupDir, BACKUP_PUBLIC_KEY: 'ops@example' },
      spawnGpg,
      now
    })).rejects.toThrow(/^TXPROOF_REGISTRY_INVALID$/)
    await expect(backupPaymentProofRegistry({
      env: {
        ...baseEnv(),
        TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1 }),
        TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
      },
      spawnGpg,
      now
    })).rejects.toThrow(/^TXPROOF_KEY_VERSION_MISSING$/)
    await expect(backupPaymentProofRegistry({
      env: {
        ...baseEnv(),
        TXPROOF_MASTER_KEYS: JSON.stringify({ 1: 'not-valid-base64!' }),
        TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
      },
      spawnGpg,
      now
    })).rejects.toThrow(/^TXPROOF_REGISTRY_KEY_INVALID$/)
    expect(fs.existsSync(backupDir)).toBe(false)
  })

  test('co-location with the DB backup dir is refused in every direction (symlinks resolved)', async () => {
    const spawnGpg = makeSpawnGpg()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'txproof-colocate-'))
    try {
      const dbDir = path.join(root, 'db')
      fs.mkdirSync(dbDir)
      const linkToDb = path.join(root, 'link-to-db')
      fs.symlinkSync(dbDir, linkToDb)

      // Equality, TX-inside-DB, DB-inside-TX, and both symlink directions.
      const txPaths = [dbDir, path.join(root, 'db', 'sub'), root, linkToDb]
      for (const txPath of txPaths) {
        await expect(backupPaymentProofRegistry({
          env: { ...baseEnv(), TXPROOF_MASTERKEY_BACKUP_DIR: txPath, BACKUP_DIR: dbDir },
          spawnGpg,
          now
        })).rejects.toThrow(/^PROOF_BACKUP_DIR_COLOCATED$/)
      }
      // Reverse: the DB dir reached through a symlink into the TX dir.
      const txReal = path.join(root, 'tx-escrow-real')
      fs.mkdirSync(txReal)
      const linkToTx = path.join(root, 'link-to-tx')
      fs.symlinkSync(txReal, linkToTx)
      await expect(backupPaymentProofRegistry({
        env: { ...baseEnv(), TXPROOF_MASTERKEY_BACKUP_DIR: txReal, BACKUP_DIR: linkToTx },
        spawnGpg,
        now
      })).rejects.toThrow(/^PROOF_BACKUP_DIR_COLOCATED$/)

      // The guard runs BEFORE any directory creation: nothing was made.
      expect(fs.existsSync(backupDir)).toBe(false)
      expect(fs.existsSync(path.join(root, 'tx'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a fresh non-colocated backup dir is created on demand', async () => {
    const env = baseEnv()
    env.TXPROOF_MASTERKEY_BACKUP_DIR = path.join(workDir, 'fresh', 'nested')
    const spawnGpg = makeSpawnGpg()
    const result = await backupPaymentProofRegistry({ env, spawnGpg, now })
    expect(fs.existsSync(result.file)).toBe(true)
    expect(fs.readdirSync(path.join(workDir, 'fresh', 'nested'))).toEqual([finalName])
  })
})
