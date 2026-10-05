/* eslint-env jest */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import {
  applyRepairOperations,
  applyRewardsReconciliation
} from '@/api/monero/applyRewardsReconciliation'
import {
  buildRewardsReconciliation,
  manifestDigest,
  normalizeEvidence,
  readRepairLedger
} from '@/api/monero/rewardsReconciliation'
import { runCli, parseArgs, redactSecrets } from '../../../scripts/reconcile-rewards-wallet'
import {
  FI,
  approvedIncomingClassification,
  syntheticRewardsEvidence,
  withApprovedIncomingClassification
} from '../../fixtures/rewards-accounting-evidence'

// Isolated real-DB apply tests for the atomic accounting repair (Task 13).
//
// The database is the dedicated /stasher_rewards_repair_test one; the synthetic
// evidence is Task 12's exact money story. The suite is skipped everywhere else
// so ordinary dev-DB collection neither crashes nor touches that database.
// Run via:
//   docker exec stasher-rewards-repair-runner npm run test -- \
//     --runInBand --runTestsByPath test/api/monero/applyRewardsReconciliation.test.js

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

jest.setTimeout(60000)

const SCOPE = FI.SCOPE
const BACKUP = 'isolated-fixture-snapshot'
// Extra rows a later-activity regression may create (deleted by the fixture's
// teardown as well).
const LATER_RECEIPT_HASH = 'aa'.repeat(32)
const LATER_JOURNAL_HASH = 'bb'.repeat(32)

const reserveInputs = () => ({
  feeHeadroomPiconeros: BigInt(process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS || '1000000000'),
  dustFloorPiconeros: BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')
})

// The explicit contractual fields a repair may never change: payout
// recipient/amount/state/hash, distribution reward totals and Earn rows.
async function protectedRewardSnapshot (models) {
  return {
    payouts: await models.rewardPayout.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, distributionId: true, recipientAddress: true, piconeros: true, state: true, txHash: true }
    }),
    distributions: await models.rewardDistribution.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, poolPiconeros: true, distributedPiconeros: true, rolledOverPiconeros: true }
    }),
    earns: await models.earn.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, distributionId: true, piconeros: true }
    })
  }
}

// The mutable financial rows a repair is expected to correct (used by the
// rollback assertions).
async function repairState (models) {
  return {
    receipts: await models.feeObservation.findMany({
      where: { txHash: { in: [FI.TX.FUNDING, FI.TX.ROLLOVER, FI.TX.INCOMING, LATER_RECEIPT_HASH] } },
      orderBy: { id: 'asc' },
      select: { id: true, txHash: true, piconeros: true, rewardsPiconeros: true, walletReceipt: true, state: true }
    }),
    distribution: await models.rewardDistribution.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        opsInflowPiconeros: true,
        opsRolledOverPiconeros: true,
        opsAvailablePiconeros: true,
        opsSweptPiconeros: true,
        opsSweepTxHash: true
      }
    }),
    bountyPayments: await models.bountyPayment.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        feeRecipientAddress: true,
        networkFeePiconeros: true,
        recipientReceivedPiconeros: true,
        feeReceivedPiconeros: true,
        feeSettlementNetworkFeePiconeros: true
      }
    }),
    journal: await models.rewardsWalletTransaction.findMany({
      where: { walletAddress: SCOPE.walletAddress },
      orderBy: { txHash: 'asc' },
      select: { id: true, txHash: true, networkFeePiconeros: true, state: true }
    })
  }
}

const isRetryableRaceFailure = err =>
  ['P2034', 'P2002'].includes(err?.code) || /serializ|deadlock|write conflict/i.test(String(err?.message))

// Wraps a Prisma client so the audit insert fails once, after every financial
// correction has already been written inside the transaction.
function faultInjectAuditCreate (client) {
  let armed = true
  const wrapTx = tx => new Proxy(tx, {
    get (target, prop) {
      if (prop === 'rewardsWalletReconciliation') {
        return new Proxy(target.rewardsWalletReconciliation, {
          get (delegate, method) {
            const value = delegate[method]
            if (method === 'create' && armed) {
              return () => {
                armed = false
                throw new Error('injected audit persistence failure')
              }
            }
            return typeof value === 'function' ? value.bind(delegate) : value
          }
        })
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return new Proxy(client, {
    get (target, prop) {
      if (prop === '$transaction') {
        return (fn, options) => target.$transaction(tx => fn(wrapTx(tx)), options)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
function countingModels (client) {
  const counter = { writes: 0, transactions: 0 }
  const wrapDelegate = delegate => new Proxy(delegate, {
    get (target, method) {
      const value = target[method]
      if (typeof value === 'function' && WRITE_METHODS.has(method)) {
        return (...args) => {
          counter.writes += 1
          return value.apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return {
    models: new Proxy(client, {
      get (target, prop) {
        if (prop === '$transaction') {
          return (...args) => {
            counter.transactions += 1
            return target.$transaction(...args)
          }
        }
        const value = target[prop]
        if (value && typeof value === 'object' && typeof value.findMany === 'function') return wrapDelegate(value)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }),
    counter
  }
}

;(ISOLATED_DB ? describe : describe.skip)('atomic confirmed repair (isolated DB only)', () => {
  let db

  beforeAll(() => {
    db = new PrismaClient()
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
  })

  // FK-safe fixture for the Task 12 synthetic evidence: real users/items/
  // distributions/payouts/earns/receipts/bounty payments/journal rows in the
  // dedicated isolated DB. The manifest is built from the SAME `readRepairLedger`
  // output an operator CLI would read, so the apply preconditions are exact by
  // construction (and a non-applicable fixture fails loudly here).
  async function seedRepairFixture () {
    const fixtureInput = withApprovedIncomingClassification(syntheticRewardsEvidence())
    const rawEvidence = fixtureInput.evidence
    const configBefore = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    const created = {
      users: [],
      items: [],
      distributions: [],
      accounts: [],
      bountyPayments: [],
      feeHashes: [FI.TX.FUNDING, FI.TX.ROLLOVER, FI.TX.INCOMING, LATER_RECEIPT_HASH]
    }
    const createUser = async () => {
      const rows = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      created.users.push(rows[0].id)
      return rows[0].id
    }
    const createItem = async (userId, bountyPiconeros) => {
      const rows = await db.$queryRaw`
        INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, 'repair fixture item')
        RETURNING id::int AS id`
      const id = rows[0].id
      created.items.push(id)
      if (bountyPiconeros != null) {
        await db.item.update({ where: { id }, data: { bountyPiconeros } })
      }
      return id
    }

    const curatorOne = await createUser()
    const curatorTwo = await createUser()
    const curatorThree = await createUser()
    const awardItemId = await createItem(curatorOne, null)
    const rolloverItemId = await createItem(curatorOne, 100n)

    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(FI.DATE.DIST_START),
        periodEnd: new Date(FI.DATE.DIST_END),
        poolPiconeros: 140n,
        distributedPiconeros: 60n,
        rolledOverPiconeros: 0n,
        payoutCount: 3,
        status: 'COMPLETE',
        opsInflowPiconeros: 20n,
        opsRolledOverPiconeros: 0n,
        opsAvailablePiconeros: 20n,
        opsSweptPiconeros: 0n,
        opsSweepTxHash: null,
        opsNetworkFeesAccountedPiconeros: 0n
      }
    })
    created.distributions.push(distribution.id)

    const payoutOne = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: curatorOne, recipientAddress: FI.ADDRESS.CURATOR_ONE, piconeros: 40n, txHash: FI.TX.PAYOUT, state: 'CONFIRMED' }
    })
    const payoutTwo = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: curatorTwo, recipientAddress: FI.ADDRESS.CURATOR_TWO, piconeros: 20n, txHash: FI.TX.PAYOUT, state: 'SENT' }
    })
    const payoutThree = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId: curatorThree, recipientAddress: FI.ADDRESS.CURATOR_ONE, piconeros: 8n, txHash: null, state: 'QUEUED' }
    })

    const fundingReceipt = await db.feeObservation.create({
      data: {
        txHash: FI.TX.FUNDING,
        feeType: 'BOUNTY_FEE',
        walletReceipt: true,
        state: 'CONFIRMED',
        piconeros: 20n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        recipientMajor: 0,
        recipientMinor: 0,
        height: FI.HEIGHT.FUNDING,
        confirmedAt: new Date(FI.DATE.FUNDING),
        postId: awardItemId,
        payInId: null
      }
    })
    const rolloverReceipt = await db.feeObservation.create({
      data: {
        txHash: FI.TX.ROLLOVER,
        feeType: 'BOUNTY_ROLLOVER',
        walletReceipt: true,
        state: 'CONFIRMED',
        piconeros: 140n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        recipientMajor: 0,
        recipientMinor: 0,
        height: FI.HEIGHT.ROLLOVER,
        confirmedAt: new Date(FI.DATE.ROLLOVER),
        postId: rolloverItemId,
        payInId: null
      }
    })

    const journalBase = {
      network: SCOPE.network,
      walletAddress: SCOPE.walletAddress,
      relayAttemptedAt: new Date(FI.DATE.ROLLOVER)
    }
    await db.rewardsWalletTransaction.create({
      data: {
        ...journalBase,
        txHash: FI.TX.PAYOUT,
        kind: 'PAYOUT',
        state: 'RELAYED',
        accountIndex: 0,
        distributionId: distribution.id,
        principalPiconeros: 60n,
        networkFeePiconeros: 0n,
        metadata: {
          payouts: [
            { payoutId: payoutOne.id, recipientAddress: FI.ADDRESS.CURATOR_ONE, piconeros: '40' },
            { payoutId: payoutTwo.id, recipientAddress: FI.ADDRESS.CURATOR_TWO, piconeros: '20' }
          ]
        },
        relayedAt: new Date(FI.DATE.ROLLOVER)
      }
    })
    await db.rewardsWalletTransaction.create({
      data: {
        ...journalBase,
        txHash: FI.TX.CONSOLIDATION,
        kind: 'CONSOLIDATION',
        state: 'RELAYED',
        accountIndex: 1,
        distributionId: distribution.id,
        principalPiconeros: 0n,
        networkFeePiconeros: 3n,
        metadata: { destination: FI.ADDRESS.WALLET, selfTransfer: true },
        relayedAt: new Date(FI.DATE.ROLLOVER)
      }
    })
    await db.rewardsWalletTransaction.create({
      data: {
        ...journalBase,
        txHash: FI.TX.SWEEP,
        kind: 'OPS_SWEEP',
        state: 'RELAYED',
        accountIndex: 0,
        distributionId: distribution.id,
        principalPiconeros: 10n,
        networkFeePiconeros: 2n,
        metadata: { destination: FI.ADDRESS.OPS },
        relayedAt: new Date(FI.DATE.ROLLOVER)
      }
    })
    await db.rewardsWalletTransaction.create({
      data: {
        ...journalBase,
        txHash: FI.TX.PENDING_PAYOUT,
        kind: 'PAYOUT',
        state: 'PREPARED',
        accountIndex: 0,
        distributionId: distribution.id,
        principalPiconeros: 8n,
        networkFeePiconeros: 1n,
        metadata: {
          payouts: [{ payoutId: payoutThree.id, recipientAddress: FI.ADDRESS.CURATOR_ONE, piconeros: '8' }]
        },
        relayedAt: null
      }
    })

    const awardPayment = await db.bountyPayment.create({
      data: {
        itemId: awardItemId,
        winnerUserId: curatorOne,
        piconeros: 100n,
        feePiconeros: 20n,
        recipientAddress: FI.ADDRESS.CURATOR_ONE,
        kind: 'AWARD',
        txHash: FI.TX.AWARD,
        state: 'CONFIRMED'
      }
    })
    const rolloverPayment = await db.bountyPayment.create({
      data: {
        itemId: rolloverItemId,
        winnerUserId: curatorOne,
        piconeros: 140n,
        feePiconeros: 0n,
        recipientAddress: FI.ADDRESS.WALLET,
        kind: 'ROLLOVER',
        txHash: FI.TX.ROLLOVER,
        state: 'CONFIRMED'
      }
    })
    created.bountyPayments.push(awardPayment.id, rolloverPayment.id)

    await db.earn.createMany({
      data: [
        { userId: curatorOne, distributionId: distribution.id, piconeros: 40n },
        { userId: curatorTwo, distributionId: distribution.id, piconeros: 20n }
      ]
    })

    const account = await db.moneroAccount.create({
      data: { ownerUserId: null, address: SCOPE.walletAddress, label: 'platform_rewards', network: SCOPE.network, status: 'ACTIVE' }
    })
    created.accounts.push(account.id)

    const cleanup = async () => {
      await db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: SCOPE.walletAddress } })
      await db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: SCOPE.walletAddress } })
      await db.feeObservation.deleteMany({ where: { txHash: { in: created.feeHashes } } })
      if (created.distributions.length > 0) {
        await db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
        await db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
      }
      if (created.bountyPayments.length > 0) {
        await db.bountyPayment.deleteMany({ where: { id: { in: created.bountyPayments } } })
      }
      if (created.distributions.length > 0) {
        await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
      }
      if (created.items.length > 0) await db.item.deleteMany({ where: { id: { in: created.items } } })
      if (created.accounts.length > 0) await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
      if (created.users.length > 0) await db.user.deleteMany({ where: { id: { in: created.users } } })
      if (configBefore) {
        await db.platformFeeConfig.update({
          where: { id: 1 },
          data: {
            downvoteRewardsPct: configBefore.downvoteRewardsPct,
            postingFeeRewardsPct: configBefore.postingFeeRewardsPct,
            territoryFeeRewardsPct: configBefore.territoryFeeRewardsPct,
            boostRewardsPct: configBefore.boostRewardsPct,
            walletlessTipRewardsPct: configBefore.walletlessTipRewardsPct
          }
        })
      }
    }

    try {
      const ledger = await readRepairLedger(db, SCOPE)
      const manifest = buildRewardsReconciliation({
        scope: SCOPE,
        boundary: FI.BOUNDARY,
        evidence: rawEvidence,
        ledger,
        decisions: fixtureInput.decisions,
        config: ledger.config,
        reserve: reserveInputs(),
        opsCarryProvenance: {}
      })
      if (manifest.issues.length > 0) {
        throw new Error(`repair fixture is not applicable: ${manifest.issues.map(issue => issue.code).join(', ')}`)
      }
      return {
        models: db,
        manifest,
        evidence: normalizeEvidence(rawEvidence),
        evidenceInput: rawEvidence,
        distributionId: distribution.id,
        receipts: { fundingReceipt, rolloverReceipt },
        payouts: { payoutOne, payoutTwo, payoutThree },
        items: { awardItemId, rolloverItemId },
        cleanup
      }
    } catch (err) {
      await cleanup()
      throw err
    }
  }

  test('confirmed repair is atomic, auditable, and a replay is a no-op', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      const args = {
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      const before = await protectedRewardSnapshot(models)
      expect(await applyRewardsReconciliation(args)).toMatchObject({ applied: true, digest: manifest.digest })
      expect(await applyRewardsReconciliation(args)).toMatchObject({ applied: false, digest: manifest.digest })
      expect(await protectedRewardSnapshot(models)).toEqual(before)
      expect(await models.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)
    } finally {
      await cleanup()
    }
  })

  test('applies the exact corrections and records the full audit row', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      await applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })
      // Funding accrual is no longer a cash receipt; the rollover is the net
      // 139 with the exact frozen-prize split; the unbooked 5 is booked.
      const funding = await models.feeObservation.findUnique({ where: { txHash_recipientMajor_recipientMinor: { txHash: FI.TX.FUNDING, recipientMajor: 0, recipientMinor: 0 } } })
      expect(funding.walletReceipt).toBe(false)
      const rollover = await models.feeObservation.findUnique({ where: { txHash_recipientMajor_recipientMinor: { txHash: FI.TX.ROLLOVER, recipientMajor: 0, recipientMinor: 0 } } })
      expect(rollover).toMatchObject({ piconeros: 139n, rewardsPiconeros: 100n })
      const inserted = await models.feeObservation.findUnique({ where: { txHash_recipientMajor_recipientMinor: { txHash: FI.TX.INCOMING, recipientMajor: 0, recipientMinor: 0 } } })
      expect(inserted).toMatchObject({ feeType: 'BOUNTY_FEE', piconeros: 5n, walletReceipt: true, state: 'CONFIRMED' })
      // Journal fee corrected in place; settlement metadata recovered.
      const journal = await models.rewardsWalletTransaction.findUnique({ where: { network_walletAddress_txHash: { network: SCOPE.network, walletAddress: SCOPE.walletAddress, txHash: FI.TX.PAYOUT } } })
      expect(journal.networkFeePiconeros).toBe(7n)
      const award = await models.bountyPayment.findFirst({ where: { txHash: FI.TX.AWARD } })
      expect(award).toMatchObject({ feeRecipientAddress: FI.ADDRESS.COLD, recipientReceivedPiconeros: 100n, feeReceivedPiconeros: 17n })
      // The distribution's three ops fields are rebuilt from original terms.
      const distribution = await models.rewardDistribution.findUnique({ where: { id: manifest.operations.find(op => op.table === 'RewardDistribution').id } })
      expect(distribution).toMatchObject({ opsInflowPiconeros: 39n, opsRolledOverPiconeros: 0n, opsAvailablePiconeros: 39n, opsSweptPiconeros: 0n, opsSweepTxHash: null })
      // The audit row carries the digest, boundary and backup reference.
      const audit = await models.rewardsWalletReconciliation.findUnique({ where: { digest_kind: { digest: manifest.digest, kind: 'APPLY' } } })
      expect(audit).toMatchObject({
        network: SCOPE.network,
        walletAddress: SCOPE.walletAddress,
        height: FI.BOUNDARY.height,
        blockHash: FI.BOUNDARY.blockHash,
        ledgerFingerprint: manifest.ledgerFingerprint,
        evidenceDigest: manifest.evidenceDigest,
        positiveDriftPiconeros: BigInt(manifest.after.positiveDriftPiconeros),
        backupReference: BACKUP
      })
      expect(audit.appliedAt).toBeInstanceOf(Date)
      expect(audit.report.digest).toBe(manifest.digest)
      expect(audit.report.operations[0]).toHaveProperty('before')
      expect(audit.report.operations[0]).toHaveProperty('after')
    } finally {
      await cleanup()
    }
  })

  test('refuses a changed receipt amount with no partial financial writes', async () => {
    const { models, manifest, evidence, receipts, cleanup } = await seedRepairFixture()
    try {
      await models.feeObservation.update({ where: { id: receipts.rolloverReceipt.id }, data: { piconeros: 141n } })
      const before = await repairState(models)
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/approved ledger, item terms or fee config changed/)
      expect(await repairState(models)).toEqual(before)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses a changed frozen Item fee with no covering operation', async () => {
    const { models, manifest, evidence, items, cleanup } = await seedRepairFixture()
    try {
      expect(await models.item.findUnique({ where: { id: items.awardItemId } })).toMatchObject({ bountyFeePiconeros: null })
      await models.item.update({ where: { id: items.awardItemId }, data: { bountyFeePiconeros: 20n } })
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/approved ledger, item terms or fee config changed/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses a new journal transaction and a changed fee config', async () => {
    const first = await seedRepairFixture()
    try {
      await first.models.rewardsWalletTransaction.create({
        data: {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: LATER_JOURNAL_HASH,
          kind: 'CONSOLIDATION',
          state: 'RELAYED',
          accountIndex: 1,
          principalPiconeros: 0n,
          networkFeePiconeros: 2n,
          metadata: { destination: SCOPE.walletAddress, selfTransfer: true },
          relayAttemptedAt: new Date(),
          relayedAt: new Date()
        }
      })
      await expect(applyRewardsReconciliation({
        models: first.models,
        manifest: first.manifest,
        evidence: first.evidence,
        confirmedDigest: first.manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/scoped ledger changed/)
      expect(await first.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await first.cleanup()
    }

    const second = await seedRepairFixture()
    try {
      await second.models.platformFeeConfig.update({ where: { id: 1 }, data: { postingFeeRewardsPct: 60 } })
      await expect(applyRewardsReconciliation({
        models: second.models,
        manifest: second.manifest,
        evidence: second.evidence,
        confirmedDigest: second.manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/approved ledger, item terms or fee config changed/)
      expect(await second.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await second.cleanup()
    }
  })

  test('refuses an actively SENDING distribution', async () => {
    const { models, manifest, evidence, distributionId, cleanup } = await seedRepairFixture()
    try {
      await models.rewardDistribution.update({ where: { id: distributionId }, data: { status: 'SENDING' } })
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/actively SENDING/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses a mismatched confirmation digest and an edited operation', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: 'a'.repeat(64),
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/manifest confirmation mismatch/)

      const edited = structuredClone(manifest)
      edited.operations[0].after.piconeros = '999'
      await expect(applyRewardsReconciliation({
        models,
        manifest: edited,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/manifest confirmation mismatch/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses evidence that no longer matches the approved scope or digest', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      const wrongScope = structuredClone(evidence)
      wrongScope.scope.walletAddress = '5SomeOtherWallet'
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence: wrongScope,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/evidence scope does not match/)

      const incomplete = { ...structuredClone(evidence), escrow: null }
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence: incomplete,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/evidence does not match the approved evidence digest/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses a mismatched registered wallet', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      await models.moneroAccount.updateMany({
        where: { label: 'platform_rewards', network: SCOPE.network },
        data: { address: '5SomeOtherRegisteredWallet' }
      })
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/not the registered platform wallet/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('requires a backup reference and the writer-pause acknowledgement', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: null,
        writersPaused: true
      })).rejects.toThrow(/backup reference is required/)
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: false
      })).rejects.toThrow(/paused financial writers are required/)
      expect(await models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('refuses a manifest that still carries material issues', async () => {
    const fixture = await seedRepairFixture()
    try {
      // The DEFAULT synthetic evidence has no classification for the unbooked
      // incoming 5: the manifest reports UNKNOWN_INCOMING and is not applicable.
      const input = syntheticRewardsEvidence()
      const ledger = await readRepairLedger(fixture.models, SCOPE)
      const manifest = buildRewardsReconciliation({
        scope: SCOPE,
        boundary: FI.BOUNDARY,
        evidence: input.evidence,
        ledger,
        decisions: input.decisions,
        config: ledger.config,
        reserve: reserveInputs(),
        opsCarryProvenance: {}
      })
      expect(manifest.issues.map(issue => issue.code)).toContain('UNKNOWN_INCOMING')
      await expect(applyRewardsReconciliation({
        models: fixture.models,
        manifest,
        evidence: normalizeEvidence(input.evidence),
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/unresolved accounting evidence/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a replay is a no-op even after later legitimate activity', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      const args = {
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      expect(await applyRewardsReconciliation(args)).toMatchObject({ applied: true })
      // Legitimate later activity: a new confirmed receipt and a new relayed
      // journal row change every precondition the apply just checked.
      await models.feeObservation.create({
        data: {
          txHash: LATER_RECEIPT_HASH,
          feeType: 'BOUNTY_FEE',
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 3n,
          rewardsPiconeros: null,
          recipientMajor: 0,
          recipientMinor: 0,
          height: FI.HEIGHT.FUNDING + 5,
          confirmedAt: new Date(),
          payInId: null,
          postId: null
        }
      })
      await models.rewardsWalletTransaction.create({
        data: {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: LATER_JOURNAL_HASH,
          kind: 'CONSOLIDATION',
          state: 'RELAYED',
          accountIndex: 1,
          principalPiconeros: 0n,
          networkFeePiconeros: 2n,
          metadata: { destination: SCOPE.walletAddress, selfTransfer: true },
          relayAttemptedAt: new Date(),
          relayedAt: new Date()
        }
      })
      expect(await applyRewardsReconciliation(args)).toMatchObject({ applied: false, digest: manifest.digest })
      expect(await models.feeObservation.count({ where: { txHash: LATER_RECEIPT_HASH } })).toBe(1)
      expect(await models.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)
    } finally {
      await cleanup()
    }
  })

  test('a mid-apply persistence failure rolls back every financial write and the audit row', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      const rewardsBefore = await protectedRewardSnapshot(models)
      const financialBefore = await repairState(models)
      await expect(applyRewardsReconciliation({
        models: faultInjectAuditCreate(models),
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      })).rejects.toThrow(/injected audit persistence failure/)
      expect(await protectedRewardSnapshot(models)).toEqual(rewardsBefore)
      expect(await repairState(models)).toEqual(financialBefore)
      expect(await models.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(0)
    } finally {
      await cleanup()
    }
  })

  test('two identical applies: exactly one application, the other no-ops or fails retryably', async () => {
    const { models, manifest, evidence, cleanup } = await seedRepairFixture()
    try {
      const args = {
        models,
        manifest,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: 'race-snapshot',
        writersPaused: true
      }
      const results = await Promise.allSettled([
        applyRewardsReconciliation(args),
        applyRewardsReconciliation(args)
      ])
      const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value)
      expect(fulfilled.filter(result => result.applied)).toHaveLength(1)
      for (const rejected of results.filter(result => result.status === 'rejected')) {
        expect(isRetryableRaceFailure(rejected.reason)).toBe(true)
      }
      expect(await models.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)
      expect(await models.feeObservation.count({ where: { txHash: FI.TX.INCOMING, recipientMajor: 0, recipientMinor: 0 } })).toBe(1)
      const rollover = await models.feeObservation.findUnique({ where: { txHash_recipientMajor_recipientMinor: { txHash: FI.TX.ROLLOVER, recipientMajor: 0, recipientMinor: 0 } } })
      expect(rollover).toMatchObject({ piconeros: 139n, rewardsPiconeros: 100n })
    } finally {
      await cleanup()
    }
  })

  test('the closed operation allowlist refuses unknown or contract-mutating operations', async () => {
    const { models, cleanup } = await seedRepairFixture()
    const reason = 'probe'
    const run = operations => models.$transaction(tx => applyRepairOperations(tx, operations))
    try {
      await expect(run([{ kind: 'update', table: 'User', id: 1, before: { name: 'a' }, after: { name: 'b' }, reason }]))
        .rejects.toThrow(/not an approved update target/)
      await expect(run([{ kind: 'update', table: 'RewardPayout', id: 1, before: { piconeros: '1' }, after: { piconeros: '2' }, reason }]))
        .rejects.toThrow(/not an approved update target/)
      await expect(run([{ kind: 'update', table: 'Earn', id: 1, before: { piconeros: '1' }, after: { piconeros: '2' }, reason }]))
        .rejects.toThrow(/not an approved update target/)
      await expect(run([{ kind: 'update', table: 'RewardDistribution', id: 1, before: { opsSweptPiconeros: '0' }, after: { opsSweptPiconeros: '1' }, reason }]))
        .rejects.toThrow(/not an approved RewardDistribution correction/)
      await expect(run([{ kind: 'update', table: 'RewardDistribution', id: 1, before: { opsSweepTxHash: null }, after: { opsSweepTxHash: 'ab'.repeat(32) }, reason }]))
        .rejects.toThrow(/not an approved RewardDistribution correction/)
      await expect(run([{ kind: 'update', table: 'RewardPayout', id: 1, before: { state: 'QUEUED' }, after: { state: 'SENT' }, reason }]))
        .rejects.toThrow(/not an approved update target/)
      // Journal updates must bind the approved (network, walletAddress, txHash)
      // identity; a bare hash can never match another wallet's same-hash row.
      await expect(run([{ kind: 'update', table: 'RewardsWalletTransaction', txHash: 'ab'.repeat(32), before: { networkFeePiconeros: '0' }, after: { networkFeePiconeros: '1' }, reason }]))
        .rejects.toThrow(/must bind the approved network and wallet address/)
      // The only journal state transition is a proved PREPARED -> RELAYED.
      await expect(run([{
        kind: 'update',
        table: 'RewardsWalletTransaction',
        txHash: 'ab'.repeat(32),
        network: SCOPE.network,
        walletAddress: SCOPE.walletAddress,
        before: { state: 'RELAYED', relayedAt: null },
        after: { state: 'PREPARED', relayedAt: null },
        reason
      }])).rejects.toThrow(/only journal state transition is PREPARED -> RELAYED/)
      await expect(run([{
        kind: 'update',
        table: 'RewardsWalletTransaction',
        txHash: 'ab'.repeat(32),
        network: SCOPE.network,
        walletAddress: SCOPE.walletAddress,
        before: { relayedAt: null },
        after: { relayedAt: '2026-09-07T00:00:00.000Z' },
        reason
      }])).rejects.toThrow(/only a proved PREPARED -> RELAYED journal transition may change state\/relayedAt/)
      await expect(run([{ kind: 'update', table: 'FeeObservation', id: 1, before: { walletReceipt: true }, after: { walletReceipt: false }, network: SCOPE.network, walletAddress: SCOPE.walletAddress, reason }]))
        .rejects.toThrow(/do not carry a journal scope/)
      await expect(run([{ kind: 'update', table: 'Item', id: 1, before: { bountyFeePiconeros: null }, after: { bountyFeePiconeros: '20' }, relayProof: { txHash: 'ab'.repeat(32) }, reason }]))
        .rejects.toThrow(/do not carry a relay proof/)
      await expect(run([{
        kind: 'update',
        table: 'RewardsWalletTransaction',
        txHash: 'ab'.repeat(32),
        network: SCOPE.network,
        walletAddress: SCOPE.walletAddress,
        before: { networkFeePiconeros: '0' },
        after: { networkFeePiconeros: '1' },
        relayProof: { txHash: 'ab'.repeat(32), accountIndex: 0, height: 1, feePiconeros: '1', destinations: [{ address: '5A', amountPiconeros: '1' }] },
        reason
      }])).rejects.toThrow(/relay proof is only valid with a PREPARED -> RELAYED transition/)
      await expect(run([{ kind: 'update', table: 'BountyPayment', id: 1, before: { piconeros: '1', txHash: null }, after: { piconeros: '2', txHash: null }, reason }]))
        .rejects.toThrow(/not an approved BountyPayment correction/)
      await expect(run([{ kind: 'update', table: 'FeeObservation', id: 1, before: { piconeros: '1' }, after: { piconeros: '2' }, reason, extra: true }]))
        .rejects.toThrow(/unknown operation field/)
      await expect(run([{ kind: 'update', table: 'FeeObservation', id: 1, before: { piconeros: '1' }, after: { rewardsPiconeros: '1' }, reason }]))
        .rejects.toThrow(/same non-empty field set/)
      await expect(run([{ kind: 'delete', table: 'FeeObservation', id: 1, before: { piconeros: '1' }, after: {}, reason }]))
        .rejects.toThrow(/unknown operation kind/)
      // Compare-before-write: a target row that no longer matches must affect
      // zero rows and refuse (the (digest,kind) key already exists for nothing
      // else in this transaction, so the probe can never match).
      await expect(run([{ kind: 'update', table: 'FeeObservation', id: 999999, before: { walletReceipt: true }, after: { walletReceipt: false }, reason }]))
        .rejects.toThrow(/expected exactly one matching FeeObservation row, found 0/)
    } finally {
      await cleanup()
    }
  })

  test('the closed operation allowlist applies an Item fee freeze and a proved journal insert', async () => {
    const { models, items, cleanup } = await seedRepairFixture()
    try {
      const item = await models.item.findUnique({ where: { id: items.awardItemId } })
      expect(item.bountyFeePiconeros).toBeNull()
      const journalHash = 'cd'.repeat(32)
      await models.$transaction(tx => applyRepairOperations(tx, [
        {
          kind: 'update',
          table: 'Item',
          id: items.awardItemId,
          before: { bountyFeePiconeros: null },
          after: { bountyFeePiconeros: '20' },
          reason: 'freeze-verified-terms'
        },
        {
          kind: 'insert',
          table: 'RewardsWalletTransaction',
          key: { network: SCOPE.network, walletAddress: SCOPE.walletAddress, txHash: journalHash },
          before: null,
          after: {
            network: SCOPE.network,
            walletAddress: SCOPE.walletAddress,
            txHash: journalHash,
            kind: 'CONSOLIDATION',
            state: 'RELAYED',
            accountIndex: 1,
            distributionId: null,
            principalPiconeros: '0',
            networkFeePiconeros: '2',
            metadata: { destination: SCOPE.walletAddress, selfTransfer: true },
            relayAttemptedAt: null
          },
          reason: 'wallet-history-relay'
        }
      ]))
      expect(await models.item.findUnique({ where: { id: items.awardItemId } })).toMatchObject({ bountyFeePiconeros: 20n })
      expect(await models.rewardsWalletTransaction.findUnique({ where: { network_walletAddress_txHash: { network: SCOPE.network, walletAddress: SCOPE.walletAddress, txHash: journalHash } } }))
        .toMatchObject({ kind: 'CONSOLIDATION', state: 'RELAYED', networkFeePiconeros: 2n })
    } finally {
      await cleanup()
    }
  })

  test('the closed operation allowlist applies a PROVED PREPARED -> RELAYED journal transition', async () => {
    const fixture = await seedRepairFixture()
    const { models, cleanup } = fixture
    const relayHash = 'ef'.repeat(32)
    const relayHeight = FI.HEIGHT.PAYOUT + 1
    const relayFee = '2'
    const relayPrincipal = 10n
    const evidence = structuredClone(fixture.evidenceInput)
    evidence.outgoing.push({
      txHash: relayHash,
      accountIndex: 0,
      feePiconeros: relayFee,
      destinations: [{ address: FI.ADDRESS.OPS, amountPiconeros: relayPrincipal.toString() }],
      height: relayHeight,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    })
    const transition = {
      kind: 'update',
      table: 'RewardsWalletTransaction',
      txHash: relayHash,
      network: SCOPE.network,
      walletAddress: SCOPE.walletAddress,
      before: { state: 'PREPARED', relayedAt: null, networkFeePiconeros: '1' },
      after: { state: 'RELAYED', relayedAt: '2026-09-07T00:00:00.000Z', networkFeePiconeros: relayFee },
      relayProof: {
        txHash: relayHash,
        accountIndex: 0,
        height: relayHeight,
        feePiconeros: relayFee,
        destinations: [{ address: FI.ADDRESS.OPS, amountPiconeros: relayPrincipal.toString() }]
      },
      reason: 'proved-relay-state'
    }
    try {
      const row = await models.rewardsWalletTransaction.create({
        data: {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: relayHash,
          kind: 'OPS_SWEEP',
          state: 'PREPARED',
          accountIndex: 0,
          distributionId: null,
          principalPiconeros: relayPrincipal,
          networkFeePiconeros: 1n,
          metadata: { destination: FI.ADDRESS.OPS },
          relayAttemptedAt: new Date(),
          relayedAt: null
        }
      })

      await models.$transaction(tx => applyRepairOperations(tx, [transition], { evidence }))
      const updated = await models.rewardsWalletTransaction.findUnique({ where: { id: row.id } })
      expect(updated).toMatchObject({ state: 'RELAYED', networkFeePiconeros: 2n })
      expect(updated.relayedAt).toEqual(new Date('2026-09-07T00:00:00.000Z'))
    } finally {
      await cleanup()
    }
  })

  test('an UNPROVED PREPARED -> RELAYED transition is refused with no state change', async () => {
    const fixture = await seedRepairFixture()
    const { models, cleanup } = fixture
    const relayHash = 'ef'.repeat(32)
    const relayHeight = FI.HEIGHT.PAYOUT + 1
    const relayFee = '2'
    const relayPrincipal = 10n
    const destinations = [{ address: FI.ADDRESS.OPS, amountPiconeros: relayPrincipal.toString() }]
    const evidence = structuredClone(fixture.evidenceInput)
    evidence.outgoing.push({
      txHash: relayHash,
      accountIndex: 0,
      feePiconeros: relayFee,
      destinations,
      height: relayHeight,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    })
    const baseProof = { txHash: relayHash, accountIndex: 0, height: relayHeight, feePiconeros: relayFee, destinations }
    const base = {
      kind: 'update',
      table: 'RewardsWalletTransaction',
      txHash: relayHash,
      network: SCOPE.network,
      walletAddress: SCOPE.walletAddress,
      before: { state: 'PREPARED', relayedAt: null, networkFeePiconeros: '1' },
      after: { state: 'RELAYED', relayedAt: '2026-09-07T00:00:00.000Z', networkFeePiconeros: relayFee },
      relayProof: baseProof,
      reason: 'probe'
    }
    const run = (operations, options) => models.$transaction(tx => applyRepairOperations(tx, operations, options))
    try {
      const row = await models.rewardsWalletTransaction.create({
        data: {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: relayHash,
          kind: 'OPS_SWEEP',
          state: 'PREPARED',
          accountIndex: 0,
          distributionId: null,
          principalPiconeros: relayPrincipal,
          networkFeePiconeros: 1n,
          metadata: { destination: FI.ADDRESS.OPS },
          relayAttemptedAt: new Date(),
          relayedAt: null
        }
      })

      // A relay attempt alone is NOT a relay: no approved evidence at all.
      await expect(run([base])).rejects.toThrow(/requires the approved chain evidence/)
      // The evidence linkage itself is mandatory.
      const noProof = structuredClone(base)
      delete noProof.relayProof
      await expect(run([noProof], { evidence })).rejects.toThrow(/requires its exact relayProof/)
      // A relay proof that does not match the approved evidence is refused.
      const wrongDestinations = structuredClone(base)
      wrongDestinations.relayProof.destinations = [{ address: '5SomebodyElse', amountPiconeros: '10' }]
      await expect(run([wrongDestinations], { evidence })).rejects.toThrow(/destinations do not match the approved evidence/)
      const wrongFee = structuredClone(base)
      wrongFee.relayProof.feePiconeros = '3'
      wrongFee.after.networkFeePiconeros = '3'
      await expect(run([wrongFee], { evidence })).rejects.toThrow(/height\/fee do not match the approved evidence/)
      // A mempool bridge item is not a confirmed relay.
      const pending = structuredClone(fixture.evidenceInput)
      pending.bridge.pendingOutgoing[0].destinations = [{ address: FI.ADDRESS.CURATOR_ONE, amountPiconeros: '8' }]
      pending.bridge.pendingOutgoing[0].feePiconeros = '1'
      const pendingHash = FI.TX.PENDING_PAYOUT
      const pendingOp = {
        ...structuredClone(base),
        txHash: pendingHash,
        relayProof: {
          txHash: pendingHash,
          accountIndex: 0,
          height: FI.HEIGHT.PAYOUT,
          feePiconeros: '1',
          destinations: [{ address: FI.ADDRESS.CURATOR_ONE, amountPiconeros: '8' }]
        }
      }
      await expect(run([pendingOp], { evidence: pending })).rejects.toThrow(/does not prove a confirmed outgoing relay/)

      // The same confirmed proof cannot transition a row with no relay attempt.
      await models.rewardsWalletTransaction.update({ where: { id: row.id }, data: { relayAttemptedAt: null } })
      await expect(run([base], { evidence })).rejects.toThrow(/no recorded relay attempt/)

      // Nothing above changed the row.
      const unchanged = await models.rewardsWalletTransaction.findUnique({ where: { id: row.id } })
      expect(unchanged).toMatchObject({ state: 'PREPARED', relayedAt: null })
      expect(unchanged.networkFeePiconeros).toBe(1n)
    } finally {
      await cleanup()
    }
  })

  test('the CLI dry-run writes only the report file and the CLI apply never signs', async () => {
    const fixture = await seedRepairFixture()
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const decisionsPath = path.join(dir, 'decisions.json')
      writeFileSync(decisionsPath, JSON.stringify({ receipts: { [FI.TX.INCOMING]: approvedIncomingClassification() } }))
      const outputPath = path.join(dir, 'report.json')
      const { models, counter } = countingModels(fixture.models)
      const dryRun = await runCli(['--decisions', decisionsPath, '--output', outputPath], {
        models,
        scope: SCOPE,
        collectEvidence: async () => fixture.evidenceInput,
        log: () => {}
      })
      expect(dryRun.mode).toBe('dry-run')
      expect(dryRun.digest).toBe(fixture.manifest.digest)
      expect(counter.transactions).toBe(0)
      expect(counter.writes).toBe(0)
      expect(statSync(outputPath).mode & 0o777).toBe(0o600)
      const report = JSON.parse(readFileSync(outputPath, 'utf8'))
      expect(manifestDigest(report.manifest)).toBe(fixture.manifest.digest)
      expect(report.evidence.scope).toEqual(SCOPE)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { walletAddress: SCOPE.walletAddress } })).toBe(0)
      // Exclusive creation: an existing path (including any input) is never overwritten.
      await expect(runCli(['--decisions', decisionsPath, '--output', outputPath], {
        models,
        scope: SCOPE,
        collectEvidence: async () => fixture.evidenceInput,
        log: () => {}
      })).rejects.toThrow(/EEXIST|file already exists/i)

      // Confirmed apply through the CLI: rescan + boundary re-verification, no
      // signing method is ever reachable from the CLI's own imports/calls.
      const signing = { createTx: jest.fn(), relayTx: jest.fn(), sweepUnlocked: jest.fn() }
      const daemon = {
        getBlockHashByHeight: jest.fn(async height => {
          if (height !== FI.BOUNDARY.height) throw new Error('unknown block height')
          return FI.BOUNDARY.blockHash
        })
      }
      const applied = await runCli([
        '--apply', outputPath,
        '--confirm', fixture.manifest.digest,
        '--backup-reference', 'vps-pre-migration-snapshot',
        '--writers-paused'
      ], {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence: async () => {
          expect(signing.createTx).not.toHaveBeenCalled()
          expect(signing.relayTx).not.toHaveBeenCalled()
          expect(signing.sweepUnlocked).not.toHaveBeenCalled()
          return fixture.evidenceInput
        },
        log: () => {}
      })
      expect(applied).toEqual({ mode: 'apply', applied: true, digest: fixture.manifest.digest })
      expect(daemon.getBlockHashByHeight).toHaveBeenCalledWith(FI.BOUNDARY.height)
      const source = readFileSync(path.join(process.cwd(), 'scripts/reconcile-rewards-wallet.js'), 'utf8')
      for (const forbidden of ['sendPayouts', 'sweepOpsEarmark', 'relayWalletTransaction', 'reconcileWalletTransactions', 'requeueFailedPayouts', 'rewardsDistributor', 'opsSweepQueue', "from '@/api/monero/rewards'", "from '@/api/monero/rewardsTransactions'"]) {
        expect(source).not.toContain(forbidden)
      }
      const applySource = readFileSync(path.join(process.cwd(), 'api/monero/applyRewardsReconciliation.js'), 'utf8')
      for (const forbidden of ['sendPayouts', 'sweepOpsEarmark', 'relayTx', 'createTx', 'sweepUnlocked', "from '@/api/monero/rewards'", "from '@/api/monero/rewardsTransactions'"]) {
        expect(applySource).not.toContain(forbidden)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test('the CLI refuses an incompatible rescan and a non-canonical boundary before applying', async () => {
    const fixture = await seedRepairFixture()
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const reportPath = path.join(dir, 'report.json')
      writeFileSync(reportPath, JSON.stringify({ manifest: fixture.manifest, evidence: fixture.evidence }))
      const args = [
        '--apply', reportPath,
        '--confirm', fixture.manifest.digest,
        '--backup-reference', BACKUP,
        '--writers-paused'
      ]
      const daemon = {
        getBlockHashByHeight: jest.fn(async () => FI.BOUNDARY.blockHash)
      }
      // A failed rescan aborts: the approved evidence is never reused as fresh
      // permission to apply.
      await expect(runCli(args, {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence: async () => { throw new Error('rescan unavailable') },
        log: () => {}
      })).rejects.toThrow(/rescan unavailable/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // The tip advanced with a changed accounting fact: a new manifest/review is required.
      const changed = structuredClone(fixture.evidenceInput)
      changed.balances.totalPiconeros = '63'
      await expect(runCli(args, {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence: async () => changed,
        log: () => {}
      })).rejects.toThrow(/changed chain facts/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // An approved pending relay proof disappearing leaves confirmed facts and
      // the balance unchanged, but the manifest relied on that proof.
      const droppedPending = structuredClone(fixture.evidenceInput)
      droppedPending.bridge.pendingOutgoing = []
      await expect(runCli(args, {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence: async () => droppedPending,
        log: () => {}
      })).rejects.toThrow(/changed chain facts/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // A new pending item is a new material unknown: also a new manifest/review.
      const addedPending = structuredClone(fixture.evidenceInput)
      addedPending.bridge.pendingIncoming.push({
        txHash: 'ee'.repeat(32),
        accountIndex: 0,
        subaddressIndex: 0,
        amountPiconeros: '9',
        inTxPool: true,
        isConfirmed: false
      })
      await expect(runCli(args, {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence: async () => addedPending,
        log: () => {}
      })).rejects.toThrow(/changed chain facts/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // A reorg below the approved boundary invalidates the manifest.
      const reorged = { getBlockHashByHeight: jest.fn(async () => 'ff'.repeat(32)) }
      await expect(runCli(args, {
        models: fixture.models,
        scope: SCOPE,
        daemon: reorged,
        collectEvidence: async () => fixture.evidenceInput,
        log: () => {}
      })).rejects.toThrow(/no longer canonical/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test('the CLI publishes a CHECK only when explicitly flagged, with real drift', async () => {
    const fixture = await seedRepairFixture()
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const decisionsPath = path.join(dir, 'decisions.json')
      writeFileSync(decisionsPath, JSON.stringify({ receipts: { [FI.TX.INCOMING]: approvedIncomingClassification() } }))
      const result = await runCli(['--publish-check', '--decisions', decisionsPath], {
        models: fixture.models,
        scope: SCOPE,
        collectEvidence: async () => fixture.evidenceInput,
        log: () => {}
      })
      expect(result).toMatchObject({ mode: 'publish-check', published: true, digest: fixture.manifest.digest })
      const row = await fixture.models.rewardsWalletReconciliation.findUnique({
        where: { digest_kind: { digest: fixture.manifest.digest, kind: 'CHECK' } }
      })
      expect(row).toMatchObject({
        kind: 'CHECK',
        network: SCOPE.network,
        walletAddress: SCOPE.walletAddress,
        height: FI.BOUNDARY.height,
        blockHash: FI.BOUNDARY.blockHash,
        positiveDriftPiconeros: BigInt(fixture.manifest.before.positiveDriftPiconeros),
        backupReference: null
      })
      // The CHECK records the CURRENT measured drift, never the hypothetical
      // post-repair drift (which is 0 here): publishing must not clear the real
      // phantom discrepancy before the corrections are applied.
      expect(fixture.manifest.before.positiveDriftPiconeros).not.toBe(fixture.manifest.after.positiveDriftPiconeros)
      expect(row.positiveDriftPiconeros).not.toBe(BigInt(fixture.manifest.after.positiveDriftPiconeros))
      expect(row.report.manifest.digest).toBe(fixture.manifest.digest)
      expect(row.report.evidence.scope).toEqual(SCOPE)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
      // Re-publishing the same manifest is an idempotent no-op.
      const replay = await runCli(['--publish-check', '--decisions', decisionsPath], {
        models: fixture.models,
        scope: SCOPE,
        collectEvidence: async () => fixture.evidenceInput,
        log: () => {}
      })
      expect(replay).toMatchObject({ published: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })
})

describe('reconcile-rewards-wallet CLI argument handling', () => {
  test('defaults to dry-run and accepts the documented flags', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', output: null, decisions: null })
    expect(parseArgs(['--output', 'report.json'])).toMatchObject({ mode: 'dry-run', output: 'report.json' })
    expect(parseArgs(['--publish-check', '--decisions', 'decisions.json'])).toMatchObject({ mode: 'publish-check', decisions: 'decisions.json' })
    const apply = parseArgs([
      '--apply', 'report.json',
      '--confirm', 'a'.repeat(64),
      '--backup-reference', 'snapshot-1',
      '--writers-paused'
    ])
    expect(apply).toMatchObject({ mode: 'apply', apply: 'report.json', confirm: 'a'.repeat(64), backupReference: 'snapshot-1', writersPaused: true })
  })

  test('rejects unknown, repeated, incomplete and cross-mode flags', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['extra'])).toThrow(/unknown argument/)
    expect(() => parseArgs(['--output'])).toThrow(/missing value for --output/)
    expect(() => parseArgs(['--output', 'a', '--output', 'b'])).toThrow(/repeated argument/)
    expect(() => parseArgs(['--publish-check', '--confirm', 'a'.repeat(64)])).toThrow(/does not accept --confirm/)
    expect(() => parseArgs(['--publish-check', '--writers-paused'])).toThrow(/does not accept --writers-paused/)
    expect(() => parseArgs(['--apply', 'report.json'])).toThrow(/requires --confirm/)
    expect(() => parseArgs(['--apply', 'report.json', '--confirm', 'zz', '--backup-reference', 'x', '--writers-paused']))
      .toThrow(/SHA-256/)
    expect(() => parseArgs(['--apply', 'report.json', '--confirm', 'a'.repeat(64), '--writers-paused']))
      .toThrow(/requires --backup-reference/)
    expect(() => parseArgs(['--apply', 'report.json', '--confirm', 'a'.repeat(64), '--backup-reference', 'x', '--writers-paused', '--output', 'y']))
      .toThrow(/--output is not accepted/)
    expect(() => parseArgs(['--apply', 'report.json', '--confirm', 'a'.repeat(64), '--backup-reference', 'x', '--writers-paused', '--decisions', 'd']))
      .toThrow(/--decisions is not accepted/)
  })

  test('redacts configured credentials and 64-hex secrets from printed errors', () => {
    const key = 'PLATFORM_REWARDS_SPEND_KEY'
    const previous = process.env[key]
    process.env[key] = 'f'.repeat(64)
    try {
      const redacted = redactSecrets(`failed with key ${'f'.repeat(64)} for wallet ${'a'.repeat(64)}`)
      expect(redacted).not.toContain('f'.repeat(64))
      expect(redacted).toContain('[redacted')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
})

// Final-review Important regression: the contractual signed ops fields must
// accept exact negative values (known debt) in both before and after, while
// every other money field stays nonnegative and a corrected snapshot must be
// internally consistent. Pure dispatcher coverage (no DB) so it runs everywhere.
describe('signed ops repair operations', () => {
  const fakeTx = () => {
    const calls = []
    return {
      calls,
      rewardDistribution: {
        async updateMany (args) {
          calls.push(args)
          return { count: 1 }
        }
      }
    }
  }
  const signedOperation = {
    kind: 'update',
    table: 'RewardDistribution',
    id: 1,
    before: { opsInflowPiconeros: '0', opsRolledOverPiconeros: '-3', opsAvailablePiconeros: '-3' },
    after: { opsInflowPiconeros: '5', opsRolledOverPiconeros: '-8', opsAvailablePiconeros: '-3' },
    reason: 'ops-inflow-rebuild'
  }

  test('accepts exact signed carry/available values and applies them', async () => {
    const tx = fakeTx()
    await applyRepairOperations(tx, [signedOperation])
    expect(tx.calls).toHaveLength(1)
    expect(tx.calls[0].data).toEqual({
      opsInflowPiconeros: 5n,
      opsRolledOverPiconeros: -8n,
      opsAvailablePiconeros: -3n
    })
  })

  test('keeps ops inflow (and other money) nonnegative', async () => {
    const tx = fakeTx()
    await expect(applyRepairOperations(tx, [{
      ...signedOperation,
      after: { ...signedOperation.after, opsInflowPiconeros: '-1' }
    }])).rejects.toThrow(/nonnegative/)
    expect(tx.calls).toHaveLength(0)
  })

  test('refuses malformed signed literals', async () => {
    const tx = fakeTx()
    await expect(applyRepairOperations(tx, [{
      ...signedOperation,
      after: { ...signedOperation.after, opsAvailablePiconeros: '1.5' }
    }])).rejects.toThrow(/signed decimal/)
    await expect(applyRepairOperations(tx, [{
      ...signedOperation,
      after: { ...signedOperation.after, opsAvailablePiconeros: '+3' }
    }])).rejects.toThrow(/signed decimal/)
    expect(tx.calls).toHaveLength(0)
  })

  test('refuses an inconsistent corrected snapshot (available != inflow + rolled)', async () => {
    const tx = fakeTx()
    await expect(applyRepairOperations(tx, [{
      ...signedOperation,
      after: { ...signedOperation.after, opsAvailablePiconeros: '-2' }
    }])).rejects.toThrow(/available = inflow \+ rolled/)
    expect(tx.calls).toHaveLength(0)
  })
})
