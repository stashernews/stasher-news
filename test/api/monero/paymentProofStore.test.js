/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { checkPaymentProofInventory } from '@/api/monero/paymentProofLifecycle'
import {
  assertPreparedPayment,
  claimPaymentAttempt,
  loadPaymentProof,
  preparePaymentDispatch,
  readPaymentProofInventory
} from '@/api/monero/paymentProofStore'
import { paymentFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'

jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Atomic-pair store tests (Finding #1, Task 3), against the dedicated isolated
// database with REAL seal/open crypto (Task 2) and the Task 1 fixtures. The
// matrix proves the pair barrier end to end: a proof-insert fault rolls back
// the journal AND never reaches relay; a fault after the write phase still
// leaves neither row (neither/both semantics through a real transaction);
// identical preparation re-adopts the ORIGINAL dispatchId/proof; differing
// immutable claims refuse; a legacy row can neither gain proof-era identity
// nor load a bundle; an attempted escrow leg refuses a competing txHash; the
// attempt CAS admits exactly one relay authorization; and an unknown commit
// outcome authorizes nothing until a fresh successful pair read.
//
// The wallet is a fake; `relayTx` throws if ever called (the store must never
// relay). Runs only when DATABASE_URL points at /stasher_rewards_repair_test;
// skipped everywhere else. Run ONLY via the guarded isolated runner.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const HASH = 'f1'.repeat(32)
const HASH_ALT = 'e9'.repeat(32)

// Synthetic throwaway master key (never a real secret).
const keyProvider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
})

const baseFixture = paymentFixture()
const SCOPE = baseFixture.scope
const ADDRESS_A = baseFixture.members[0].address
const ADDRESS_B = baseFixture.members[1].address

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

const escrowOwner = (bountyPaymentId, itemId, overrides = {}) => ({
  journalRole: 'ESCROW',
  kind: 'AWARD',
  bountyPaymentId,
  itemId,
  leg: 'DISPOSITION',
  frozenTerms: escrowFrozenTerms(),
  settlement: null,
  ...overrides
})

const escrowFixtureOverrides = () => ({
  journalRole: 'ESCROW',
  kind: 'AWARD',
  distributionId: null,
  bountyPaymentId: '1',
  itemId: '2',
  feeSubtractedFromLast: true,
  frozenTerms: escrowFrozenTerms()
})

;(ISOLATED_DB ? describe : describe.skip)('payment proof store (isolated DB only)', () => {
  let db
  let bountyIds
  let itemIds
  let userIds
  let distributionIds

  beforeAll(() => {
    db = new PrismaClient()
  })

  beforeEach(() => {
    bountyIds = []
    itemIds = []
    userIds = []
    distributionIds = []
  })

  afterEach(async () => {
    // Fixture-owned cleanup: proofs before owners (Restrict FKs), escrow
    // journals before their BountyPayment — each pair torn down together.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.paymentTransactionProof.deleteMany({ where: { escrowJournal: { walletAddress: SCOPE.walletAddress } } }),
      db.escrowWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } }),
      db.rewardPayout.deleteMany({ where: { distributionId: { in: distributionIds } } }),
      db.rewardDistribution.deleteMany({ where: { id: { in: distributionIds } } }),
      db.bountyPayment.deleteMany({ where: { id: { in: bountyIds } } }),
      db.item.deleteMany({ where: { id: { in: itemIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } })
    ])
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  // --- local helpers (R6: defined here, never shared test modules) -------------

  const makeWallet = (overrides = {}) => ({
    getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
    getNetworkType: jest.fn(async () => 2),
    relayTx: jest.fn(async () => { throw new Error('store must never relay') }),
    ...overrides
  })

  const pairCounts = async () => ({
    hot: await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } }),
    escrow: await db.escrowWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } }),
    proofs: await db.paymentTransactionProof.count({
      where: {
        OR: [
          { rewardsJournal: { walletAddress: SCOPE.walletAddress } },
          { escrowJournal: { walletAddress: SCOPE.walletAddress } }
        ]
      }
    })
  })

  const prepareRewards = (overrides = {}) => preparePaymentDispatch({
    models: db,
    wallet: makeWallet(),
    tx: paymentTxFixture(),
    owner: rewardOwner(),
    keyProvider,
    ...overrides
  })

  const prepareEscrow = (bountyPaymentId, itemId, overrides = {}) => preparePaymentDispatch({
    models: db,
    wallet: makeWallet(),
    tx: paymentTxFixture(escrowFixtureOverrides()),
    owner: escrowOwner(bountyPaymentId, itemId),
    keyProvider,
    ...overrides
  })

  test.each([undefined, null, ADDRESS_A])('captures unavailable SDK change amount with address %p as explicit null', async address => {
    const tx = paymentTxFixture()
    tx.getChangeAddress = () => address
    tx.getChangeAmount = () => undefined
    const { journal } = await prepareRewards({ tx })
    const proof = await loadPaymentProof({ models: db, journalRole: 'REWARDS', journalId: journal.id, keyProvider })
    expect(proof.payload.builtStructure.changeAddress).toBe(address ?? null)
    expect(proof.payload.builtStructure.changeAmountPiconeros).toBeNull()
  })

  test.each([true, false])('preserves repeated reward members with merged destinations %p', async merged => {
    const tx = paymentTxFixture()
    const amounts = merged ? [60n] : [40n, 20n]
    tx.getOutgoingTransfer = () => ({ getDestinations: () => amounts.map(amount => ({ getAddress: () => ADDRESS_A, getAmount: () => amount })) })
    const owner = rewardOwner({
      metadata: {
        payouts: [
          { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 40n },
          { payoutId: 12, recipientAddress: ADDRESS_A, piconeros: 20n }
        ]
      }
    })
    const prepared = await prepareRewards({ tx, owner })
    const loaded = await loadPaymentProof({ models: db, journalRole: 'REWARDS', journalId: prepared.journal.id, keyProvider })
    expect(loaded.claims.members.map(member => member.id)).toEqual(['11', '12'])
    expect(loaded.claims.receivingAggregates).toHaveLength(1)
    expect(loaded.claims.receivingAggregates[0].amountPiconeros).toBe('60')
    expect((await checkPaymentProofInventory({ models: db, keyProvider })).ownerIssues).toEqual([])
  })

  test.each([true, false])('captures shared escrow prize and fee with merged destinations %p in subtraction order', async merged => {
    const { bountyPaymentId, itemId } = await seedEscrowBounty({ feeRecipientAddress: ADDRESS_A })
    const terms = { ...escrowFrozenTerms(), feeRecipientAddress: ADDRESS_A }
    const tx = paymentTxFixture(escrowFixtureOverrides())
    const amounts = merged ? [53n] : [40n, 13n]
    tx.getOutgoingTransfer = () => ({ getDestinations: () => amounts.map(amount => ({ getAddress: () => ADDRESS_A, getAmount: () => amount })) })
    const prepared = await prepareEscrow(bountyPaymentId, itemId, { tx, owner: escrowOwner(bountyPaymentId, itemId, { frozenTerms: terms }) })
    const loaded = await loadPaymentProof({ models: db, journalRole: 'ESCROW', journalId: prepared.journal.id, keyProvider })
    expect(loaded.claims.members).toHaveLength(2)
    expect(loaded.claims.receivingAggregates[0].amountPiconeros).toBe('53')
    expect(loaded.claims.feePolicy.legs.map(leg => leg.leg)).toEqual(['PRINCIPAL', 'FEE'])
    expect((await checkPaymentProofInventory({ models: db, keyProvider })).ownerIssues).toEqual([])
  })

  const seedEscrowBounty = async (payoutOverrides = {}) => {
    const user = await db.user.create({ data: { subs: [] } })
    const item = await db.item.create({
      data: { userId: user.id, subNames: ['proofstore'], bountyPiconeros: 0n, bountyStatus: 'AWARDED' }
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
        state: 'QUEUED',
        ...payoutOverrides
      }
    })
    userIds.push(user.id)
    itemIds.push(item.id)
    bountyIds.push(bounty.id)
    return { bountyPaymentId: bounty.id, itemId: item.id }
  }

  // Proxy ONLY the tx.paymentTransactionProof.create call (R6). Both the outer
  // models object and every transaction-scoped client are wrapped.
  const failProofInsert = client => {
    const failingCreate = async () => { throw new Error('PAYMENT_PROOF_TEST_PROOF_INSERT_FAILED') }
    const wrapModel = model => new Proxy(model, {
      get (target, prop) {
        if (prop === 'create') return failingCreate
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const wrap = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === 'paymentTransactionProof') return wrapModel(Reflect.get(inner, prop, inner))
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return (callback, options) =>
            transactional.call(inner, scoped => callback(wrap(scoped)), options)
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return wrap(client)
  }

  // Fault injected AFTER the full write phase but BEFORE the commit: the
  // store's callback has completed, then the "connection" dies — the whole
  // transaction must roll back (neither/both semantics).
  const failAfterWritePhase = client => {
    const wrap = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return (callback, options) => transactional.call(inner,
            async scoped => {
              await callback(wrap(scoped))
              throw new Error('PAYMENT_PROOF_TEST_CONNECTION_DROPPED')
            }, options)
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return wrap(client)
  }

  // Fault injected AFTER the real COMMIT: the commit landed but the caller
  // learns only a thrown error — the outcome is unknowable from the throw.
  const failAfterCommit = client => {
    const wrap = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return async (callback, options) => {
            await transactional.call(inner, scoped => callback(wrap(scoped)), options)
            throw new Error('PAYMENT_PROOF_TEST_UNKNOWN_COMMIT_OUTCOME')
          }
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return wrap(client)
  }

  // --- the pinned atomicity test -------------------------------------------------

  test('proof insert failure rolls back the journal and never reaches relay', async () => {
    const wallet = makeWallet()
    const models = failProofInsert(db)
    await expect(preparePaymentDispatch({
      models, wallet, tx: paymentTxFixture(), owner: rewardOwner(), keyProvider
    })).rejects.toThrow('PAYMENT_PROOF_TEST_PROOF_INSERT_FAILED')
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(0)
    const { hot, escrow, proofs } = await pairCounts()
    expect({ hot, escrow, proofs }).toEqual({ hot: 0, escrow: 0, proofs: 0 })
    expect(wallet.relayTx).not.toHaveBeenCalled()
  })

  test('a failure after the write phase leaves neither row (commit-after-proof fault)', async () => {
    const wallet = makeWallet()
    await expect(preparePaymentDispatch({
      models: failAfterWritePhase(db), wallet, tx: paymentTxFixture(), owner: rewardOwner(), keyProvider
    })).rejects.toThrow('PAYMENT_PROOF_TEST_CONNECTION_DROPPED')
    const { hot, proofs } = await pairCounts()
    expect({ hot, proofs }).toEqual({ hot: 0, proofs: 0 })
    expect(wallet.relayTx).not.toHaveBeenCalled()
  })

  test('unknown commit outcome authorizes no relay until a fresh pair read authenticates', async () => {
    const wallet = makeWallet()
    await expect(preparePaymentDispatch({
      models: failAfterCommit(db), wallet, tx: paymentTxFixture(), owner: rewardOwner(), keyProvider
    })).rejects.toThrow('PAYMENT_PROOF_TEST_UNKNOWN_COMMIT_OUTCOME')
    // The caller must NOT relay on a thrown preparation: no relay happened.
    expect(wallet.relayTx).not.toHaveBeenCalled()
    // Recovery is a FRESH successful pair read — never inferred absence. The
    // commit may have landed, so idempotent re-preparation adopts whatever
    // identity is durable instead of building a second one.
    const repared = await preparePaymentDispatch({
      models: db, wallet, tx: paymentTxFixture(), owner: rewardOwner(), keyProvider
    })
    expect(repared.created).toBe(false)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(1)
    const verified = await assertPreparedPayment({
      models: db, wallet, tx: paymentTxFixture(), journalRole: 'REWARDS', journalId: repared.journal.id, keyProvider
    })
    expect(verified.proofId).toBe(repared.proofId)
    expect(verified.claimDigest).toBe(repared.claimDigest)
    expect(verified.journal.dispatchId).toBe(repared.dispatchId)
  })

  // --- identical retry / differing claims ----------------------------------------

  test('identical retry returns the ORIGINAL dispatchId and proof unchanged', async () => {
    const first = await prepareRewards()
    expect(first.created).toBe(true)
    expect(first.journal.dispatchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const second = await prepareRewards()
    expect(second.created).toBe(false)
    expect(second.dispatchId).toBe(first.dispatchId)
    expect(second.proofId).toBe(first.proofId)
    expect(second.claimDigest).toBe(first.claimDigest)
    expect(second.revision).toBe(1)
    expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(1)
    expect(await db.paymentTransactionProof.count({
      where: { rewardsJournal: { walletAddress: SCOPE.walletAddress } }
    })).toBe(1)
  })

  test('differing immutable claims reject and never replace the captured pair', async () => {
    const first = await prepareRewards()
    const mutatedOwner = rewardOwner({
      principalPiconeros: 61n,
      metadata: {
        payouts: [
          { payoutId: 11, recipientAddress: ADDRESS_A, piconeros: 41n },
          { payoutId: 12, recipientAddress: ADDRESS_B, piconeros: 20n }
        ]
      }
    })
    await expect(prepareRewards({ owner: mutatedOwner })).rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
    const journal = await db.rewardsWalletTransaction.findUnique({ where: { id: first.journal.id } })
    expect(journal.dispatchId).toBe(first.dispatchId)
    expect(journal.claimDigest).toBe(first.claimDigest)
    expect(journal.principalPiconeros).toBe(60n)
  })

  test('a scoped legacy journal row cannot gain proof-era identity', async () => {
    await db.rewardsWalletTransaction.create({
      data: {
        network: 'STAGENET',
        walletAddress: SCOPE.walletAddress,
        txHash: HASH,
        kind: 'PAYOUT',
        accountIndex: 0,
        principalPiconeros: 60n,
        networkFeePiconeros: 7n,
        metadata: { payouts: [] }
      }
    })
    await expect(prepareRewards()).rejects.toThrow('PAYMENT_PROOF_LEGACY_OWNER')
    const legacy = await db.rewardsWalletTransaction.findFirst({ where: { walletAddress: SCOPE.walletAddress } })
    expect(legacy.dispatchId).toBeNull()
    expect(legacy.proofId).toBeNull()
    expect(legacy.claimDigest).toBeNull()
    // Scoped to this suite's fixture wallets: the shared isolated DB may hold
    // other suites' rows.
    expect(await db.paymentTransactionProof.count({
      where: {
        OR: [
          { rewardsJournal: { walletAddress: SCOPE.walletAddress } },
          { escrowJournal: { walletAddress: SCOPE.walletAddress } }
        ]
      }
    })).toBe(0)
  })

  // --- attempt CAS -----------------------------------------------------------------

  test('claim admits exactly one attempt; the losing CAS cannot re-claim', async () => {
    const prepared = await prepareRewards()
    const expectedProof = { proofId: prepared.proofId, revision: prepared.revision, claimDigest: prepared.claimDigest }
    const claimed = await claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      keyProvider,
      expectedProof
    })
    expect(claimed.proofId).toBe(prepared.proofId)
    expect(claimed.revision).toBe(1)
    expect(claimed.relayAttemptedAt).toBeInstanceOf(Date)
    await expect(claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      keyProvider,
      expectedProof
    })).rejects.toThrow('PAYMENT_PROOF_ATTEMPT_CONFLICT')
    // A stale expectedProof (wrong revision) is refused even while PREPARED.
    const fresh = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: HASH_ALT }),
      owner: rewardOwner(),
      keyProvider
    })
    await expect(claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: HASH_ALT }),
      journalRole: 'REWARDS',
      journalId: fresh.journal.id,
      keyProvider,
      expectedProof: { proofId: fresh.proofId, revision: fresh.revision + 1, claimDigest: fresh.claimDigest }
    })).rejects.toThrow('PAYMENT_PROOF_ATTEMPT_CONFLICT')
    const still = await db.rewardsWalletTransaction.findUnique({ where: { id: fresh.journal.id } })
    expect(still.relayAttemptedAt).toBeNull()
  })

  test('concurrent claims resolve to exactly one winner', async () => {
    const prepared = await prepareRewards()
    const expectedProof = { proofId: prepared.proofId, revision: prepared.revision, claimDigest: prepared.claimDigest }
    const attempt = () => claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      keyProvider,
      expectedProof
    })
    const results = await Promise.allSettled([attempt(), attempt()])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0].reason?.message)).toBe('PAYMENT_PROOF_ATTEMPT_CONFLICT')
  })

  // --- assert / load -----------------------------------------------------------------

  test('assertPreparedPayment returns the authentic pair identity for the same built tx', async () => {
    const prepared = await prepareRewards()
    const asserted = await assertPreparedPayment({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      keyProvider
    })
    expect(asserted.proofId).toBe(prepared.proofId)
    expect(asserted.revision).toBe(prepared.revision)
    expect(asserted.claimDigest).toBe(prepared.claimDigest)
    expect(asserted.journal.id).toBe(prepared.journal.id)
  })

  test('assertPreparedPayment refuses a missing pair and a foreign built tx', async () => {
    await expect(assertPreparedPayment({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture(),
      journalRole: 'REWARDS',
      journalId: 424242n,
      keyProvider
    })).rejects.toThrow('PAYMENT_PROOF_NOT_PREPARED')
    const prepared = await prepareRewards()
    await expect(assertPreparedPayment({
      models: db,
      wallet: makeWallet(),
      tx: paymentTxFixture({ txHash: HASH_ALT }),
      journalRole: 'REWARDS',
      journalId: prepared.journal.id,
      keyProvider
    })).rejects.toThrow('PAYMENT_PROOF_CAPTURE_MISMATCH')
  })

  test('loadPaymentProof authenticates the pair with real crypto and returns the sealed payload', async () => {
    const tx = paymentTxFixture()
    const prepared = await prepareRewards({ tx })
    const loaded = await loadPaymentProof({
      models: db, journalRole: 'REWARDS', journalId: prepared.journal.id, keyProvider
    })
    expect(loaded.claims.dispatchId).toBe(prepared.dispatchId)
    expect(loaded.claims.txHash).toBe(HASH)
    expect(loaded.payload).toEqual(tx.proofPayload)
    expect(loaded.inventory).toEqual({
      proofId: prepared.proofId,
      revision: 1,
      masterKeyVersion: 1,
      bindingVersion: 1,
      envelopeVersion: 1,
      payloadVersion: 1,
      claimDigest: prepared.claimDigest,
      bindingDigest: loaded.inventory.bindingDigest,
      envelopeIntegrityDigest: loaded.inventory.envelopeIntegrityDigest
    })
    expect(loaded.inventory.bindingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.inventory.envelopeIntegrityDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('loadPaymentProof refuses a legacy row with LEGACY_PROOF_MISSING, never an empty bundle', async () => {
    const legacy = await db.rewardsWalletTransaction.create({
      data: {
        network: 'STAGENET',
        walletAddress: SCOPE.walletAddress,
        txHash: HASH,
        kind: 'PAYOUT',
        accountIndex: 0,
        principalPiconeros: 60n,
        networkFeePiconeros: 7n,
        metadata: { payouts: [] }
      }
    })
    await expect(loadPaymentProof({
      models: db, journalRole: 'REWARDS', journalId: legacy.id, keyProvider
    })).rejects.toThrow('LEGACY_PROOF_MISSING')
  })

  test('a tampered envelope fails authentication and changes the integrity digest', async () => {
    const prepared = await prepareRewards()
    const before = await loadPaymentProof({
      models: db, journalRole: 'REWARDS', journalId: prepared.journal.id, keyProvider
    })
    // Rotation-shaped tamper (revision bump keeps the row-level guard happy):
    // flipped envelope bytes must fail GCM authentication at open time.
    await db.$executeRawUnsafe(
      `UPDATE "PaymentTransactionProof"
       SET ciphertext = ciphertext || decode('00','hex'), revision = revision + 1, "updatedAt" = now()
       WHERE id = $1::uuid`, prepared.proofId)
    await expect(loadPaymentProof({
      models: db, journalRole: 'REWARDS', journalId: prepared.journal.id, keyProvider
    })).rejects.toThrow('TXPROOF_ENVELOPE_AUTH_FAILED')
    const after = await db.$queryRawUnsafe(
      'SELECT ciphertext FROM "PaymentTransactionProof" WHERE id = $1::uuid', prepared.proofId)
    expect(after[0].ciphertext.length).toBeGreaterThan(0)
    const inventoryAfterTamper = await readPaymentProofInventory(db, [
      { journalRole: 'REWARDS', journalId: prepared.journal.id }
    ])
    expect(inventoryAfterTamper[0].revision).toBe(2)
    expect(inventoryAfterTamper[0].envelopeIntegrityDigest)
      .not.toBe(before.inventory.envelopeIntegrityDigest)
    expect(inventoryAfterTamper[0].claimDigest).toBe(before.inventory.claimDigest)
  })

  test('readPaymentProofInventory returns the safe projection only', async () => {
    const prepared = await prepareRewards()
    const inventory = await readPaymentProofInventory(db, [
      { journalRole: 'REWARDS', journalId: prepared.journal.id },
      { journalRole: 'REWARDS', journalId: 424242n }
    ])
    expect(inventory).toHaveLength(2)
    // The locked proofInventory shape (safe metadata + integrity digests).
    expect(Object.keys(inventory[0]).sort()).toEqual([
      'bindingDigest', 'bindingVersion', 'claimDigest', 'envelopeIntegrityDigest', 'envelopeVersion',
      'masterKeyVersion', 'payloadVersion', 'proofId', 'revision'
    ])
    expect(inventory[0].proofId).toBe(prepared.proofId)
    expect(inventory[1]).toBeNull()
    const serialized = JSON.stringify(inventory[0])
    expect(serialized).not.toMatch(/ciphertext|nonce|wrappedDek|dataTag|wrapTag/i)
  })

  // --- escrow -------------------------------------------------------------------------

  test('escrow disposition dispatch: atomic pair, load, claim, and leg protection', async () => {
    const seeds = await seedEscrowBounty()
    const tx = paymentTxFixture(escrowFixtureOverrides())
    const prepared = await prepareEscrow(seeds.bountyPaymentId, seeds.itemId, { tx })
    expect(prepared.created).toBe(true)
    expect(prepared.journal.leg).toBe('DISPOSITION')
    expect(prepared.journal.kind).toBe('AWARD')
    expect(prepared.journal.principalPiconeros).toBe(60n)

    // Identical retry keeps the original identity.
    const retry = await prepareEscrow(seeds.bountyPaymentId, seeds.itemId, { tx })
    expect(retry.created).toBe(false)
    expect(retry.dispatchId).toBe(prepared.dispatchId)
    expect(retry.proofId).toBe(prepared.proofId)

    const loaded = await loadPaymentProof({
      models: db, journalRole: 'ESCROW', journalId: prepared.journal.id, keyProvider
    })
    expect(loaded.payload).toEqual(tx.proofPayload)
    expect(loaded.claims.frozenTerms).toEqual(escrowFrozenTerms())

    const expectedProof = { proofId: prepared.proofId, revision: prepared.revision, claimDigest: prepared.claimDigest }
    await claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx,
      journalRole: 'ESCROW',
      journalId: prepared.journal.id,
      keyProvider,
      expectedProof
    })

    // The attempted leg cannot gain a competing txHash.
    await expect(prepareEscrow(seeds.bountyPaymentId, seeds.itemId, {
      tx: paymentTxFixture({ ...escrowFixtureOverrides(), txHash: HASH_ALT })
    })).rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
    const journal = await db.escrowWalletTransaction.findUnique({ where: { id: prepared.journal.id } })
    expect(journal.txHash).toBe(HASH)
    expect(await db.escrowWalletTransaction.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(1)
  })

  test('escrow claims diverging from the frozen BountyPayment terms refuse', async () => {
    const seeds = await seedEscrowBounty({ feePiconeros: 21n })
    await expect(prepareEscrow(seeds.bountyPaymentId, seeds.itemId))
      .rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
  })

  test('escrow legacy separate-fee leg captures the exact fee destination', async () => {
    const seeds = await seedEscrowBounty({
      state: 'SENT',
      txHash: HASH_ALT,
      sentAt: new Date('2026-10-06T00:00:00.000Z'),
      feePendingAt: new Date('2026-10-06T01:00:00.000Z')
    })
    const legacyOverrides = {
      journalRole: 'ESCROW',
      kind: 'LEGACY_SEPARATE_FEE',
      distributionId: null,
      bountyPaymentId: '1',
      itemId: '2',
      members: [{
        id: '1',
        leg: 'LEGACY_SEPARATE_FEE',
        address: ADDRESS_B,
        type: 'SUBADDRESS',
        paymentId: null,
        receivingIdentity: baseFixture.members[1].receivingIdentity,
        grossPiconeros: '20',
        actualPiconeros: '20'
      }]
    }
    const tx = paymentTxFixture(legacyOverrides)
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx,
      owner: escrowOwner(seeds.bountyPaymentId, seeds.itemId, {
        kind: 'LEGACY_SEPARATE_FEE',
        leg: 'LEGACY_SEPARATE_FEE',
        frozenTerms: escrowFrozenTerms()
      }),
      keyProvider
    })
    expect(prepared.created).toBe(true)
    expect(prepared.journal.leg).toBe('LEGACY_SEPARATE_FEE')
    expect(prepared.journal.principalPiconeros).toBe(20n)
    const loaded = await loadPaymentProof({
      models: db, journalRole: 'ESCROW', journalId: prepared.journal.id, keyProvider
    })
    expect(loaded.claims.members[0].leg).toBe('LEGACY_SEPARATE_FEE')
    expect(loaded.claims.members[0].address).toBe(ADDRESS_B)
    expect(loaded.payload).toEqual(tx.proofPayload)
  })

  test('a CONFIRMED payout can still prepare its deferred LEGACY_SEPARATE_FEE leg (matured prize, fee not yet settled)', async () => {
    const seeds = await seedEscrowBounty({
      state: 'CONFIRMED',
      txHash: HASH_ALT,
      sentAt: new Date('2026-10-06T00:00:00.000Z'),
      confirmedAt: new Date('2026-10-06T02:00:00.000Z'),
      feePendingAt: new Date('2026-10-06T01:00:00.000Z')
    })
    const legacyTx = paymentTxFixture({
      journalRole: 'ESCROW',
      kind: 'LEGACY_SEPARATE_FEE',
      distributionId: null,
      bountyPaymentId: String(seeds.bountyPaymentId),
      itemId: String(seeds.itemId),
      members: [{
        id: String(seeds.bountyPaymentId),
        leg: 'LEGACY_SEPARATE_FEE',
        address: ADDRESS_B,
        type: 'SUBADDRESS',
        paymentId: null,
        receivingIdentity: baseFixture.members[1].receivingIdentity,
        grossPiconeros: '20',
        actualPiconeros: '20'
      }]
    })
    const prepared = await preparePaymentDispatch({
      models: db,
      wallet: makeWallet(),
      tx: legacyTx,
      owner: escrowOwner(seeds.bountyPaymentId, seeds.itemId, {
        kind: 'LEGACY_SEPARATE_FEE',
        leg: 'LEGACY_SEPARATE_FEE',
        frozenTerms: escrowFrozenTerms()
      }),
      keyProvider
    })
    expect(prepared.created).toBe(true)
    expect(prepared.journal.state).toBe('PREPARED')
    expect(prepared.journal.leg).toBe('LEGACY_SEPARATE_FEE')
    // The barrier still authorizes exactly one attempt for the deferred fee.
    await claimPaymentAttempt({
      models: db,
      wallet: makeWallet(),
      tx: legacyTx,
      journalRole: 'ESCROW',
      journalId: prepared.journal.id,
      keyProvider,
      expectedProof: { proofId: prepared.proofId, revision: prepared.revision, claimDigest: prepared.claimDigest }
    })
    const claimed = await db.escrowWalletTransaction.findUnique({ where: { id: prepared.journal.id } })
    expect(claimed.state).toBe('PREPARED')
    expect(claimed.relayAttemptedAt).not.toBeNull()
  })

  test('a CONFIRMED payout\u2019s DISPOSITION leg is still refused (a confirmed prize is never re-dispatched)', async () => {
    const seeds = await seedEscrowBounty({
      state: 'CONFIRMED',
      txHash: HASH_ALT,
      sentAt: new Date('2026-10-06T00:00:00.000Z'),
      confirmedAt: new Date('2026-10-06T02:00:00.000Z')
    })
    await expect(prepareEscrow(seeds.bountyPaymentId, seeds.itemId))
      .rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
    expect(await pairCounts()).toEqual({ hot: 0, escrow: 0, proofs: 0 })
  })

  // --- frozen participant contracts (rewards) -------------------------------------------

  test('rewards participant contracts are revalidated inside the transaction', async () => {
    const user = await db.user.create({ data: { subs: [] } })
    userIds.push(user.id)
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-08T00:00:00.000Z'),
        poolPiconeros: 100n,
        status: 'SENDING'
      }
    })
    distributionIds.push(distribution.id)
    const payoutOne = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: user.id, recipientAddress: ADDRESS_A, piconeros: 40n, state: 'QUEUED' }
    })
    const payoutTwo = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: user.id, recipientAddress: ADDRESS_B, piconeros: 20n, state: 'QUEUED' }
    })
    const owner = rewardOwner({
      distributionId: distribution.id,
      metadata: {
        payouts: [
          { payoutId: payoutOne.id, recipientAddress: ADDRESS_A, piconeros: 40n },
          { payoutId: payoutTwo.id, recipientAddress: ADDRESS_B, piconeros: 20n }
        ]
      }
    })
    const prepared = await prepareRewards({ owner })
    expect(prepared.created).toBe(true)
    // A concurrent distributor flipped a payout: the frozen participant set is
    // no longer current, so a NEW dispatch for a different hash must refuse.
    await db.rewardPayout.update({ where: { id: payoutTwo.id }, data: { state: 'SENT' } })
    await expect(prepareRewards({ owner, tx: paymentTxFixture({ txHash: HASH_ALT }) }))
      .rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
    // The committed pair itself stays authentic.
    const retry = await prepareRewards({ owner })
    expect(retry.created).toBe(false)
    expect(retry.proofId).toBe(prepared.proofId)
  })

  // --- scope and built-tx validation -------------------------------------------------------

  test('a wallet that cannot prove the scope is refused', async () => {
    await expect(prepareRewards({
      wallet: makeWallet({ getNetworkType: jest.fn(async () => 0) })
    })).rejects.toThrow(/wallet scope mismatch/)
    await expect(prepareRewards({
      wallet: makeWallet({ getPrimaryAddress: jest.fn(async () => '5NOTTHEWALLET') })
    })).rejects.toThrow(/wallet scope mismatch/)
    expect(await pairCounts()).toEqual({ hot: 0, escrow: 0, proofs: 0 })
  })

  test('a built tx with invalid facts never reaches the journal', async () => {
    await expect(prepareRewards({ tx: paymentTxFixture({ txHash: 'NOTAHASH' }) }))
      .rejects.toThrow('PAYMENT_PROOF_TX_INVALID')
    await expect(prepareRewards({ tx: paymentTxFixture({ txHash: 'zz'.repeat(32) }) }))
      .rejects.toThrow('PAYMENT_PROOF_TX_INVALID')
    const mismatched = paymentTxFixture()
    mismatched.getOutgoingTransfer = () => ({
      getDestinations: () => [{ getAddress: () => ADDRESS_A, getAmount: () => 39n }, { getAddress: () => ADDRESS_B, getAmount: () => 20n }]
    })
    await expect(prepareRewards({ tx: mismatched }))
      .rejects.toThrow('PAYMENT_PROOF_OWNER_CONFLICT')
    expect(await pairCounts()).toEqual({ hot: 0, escrow: 0, proofs: 0 })
  })
})
