/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'child_process'
import { cpSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { buildRewardsReconciliation, readRepairLedger } from '@/api/monero/rewardsReconciliation'
import { applyRewardsReconciliation } from '@/api/monero/applyRewardsReconciliation'

// Isolated real-DB tests for the rewards-wallet accounting repair (Task 1).
//
// 1) Money CHECK constraints + journal uniqueness, exercised through the
//    generated Prisma client against the dedicated rewards test database.
// 2) The migration's fail-closed legacy BOUNTY_FEE backfill, exercised by
//    applying the migration to throwaway scratch databases seeded with the
//    PRE-migration schema and pre-migration row shapes: a matching funding fee
//    (preserved + excluded from receipts), a zero-fee abandonment pseudo-row
//    (preserved), conflicting terms (refused atomically), and an unresolved
//    positive row without funding evidence (refused atomically).
//
// The scratch databases live on the same disposable PG server and are dropped
// after each test; nothing here writes to stasher_rewards_repair_test or any
// other existing database.
//
// Runs only in the dedicated isolated runner (DATABASE_URL pointing at
// stasher_rewards_repair_test); the whole suite is skipped by default anywhere
// else, so ordinary dev-DB test runs neither crash nor touch that database.
// Run via: ./sndev test test/prisma/rewards-accounting-constraints.test.js

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const repoRoot = process.cwd()
const prismaBin = path.join('node_modules', '.bin', 'prisma')
const newMigrationName = '20261005000000_rewards_wallet_accounting'
// Each scratch DB runs a 109-migration pre-deploy, then the migration under
// test, plus seeds and assertions — well over Jest's 5s default.
const migrationTimeoutMs = 10 * 60 * 1000

const adminUrl = () => {
  const u = new URL(process.env.DATABASE_URL)
  u.pathname = '/postgres'
  return u.toString()
}
const scratchUrl = (name) => {
  const u = new URL(process.env.DATABASE_URL)
  u.pathname = `/${name}`
  return u.toString()
}

const migrateDeploy = (schemaPath, databaseUrl) => spawnSync(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  encoding: 'utf8'
})

const deployOutput = (result) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`

const assertDeployOk = (result) => {
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed:\n${deployOutput(result)}`)
}

const one = async (client, sql, ...params) => (await client.$queryRawUnsafe(sql, ...params))[0]

async function columnExists (client, table, column) {
  const rows = await client.$queryRawUnsafe(
    'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', table, column)
  return rows.length > 0
}

async function tableExists (client, table) {
  const rows = await client.$queryRawUnsafe(
    'SELECT 1 FROM information_schema.tables WHERE table_name = $1', table)
  return rows.length > 0
}

// --- pre-migration fixture writers (raw SQL: the generated client knows only
// the post-migration schema) ------------------------------------------------

const seedUserAndAccount = async (scratch) => {
  const user = await one(scratch, 'INSERT INTO users ("subs") VALUES (ARRAY[]::text[]) RETURNING "id"')
  const account = await one(scratch,
    `INSERT INTO "MoneroAccount" ("address", "label", "network")
     VALUES ('5HOTWALLET', 'rewards', 'STAGENET'::"Network") RETURNING "id"`)
  return { userId: user.id, accountId: account.id }
}

const seedBountyItem = async (scratch, { userId, bountyStatus }) =>
  one(scratch,
    `INSERT INTO "Item" ("userId", "subNames", "bountyPiconeros", "bountyStatus")
     VALUES ($1, ARRAY['test']::citext[], 0, $2::"BountyStatus") RETURNING "id"`,
    userId, bountyStatus)

const seedObservedBounty = async (scratch, { postId, accountId, txHash, paymentId, state = 'CONFIRMED' }) =>
  one(scratch,
    `INSERT INTO "ObservedBounty" ("txHash", "postId", "paymentId", "recipientAccountId", "piconeros", "state")
     VALUES ($1, $2, $3, $4, 100, $5::"ObservedState") RETURNING "id"`,
    txHash, postId, paymentId, accountId, state)

const seedObservedBountyReceipt = async (scratch, { bountyId, txHash }) =>
  one(scratch,
    `INSERT INTO "ObservedBountyReceipt" ("bountyId", "txHash", "piconeros")
     VALUES ($1, $2, 100) RETURNING "id"`,
    bountyId, txHash)

const seedFeeObservation = async (scratch, { txHash, postId, piconeros, feeType = 'BOUNTY_FEE' }) =>
  one(scratch,
    `INSERT INTO "FeeObservation" ("txHash", "feeType", "postId", "recipientMajor", "recipientMinor", "piconeros", "state")
     VALUES ($1, $2::"FeeType", $3, 0, 0, $4, 'CONFIRMED'::"ObservedState") RETURNING "id"`,
    txHash, feeType, postId, piconeros)

// =============================================================================
// Everything below runs only against the dedicated isolated database. Skipped
// (not thrown) elsewhere, so dev-DB collection neither crashes tests nor opens
// a single connection: the describe callback only registers tests, and the
// clients themselves are created in beforeAll, which does not run when skipped.
// =============================================================================
;(ISOLATED_DB ? describe : describe.skip)('rewards accounting constraints (isolated DB only)', () => {
  let db
  let admin
  const scratchDbs = []
  const tempDirs = []

  beforeAll(() => {
    db = new PrismaClient()
    admin = new PrismaClient({ datasourceUrl: adminUrl() })
  })

  afterEach(async () => {
    if (!admin) return
    while (scratchDbs.length) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchDbs.pop()}" WITH (FORCE)`)
    }
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
  })

  afterAll(async () => {
    if (admin) await admin.$disconnect()
    if (db) await db.$disconnect()
  })

  const createScratchDb = async (name) => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    scratchDbs.push(name)
    return scratchUrl(name)
  }

  // The current schema with every migration EXCEPT the one under test, so a
  // scratch database can be seeded with pre-migration row shapes and then
  // receive only this migration.
  const preMigrationSchemaPath = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-mig-'))
    tempDirs.push(dir)
    cpSync(path.join(repoRoot, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'))
    cpSync(path.join(repoRoot, 'prisma', 'migrations'), path.join(dir, 'migrations'), {
      recursive: true,
      filter: (src) => path.basename(src) !== newMigrationName
    })
    return path.join(dir, 'schema.prisma')
  }

  // --- exact-money constraints and journal behavior -------------------------

  test.each([[-1n, 0n], [11n, 10n]])('rejects receipt allocation %s beyond amount %s', async (reward, amount) => {
    await expect(db.$transaction(async tx => {
      await tx.feeObservation.create({
        data: {
          txHash: 'e1'.repeat(32),
          feeType: 'BOUNTY_ROLLOVER',
          recipientMajor: 0,
          recipientMinor: 0,
          piconeros: amount,
          rewardsPiconeros: reward
        }
      })
    })).rejects.toThrow()
  })

  test('keeps large journal fee amounts exact and transaction hash unique', async () => {
    const data = {
      network: 'STAGENET',
      walletAddress: '5HOT',
      txHash: 'e2'.repeat(32),
      kind: 'CONSOLIDATION',
      accountIndex: 1,
      principalPiconeros: 0n,
      networkFeePiconeros: 9007199254740993n,
      metadata: { selfTransfer: true, destination: '5HOT' }
    }
    try {
      const row = await db.rewardsWalletTransaction.create({ data })
      expect(row.networkFeePiconeros).toBe(9007199254740993n)
      await expect(db.rewardsWalletTransaction.create({ data })).rejects.toThrow()
    } finally {
      await db.rewardsWalletTransaction.deleteMany({ where: { txHash: data.txHash } })
    }
  })

  // --- fail-closed legacy metadata migration --------------------------------

  test('migration preserves legacy frozen fees and excludes them from receipts', async () => {
    const scratch = new PrismaClient({ datasourceUrl: await createScratchDb('rwr_mig_legacy_ok') })
    try {
      const pre = migrateDeploy(preMigrationSchemaPath(), scratchUrl('rwr_mig_legacy_ok'))
      assertDeployOk(pre)

      const { userId, accountId } = await seedUserAndAccount(scratch)

      // A confirmed funding whose BOUNTY_FEE observation carries the declared fee.
      const fundedTx = 'aa'.repeat(32)
      const fundedItem = await seedBountyItem(scratch, { userId, bountyStatus: 'FUNDED' })
      await seedObservedBounty(scratch, { postId: fundedItem.id, accountId, txHash: fundedTx, paymentId: 'ba'.repeat(32) })
      const fundedFee = await seedFeeObservation(scratch, { txHash: fundedTx, postId: fundedItem.id, piconeros: 100n })

      // An abandoned underfunded attempt: zero-fee pseudo-row keyed by paymentId.
      const abandonedItem = await seedBountyItem(scratch, { userId, bountyStatus: 'EXPIRED' })
      await seedObservedBounty(scratch, { postId: abandonedItem.id, accountId, txHash: 'bb'.repeat(32), paymentId: 'bb01', state: 'EXPIRED' })
      const abandonedFee = await seedFeeObservation(scratch, { txHash: 'abandoned-bb01', postId: abandonedItem.id, piconeros: 0n })

      // A fee row matched through one of the funding's observed receipts.
      const receiptTx = 'ee'.repeat(32)
      const receiptItem = await seedBountyItem(scratch, { userId, bountyStatus: 'FUNDED' })
      const receiptBounty = await seedObservedBounty(scratch, { postId: receiptItem.id, accountId, txHash: 'dd'.repeat(32), paymentId: 'dd01' })
      await seedObservedBountyReceipt(scratch, { bountyId: receiptBounty.id, txHash: receiptTx })
      const receiptFee = await seedFeeObservation(scratch, { txHash: receiptTx, postId: receiptItem.id, piconeros: 250n })

      // An ordinary receipt writer's row: must stay a receipt.
      const postingFee = await seedFeeObservation(scratch, { txHash: 'cc'.repeat(32), postId: fundedItem.id, piconeros: 300n, feeType: 'POSTING' })

      const applied = migrateDeploy(path.join(repoRoot, 'prisma', 'schema.prisma'), scratchUrl('rwr_mig_legacy_ok'))
      assertDeployOk(applied)

      expect((await scratch.item.findUnique({ where: { id: fundedItem.id } })).bountyFeePiconeros).toBe(100n)
      expect((await scratch.item.findUnique({ where: { id: abandonedItem.id } })).bountyFeePiconeros).toBe(0n)
      expect((await scratch.item.findUnique({ where: { id: receiptItem.id } })).bountyFeePiconeros).toBe(250n)

      expect((await scratch.feeObservation.findUnique({ where: { id: fundedFee.id } })).walletReceipt).toBe(false)
      expect((await scratch.feeObservation.findUnique({ where: { id: abandonedFee.id } })).walletReceipt).toBe(false)
      expect((await scratch.feeObservation.findUnique({ where: { id: receiptFee.id } })).walletReceipt).toBe(false)
      expect((await scratch.feeObservation.findUnique({ where: { id: postingFee.id } })).walletReceipt).toBe(true)
    } finally {
      await scratch.$disconnect()
    }
  }, migrationTimeoutMs)

  test('a migration-classified funding accrual still corrects the historical ops inflow exactly once', async () => {
    const scratchName = 'rwr_mig_phantom'
    const scratch = new PrismaClient({ datasourceUrl: await createScratchDb(scratchName) })
    try {
      const pre = migrateDeploy(preMigrationSchemaPath(), scratchUrl(scratchName))
      assertDeployOk(pre)

      const walletAddress = '5PHANTOMREPAIRHOTWALLET'
      const scope = { network: 'STAGENET', walletAddress }
      const boundary = { height: 3000000, blockHash: 'd4'.repeat(32) }
      const fundingTx = 'ab'.repeat(32)

      // PRE-migration fixture shape: the funding-time BOUNTY_FEE row is still
      // cash-eligible and Item has no frozen term yet.
      const user = await one(scratch, 'INSERT INTO users ("subs") VALUES (ARRAY[]::text[]) RETURNING "id"')
      await one(scratch,
        `INSERT INTO "MoneroAccount" ("address", "label", "network")
         VALUES ($1, 'platform_rewards', 'STAGENET'::"Network") RETURNING "id"`, walletAddress)
      const account = await one(scratch, 'SELECT "id"::int AS id FROM "MoneroAccount" WHERE "address" = $1', walletAddress)
      const item = await seedBountyItem(scratch, { userId: user.id, bountyStatus: 'FUNDED' })
      await seedObservedBounty(scratch, { postId: item.id, accountId: account.id, txHash: fundingTx, paymentId: 'mig01' })
      await seedFeeObservation(scratch, { txHash: fundingTx, postId: item.id, piconeros: 20n })
      // A real funding-confirmation timestamp inside the distribution window
      // (the shared seeder is intentionally minimal).
      await scratch.$executeRawUnsafe(
        'UPDATE "FeeObservation" SET "confirmedAt" = $2::timestamp WHERE "txHash" = $1', fundingTx, '2026-09-02T00:00:00Z')
      // Pre-migration shape: no opsNetworkFeesAccountedPiconeros column yet.
      await scratch.$executeRawUnsafe(
        `INSERT INTO "RewardDistribution" ("periodStart", "periodEnd", "poolPiconeros",
           "opsInflowPiconeros", "opsRolledOverPiconeros", "opsAvailablePiconeros")
         VALUES ('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z', 0, 20, 0, 20)`)

      // Apply the REAL migration: the identified accrual moves out of cash
      // while its phantom ops contribution stays inside the stored snapshot.
      const applied = migrateDeploy(path.join(repoRoot, 'prisma', 'schema.prisma'), scratchUrl(scratchName))
      assertDeployOk(applied)
      expect((await scratch.feeObservation.findUnique({
        where: { txHash_recipientMajor_recipientMinor: { txHash: fundingTx, recipientMajor: 0, recipientMinor: 0 } }
      })).walletReceipt).toBe(false)
      expect((await scratch.item.findUnique({ where: { id: item.id } })).bountyFeePiconeros).toBe(20n)

      const evidence = {
        scope,
        boundary,
        daemon: { tipBefore: boundary, tipAfter: boundary },
        restoreHeight: 0,
        restoreProvenance: 'genesis',
        walletHeight: boundary.height + 1,
        derivation: {
          complete: true,
          derived: [{ majorIndex: 0, minorIndex: 0, address: walletAddress }],
          mismatches: []
        },
        balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
        incoming: [],
        outgoing: [],
        bridge: { pendingIncoming: [], pendingOutgoing: [] },
        escrow: null
      }

      const build = async () => {
        const ledger = await readRepairLedger(scratch, scope)
        return {
          ledger,
          manifest: buildRewardsReconciliation({
            scope,
            boundary,
            evidence,
            ledger,
            decisions: {},
            config: ledger.config,
            reserve: { feeHeadroomPiconeros: 1_000_000_000n, dustFloorPiconeros: 1_000_000_000n },
            opsCarryProvenance: {}
          })
        }
      }

      const first = await build()
      expect(first.manifest.issues).toEqual([])
      const distributionOps = first.manifest.operations.filter(operation => operation.table === 'RewardDistribution')
      expect(distributionOps).toHaveLength(1)
      expect(distributionOps[0].before).toEqual({
        opsInflowPiconeros: '20', opsRolledOverPiconeros: '0', opsAvailablePiconeros: '20'
      })
      expect(distributionOps[0].after).toEqual({
        opsInflowPiconeros: '0', opsRolledOverPiconeros: '0', opsAvailablePiconeros: '0'
      })
      expect(first.manifest.before.opsPendingPiconeros).toBe('20')
      expect(first.manifest.after.opsPendingPiconeros).toBe('0')

      await expect(applyRewardsReconciliation({
        models: scratch,
        manifest: first.manifest,
        confirmedDigest: first.manifest.digest,
        backupReference: 'migration-handoff-fixture',
        writersPaused: true,
        evidence
      })).resolves.toMatchObject({ applied: true })
      expect((await scratch.rewardDistribution.findFirst()).opsInflowPiconeros).toBe(0n)

      // Regenerated acceptance after APPLY: the phantom contribution is gone
      // exactly once and no reconstruction is emitted again.
      const second = await build()
      expect(second.manifest.issues).toEqual([])
      expect(second.manifest.operations.filter(operation => operation.table === 'RewardDistribution')).toEqual([])
      expect(second.manifest.before.opsPendingPiconeros).toBe('0')
    } finally {
      await scratch.$disconnect()
    }
  }, migrationTimeoutMs)

  test('migration refuses conflicting legacy fee terms atomically', async () => {
    const scratch = new PrismaClient({ datasourceUrl: await createScratchDb('rwr_mig_conflict') })
    try {
      const pre = migrateDeploy(preMigrationSchemaPath(), scratchUrl('rwr_mig_conflict'))
      assertDeployOk(pre)

      const { userId, accountId } = await seedUserAndAccount(scratch)
      const item = await seedBountyItem(scratch, { userId, bountyStatus: 'FUNDED' })
      const bounty = await seedObservedBounty(scratch, { postId: item.id, accountId, txHash: 'aa'.repeat(32), paymentId: 'ba'.repeat(32) })
      await seedFeeObservation(scratch, { txHash: 'aa'.repeat(32), postId: item.id, piconeros: 100n })
      // Same item, same funding, a second matched fee with a different amount.
      await seedObservedBountyReceipt(scratch, { bountyId: bounty.id, txHash: 'ff'.repeat(32) })
      await seedFeeObservation(scratch, { txHash: 'ff'.repeat(32), postId: item.id, piconeros: 200n })

      const applied = migrateDeploy(path.join(repoRoot, 'prisma', 'schema.prisma'), scratchUrl('rwr_mig_conflict'))
      expect(applied.status).not.toBe(0)
      expect(deployOutput(applied)).toContain('conflicting bounty fee terms')

      // Atomic: the migration's DDL rolled back with it.
      expect(await columnExists(scratch, 'Item', 'bountyFeePiconeros')).toBe(false)
      expect(await columnExists(scratch, 'FeeObservation', 'walletReceipt')).toBe(false)
      expect(await tableExists(scratch, 'RewardsWalletTransaction')).toBe(false)
    } finally {
      await scratch.$disconnect()
    }
  }, migrationTimeoutMs)

  test('migration refuses unresolved legacy positive fees atomically', async () => {
    const scratch = new PrismaClient({ datasourceUrl: await createScratchDb('rwr_mig_unresolved') })
    try {
      const pre = migrateDeploy(preMigrationSchemaPath(), scratchUrl('rwr_mig_unresolved'))
      assertDeployOk(pre)

      const { userId, accountId } = await seedUserAndAccount(scratch)
      // A resolvable funding fee: its backfill must roll back with the refusal.
      const item = await seedBountyItem(scratch, { userId, bountyStatus: 'FUNDED' })
      await seedObservedBounty(scratch, { postId: item.id, accountId, txHash: 'aa'.repeat(32), paymentId: 'ba'.repeat(32) })
      await seedFeeObservation(scratch, { txHash: 'aa'.repeat(32), postId: item.id, piconeros: 100n })
      // A positive legacy BOUNTY_FEE row with no funding evidence at all.
      const orphanItem = await seedBountyItem(scratch, { userId, bountyStatus: 'UNFUNDED' })
      await seedFeeObservation(scratch, { txHash: '99'.repeat(32), postId: orphanItem.id, piconeros: 500n })

      const applied = migrateDeploy(path.join(repoRoot, 'prisma', 'schema.prisma'), scratchUrl('rwr_mig_unresolved'))
      expect(applied.status).not.toBe(0)
      expect(deployOutput(applied)).toContain('unresolved legacy BOUNTY_FEE')
      expect(deployOutput(applied)).toContain('piconeros=500')

      // Atomic: the resolvable backfill and all DDL rolled back too.
      expect(await columnExists(scratch, 'Item', 'bountyFeePiconeros')).toBe(false)
      expect(await columnExists(scratch, 'FeeObservation', 'walletReceipt')).toBe(false)
      const feeRows = await scratch.$queryRawUnsafe('SELECT count(*)::int AS n FROM "FeeObservation"')
      expect(feeRows[0].n).toBe(2)
    } finally {
      await scratch.$disconnect()
    }
  }, migrationTimeoutMs)
})
