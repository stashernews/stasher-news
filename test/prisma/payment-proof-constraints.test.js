/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { Client } from 'pg'

// Real-DB constraint tests for the payment-proof pair storage (Finding #1,
// Task 3): the exactly-one-owner CHECK, envelope byte/digest/version CHECKs,
// the DEFERRABLE INITIALLY DEFERRED pair-integrity triggers (a mismatch rolls
// back ONLY at COMMIT — a mid-transaction repair commits), the immutability
// triggers over captured journal facts and the rotation-only proof update
// path, the legacy-promotion barrier, escrow kind/leg consistency, and the
// unique constraints. Everything is exercised through raw SQL against the
// dedicated isolated database so the constraints are tested beneath the
// generated client.
//
// Commit-time failures are proven through a RAW pg connection: PostgreSQL
// rejects the COMMIT itself (the deferred trigger's fixed code is the error),
// and the rollback leaves nothing behind. Prisma's interactive transactions
// do not surface deferred-commit failures (the client resolves; the server
// still rolls back — asserted via row absence), so the authoritative
// commit-failure assertions use the driver the server actually talks to.
// Failure probes that fire mid-statement run in autocommit (one statement =
// one transaction) so a rejected statement never poisons a live transaction.
//
// Fixture cleanup deletes each owner/pair TOGETHER (proof first, then owner,
// in one transaction) so no pair invariant is ever severed mid-cleanup, and
// only rows this suite created are touched. Runs only when DATABASE_URL
// points at /stasher_rewards_repair_test (the isolated runner); skipped
// everywhere else so ordinary dev-DB collection neither crashes nor touches
// that database. Run ONLY via:
//   /tmp/opencode/mainnet-fix-execution/run-isolated-test.sh --runInBand \
//     --runTestsByPath test/prisma/payment-proof-constraints.test.js

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const WALLET = '5PROOFCONSTTEST'
const DIGEST_A = 'ab'.repeat(32)
const DIGEST_B = 'cd'.repeat(32)
const HASH_A = 'a1'.repeat(32)
const HASH_B = 'b2'.repeat(32)
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

;(ISOLATED_DB ? describe : describe.skip)('payment proof pair constraints (isolated DB only)', () => {
  let db
  let bountyIds
  let itemIds
  let userIds

  beforeAll(() => {
    db = new PrismaClient()
  })

  beforeEach(() => {
    bountyIds = []
    itemIds = []
    userIds = []
  })

  afterEach(async () => {
    // Fixture-owned cleanup only: proofs before their owners (Restrict FKs),
    // escrow journals before their BountyPayment, each pair torn down together.
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: WALLET } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: WALLET } }),
      db.paymentTransactionProof.deleteMany({ where: { escrowJournal: { walletAddress: WALLET } } }),
      db.escrowWalletTransaction.deleteMany({ where: { walletAddress: WALLET } }),
      db.bountyPayment.deleteMany({ where: { id: { in: bountyIds } } }),
      db.item.deleteMany({ where: { id: { in: itemIds } } }),
      db.user.deleteMany({ where: { id: { in: userIds } } })
    ])
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  // --- raw-SQL fixture writers (the constraints live beneath the client) -----

  const insertHotJournal = async (client, {
    txHash = HASH_A,
    dispatchId = null,
    proofId = null,
    claimDigest = null,
    legacy = false
  } = {}) => {
    const rows = legacy
      ? await client.$queryRawUnsafe(
        `INSERT INTO "RewardsWalletTransaction"
           ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata")
         VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb)
         RETURNING id`, WALLET, txHash)
      : await client.$queryRawUnsafe(
        `INSERT INTO "RewardsWalletTransaction"
           ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata",
            "dispatchId","captureContractVersion","claimDigest","paymentClaims","proofId")
         VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,
           '{"payouts":[{"payoutId":1,"recipientAddress":"5A","piconeros":"60"}]}'::jsonb,
         $3::uuid, 1, $4, '{"captured":true}'::jsonb, $5::uuid)
         RETURNING id`, WALLET, txHash, dispatchId, claimDigest, proofId)
    return rows[0].id
  }

  const insertEscrowSeeds = async client => {
    const user = await client.$queryRawUnsafe(
      'INSERT INTO users ("subs") VALUES (ARRAY[]::text[]) RETURNING id')
    const item = await client.$queryRawUnsafe(
      `INSERT INTO "Item" ("userId","subNames","bountyPiconeros","bountyStatus")
       VALUES ($1, ARRAY['proofconstraints']::citext[], 0, 'AWARDED'::"BountyStatus") RETURNING id`, user[0].id)
    const bounty = await client.$queryRawUnsafe(
      `INSERT INTO "BountyPayment"
         ("itemId","winnerUserId","piconeros","feePiconeros","recipientAddress","feeRecipientAddress","kind","state")
       VALUES ($1,$2,40,20,'5BENEFICIARY','5FEECOLLECTOR','AWARD','QUEUED'::"BountyPayoutState") RETURNING id`,
      item[0].id, user[0].id)
    userIds.push(Number(user[0].id))
    itemIds.push(Number(item[0].id))
    bountyIds.push(Number(bounty[0].id))
    return { bountyPaymentId: Number(bounty[0].id), itemId: Number(item[0].id) }
  }

  const insertEscrowJournal = (client, {
    txHash = HASH_A,
    dispatchId,
    proofId,
    claimDigest = DIGEST_A,
    bountyPaymentId,
    itemId,
    kind = 'AWARD',
    leg = 'DISPOSITION'
  }) => client.$queryRawUnsafe(
    `INSERT INTO "EscrowWalletTransaction"
       ("network","walletAddress","txHash","dispatchId","proofId","captureContractVersion","claimDigest","paymentClaims",
        "kind","leg","bountyPaymentId","itemId","accountIndex","principalPiconeros","networkFeePiconeros","metadata")
     VALUES ('STAGENET',$1,$2,$3::uuid,$4::uuid,1,$5,'{"captured":true}'::jsonb,
             $6::"EscrowWalletTxKind",$7::"EscrowPaymentLeg",$8,$9,0,60,7,'{"leg":true}'::jsonb)
     RETURNING id`,
    WALLET, txHash, dispatchId, proofId, claimDigest, kind, leg, bountyPaymentId, itemId)

  const insertProof = (client, {
    id,
    hot = null,
    escrow = null,
    claimDigest = DIGEST_A,
    bindingDigest = DIGEST_A,
    revision = 1,
    masterKeyVersion = 1,
    bindingVersion = 1,
    envelopeVersion = 1,
    payloadVersion = 1,
    dataNonceHex = '000102030405060708090a0b',
    dataTagHex = '101112131415161718191a1b1c1d1e1f',
    ciphertextHex = 'ff',
    wrapNonceHex = '0102030405060708090a0b0c',
    wrapTagHex = '202122232425262728292a2b2c2d2e2f',
    wrappedDekHex = '303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f'
  } = {}) => client.$executeRawUnsafe(
    `INSERT INTO "PaymentTransactionProof"
       ("id","rewardsJournalId","escrowJournalId","revision","masterKeyVersion","bindingVersion","envelopeVersion",
        "payloadVersion","claimDigest","bindingDigest","dataNonce","dataTag","ciphertext","wrapNonce","wrapTag","wrappedDek","updatedAt")
     VALUES ($1::uuid,$2::bigint,$3::bigint,$4,$5,$6,$7,$8,$9,$10,
             decode($11,'hex'),decode($12,'hex'),decode($13,'hex'),
             decode($14,'hex'),decode($15,'hex'),decode($16,'hex'),now())`,
    id, hot, escrow, revision, masterKeyVersion, bindingVersion, envelopeVersion, payloadVersion,
    claimDigest, bindingDigest, dataNonceHex, dataTagHex, ciphertextHex, wrapNonceHex, wrapTagHex, wrappedDekHex
  )

  // The atomic-promotion regression must exercise a VALID proof INSERT, not
  // rely on the earlier UPDATE trigger hiding an invalid/unreachable fixture.
  const insertAtomicPromotionProof = (client, proofId, legacyId) => insertProof(client, {
    id: proofId,
    hot: legacyId,
    claimDigest: DIGEST_A,
    bindingDigest: DIGEST_B
  })

  // A complete, internally consistent owner/pair fixture (what the store
  // writes), created in ONE transaction so the deferred triggers see a
  // consistent state at commit.
  const insertHotPair = async (client, { txHash = HASH_A, n = 1 } = {}) => {
    const dispatchId = uuid(n)
    const proofId = uuid(n + 100)
    const journalId = await insertHotJournal(client, { txHash, dispatchId, proofId, claimDigest: DIGEST_A })
    await insertProof(client, { id: proofId, hot: journalId, claimDigest: DIGEST_A })
    return { journalId, dispatchId, proofId }
  }

  // Journal + proof together in one transaction: an owner row with a proofId
  // can never persist standalone (the deferred trigger fires at COMMIT).
  const insertEscrowPair = async (client, spec = {}) => {
    const seeds = spec.seeds ?? await insertEscrowSeeds(client)
    const full = { dispatchId: uuid(23), proofId: uuid(123), ...seeds, ...spec }
    const rows = await insertEscrowJournal(client, full)
    await insertProof(client, { id: full.proofId, escrow: rows[0].id })
    return full
  }

  // Real transaction-commit probe on a raw connection: PostgreSQL rejects the
  // COMMIT itself when a deferred trigger raises (Prisma's client does not
  // surface deferred-commit failures, so the driver is authoritative here).
  const commitOutcome = async statements => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      for (const { text, values } of statements) await client.query(text, values)
      try {
        await client.query('COMMIT')
        return { committed: true }
      } catch (err) {
        return { committed: false, message: String(err.message) }
      }
    } finally {
      await client.end()
    }
  }

  const expectNothingPersisted = async label => {
    // Counts are scoped to this suite's fixture rows (the same predicate the
    // cleanup uses): other suites on the shared isolated DB may legitimately
    // have their own rows in flight.
    const hot = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "RewardsWalletTransaction" WHERE "walletAddress" = $1', WALLET)
    const proofs = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "PaymentTransactionProof"
       WHERE "rewardsJournalId" IN (SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $1)
          OR "escrowJournalId" IN (SELECT id FROM "EscrowWalletTransaction" WHERE "walletAddress" = $1)`, WALLET)
    const escrow = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "EscrowWalletTransaction" WHERE "walletAddress" = $1', WALLET)
    expect({ hot: hot[0].n, proofs: proofs[0].n, escrow: escrow[0].n, label }).toEqual({ hot: 0, proofs: 0, escrow: 0, label })
  }

  // --- exactly-one-owner CHECK ------------------------------------------------

  test('exactly-one-owner CHECK: both owners null is refused and persists nothing', async () => {
    await expect(db.$transaction(client => insertProof(client, { id: uuid(1) })))
      .rejects.toThrow(/PaymentTransactionProof_single_owner/)
    await expectNothingPersisted('both-null')
  })

  test('exactly-one-owner CHECK: both owners set is refused and persists nothing', async () => {
    await expect(db.$transaction(async client => {
      const seeds = await insertEscrowSeeds(client)
      const hotId = await insertHotJournal(client, { dispatchId: uuid(2), proofId: uuid(102), claimDigest: DIGEST_A })
      await insertEscrowJournal(client, { ...seeds, dispatchId: uuid(3), proofId: uuid(102) })
      await insertProof(client, {
        id: uuid(102),
        hot: hotId,
        escrow: (await client.$queryRawUnsafe(
          'SELECT id FROM "EscrowWalletTransaction" WHERE "dispatchId" = $1::uuid', uuid(3)))[0].id
      })
    })).rejects.toThrow(/PaymentTransactionProof_single_owner/)
    await expectNothingPersisted('both-set')
  })

  // --- envelope byte/digest/version CHECKs (autocommit probes on a live pair) --

  test.each([
    ['dataNonce', { dataNonceHex: '000102030405060708090a' }],
    ['wrapNonce', { wrapNonceHex: '0102030405060708090a0b' }],
    ['dataTag', { dataTagHex: '101112131415161718191a1b1c1d1e' }],
    ['wrapTag', { wrapTagHex: '202122232425262728292a2b2c2d2e' }],
    ['wrappedDek', { wrappedDekHex: '303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e' }]
  ])('byte-length CHECK rejects a wrong-length %s', async (label, override) => {
    const { journalId } = await db.$transaction(client => insertHotPair(client, { n: 4 }))
    await expect(insertProof(db, { id: uuid(104), hot: journalId, ...override }))
      .rejects.toThrow(/PaymentTransactionProof_envelope_byte_lengths/)
    // Scoped to the fixture pair: the shared isolated DB may hold other
    // suites' rows.
    const proofs = await db.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "PaymentTransactionProof" WHERE "rewardsJournalId" = $1', journalId)
    expect(proofs[0].n).toBe(1)
  })

  test('hex digest format CHECK rejects a non-hex claimDigest', async () => {
    const { journalId } = await db.$transaction(client => insertHotPair(client, { n: 5 }))
    await expect(insertProof(db, { id: uuid(105), hot: journalId, claimDigest: 'not-hex' }))
      .rejects.toThrow(/PaymentTransactionProof_digest_formats/)
  })

  test('version CHECKs reject wrong format versions and a nonpositive master key version', async () => {
    const { journalId } = await db.$transaction(client => insertHotPair(client, { n: 6 }))
    await expect(insertProof(db, { id: uuid(106), hot: journalId, bindingVersion: 2 }))
      .rejects.toThrow(/PaymentTransactionProof_format_versions/)
    await expect(insertProof(db, { id: uuid(107), hot: journalId, envelopeVersion: 2 }))
      .rejects.toThrow(/PaymentTransactionProof_format_versions/)
    await expect(insertProof(db, { id: uuid(108), hot: journalId, payloadVersion: 2 }))
      .rejects.toThrow(/PaymentTransactionProof_format_versions/)
    await expect(insertProof(db, { id: uuid(109), hot: journalId, masterKeyVersion: 0 }))
      .rejects.toThrow(/PaymentTransactionProof_revision_key_versions/)
    await expect(insertProof(db, { id: uuid(110), hot: journalId, revision: 0 }))
      .rejects.toThrow(/PaymentTransactionProof_revision_key_versions/)
  })

  test('nonnull ciphertext CHECK rejects an empty ciphertext', async () => {
    const { journalId } = await db.$transaction(client => insertHotPair(client, { n: 7 }))
    await expect(insertProof(db, { id: uuid(111), hot: journalId, ciphertextHex: '' }))
      .rejects.toThrow(/PaymentTransactionProof_ciphertext_present/)
  })

  // --- hot legacy capture tuple CHECK ------------------------------------------

  test('hot capture tuple CHECK rejects a partial proof-era capture', async () => {
    await expect(db.$queryRawUnsafe(
      `INSERT INTO "RewardsWalletTransaction"
         ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata","dispatchId")
       VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb,$3::uuid)`,
      WALLET, HASH_A, uuid(8))).rejects.toThrow(/RewardsWalletTransaction_capture_tuple/)
  })

  // --- deferred pair triggers: real COMMIT failures ------------------------------

  test('commit after journal insert only: the missing proof rejects the COMMIT and rolls the journal back', async () => {
    const outcome = await commitOutcome([{
      text: `INSERT INTO "RewardsWalletTransaction"
               ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata",
                "dispatchId","captureContractVersion","claimDigest","paymentClaims","proofId")
             VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb,$3::uuid,1,$4,'{"captured":true}'::jsonb,$5::uuid)`,
      values: [WALLET, HASH_A, uuid(9), DIGEST_A, uuid(109)]
    }])
    expect(outcome.committed).toBe(false)
    expect(outcome.message).toMatch(/PAYMENT_PROOF_MISSING/)
    await expectNothingPersisted('commit-after-journal')
  })

  test('bidirectional mismatch rolls back only at COMMIT and a mid-transaction repair commits', async () => {
    // One transaction: insert journal J (proofId = W), insert proof Z (wrong
    // link), repair by deleting Z and inserting W, commit. The pair trigger is
    // deferred: the intermediate mismatch must NOT abort mid-transaction.
    let journalId
    await db.$transaction(async client => {
      journalId = await insertHotJournal(client, { dispatchId: uuid(10), proofId: uuid(110), claimDigest: DIGEST_A })
      await insertProof(client, { id: uuid(210), hot: journalId, claimDigest: DIGEST_A })
      await client.$executeRawUnsafe('DELETE FROM "PaymentTransactionProof" WHERE id = $1::uuid', uuid(210))
      await insertProof(client, { id: uuid(110), hot: journalId, claimDigest: DIGEST_A })
    })
    const proofs = await db.$queryRawUnsafe(
      'SELECT id FROM "PaymentTransactionProof" WHERE "rewardsJournalId" = $1', journalId)
    expect(proofs.map(row => row.id)).toEqual([uuid(110)])
  })

  test('bidirectional mismatch at COMMIT rejects the COMMIT and rolls the pair back', async () => {
    // Journal 11 expects proof 211; proof 211 links back to legacy journal 12
    // instead (a legal FK target that owns no proof and is skipped by its own
    // legacy-return check). Only the COMMIT-time pair check sees the mismatch.
    const journal11 = {
      text: `INSERT INTO "RewardsWalletTransaction"
               ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata",
                "dispatchId","captureContractVersion","claimDigest","paymentClaims","proofId")
             VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb,$3::uuid,1,$4,'{"captured":true}'::jsonb,$5::uuid)`,
      values: [WALLET, HASH_A, uuid(11), DIGEST_A, uuid(211)]
    }
    const legacyJournal12 = {
      text: `INSERT INTO "RewardsWalletTransaction"
               ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata")
             VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb)`,
      values: [WALLET, HASH_B]
    }
    const proofIntoLegacy = {
      text: `INSERT INTO "PaymentTransactionProof"
               ("id","rewardsJournalId","revision","masterKeyVersion","bindingVersion","envelopeVersion","payloadVersion",
                "claimDigest","bindingDigest","dataNonce","dataTag","ciphertext","wrapNonce","wrapTag","wrappedDek","updatedAt")
             VALUES ($1::uuid,
                     (SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $2 AND "proofId" IS NULL),
                     1,1,1,1,1,$3,$3,
                     decode('000102030405060708090a0b','hex'),decode('101112131415161718191a1b1c1d1e1f','hex'),
                     decode('ff','hex'),decode('0102030405060708090a0b0c','hex'),
                     decode('202122232425262728292a2b2c2d2e2f','hex'),
                     decode('303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f','hex'),now())`,
      values: [uuid(211), WALLET, DIGEST_A]
    }
    // Journal-only commits are refused first (missing proof at COMMIT).
    const outcome = await commitOutcome([journal11])
    expect(outcome.committed).toBe(false)
    expect(outcome.message).toMatch(/PAYMENT_PROOF_MISSING/)
    await expectNothingPersisted('journal-only')
    // The mismatched backlink survives every immediate constraint but fails
    // the deferred pair check at COMMIT.
    const mismatch = await commitOutcome([journal11, legacyJournal12, proofIntoLegacy])
    expect(mismatch.committed).toBe(false)
    expect(mismatch.message).toMatch(/PAYMENT_PROOF_PAIR_MISMATCH/)
    await expectNothingPersisted('bidirectional-mismatch')
  })

  test('claimDigest divergence between owner and proof fails at COMMIT', async () => {
    const outcome = await db.$transaction(async client => {
      const journalId = await insertHotJournal(client, { dispatchId: uuid(12), proofId: uuid(112), claimDigest: DIGEST_A })
      await insertProof(client, { id: uuid(112), hot: journalId, claimDigest: DIGEST_B })
      // Prisma's client may not surface the deferred-commit failure, but the
      // server-side rollback is verifiable through what persists afterwards.
    }).then(() => 'resolved').catch(err => String(err.message))
    const proofs = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PaymentTransactionProof" WHERE "claimDigest" = $1', DIGEST_B)
    expect(proofs[0].n).toBe(0)
    expect(outcome === 'resolved' || /PAYMENT_PROOF_DIGEST_MISMATCH/.test(outcome)).toBe(true)
    const divergent = await commitOutcome([{
      text: `INSERT INTO "RewardsWalletTransaction"
               ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata",
                "dispatchId","captureContractVersion","claimDigest","paymentClaims","proofId")
             VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb,$3::uuid,1,$4,'{"captured":true}'::jsonb,$5::uuid)`,
      values: [WALLET, HASH_A, uuid(12), DIGEST_A, uuid(312)]
    }, {
      text: `INSERT INTO "PaymentTransactionProof"
               ("id","rewardsJournalId","revision","masterKeyVersion","bindingVersion","envelopeVersion","payloadVersion",
                "claimDigest","bindingDigest","dataNonce","dataTag","ciphertext","wrapNonce","wrapTag","wrappedDek","updatedAt")
             VALUES ($1::uuid,
                     (SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $2 AND "dispatchId" = $3::uuid),
                     1,1,1,1,1,$4,$4,
                     decode('000102030405060708090a0b','hex'),decode('101112131415161718191a1b1c1d1e1f','hex'),
                     decode('ff','hex'),decode('0102030405060708090a0b0c','hex'),
                     decode('202122232425262728292a2b2c2d2e2f','hex'),
                     decode('303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f','hex'),now())`,
      values: [uuid(312), WALLET, uuid(12), DIGEST_B]
    }])
    expect(divergent.committed).toBe(false)
    expect(divergent.message).toMatch(/PAYMENT_PROOF_DIGEST_MISMATCH/)
    await expectNothingPersisted('digest-divergence')
  })

  test('a proof may not promote a legacy journal row (COMMIT rejected, pair rolled back)', async () => {
    const legacyInsert = {
      text: `INSERT INTO "RewardsWalletTransaction"
               ("network","walletAddress","txHash","kind","accountIndex","principalPiconeros","networkFeePiconeros","metadata")
             VALUES ('STAGENET',$1,$2,'PAYOUT',0,60,7,'{"payouts":[]}'::jsonb)`,
      values: [WALLET, HASH_A]
    }
    const proofOnLegacy = {
      text: `INSERT INTO "PaymentTransactionProof"
               ("id","rewardsJournalId","revision","masterKeyVersion","bindingVersion","envelopeVersion","payloadVersion",
                "claimDigest","bindingDigest","dataNonce","dataTag","ciphertext","wrapNonce","wrapTag","wrappedDek","updatedAt")
             VALUES ($1::uuid,
                     (SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $2 AND "proofId" IS NULL),
                     1,1,1,1,1,$3,$3,
                     decode('000102030405060708090a0b','hex'),decode('101112131415161718191a1b1c1d1e1f','hex'),
                     decode('ff','hex'),decode('0102030405060708090a0b0c','hex'),
                     decode('202122232425262728292a2b2c2d2e2f','hex'),
                     decode('303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f','hex'),now())`,
      values: [uuid(113), WALLET, DIGEST_A]
    }
    const outcome = await commitOutcome([legacyInsert, proofOnLegacy])
    expect(outcome.committed).toBe(false)
    expect(outcome.message).toMatch(/PAYMENT_PROOF_LEGACY_PROMOTION/)
    await expectNothingPersisted('legacy-promotion')
  })

  test('standalone proof deletion is restricted at COMMIT; deleting the pair in one transaction is permitted', async () => {
    const { journalId, proofId } = await db.$transaction(client => insertHotPair(client, { n: 14 }))
    // Standalone proof delete: the owner still references it -> COMMIT fails.
    const outcome = await commitOutcome([{
      text: 'DELETE FROM "PaymentTransactionProof" WHERE id = $1::uuid',
      values: [proofId]
    }])
    expect(outcome.committed).toBe(false)
    expect(outcome.message).toMatch(/PAYMENT_PROOF_DELETE_RESTRICTED/)
    const still = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "PaymentTransactionProof" WHERE id = $1::uuid', proofId)
    expect(still[0].n).toBe(1)
    // Deliberate pair teardown in ONE transaction (fixture-cleanup path).
    await db.$transaction(async client => {
      await client.$executeRawUnsafe('DELETE FROM "PaymentTransactionProof" WHERE id = $1::uuid', proofId)
      await client.$executeRawUnsafe('DELETE FROM "RewardsWalletTransaction" WHERE id = $1', journalId)
    })
    const gone = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "RewardsWalletTransaction" WHERE id = $1', journalId)
    expect(gone[0].n).toBe(0)
  })

  // --- immutability triggers ------------------------------------------------------

  test('captured journal identity/claims/principal/fee/source/hash/metadata mutations are rejected', async () => {
    await db.$transaction(client => insertHotPair(client, { n: 15 }))
    const journalId = (await db.$queryRawUnsafe(
      'SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $1', WALLET))[0].id
    for (const [column, assignment] of [
      ['claimDigest', `'${DIGEST_B}'`],
      ['paymentClaims', '\'{"changed":true}\'::jsonb'],
      ['dispatchId', `'${uuid(999)}'::uuid`],
      ['proofId', `'${uuid(998)}'::uuid`],
      ['principalPiconeros', '61'],
      ['networkFeePiconeros', '8'],
      ['txHash', `'${HASH_B}'`],
      ['kind', '\'OPS_SWEEP\'::"RewardsWalletTxKind"'],
      ['accountIndex', '2'],
      ['metadata', '\'{"payouts":[]}\'::jsonb']
    ]) {
      await expect(db.$executeRawUnsafe(
        `UPDATE "RewardsWalletTransaction" SET "${column}" = ${assignment} WHERE id = $1`, journalId))
        .rejects.toThrow(/PAYMENT_PROOF_CAPTURE_IMMUTABLE/, `${column} mutation must be rejected`)
    }
  })

  test('mutable state/timestamps/relay provenance follow the existing rules', async () => {
    await db.$transaction(client => insertHotPair(client, { n: 16 }))
    const journalId = (await db.$queryRawUnsafe(
      'SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $1', WALLET))[0].id
    await db.$executeRawUnsafe(
      `UPDATE "RewardsWalletTransaction"
       SET state = 'RELAYED', "relayAttemptedAt" = now(), "relayedAt" = now(), "relayProvenance" = 'relay-wallet'
       WHERE id = $1`, journalId)
    const row = (await db.$queryRawUnsafe(
      'SELECT state, "relayProvenance" FROM "RewardsWalletTransaction" WHERE id = $1', journalId))[0]
    expect(row.state).toBe('RELAYED')
    expect(row.relayProvenance).toBe('relay-wallet')
  })

  test('legacy rows keep the guarded repair mutability (amendment §8 fee correction)', async () => {
    // A legacy RELAYED row with no capture tuple: the reconciliation repair's
    // plain-UPDATE fee correction must succeed — the immutability trigger
    // deliberately exempts legacy rows (plan: "legacy repair fields follow
    // existing rules").
    const legacyId = await insertHotJournal(db, { txHash: HASH_A, legacy: true })
    await db.$executeRawUnsafe(
      'UPDATE "RewardsWalletTransaction" SET state = \'RELAYED\', "relayedAt" = now() WHERE id = $1', legacyId)
    await db.$executeRawUnsafe(
      'UPDATE "RewardsWalletTransaction" SET "networkFeePiconeros" = 9 WHERE id = $1', legacyId)
    const row = (await db.$queryRawUnsafe(
      'SELECT "networkFeePiconeros", state FROM "RewardsWalletTransaction" WHERE id = $1', legacyId))[0]
    expect({ fee: row.networkFeePiconeros, state: row.state }).toEqual({ fee: 9n, state: 'RELAYED' })
  })

  test('a proof-era row keeps its captured fee absolutely immutable', async () => {
    await db.$transaction(client => insertHotPair(client, { n: 161 }))
    const journalId = (await db.$queryRawUnsafe(
      'SELECT id FROM "RewardsWalletTransaction" WHERE "walletAddress" = $1', WALLET))[0].id
    await expect(db.$executeRawUnsafe(
      'UPDATE "RewardsWalletTransaction" SET "networkFeePiconeros" = 9 WHERE id = $1', journalId))
      .rejects.toThrow(/PAYMENT_PROOF_CAPTURE_IMMUTABLE/)
    const row = (await db.$queryRawUnsafe(
      'SELECT "networkFeePiconeros" FROM "RewardsWalletTransaction" WHERE id = $1', journalId))[0]
    expect(row.networkFeePiconeros).toBe(7n)
  })

  test('a legacy row cannot gain a proof-era capture tuple post-hoc', async () => {
    // Writing the complete five-column tuple is rejected IMMEDIATELY by the
    // legacy→capture promotion barrier (final-review I9) — the deferred pair
    // trigger can never even see the promoted state, so the atomic
    // "update the tuple AND insert the matching proof in one transaction"
    // route is equally dead.
    const legacyId = await insertHotJournal(db, { txHash: HASH_A, legacy: true })
    await expect(db.$executeRawUnsafe(
      `UPDATE "RewardsWalletTransaction"
       SET "dispatchId" = $2::uuid, "captureContractVersion" = 1, "claimDigest" = $3,
           "paymentClaims" = '{"captured":true}'::jsonb, "proofId" = $4::uuid
       WHERE id = $1`,
      legacyId, uuid(900), DIGEST_A, uuid(901))).rejects.toThrow(/PAYMENT_PROOF_LEGACY_PROMOTION/)
    const row = (await db.$queryRawUnsafe(
      'SELECT "dispatchId", "proofId", "claimDigest" FROM "RewardsWalletTransaction" WHERE id = $1', legacyId))[0]
    expect(row.dispatchId).toBeNull()
    expect(row.proofId).toBeNull()
    expect(row.claimDigest).toBeNull()
  })

  test('an ATOMIC legacy→capture promotion (complete tuple + matching proof in one transaction) is rejected', async () => {
    // Final-review I9: the R9 legacy exemption let a transaction update its
    // complete capture tuple and insert the matching proof in ONE
    // transaction — the deferred checks passed on the complete result. The
    // immediate promotion barrier now rejects the update before COMMIT, so
    // the whole transaction (tuple AND proof) rolls back and the row stays
    // legacy.
    const legacyId = await insertHotJournal(db, { txHash: HASH_A, legacy: true })
    const proofId = uuid(902)
    await expect(db.$transaction(async client => {
      await client.$executeRawUnsafe(
        `UPDATE "RewardsWalletTransaction"
         SET "dispatchId" = $2::uuid, "captureContractVersion" = 1, "claimDigest" = $3,
             "paymentClaims" = '{"captured":true}'::jsonb, "proofId" = $4::uuid
         WHERE id = $1`,
        legacyId, uuid(903), DIGEST_A, proofId)
      await insertAtomicPromotionProof(client, proofId, legacyId)
    })).rejects.toThrow(/PAYMENT_PROOF_LEGACY_PROMOTION/)
    const row = (await db.$queryRawUnsafe(
      'SELECT "dispatchId", "proofId" FROM "RewardsWalletTransaction" WHERE id = $1', legacyId))[0]
    expect(row.dispatchId).toBeNull()
    expect(row.proofId).toBeNull()
    expect((await db.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "PaymentTransactionProof" WHERE id = $1::uuid', proofId))[0].n).toBe(0)
  })

  test('atomic promotion regression proof INSERT is independently valid for a complete owner tuple', async () => {
    const proofId = uuid(904)
    await db.$transaction(async client => {
      const journalId = await insertHotJournal(client, { dispatchId: uuid(905), proofId, claimDigest: DIGEST_A })
      await insertAtomicPromotionProof(client, proofId, journalId)
    })
    const proof = await db.paymentTransactionProof.findUniqueOrThrow({ where: { id: proofId } })
    expect(proof.wrappedDek).toHaveLength(32)
    expect(proof.updatedAt).toBeInstanceOf(Date)
    expect(proof.rewardsJournalId).not.toBeNull()
  })

  test('rotation-style envelope+revision update is allowed; revision decrease is rejected', async () => {
    const { proofId } = await db.$transaction(client => insertHotPair(client, { n: 17 }))
    await db.$executeRawUnsafe(
      `UPDATE "PaymentTransactionProof"
       SET revision = 2, "masterKeyVersion" = 2, ciphertext = decode('ffee','hex'), "updatedAt" = now()
       WHERE id = $1::uuid`, proofId)
    const rotated = (await db.$queryRawUnsafe(
      'SELECT revision, "masterKeyVersion" FROM "PaymentTransactionProof" WHERE id = $1::uuid', proofId))[0]
    expect({ revision: rotated.revision, masterKeyVersion: rotated.masterKeyVersion }).toEqual({ revision: 2, masterKeyVersion: 2 })
    await expect(db.$executeRawUnsafe(
      'UPDATE "PaymentTransactionProof" SET revision = 1, ciphertext = decode(\'ff\',\'hex\'), "updatedAt" = now() WHERE id = $1::uuid', proofId))
      .rejects.toThrow(/PAYMENT_PROOF_ROTATION_REVISION/)
    // Even a pure envelope change without a revision bump is refused.
    await expect(db.$executeRawUnsafe(
      'UPDATE "PaymentTransactionProof" SET ciphertext = decode(\'ff00\',\'hex\'), "updatedAt" = now() WHERE id = $1::uuid', proofId))
      .rejects.toThrow(/PAYMENT_PROOF_ROTATION_REVISION/)
  })

  test('proof owner linkage and claimDigest are immutable', async () => {
    const { journalId, proofId } = await db.$transaction(client => insertHotPair(client, { n: 18 }))
    await expect(db.$executeRawUnsafe(
      'UPDATE "PaymentTransactionProof" SET "claimDigest" = $2 WHERE id = $1::uuid', proofId, DIGEST_B))
      .rejects.toThrow(/PAYMENT_PROOF_ROTATION_INVALID/)
    await expect(db.$executeRawUnsafe(
      'UPDATE "PaymentTransactionProof" SET "rewardsJournalId" = $2 WHERE id = $1::uuid', proofId, journalId + 1n))
      .rejects.toThrow(/PAYMENT_PROOF_ROTATION_INVALID/)
  })

  // --- escrow kind/leg consistency and nonnegative checks --------------------------

  test('escrow kind/leg consistency CHECK', async () => {
    const seeds = await insertEscrowSeeds(db)
    await db.$transaction(client => insertEscrowPair(client, {
      seeds, dispatchId: uuid(19), proofId: uuid(119), kind: 'LEGACY_SEPARATE_FEE', leg: 'LEGACY_SEPARATE_FEE'
    }))
    await expect(insertEscrowJournal(db, {
      ...seeds, txHash: HASH_B, dispatchId: uuid(20), proofId: uuid(120), kind: 'AWARD', leg: 'LEGACY_SEPARATE_FEE'
    })).rejects.toThrow(/EscrowWalletTransaction_kind_leg_consistent/)
    await expect(insertEscrowJournal(db, {
      ...seeds, txHash: HASH_B, dispatchId: uuid(21), proofId: uuid(121), kind: 'LEGACY_SEPARATE_FEE', leg: 'DISPOSITION'
    })).rejects.toThrow(/EscrowWalletTransaction_kind_leg_consistent/)
  })

  test('escrow nonnegative amount/account and hash format CHECKs', async () => {
    const seeds = await insertEscrowSeeds(db)
    const escrowInsert = (txHash, accountIndex, principal, fee) => db.$queryRawUnsafe(
      `INSERT INTO "EscrowWalletTransaction"
         ("network","walletAddress","txHash","dispatchId","proofId","captureContractVersion","claimDigest","paymentClaims",
          "kind","leg","bountyPaymentId","itemId","accountIndex","principalPiconeros","networkFeePiconeros","metadata")
       VALUES ('STAGENET',$1,$2,$3::uuid,$4::uuid,1,$5,'{}'::jsonb,'AWARD','DISPOSITION',$6,$7,$8,$9,$10,'{}'::jsonb)`,
      WALLET, txHash, uuid(22), uuid(122), DIGEST_A, seeds.bountyPaymentId, seeds.itemId, accountIndex, principal, fee)
    await expect(escrowInsert(HASH_A, -1, 60, 7)).rejects.toThrow(/EscrowWalletTransaction_amounts_nonnegative/)
    await expect(escrowInsert(HASH_A, 0, -1, 7)).rejects.toThrow(/EscrowWalletTransaction_amounts_nonnegative/)
    await expect(escrowInsert(HASH_A, 0, 60, -1)).rejects.toThrow(/EscrowWalletTransaction_amounts_nonnegative/)
    await expect(escrowInsert('NOTAHASH', 0, 60, 7)).rejects.toThrow(/EscrowWalletTransaction_hash/)
  })

  // --- unique constraints ------------------------------------------------------------

  test('unique constraints on dispatchId, proofId, scope triple and escrow leg', async () => {
    const { journalId, dispatchId } = await db.$transaction(client => insertHotPair(client, { n: 24 }))
    const uniqueViolation = /23505|already exists|duplicate key|unique/i
    // Hot journal: duplicate dispatchId and duplicate (network, wallet, txHash).
    await expect(insertHotJournal(db, { txHash: HASH_B, dispatchId, proofId: uuid(124), claimDigest: DIGEST_A }))
      .rejects.toThrow(uniqueViolation)
    await expect(insertHotJournal(db, { txHash: HASH_A, dispatchId: uuid(25), proofId: uuid(125), claimDigest: DIGEST_A }))
      .rejects.toThrow(uniqueViolation)
    // Proof: one proof per hot journal (unique rewardsJournalId).
    await expect(insertProof(db, { id: uuid(126), hot: journalId }))
      .rejects.toThrow(uniqueViolation)
    // Escrow: duplicate dispatchId, duplicate scope triple, duplicate leg.
    const seeds = await insertEscrowSeeds(db)
    await db.$transaction(client => insertEscrowPair(client, { seeds, dispatchId: uuid(26), proofId: uuid(126), txHash: HASH_B }))
    await expect(insertEscrowJournal(db, { ...seeds, dispatchId: uuid(26), proofId: uuid(127), txHash: HASH_B }))
      .rejects.toThrow(uniqueViolation)
    await expect(insertEscrowJournal(db, { ...seeds, dispatchId: uuid(28), proofId: uuid(128), txHash: HASH_B }))
      .rejects.toThrow(uniqueViolation)
    await expect(insertEscrowJournal(db, { ...seeds, dispatchId: uuid(29), proofId: uuid(129), txHash: 'c3'.repeat(32) }))
      .rejects.toThrow(uniqueViolation)
  })
})
