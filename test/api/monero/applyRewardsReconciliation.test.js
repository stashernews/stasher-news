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
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { recordedOutflowCoverage } from '@/api/monero/rewardsOutflowCoverage'
import { LEGACY_BACKFILL_REASON, RELAY_PROVENANCE } from '@/api/monero/rewardsRelayProof'
import { verifyLegacyPaymentTransaction } from '@/api/monero/paymentVerification'
import { paymentChainFixture, paymentTxFixture } from '../../fixtures/payment-proof'
import { runCli, parseArgs, redactSecrets } from '../../../scripts/reconcile-rewards-wallet'
import {
  FI,
  approvedIncomingClassification,
  syntheticRewardsEvidence,
  withApprovedIncomingClassification
} from '../../fixtures/rewards-accounting-evidence'
import {
  VERIFIED_ATTEMPTED_AT,
  VERIFIED_OBSERVED_AT,
  VERIFIED_PREPARED_AT,
  closeVerifiedRepairFixtures,
  legacyRepairFixture,
  verifiedFixtureIds,
  verifiedRepairFixture
} from '../../fixtures/rewards-payment-verification'

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

// A closed-shape COMPLETE verifier-result test double for the APPLY-gate
// suites (final-review I1/I2): the synthetic story's recorded outflows are
// covered by these explicit complete payments, exactly the evidence an
// operator-approved repair requires. Safe result shape only; never a claim
// about the historical fixture itself (the fixture stays unresolved without
// them).
const OBSERVED_AT = '2026-10-06T12:00:00.000Z'
const completeTestVerification = ({ hash, scope, members, role = 'REWARDS', fee = '3', owned = '5' }) => {
  const total = members.reduce((acc, member) => acc + BigInt(member.actualPiconeros), 0n)
  return {
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...scope },
    journalRole: role,
    journalId: null,
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
    observedAt: OBSERVED_AT,
    boundary: { height: 2999999, blockHash: 'b1'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'e1'.repeat(32)
  }
}

// The proof-era evidence extension for the synthetic story: the recorded
// payout batch covered by a REWARDS verification. The ESCROW leg verifications
// are injected AFTER the rows are seeded (final-review I1 round 3: the
// canonical escrow member id is the recorded bounty payment's own id).
const withCompleteStoryVerifications = input => {
  const out = structuredClone(input)
  out.evidence.evidenceVersion = 2
  out.evidence.collectionStartedAt = OBSERVED_AT
  out.evidence.observedAt = OBSERVED_AT
  out.evidence.paymentVerifications = [completeTestVerification({
    hash: FI.TX.PAYOUT,
    scope: FI.SCOPE,
    members: [
      { address: FI.ADDRESS.CURATOR_ONE, actualPiconeros: '40' },
      { address: FI.ADDRESS.CURATOR_TWO, actualPiconeros: '20' }
    ]
  })]
  return out
}

// The two recorded escrow settlement legs' covering proofs: each leg's member
// carries the canonical identity (member id = the recorded bounty payment id,
// canonical leg, the recorded recipient and its settled amount).
const storyEscrowVerifications = (awardPayment, rolloverPayment) => {
  const escrowScope = { network: FI.SCOPE.network, walletAddress: FI.ADDRESS.ESCROW }
  return [
    completeTestVerification({
      hash: FI.TX.AWARD,
      scope: escrowScope,
      members: [{ id: String(awardPayment.id), leg: 'PRINCIPAL', address: FI.ADDRESS.CURATOR_ONE, actualPiconeros: '100' }],
      role: 'ESCROW'
    }),
    completeTestVerification({
      hash: FI.TX.ROLLOVER,
      scope: escrowScope,
      members: [{ id: String(rolloverPayment.id), leg: 'PRINCIPAL', address: FI.ADDRESS.WALLET, actualPiconeros: '139' }],
      role: 'ESCROW'
    })
  ]
}

// Task 5: the apply gate performs its own guarded recheck. Tests inject the
// read-only collection (the SAME approved evidence the fixture built from —
// never a serialized report treated as fresh authority) and the boundary
// daemon that still reports the approved block hash as canonical.
const boundaryDaemon = () => ({
  getBlockHashByHeight: jest.fn(async height => {
    if (height !== FI.BOUNDARY.height) throw new Error('unknown block height')
    return FI.BOUNDARY.blockHash
  })
})
// Echoes the evidence argument a given call is exercising (including mutated
// variants) so the fine-grained precondition refusals stay pinned, and provides
// the boundary daemon the apply gate re-verifies against.
const replayDeps = evidence => ({
  collectEvidence: async () => evidence,
  daemon: boundaryDaemon()
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

  beforeAll(async () => {
    db = new PrismaClient()
    // One-time reset of rows an earlier crashed run may have leaked into the
    // shared throwaway DB: both fixture families (the Task 12 synthetic story
    // and the Task 3/5 verified pair) register ownerless platform_rewards
    // wallets on the same isolated database. Journal+proof deletion shares one
    // transaction (the deferred delete-guard requires the pair to go together).
    const addresses = [SCOPE.walletAddress, verifiedFixtureIds.SCOPE.walletAddress]
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: { in: addresses } } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: { in: addresses } } }),
      db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: { in: addresses } } })
    ])
    await db.subaddressIndex.deleteMany({ where: { address: { in: addresses } } })
    await db.moneroAccount.deleteMany({ where: { label: 'platform_rewards', ownerUserId: null } })
    await db.rewardPayout.deleteMany({ where: { id: { in: [11, 12] } } })
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
    // Final-review I1: the seeded story's recorded outflows (the CONFIRMED/
    // SENT payout batch and both escrow settlement legs) are covered by
    // explicit complete verifications — the historical fixture alone now
    // correctly builds an UNRESOLVED strict audit and can never be applied.
    const fixtureInput = withApprovedIncomingClassification(
      withCompleteStoryVerifications(syntheticRewardsEvidence())
    )
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

    // Final-review I1 round 3: the escrow leg verifications bind the CANONICAL
    // escrow member id — the recorded bounty payment's own id — so they are
    // injected here, after the rows exist.
    rawEvidence.escrow = {
      ...rawEvidence.escrow,
      paymentVerifications: storyEscrowVerifications(awardPayment, rolloverPayment)
    }

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
      expect(await applyRewardsReconciliation(args, replayDeps(evidence))).toMatchObject({ applied: true, digest: manifest.digest })
      expect(await applyRewardsReconciliation(args, replayDeps(evidence))).toMatchObject({ applied: false, digest: manifest.digest })
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
      }, replayDeps(evidence))
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
      // The stored report is the wrapper around the untouched approved
      // manifest plus the separately recorded fresh recheck time.
      expect(audit.report.manifest.digest).toBe(manifest.digest)
      expect(audit.report.manifest.operations[0]).toHaveProperty('before')
      expect(audit.report.manifest.operations[0]).toHaveProperty('after')
      // The proof-era synthetic collection carries an explicit observation
      // instant (the v2 re-verification contract), so the recorded recheck
      // time is that collection's observation — the manifest stays untouched.
      expect(audit.report.reverifiedAt).toBe(OBSERVED_AT)
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
      }, replayDeps(evidence))).rejects.toThrow(/approved ledger, item terms or fee config changed/)
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
      }, replayDeps(evidence))).rejects.toThrow(/approved ledger, item terms or fee config changed/)
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
      }, replayDeps(first.evidence))).rejects.toThrow(/approved ledger, item terms or fee config changed/)
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
      }, replayDeps(second.evidence))).rejects.toThrow(/approved ledger, item terms or fee config changed/)
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
      }, replayDeps(evidence))).rejects.toThrow(/actively SENDING/)
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
      }, replayDeps(evidence))).rejects.toThrow(/manifest confirmation mismatch/)

      const edited = structuredClone(manifest)
      edited.operations[0].after.piconeros = '999'
      await expect(applyRewardsReconciliation({
        models,
        manifest: edited,
        evidence,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }, replayDeps(evidence))).rejects.toThrow(/manifest confirmation mismatch/)
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
      // Final-review I2: the re-verification gate binds every collected
      // result to its slot's wallet scope, so a wrong-scope evidence now
      // refuses there (fail closed) — the verification facts can never be
      // silently re-attributed to another wallet.
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence: wrongScope,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }, replayDeps(wrongScope))).rejects.toThrow(/another wallet scope|evidence scope does not match/)

      const incomplete = { ...structuredClone(evidence), escrow: null }
      await expect(applyRewardsReconciliation({
        models,
        manifest,
        evidence: incomplete,
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }, replayDeps(incomplete))).rejects.toThrow(/evidence does not match the approved evidence digest/)
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
      }, replayDeps(evidence))).rejects.toThrow(/not the registered platform/)
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

  test('fresh escrow proof loss and legacy surviving-proof loss refuse the guarded APPLY (final-review I2)', async () => {
    const fixture = await seedRepairFixture()
    try {
      const args = {
        models: fixture.models,
        manifest: fixture.manifest,
        evidence: fixture.evidence,
        confirmedDigest: fixture.manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      const deps = fresh => ({ collectEvidence: async () => fresh, daemon: boundaryDaemon() })
      const before = await repairState(fixture.models)

      // A complete verifier result downgraded to the collector's explicit
      // legacy-unresolved shape (missing surviving proof): same closed result
      // contract, no complete payment.
      const downgrade = verification => ({
        ...verification,
        status: 'unresolved',
        issues: ['LEGACY_PROOF_MISSING'],
        survivingEvidenceDigest: null,
        totals: { D: null, O: null, F: null, E: null, residual: null },
        members: [],
        receivingAggregates: [],
        ownedAccounting: { totalPiconeros: null, outputs: [] },
        confirmation: { height: null, blockHash: null, confirmations: null },
        boundary: { height: null, blockHash: null }
      })

      // 1. ESCROW disposition evidence: the fresh collection DROPS the award
      // leg's complete verification (history unchanged). The nested escrow
      // verifier facts are part of the chain-facts identity, and the
      // re-verification gate owns them under the escrow scope — either way
      // the apply rolls back with no audit row.
      const escrowProofLost = structuredClone(fixture.evidenceInput)
      escrowProofLost.escrow.paymentVerifications =
        escrowProofLost.escrow.paymentVerifications.filter(entry => entry.txHash !== FI.TX.AWARD)
      await expect(applyRewardsReconciliation(args, deps(escrowProofLost)))
        .rejects.toThrow(/changed chain facts|no longer proves/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // 2. The same escrow proof freshly DOWNGRADED (LEGACY_PROOF_MISSING):
      // a non-complete result can never re-prove the relied-upon disposition.
      const escrowDowngraded = structuredClone(fixture.evidenceInput)
      escrowDowngraded.escrow.paymentVerifications = escrowDowngraded.escrow.paymentVerifications
        .map(entry => (entry.txHash === FI.TX.AWARD ? downgrade(entry) : entry))
      await expect(applyRewardsReconciliation(args, deps(escrowDowngraded)))
        .rejects.toThrow(/changed chain facts|no longer verifies complete/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // 3. LEGACY surviving-proof loss for the REWARDS payout proof: the
      // top-level verifier facts stay gate-compared (not part of the
      // chain-facts fingerprint), and the gate refuses the downgrade.
      const rewardsLost = structuredClone(fixture.evidenceInput)
      rewardsLost.paymentVerifications = [downgrade(rewardsLost.paymentVerifications[0])]
      await expect(applyRewardsReconciliation(args, deps(rewardsLost)))
        .rejects.toThrow(/no longer verifies complete/)
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)

      // Every refusal rolled back: no financial row moved.
      expect(await repairState(fixture.models)).toEqual(before)
    } finally {
      await fixture.cleanup()
    }
  })

  // Fix round 2 (final-review I2 test rigor): APPLY rollback coverage driven
  // by the REAL verifier over fake read-only sessions (the legacyRepairFixture
  // machinery: real envelope-carrying legacy contracts, real verifier gates).
  // The closed-shape doubles above stay for the pure comparison-contract tests;
  // these tests prove the rollback with results the real verifier produced.
  const REAL_BOUNDARY = { height: 3000000, blockHash: 'd4'.repeat(32) }
  const PRIZE_HASH = 'c5'.repeat(32)

  // Honest escrow contracts (final-review I1 round 3): the recorded combined
  // disposition's single tx pays the prize member AND the fee member — each
  // with the canonical escrow member identity (member id = the recorded bounty
  // payment id, canonical leg, exact recorded settled amount). The fixed
  // two-destination chain fixture models exactly this combined shape (a
  // separate single-destination fee tx cannot be projected onto it).
  const escrowLegMembers = bountyPayment => ([
    { id: String(bountyPayment.id), leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_A, type: 'PRIMARY', paymentId: null, grossPiconeros: '40', actualPiconeros: '40' },
    { id: String(bountyPayment.id), leg: 'FEE', address: verifiedFixtureIds.ADDRESS_B, type: 'SUBADDRESS', paymentId: null, grossPiconeros: '20', actualPiconeros: '20' }
  ])
  // The legacy REWARDS payout proof is one payment with two payout members.
  const legacyPayoutMembers = () => ([
    { id: '11', leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_A, type: 'PRIMARY', paymentId: null, grossPiconeros: '40', actualPiconeros: '40' },
    { id: '12', leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_B, type: 'SUBADDRESS', paymentId: null, grossPiconeros: '20', actualPiconeros: '20' }
  ])

  // One REAL legacy-verifier result for a leg hash: the real verifier over the
  // hash-remapped fake chain session with a real surviving proof bundle (or,
  // with `withSurvivingProof: false`, the REAL unresolved
  // LEGACY_PROOF_MISSING result for the same payment). The contract members
  // are the CALLER's honest per-leg facts (final-review I1 round 3: the escrow
  // disposition proves its prize member, the separate fee proves its fee
  // member — never one shared two-member payment).
  const realLegacyVerification = async ({ hash, journalRole, bountyPaymentId, withSurvivingProof, members }) => {
    const chain = paymentChainFixture()
    const session = {
      ...chain.session,
      rawByHash: { ...chain.session.rawByHash, [hash]: { ...chain.session.rawByHash[chain.txHash], txHash: hash } },
      ownershipFor: candidate => (candidate === hash
        ? { owned: chain.session.ownedOutputs, inputSources: chain.session.ownershipFor(chain.txHash).inputSources }
        : { owned: [], inputSources: [] })
    }
    return verifyLegacyPaymentTransaction({
      contract: {
        scope: { ...verifiedFixtureIds.SCOPE },
        txHash: hash,
        journalRole,
        journalId: '9002',
        owner: { kind: journalRole === 'ESCROW' ? 'AWARD' : 'PAYOUT', distributionId: '1', bountyPaymentId: bountyPaymentId == null ? null : String(bountyPaymentId), itemId: null },
        members,
        recordedFeePiconeros: null
      },
      session,
      observedAt: VERIFIED_OBSERVED_AT,
      survivingProofProvider: withSurvivingProof
        ? async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'apply-rollback-fixture' })
        : null
    })
  }

  // Minimal scoped DB rows for the rollback tests: the registered platform
  // wallet, one distribution and — per variant — either the recorded legacy
  // payout batch or the two-leg escrow disposition. Everything is registered
  // for the finally-guarded cleanup.
  const seedRealRollbackFixture = async ({ withLegacyPayouts }) => {
    const scope = { ...verifiedFixtureIds.SCOPE }
    const configBefore = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    const tracked = { accounts: [], users: [], items: [], distributions: [], payouts: [], bountyPayments: [] }
    const account = await db.moneroAccount.create({
      data: { ownerUserId: null, address: scope.walletAddress, label: 'platform_rewards', network: scope.network, status: 'ACTIVE' }
    })
    tracked.accounts.push(account.id)
    const userRows = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    const winner = userRows[0].id
    tracked.users.push(winner)
    const itemRows = await db.$queryRaw`
      INSERT INTO "Item" ("userId", title) VALUES (${winner}::int, 'real-verifier rollback fixture')
      RETURNING id::int AS id`
    const itemId = itemRows[0].id
    tracked.items.push(itemId)
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date('2026-10-06T00:00:00.000Z'),
        periodEnd: new Date('2026-10-13T00:00:00.000Z'),
        poolPiconeros: 60n,
        distributedPiconeros: 60n,
        payoutCount: 2
      }
    })
    tracked.distributions.push(distribution.id)
    let bountyPayment = null
    if (withLegacyPayouts) {
      const p1 = await db.rewardPayout.create({
        data: { distributionId: distribution.id, curatorId: winner, recipientAddress: verifiedFixtureIds.ADDRESS_A, piconeros: 40n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'CONFIRMED' }
      })
      const p2 = await db.rewardPayout.create({
        data: { distributionId: distribution.id, curatorId: winner, recipientAddress: verifiedFixtureIds.ADDRESS_B, piconeros: 20n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'SENT' }
      })
      tracked.payouts.push(p1.id, p2.id)
    } else {
      bountyPayment = await db.bountyPayment.create({
        data: {
          itemId,
          winnerUserId: winner,
          piconeros: 40n,
          feePiconeros: 20n,
          recipientAddress: verifiedFixtureIds.ADDRESS_A,
          kind: 'AWARD',
          txHash: PRIZE_HASH,
          feeTxHash: null,
          feeRecipientAddress: verifiedFixtureIds.ADDRESS_B,
          state: 'SENT',
          networkFeePiconeros: 7n,
          recipientReceivedPiconeros: 40n,
          feeReceivedPiconeros: 20n
        }
      })
      tracked.bountyPayments.push(bountyPayment.id)
    }
    const cleanup = async () => {
      await db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: scope.walletAddress } })
      await db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } })
      if (tracked.payouts.length > 0) await db.rewardPayout.deleteMany({ where: { id: { in: tracked.payouts } } })
      if (tracked.bountyPayments.length > 0) await db.bountyPayment.deleteMany({ where: { id: { in: tracked.bountyPayments } } })
      await db.rewardDistribution.deleteMany({ where: { id: { in: tracked.distributions } } })
      if (tracked.items.length > 0) await db.item.deleteMany({ where: { id: { in: tracked.items } } })
      if (tracked.users.length > 0) await db.user.deleteMany({ where: { id: { in: tracked.users } } })
      if (tracked.accounts.length > 0) await db.moneroAccount.deleteMany({ where: { id: { in: tracked.accounts } } })
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
    return { scope, bountyPayment, cleanup }
  }

  const realRollbackEvidence = escrowVerifications => ({
    evidenceVersion: 2,
    collectionStartedAt: VERIFIED_OBSERVED_AT,
    observedAt: VERIFIED_OBSERVED_AT,
    scope: { ...verifiedFixtureIds.SCOPE },
    boundary: REAL_BOUNDARY,
    daemon: { tipBefore: REAL_BOUNDARY, tipAfter: REAL_BOUNDARY },
    restoreHeight: 0,
    restoreProvenance: 'genesis',
    walletHeight: REAL_BOUNDARY.height + 1,
    derivation: { complete: true, primaryAddress: verifiedFixtureIds.SCOPE.walletAddress, derived: [], mismatches: [] },
    balances: { totalPiconeros: '0', unlockedPiconeros: '0', accounts: {} },
    incoming: [],
    outgoing: [],
    bridge: { pendingIncoming: [], pendingOutgoing: [] },
    escrow: escrowVerifications === null
      ? null
      : {
          walletAddress: verifiedFixtureIds.SCOPE.walletAddress,
          derivation: { complete: true, primaryAddress: verifiedFixtureIds.SCOPE.walletAddress, derived: [], mismatches: [] },
          incoming: [],
          outgoing: [],
          bridge: { pendingIncoming: [], pendingOutgoing: [] },
          paymentVerifications: escrowVerifications
        },
    paymentVerifications: []
  })

  test('real-verifier APPLY rollback: fresh loss of the REAL combined-disposition proof refuses before any write', async () => {
    const fixture = await seedRealRollbackFixture({ withLegacyPayouts: false })
    try {
      // Approved evidence: the REAL complete ESCROW verifier result for the
      // recorded combined disposition — the honest per-leg membership (prize
      // member + fee member, canonical ids/legs, exact recorded amounts).
      const combined = await realLegacyVerification({ hash: PRIZE_HASH, journalRole: 'ESCROW', bountyPaymentId: fixture.bountyPayment.id, withSurvivingProof: true, members: escrowLegMembers(fixture.bountyPayment) })
      expect(combined.status).toBe('complete')
      expect(combined.members.map(member => member.leg).sort()).toEqual(['FEE', 'PRINCIPAL'])
      const evidence = realRollbackEvidence([combined])
      const ledger = await readRepairLedger(db, fixture.scope)
      const manifest = buildRewardsReconciliation({
        scope: fixture.scope,
        boundary: REAL_BOUNDARY,
        evidence,
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
      expect(manifest.issues).toEqual([]) // the REAL result carries the exact frozen membership
      // The attribution is genuine: a prize-only proof (validator-valid, with
      // matching aggregates) names the missing FEE member — the recorded fee
      // receipt requires its member.
      const prizeOnly = structuredClone(evidence)
      prizeOnly.escrow.paymentVerifications = [completeTestVerification({
        hash: PRIZE_HASH,
        scope: verifiedFixtureIds.SCOPE,
        members: [escrowLegMembers(fixture.bountyPayment)[0]],
        role: 'ESCROW'
      })]
      const prizeOnlyManifest = buildRewardsReconciliation({
        scope: fixture.scope,
        boundary: REAL_BOUNDARY,
        evidence: prizeOnly,
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
      expect(prizeOnlyManifest.issues).toEqual([
        expect.objectContaining({
          code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
          table: 'BountyPayment',
          leg: 'PRINCIPAL',
          txHash: PRIZE_HASH,
          reason: 'the proved payment is missing a recorded escrow leg member'
        })
      ])
      const args = {
        models: db,
        manifest,
        evidence: normalizeEvidence(evidence),
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      const before = await repairState(db)

      // Fresh LOSS of the disposition proof: the nested escrow verifier facts
      // leave the chain-facts identity — refused before mutations, no audit.
      const lost = structuredClone(normalizeEvidence(evidence))
      lost.escrow.paymentVerifications = []
      await expect(applyRewardsReconciliation(args, {
        collectEvidence: async () => lost,
        daemon: boundaryDaemon()
      })).rejects.toThrow(/changed chain facts|no longer proves/)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
      expect(await repairState(db)).toEqual(before)
    } finally {
      await fixture.cleanup()
    }
  })

  test('real-verifier APPLY rollback: fresh downgrade to the REAL receipt-unavailable unresolved result refuses before any write', async () => {
    const fixture = await seedRealRollbackFixture({ withLegacyPayouts: false })
    try {
      const combined = await realLegacyVerification({ hash: PRIZE_HASH, journalRole: 'ESCROW', bountyPaymentId: fixture.bountyPayment.id, withSurvivingProof: true, members: escrowLegMembers(fixture.bountyPayment) })
      expect(combined.status).toBe('complete')
      const evidence = realRollbackEvidence([combined])
      const ledger = await readRepairLedger(db, fixture.scope)
      const manifest = buildRewardsReconciliation({
        scope: fixture.scope,
        boundary: REAL_BOUNDARY,
        evidence,
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
      expect(manifest.issues).toEqual([])
      const args = {
        models: db,
        manifest,
        evidence: normalizeEvidence(evidence),
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      const before = await repairState(db)
      // Fresh DOWNGRADE: the REAL verifier's own receipt-unavailable result —
      // members STILL MATERIALIZED (the exact B3 shape) — can never re-prove
      // the disposition, at the gate or through the chain-facts identity.
      const chain = paymentChainFixture()
      const unresolved = await verifyLegacyPaymentTransaction({
        contract: {
          scope: { ...verifiedFixtureIds.SCOPE },
          txHash: PRIZE_HASH,
          journalRole: 'ESCROW',
          journalId: '9002',
          owner: { kind: 'AWARD', distributionId: '1', bountyPaymentId: String(fixture.bountyPayment.id), itemId: null },
          members: escrowLegMembers(fixture.bountyPayment),
          recordedFeePiconeros: null
        },
        session: {
          ...chain.session,
          checkTxKey: jest.fn(async () => null),
          rawByHash: {
            ...chain.session.rawByHash,
            [PRIZE_HASH]: { ...chain.session.rawByHash[chain.txHash], txHash: PRIZE_HASH }
          },
          ownershipFor: candidate => (candidate === PRIZE_HASH
            ? { owned: chain.session.ownedOutputs, inputSources: chain.session.ownershipFor(chain.txHash).inputSources }
            : { owned: [], inputSources: [] })
        },
        observedAt: VERIFIED_OBSERVED_AT,
        survivingProofProvider: async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'apply-rollback-fixture' })
      })
      expect(unresolved.status).toBe('unresolved')
      expect(unresolved.issues).toContain('RECEIPT_UNAVAILABLE')
      expect(unresolved.members.length).toBeGreaterThan(0)
      const downgraded = structuredClone(normalizeEvidence(evidence))
      downgraded.escrow.paymentVerifications = [unresolved]
      await expect(applyRewardsReconciliation(args, {
        collectEvidence: async () => downgraded,
        daemon: boundaryDaemon()
      })).rejects.toThrow(/changed chain facts|no longer verifies complete/)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
      expect(await repairState(db)).toEqual(before)
    } finally {
      await fixture.cleanup()
    }
  })

  test('real-verifier APPLY rollback: legacy surviving-proof loss refuses the proved backfill before any write', async () => {
    const fixture = await seedRealRollbackFixture({ withLegacyPayouts: true })
    try {
      // Approved: the REAL complete surviving-proof verification backfills ONE
      // journal-less legacy journal row (Task 4).
      const base = await legacyRepairFixture({ withSurvivingProof: true })
      const complete = base.verification
      expect(complete.status).toBe('complete')
      const evidence = base.input.evidence
      const ledger = await readRepairLedger(db, fixture.scope)
      const manifest = buildRewardsReconciliation({
        scope: fixture.scope,
        boundary: base.input.boundary,
        evidence,
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
      expect(manifest.issues).toEqual([])
      expect(manifest.operations.some(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction')).toBe(true)
      const args = {
        models: db,
        manifest,
        evidence: normalizeEvidence(evidence),
        confirmedDigest: manifest.digest,
        backupReference: BACKUP,
        writersPaused: true
      }
      const before = await repairState(db)
      // The REAL fresh recheck: the surviving evidence is GONE — the real
      // verifier returns the unresolved LEGACY_PROOF_MISSING result.
      const unresolved = await realLegacyVerification({
        hash: verifiedFixtureIds.LEGACY_HASH,
        journalRole: 'REWARDS',
        bountyPaymentId: null,
        withSurvivingProof: false,
        members: legacyPayoutMembers()
      })
      expect(unresolved.status).toBe('unresolved')
      const fresh = structuredClone(normalizeEvidence(evidence))
      fresh.paymentVerifications = [unresolved]
      await expect(applyRewardsReconciliation(args, {
        collectEvidence: async () => fresh,
        daemon: boundaryDaemon()
      })).rejects.toThrow(/no longer verifies complete/)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
      expect(await repairState(db)).toEqual(before)
      // The journal-less backfill never happened: no journal row was written.
      expect(await db.rewardsWalletTransaction.count({ where: { walletAddress: fixture.scope.walletAddress } })).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  test('the REAL verifier receipt-unavailable unresolved result never covers a recorded escrow leg (round 3)', async () => {
    // Final-review round 3 (B3): the real verifier returns a VALIDATOR-VALID
    // unresolved result whose members remain materialized when receipt checks
    // are unavailable — membership-only attribution silently covered recorded
    // legs with exactly this shape. The recorded disposition is the combined
    // one (prize member + fee member).
    const chain = paymentChainFixture()
    const hash = 'c7'.repeat(32)
    const unresolved = await verifyLegacyPaymentTransaction({
      contract: {
        scope: { ...verifiedFixtureIds.SCOPE },
        txHash: hash,
        journalRole: 'ESCROW',
        journalId: '9002',
        owner: { kind: 'AWARD', distributionId: '1', bountyPaymentId: '4242', itemId: null },
        members: [
          { id: '4242', leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_A, type: 'PRIMARY', paymentId: null, grossPiconeros: '40', actualPiconeros: '40' },
          { id: '4242', leg: 'FEE', address: verifiedFixtureIds.ADDRESS_B, type: 'SUBADDRESS', paymentId: null, grossPiconeros: '20', actualPiconeros: '20' }
        ],
        recordedFeePiconeros: null
      },
      session: {
        ...chain.session,
        checkTxKey: jest.fn(async () => null),
        rawByHash: {
          ...chain.session.rawByHash,
          [hash]: { ...chain.session.rawByHash[chain.txHash], txHash: hash }
        },
        ownershipFor: candidate => (candidate === hash
          ? { owned: chain.session.ownedOutputs, inputSources: chain.session.ownershipFor(chain.txHash).inputSources }
          : { owned: [], inputSources: [] })
      },
      observedAt: VERIFIED_OBSERVED_AT,
      survivingProofProvider: async () => ({ keyBundleHex: paymentTxFixture().keyBundleHex, source: 'sender-cache', provenanceId: 'b3-fixture' })
    })
    expect(unresolved.status).toBe('unresolved')
    expect(unresolved.issues).toContain('RECEIPT_UNAVAILABLE')
    expect(unresolved.members.length).toBe(2) // members stay materialized
    // Coverage: the populated but non-complete result names the recorded leg
    // (both recorded members would otherwise be "covered" by it).
    const payment = {
      id: 4242,
      itemId: 1,
      winnerUserId: 1,
      piconeros: 40n,
      feePiconeros: 20n,
      recipientAddress: verifiedFixtureIds.ADDRESS_A,
      feeRecipientAddress: verifiedFixtureIds.ADDRESS_B,
      kind: 'AWARD',
      txHash: hash,
      feeTxHash: null,
      state: 'SENT',
      networkFeePiconeros: null,
      recipientReceivedPiconeros: 40n,
      feeReceivedPiconeros: 20n,
      feeSettlementNetworkFeePiconeros: null
    }
    const issues = recordedOutflowCoverage({
      ledger: {
        payouts: [],
        distributions: [],
        transactions: [],
        escrowTransactions: [],
        bountyPayments: [payment]
      },
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [],
        escrow: {
          walletAddress: verifiedFixtureIds.SCOPE.walletAddress,
          paymentVerifications: [unresolved]
        }
      },
      scope: verifiedFixtureIds.SCOPE
    })
    expect(issues.filter(issue => issue.code === 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toEqual([
      expect.objectContaining({
        table: 'BountyPayment',
        id: '4242',
        leg: 'PRINCIPAL',
        txHash: hash
      })
    ])
    expect(issues.filter(issue => issue.code === 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toHaveLength(0)
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
      expect(await applyRewardsReconciliation(args, replayDeps(evidence))).toMatchObject({ applied: true })
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
      expect(await applyRewardsReconciliation(args, replayDeps(evidence))).toMatchObject({ applied: false, digest: manifest.digest })
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
      }, replayDeps(evidence))).rejects.toThrow(/injected audit persistence failure/)
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
        applyRewardsReconciliation(args, replayDeps(evidence)),
        applyRewardsReconciliation(args, replayDeps(evidence))
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
        before: { state: 'RELAYED', relayedAt: null, relayProvenance: null },
        after: { state: 'PREPARED', relayedAt: null, relayProvenance: null },
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

  test('the CLI apply delegates the fresh recheck to the guarded APPLY (one trusted collection, no signing seam)', async () => {
    const fixture = await seedRepairFixture()
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const reportPath = path.join(dir, 'report.json')
      writeFileSync(reportPath, JSON.stringify({ manifest: fixture.manifest, evidence: fixture.evidence }))
      // The trusted read-only collection seam: the CLI resolves it once and
      // hands it to the apply gate — the gate's recheck is the ONLY collection.
      const collectEvidence = jest.fn(async () => fixture.evidenceInput)
      const signing = { createTx: jest.fn(), relayTx: jest.fn(), sweepUnlocked: jest.fn() }
      const daemon = {
        getBlockHashByHeight: jest.fn(async height => {
          if (height !== FI.BOUNDARY.height) throw new Error('unknown block height')
          return FI.BOUNDARY.blockHash
        })
      }
      const applied = await runCli([
        '--apply', reportPath,
        '--confirm', fixture.manifest.digest,
        '--backup-reference', BACKUP,
        '--writers-paused'
      ], {
        models: fixture.models,
        scope: SCOPE,
        daemon,
        collectEvidence,
        log: () => {}
      })
      expect(applied).toEqual({ mode: 'apply', applied: true, digest: fixture.manifest.digest })
      // Task 5 owns the authoritative recheck: the CLI runs NO duplicate
      // independent pre-apply rescan, so the trusted collector ran exactly once
      // (inside the guarded apply, before any transaction).
      expect(collectEvidence).toHaveBeenCalledTimes(1)
      expect(daemon.getBlockHashByHeight).toHaveBeenCalledTimes(1)
      // No send/sign/sweep method is ever reachable from the CLI's apply path.
      expect(signing.createTx).not.toHaveBeenCalled()
      expect(signing.relayTx).not.toHaveBeenCalled()
      expect(signing.sweepUnlocked).not.toHaveBeenCalled()
      expect(await fixture.models.rewardsWalletReconciliation.count({ where: { digest: fixture.manifest.digest, kind: 'APPLY' } })).toBe(1)
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

// Task 5: guarded APPLY re-verifies cryptographic evidence. The builder's
// closed v2 relay operations are applied through the real APPLY gate with an
// injected fresh read-only collection (the REAL #1 verifier over fake
// read-only sessions — never a serialized success flag); every refusal happens
// before any mutation and an exact replay stays a no-op even with lost keys.
;(ISOLATED_DB ? describe : describe.skip)('guarded APPLY re-verifies cryptographic evidence (isolated DB only)', () => {
  let db

  // Same throwaway synthetic master key material the verification fixture
  // writes its proof pairs with (never a real secret).
  const verificationKeyProvider = () => createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 11).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
  })
  const lostKeyProvider = () => createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 9: Buffer.alloc(32, 12).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '9'
  })

  const LATER_ADVANCE = 144
  const LATER_OBSERVED_AT = '2026-10-06T13:00:00.000Z'
  const LATER_TIP_HASH = 'de'.repeat(32)

  // The later-compatible fresh verification: advancing confirmation counts, an
  // advanced fresh boundary and a later recheck time over the SAME mined
  // height/block hash, claims, members, totals, inventory and sources.
  const laterCompatibleVerification = (verification, advance = LATER_ADVANCE) => ({
    ...structuredClone(verification),
    observedAt: LATER_OBSERVED_AT,
    boundary: { height: verification.boundary.height + advance, blockHash: LATER_TIP_HASH },
    confirmation: {
      height: verification.confirmation.height,
      blockHash: verification.confirmation.blockHash,
      confirmations: verification.confirmation.confirmations + advance
    },
    receivingAggregates: verification.receivingAggregates.map(aggregate => ({
      ...aggregate,
      confirmations: aggregate.confirmations + advance
    })),
    ownedAccounting: {
      ...verification.ownedAccounting,
      outputs: verification.ownedAccounting.outputs.map(output => ({ ...output, isSpent: true }))
    }
  })

  const laterCompatibleEvidence = (approvedEvidence, verification) => async () => {
    const fresh = structuredClone(approvedEvidence)
    fresh.collectionStartedAt = LATER_OBSERVED_AT
    fresh.observedAt = LATER_OBSERVED_AT
    fresh.boundary = { height: fresh.boundary.height + LATER_ADVANCE, blockHash: LATER_TIP_HASH }
    fresh.daemon = {
      tipBefore: { ...fresh.boundary },
      tipAfter: { ...fresh.boundary }
    }
    fresh.walletHeight = fresh.boundary.height + 1
    fresh.paymentVerifications = [laterCompatibleVerification(verification)]
    return fresh
  }

  const boundaryDaemonFor = boundary => ({
    getBlockHashByHeight: jest.fn(async height => {
      if (height !== boundary.height) throw new Error('unknown block height')
      return boundary.blockHash
    })
  })

  // The explicit contractual fields a repair may never change (plus the
  // distribution's sweep principal/hash bookkeeping), snapshotted exactly as
  // the existing suite does.
  async function protectedSnapshot (models) {
    return {
      payouts: await models.rewardPayout.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, distributionId: true, recipientAddress: true, piconeros: true, state: true, txHash: true }
      }),
      distributions: await models.rewardDistribution.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          poolPiconeros: true,
          distributedPiconeros: true,
          rolledOverPiconeros: true,
          opsSweptPiconeros: true,
          opsSweepTxHash: true,
          opsSweepState: true,
          opsNetworkFeesAccountedPiconeros: true
        }
      }),
      earns: await models.earn.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, userId: true, distributionId: true, piconeros: true }
      })
    }
  }

  // The fixture's audited surface lives in ONE throwaway DB shared by the
  // whole suite (and across runs): reset every row this fixture family owns
  // before seeding so a crashed earlier seed can never leak into a fingerprint.
  // Journal+proof deletion shares one transaction (the deferred delete guard
  // requires the pair to go together).
  async function cleanVerifiedSurface (scope) {
    await db.$transaction([
      db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: scope.walletAddress } } }),
      db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } }),
      db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: scope.walletAddress } })
    ])
    const staleDistributions = await db.rewardDistribution.findMany({
      where: {
        periodStart: new Date('2026-10-06T00:00:00.000Z'),
        periodEnd: new Date('2026-10-13T00:00:00.000Z')
      },
      select: { id: true }
    })
    const staleIds = staleDistributions.map(row => row.id)
    if (staleIds.length > 0) {
      await db.earn.deleteMany({ where: { distributionId: { in: staleIds } } })
      await db.rewardPayout.deleteMany({ where: { distributionId: { in: staleIds } } })
      await db.rewardDistribution.deleteMany({ where: { id: { in: staleIds } } })
    }
    await db.rewardPayout.deleteMany({ where: { id: { in: [11, 12] } } })
    await db.subaddressIndex.deleteMany({ where: { address: scope.walletAddress } })
    await db.moneroAccount.deleteMany({ where: { address: scope.walletAddress, label: 'platform_rewards' } })
    // A crashed earlier seed must never leave the capture-immutability trigger
    // disabled on the throwaway DB.
    await db.$executeRaw`ALTER TABLE "RewardsWalletTransaction" ENABLE TRIGGER "RewardsWalletTransaction_capture_immutable"`
  }

  // Local Task 5 helper: ONE real #1 protected journal/proof pair (Task 3's
  // verified fixture) plus the REAL audit-surface rows its ledger projection
  // names — real users/payouts/earns/distribution/account/subaddress with the
  // projection patched to the real identity values — so the apply-side shared
  // snapshot fingerprints exactly what the builder consumed. The captured row's
  // frozen preparation time is aligned to the fixture's audited chronology
  // under an explicit trigger window on this THROWAWAY isolated database only.
  async function seedVerifiedRepair (kind) {
    const scope = verifiedFixtureIds.SCOPE
    await cleanVerifiedSurface(scope)
    const f = await verifiedRepairFixture({ kind })
    const input = f.input
    const created = { users: [], distributions: [], payouts: [], earns: [], accounts: [], subaddresses: [] }

    const account = await db.moneroAccount.create({
      data: { ownerUserId: null, address: scope.walletAddress, label: 'platform_rewards', network: scope.network, status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    const subaddress = await db.subaddressIndex.create({
      data: { accountId: account.id, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }
    })
    created.subaddresses.push(subaddress.id)

    // Real audit-surface rows; the projection is patched to the REAL row values
    // (the fingerprint must bind what actually exists — never synthetic
    // placeholders like the fixture's informative COMPLETION_UNKNOWN status).
    const projection = input.ledger.distributions[0]
    let distributionId
    if (kind === 'OPS_SWEEP') {
      distributionId = Number(f.journal.distributionId)
    } else {
      const distribution = await db.rewardDistribution.create({
        data: {
          periodStart: new Date(projection.periodStart),
          periodEnd: new Date(projection.periodEnd),
          poolPiconeros: BigInt(projection.poolPiconeros)
        }
      })
      created.distributions.push(distribution.id)
      distributionId = distribution.id
    }
    const realDistribution = await db.rewardDistribution.findUnique({ where: { id: distributionId } })
    input.ledger.distributions[0] = {
      id: realDistribution.id,
      status: realDistribution.status,
      periodStart: realDistribution.periodStart,
      periodEnd: realDistribution.periodEnd,
      poolPiconeros: realDistribution.poolPiconeros,
      distributedPiconeros: realDistribution.distributedPiconeros,
      rolledOverPiconeros: realDistribution.rolledOverPiconeros,
      payoutCount: realDistribution.payoutCount,
      opsInflowPiconeros: realDistribution.opsInflowPiconeros,
      opsRolledOverPiconeros: realDistribution.opsRolledOverPiconeros,
      opsAvailablePiconeros: realDistribution.opsAvailablePiconeros,
      opsSweptPiconeros: realDistribution.opsSweptPiconeros,
      opsSweepState: realDistribution.opsSweepState,
      opsSweepTxHash: realDistribution.opsSweepTxHash,
      opsNetworkFeesAccountedPiconeros: realDistribution.opsNetworkFeesAccountedPiconeros
    }

    let earnIds = []
    let payouts = []
    if (kind === 'PAYOUT') {
      const members = input.ledger.transactions[0].metadata.payouts
      const userOne = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      const userTwo = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      created.users.push(userOne[0].id, userTwo[0].id)
      // The frozen capture bound the metadata payout ids (11/12) into the
      // proof claims: the recorded rows must carry exactly those ids.
      await db.$executeRaw`
        INSERT INTO "RewardPayout" (id, "distributionId", "curatorId", "recipientAddress", piconeros, "txHash", state) VALUES
          (11, ${distributionId}, ${userOne[0].id}, ${members[0].recipientAddress}, ${BigInt(members[0].piconeros)}, NULL, 'QUEUED'),
          (12, ${distributionId}, ${userTwo[0].id}, ${members[1].recipientAddress}, ${BigInt(members[1].piconeros)}, NULL, 'QUEUED')`
      created.payouts.push(11, 12)
      await db.$queryRaw`SELECT setval(pg_get_serial_sequence('"RewardPayout"', 'id'), (SELECT GREATEST(MAX(id), 1) FROM "RewardPayout"))`
      const realPayouts = await db.rewardPayout.findMany({ where: { id: { in: [11, 12] } }, orderBy: { id: 'asc' } })
      const earnOne = await db.earn.create({ data: { userId: userOne[0].id, distributionId, piconeros: BigInt(members[0].piconeros) } })
      const earnTwo = await db.earn.create({ data: { userId: userTwo[0].id, distributionId, piconeros: BigInt(members[1].piconeros) } })
      earnIds = [earnOne.id, earnTwo.id]
      created.earns.push(...earnIds)
      payouts = realPayouts.map(row => ({
        id: row.id,
        distributionId: row.distributionId,
        curatorId: row.curatorId,
        recipientAddress: row.recipientAddress,
        piconeros: row.piconeros,
        txHash: row.txHash,
        state: row.state
      }))
      input.ledger.payouts = payouts
      input.ledger.earns = [
        { id: earnIds[0], userId: earnOne.userId, distributionId: earnOne.distributionId, piconeros: earnOne.piconeros },
        { id: earnIds[1], userId: earnTwo.userId, distributionId: earnTwo.distributionId, piconeros: earnTwo.piconeros }
      ]
    }

    input.ledger.accounts = [{ id: account.id, label: 'platform_rewards', network: scope.network, address: scope.walletAddress }]
    input.ledger.subaddresses = [{ id: subaddress.id, accountId: account.id, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }]
    input.ledger.distributions[0].id = distributionId
    const realConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    input.config = {
      downvoteRewardsPct: realConfig.downvoteRewardsPct,
      postingFeeRewardsPct: realConfig.postingFeeRewardsPct,
      territoryFeeRewardsPct: realConfig.territoryFeeRewardsPct,
      boostRewardsPct: realConfig.boostRewardsPct,
      walletlessTipRewardsPct: realConfig.walletlessTipRewardsPct
    }
    input.ledger.config = { ...input.config }

    // Align the captured row's timestamps with the fixture's audited
    // chronology (preparation 11:58 -> attempt 11:59 -> observation 12:00).
    // preparedAt is a frozen capture fact, so the immutability trigger is
    // lifted for THIS one alignment update on the throwaway DB.
    await db.$executeRaw`ALTER TABLE "RewardsWalletTransaction" DISABLE TRIGGER "RewardsWalletTransaction_capture_immutable"`
    try {
      await db.rewardsWalletTransaction.update({
        where: { id: f.journal.id },
        data: {
          preparedAt: new Date(VERIFIED_PREPARED_AT),
          relayAttemptedAt: new Date(VERIFIED_ATTEMPTED_AT)
        }
      })
    } finally {
      await db.$executeRaw`ALTER TABLE "RewardsWalletTransaction" ENABLE TRIGGER "RewardsWalletTransaction_capture_immutable"`
    }

    // Align the audited journal identity to the REAL row: the shared audit
    // fingerprint projects BigInt ids differently from Numbers, so the
    // projection must carry the row's own BigInt id and post-alignment facts.
    const realJournal = await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })
    input.ledger.transactions[0] = {
      ...input.ledger.transactions[0],
      id: realJournal.id,
      state: realJournal.state,
      accountIndex: realJournal.accountIndex,
      distributionId: realJournal.distributionId,
      principalPiconeros: realJournal.principalPiconeros,
      networkFeePiconeros: realJournal.networkFeePiconeros,
      metadata: realJournal.metadata,
      preparedAt: realJournal.preparedAt,
      relayAttemptedAt: realJournal.relayAttemptedAt,
      relayedAt: realJournal.relayedAt,
      relayProvenance: realJournal.relayProvenance,
      dispatchId: realJournal.dispatchId,
      captureContractVersion: realJournal.captureContractVersion,
      claimDigest: realJournal.claimDigest,
      paymentClaims: realJournal.paymentClaims,
      proofId: realJournal.proofId
    }
    if (Array.isArray(input.ledger.proofInventory) && input.ledger.proofInventory.length > 0) {
      input.ledger.proofInventory[0] = {
        ...input.ledger.proofInventory[0],
        owner: { ...input.ledger.proofInventory[0].owner, journalId: realJournal.id },
        reference: { ...input.ledger.proofInventory[0].reference, txHash: realJournal.txHash, kind: realJournal.kind, dispatchId: realJournal.dispatchId }
      }
    }

    const cleanup = async () => {
      await db.$transaction([
        db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: scope.walletAddress } } }),
        db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } }),
        db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: scope.walletAddress } })
      ])
      if (created.earns.length > 0) await db.earn.deleteMany({ where: { id: { in: created.earns } } })
      if (created.payouts.length > 0) await db.rewardPayout.deleteMany({ where: { id: { in: created.payouts } } })
      if (created.distributions.length > 0) await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
      if (created.subaddresses.length > 0) await db.subaddressIndex.deleteMany({ where: { id: { in: created.subaddresses } } })
      if (created.accounts.length > 0) await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
      if (created.users.length > 0) await db.user.deleteMany({ where: { id: { in: created.users } } })
    }

    return {
      ...f,
      wallet: { relayTx: jest.fn(), createTx: jest.fn(), sweepUnlocked: jest.fn() },
      collectLaterCompatibleEvidence: laterCompatibleEvidence(f.approvedEvidence, f.verification),
      daemon: boundaryDaemonFor(input.boundary),
      cleanup
    }
  }

  const applyVerified = (f, manifest, overrides = {}) => applyRewardsReconciliation({
    models: db,
    manifest,
    evidence: f.approvedEvidence,
    confirmedDigest: manifest.digest,
    backupReference: 'isolated-fixture-snapshot',
    writersPaused: true,
    ...overrides
  }, {
    collectEvidence: f.collectLaterCompatibleEvidence,
    daemon: f.daemon,
    keyProvider: verificationKeyProvider(),
    ...overrides.deps
  })

  beforeAll(() => {
    db = new PrismaClient()
  })

  afterAll(async () => {
    await closeVerifiedRepairFixtures()
    if (db) await db.$disconnect()
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s: builder -> guarded APPLY -> replay proves the relay exactly once', async kind => {
    const f = await seedVerifiedRepair(kind)
    try {
      const manifest = buildRewardsReconciliation(f.input)
      expect(manifest.issues).toEqual([])
      const before = await protectedSnapshot(db)
      const result = await applyVerified(f, manifest)
      expect(result).toMatchObject({ applied: true, digest: manifest.digest })
      // No sending code is ever reachable from the guarded apply.
      expect(f.wallet.relayTx).not.toHaveBeenCalled()
      expect(f.wallet.createTx).not.toHaveBeenCalled()
      expect(f.wallet.sweepUnlocked).not.toHaveBeenCalled()
      // The recorded relay is the APPROVED observation with the closed
      // provenance; fee and principal are unchanged and counted once.
      const row = await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })
      expect(row.state).toBe('RELAYED')
      expect(row.relayProvenance).toBe(RELAY_PROVENANCE)
      expect(row.relayedAt.toISOString()).toBe(VERIFIED_OBSERVED_AT)
      expect(row.relayAttemptedAt.toISOString()).toBe(VERIFIED_ATTEMPTED_AT)
      expect(row.networkFeePiconeros).toBe(f.journal.networkFeePiconeros)
      expect(row.principalPiconeros).toBe(f.journal.principalPiconeros)
      // The audit wrapper binds the untouched manifest and records the fresh
      // recheck time separately (never overwriting the approved observation).
      const audit = await db.rewardsWalletReconciliation.findUnique({ where: { digest_kind: { digest: manifest.digest, kind: 'APPLY' } } })
      expect(audit.report.manifest.digest).toBe(manifest.digest)
      expect(audit.report.reverifiedAt).toBe(LATER_OBSERVED_AT)
      // Protected reward contracts and the sweep principal/hash fields never move.
      expect(await protectedSnapshot(db)).toEqual(before)
      // An exact replay is a no-op even after later DB activity and LOST keys:
      // the exact-digest probe returns before any fresh collection.
      const replay = await applyVerified(f, manifest, { deps: { keyProvider: lostKeyProvider() } })
      expect(replay).toMatchObject({ applied: false, digest: manifest.digest })
      expect(await db.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)
    } finally {
      await f.cleanup()
    }
  })

  test('fresh verification time cannot rewrite the approved observation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const expectedDigest = manifest.digest
      const result = await applyVerified(f, manifest)
      expect(result.applied).toBe(true)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).relayedAt.toISOString())
        .toBe('2026-10-06T12:00:00.000Z')
      expect(manifest.digest).toBe(expectedDigest)
      expect(f.wallet.relayTx).not.toHaveBeenCalled()
    } finally {
      await f.cleanup()
    }
  })

  test('a reorg below the approved boundary refuses before any mutation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      await expect(applyVerified(f, manifest, {
        deps: { daemon: { getBlockHashByHeight: jest.fn(async () => 'ff'.repeat(32)) } }
      })).rejects.toThrow(/no longer canonical/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('a failed fresh re-scan aborts before any verification or write', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      await expect(applyVerified(f, manifest, {
        deps: { collectEvidence: async () => { throw new Error('rescan unavailable') } }
      })).rejects.toThrow(/rescan unavailable/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test.each([
    ['a new confirmed chain fact', async fresh => {
      fresh.outgoing.push({ ...structuredClone(fresh.outgoing[0]), txHash: 'ee'.repeat(32), height: fresh.outgoing[0].height + 1 })
    }],
    ['a mutated proved member claim', async fresh => {
      fresh.paymentVerifications[0].members[0].actualPiconeros = '41'
    }],
    ['a mutated raw fee', async fresh => {
      // The verifier's own closure stays valid (D = O + F + E) while the fee
      // fact changes.
      fresh.paymentVerifications[0].totals = { ...fresh.paymentVerifications[0].totals, F: '8', D: '101' }
    }],
    ['a mutated source partition', async fresh => {
      fresh.paymentVerifications[0].sourceAccounts = ['1']
    }],
    ['a mutated owned output partition', async fresh => {
      fresh.paymentVerifications[0].ownedAccounting.outputs[0].amountPiconeros = '999'
    }]
  ])('%s in the fresh collection requires a new manifest', async (_label, mutate) => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      const changed = await f.collectLaterCompatibleEvidence()
      await mutate(changed)
      await expect(applyVerified(f, manifest, { deps: { collectEvidence: async () => changed } }))
        .rejects.toThrow()
      expect(await protectedSnapshot(db)).toEqual(before)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test.each([
    ['a pool downgrade', 'CONFIRMATION_REQUIRED'],
    ['lost proof keys in the fresh collection', 'PROOF_KEY_UNAVAILABLE']
  ])('%s invalidates the complete proof', async (_label, issueCode) => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      const downgraded = await f.collectLaterCompatibleEvidence()
      downgraded.paymentVerifications = [{
        ...downgraded.paymentVerifications[0],
        status: 'unresolved',
        issues: [issueCode],
        captureMode: null,
        dispatchId: null,
        claimDigest: null,
        proofInventory: null,
        survivingEvidenceDigest: null,
        totals: { D: null, O: null, F: null, E: null, residual: null },
        members: [],
        receivingAggregates: [],
        sourceAccounts: [],
        ownedAccounting: { totalPiconeros: null, outputs: [] },
        confirmation: { height: null, blockHash: null, confirmations: null },
        boundary: { height: null, blockHash: null }
      }]
      await expect(applyVerified(f, manifest, { deps: { collectEvidence: async () => downgraded } }))
        .rejects.toThrow(/no longer verifies complete/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('a proof rotation with writers paused is caught before any mutation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      const proof = await db.paymentTransactionProof.findFirst()
      await db.$executeRaw`UPDATE "PaymentTransactionProof" SET revision = revision + 1 WHERE id = ${proof.id}::uuid`
      await expect(applyVerified(f, manifest)).rejects.toThrow()
      expect(await protectedSnapshot(db)).toEqual(before)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
    } finally {
      await f.cleanup()
    }
  })

  test('a promotion recording a diverging relayedAt refuses before any mutation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const edited = structuredClone(manifest)
      // The recorded observation must be the APPROVED one: a later fresh
      // recheck time can never rewrite the operation's relayedAt.
      edited.operations.find(op => op.after?.state === 'RELAYED').after.relayedAt = LATER_OBSERVED_AT
      edited.digest = manifestDigest(edited)
      const before = await protectedSnapshot(db)
      await expect(applyVerified(f, edited)).rejects.toThrow(/records the approved observation as relayedAt/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('out-of-band envelope corruption refuses before any mutation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      const proof = await db.paymentTransactionProof.findFirst()
      // Out-of-band tag corruption is a "rotation" to the store's guard (same
      // 16-byte GCM tag length, different bytes): the changed integrity digest
      // stale-dates every fingerprint the approved manifest bound, and the
      // apply refuses before any financial write.
      await db.$executeRaw`UPDATE "PaymentTransactionProof" SET "dataTag" = decode(repeat('ff', 16), 'hex'), revision = revision + 1 WHERE id = ${proof.id}::uuid`
      await expect(applyVerified(f, manifest)).rejects.toThrow(/changed since the manifest was approved/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('a wrong TX proof master key fails the store re-check before any mutation', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      // The SAME key VERSION with WRONG material: the declared inventory and
      // every fingerprint stay untouched, so the failure is the apply gate's
      // own authenticated store re-check (envelope authentication), never a
      // serialized fresh-evidence flag.
      const wrongMaterialProvider = createPaymentProofKeyProvider({
        TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 77).toString('base64') }),
        TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
      })
      await expect(applyVerified(f, manifest, { deps: { keyProvider: wrongMaterialProvider } }))
        .rejects.toThrow(/failed the store re-check \(TXPROOF_ENVELOPE_AUTH_FAILED\)/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('lost TX proof master keys refuse an unapplied captured repair through the store', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const before = await protectedSnapshot(db)
      await expect(applyVerified(f, manifest, { deps: { keyProvider: lostKeyProvider() } }))
        .rejects.toThrow(/master keys are unavailable/)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  test('an unmatched new digest still requires fresh proof while the applied digest replays as a no-op', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      expect(await applyVerified(f, manifest)).toMatchObject({ applied: true })
      // A DIFFERENT digest (any edited manifest) with a fresh collection that
      // lost the keys must fail closed on the re-verification.
      const edited = structuredClone(manifest)
      edited.operations[0].reason = 'edited-reason'
      edited.digest = manifestDigest(edited)
      const lostKeys = structuredClone(await f.collectLaterCompatibleEvidence())
      lostKeys.paymentVerifications = [{
        ...lostKeys.paymentVerifications[0],
        status: 'unresolved',
        issues: ['PROOF_KEY_UNAVAILABLE'],
        captureMode: null,
        dispatchId: null,
        claimDigest: null,
        proofInventory: null,
        survivingEvidenceDigest: null,
        totals: { D: null, O: null, F: null, E: null, residual: null },
        members: [],
        receivingAggregates: [],
        sourceAccounts: [],
        ownedAccounting: { totalPiconeros: null, outputs: [] },
        confirmation: { height: null, blockHash: null, confirmations: null },
        boundary: { height: null, blockHash: null }
      }]
      await expect(applyVerified(f, edited, { deps: { collectEvidence: async () => lostKeys } }))
        .rejects.toThrow(/no longer verifies complete/)
      // ...while the EXACT previously applied digest remains a no-op.
      expect(await applyVerified(f, manifest, { deps: { keyProvider: lostKeyProvider() } }))
        .toMatchObject({ applied: false, digest: manifest.digest })
    } finally {
      await f.cleanup()
    }
  })

  test('a truncated v1 relayProof is refused even when the old destination match would pass', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const operation = structuredClone(manifest.operations.find(op => op.after?.state === 'RELAYED'))
      const approved = f.verification
      operation.relayProof = {
        txHash: operation.txHash,
        accountIndex: 0,
        height: approved.confirmation.height,
        feePiconeros: approved.totals.F,
        destinations: approved.members.map(member => ({ address: member.address, amountPiconeros: member.actualPiconeros }))
      }
      const fresh = await f.collectLaterCompatibleEvidence()
      await expect(db.$transaction(tx => applyRepairOperations(tx, [operation], {
        evidence: f.approvedEvidence,
        freshEvidence: fresh,
        evidenceDigest: manifest.evidenceDigest
      }))).rejects.toThrow(/not the closed v2 relayProof contract/)
      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
    } finally {
      await f.cleanup()
    }
  })

  test('a promotion without its exact relayProof, without fresh evidence, or with mismatching fresh facts is refused', async () => {
    const f = await seedVerifiedRepair('PAYOUT')
    try {
      const manifest = buildRewardsReconciliation(f.input)
      const operation = structuredClone(manifest.operations.find(op => op.after?.state === 'RELAYED'))
      const fresh = await f.collectLaterCompatibleEvidence()
      const run = (ops, options) => db.$transaction(tx => applyRepairOperations(tx, ops, options))

      const noProof = structuredClone(operation)
      delete noProof.relayProof
      await expect(run([noProof], { evidence: f.approvedEvidence, freshEvidence: fresh, evidenceDigest: manifest.evidenceDigest }))
        .rejects.toThrow(/requires its exact relayProof/)
      await expect(run([operation], { evidence: f.approvedEvidence, evidenceDigest: manifest.evidenceDigest }))
        .rejects.toThrow(/requires the fresh re-verification evidence/)

      const staleFresh = structuredClone(fresh)
      // Keep the verifier's own closure valid (D = O + F + E) while changing
      // the substantive fee fact.
      staleFresh.paymentVerifications[0].totals = {
        ...staleFresh.paymentVerifications[0].totals,
        F: '8',
        D: '101'
      }
      await expect(run([operation], { evidence: f.approvedEvidence, freshEvidence: staleFresh, evidenceDigest: manifest.evidenceDigest }))
        .rejects.toThrow(/does not match the approved and fresh verifier facts/)

      const freshAbsent = structuredClone(fresh)
      freshAbsent.paymentVerifications = []
      await expect(run([operation], { evidence: f.approvedEvidence, freshEvidence: freshAbsent, evidenceDigest: manifest.evidenceDigest }))
        .rejects.toThrow(/does not carry a safe REWARDS verification/)

      expect((await db.rewardsWalletTransaction.findUnique({ where: { id: f.journal.id } })).state).toBe('PREPARED')
    } finally {
      await f.cleanup()
    }
  })

  // --- journal-less legacy backfill (Task 4 insert through the Task 5 gate) ---

  // The Task 4 journal-less legacy payout candidate: the recorded payout rows
  // exist, the journal row does not, and the complete surviving proof is the
  // ONLY insert authority. Real rows mirror the fixture projection with the
  // identity values patched to reality.
  async function seedLegacyBackfill () {
    const scope = verifiedFixtureIds.SCOPE
    await cleanVerifiedSurface(scope)
    const base = await legacyRepairFixture()
    const input = base.input
    const created = { users: [], distributions: [], payouts: [], earns: [], accounts: [], subaddresses: [] }
    input.ledger.transactions = []

    const account = await db.moneroAccount.create({
      data: { ownerUserId: null, address: scope.walletAddress, label: 'platform_rewards', network: scope.network, status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    const subaddress = await db.subaddressIndex.create({
      data: { accountId: account.id, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }
    })
    created.subaddresses.push(subaddress.id)
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date('2026-10-06T00:00:00.000Z'),
        periodEnd: new Date('2026-10-13T00:00:00.000Z'),
        poolPiconeros: 60n,
        payoutCount: 2
      }
    })
    created.distributions.push(distribution.id)

    const payouts = []
    const earns = []
    for (const recorded of input.ledger.payouts) {
      const user = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
      created.users.push(user[0].id)
      const payout = await db.rewardPayout.create({
        data: {
          distributionId: distribution.id,
          curatorId: user[0].id,
          recipientAddress: recorded.recipientAddress,
          piconeros: BigInt(recorded.piconeros),
          txHash: verifiedFixtureIds.LEGACY_HASH,
          state: recorded.state
        }
      })
      created.payouts.push(payout.id)
      const earn = await db.earn.create({
        data: { userId: user[0].id, distributionId: distribution.id, piconeros: BigInt(recorded.piconeros) }
      })
      created.earns.push(earn.id)
      payouts.push({ id: payout.id, distributionId: payout.distributionId, curatorId: payout.curatorId, recipientAddress: payout.recipientAddress, piconeros: payout.piconeros, txHash: payout.txHash, state: payout.state })
      earns.push({ id: earn.id, userId: earn.userId, distributionId: earn.distributionId, piconeros: earn.piconeros })
    }
    input.ledger.payouts = payouts
    input.ledger.earns = earns
    const realDistribution = await db.rewardDistribution.findUnique({ where: { id: distribution.id } })
    input.ledger.distributions[0] = {
      id: realDistribution.id,
      status: realDistribution.status,
      periodStart: realDistribution.periodStart,
      periodEnd: realDistribution.periodEnd,
      poolPiconeros: realDistribution.poolPiconeros,
      distributedPiconeros: realDistribution.distributedPiconeros,
      rolledOverPiconeros: realDistribution.rolledOverPiconeros,
      payoutCount: realDistribution.payoutCount,
      opsInflowPiconeros: realDistribution.opsInflowPiconeros,
      opsRolledOverPiconeros: realDistribution.opsRolledOverPiconeros,
      opsAvailablePiconeros: realDistribution.opsAvailablePiconeros,
      opsSweptPiconeros: realDistribution.opsSweptPiconeros,
      opsSweepState: realDistribution.opsSweepState,
      opsSweepTxHash: realDistribution.opsSweepTxHash,
      opsNetworkFeesAccountedPiconeros: realDistribution.opsNetworkFeesAccountedPiconeros
    }
    input.ledger.accounts = [{ id: account.id, label: 'platform_rewards', network: scope.network, address: scope.walletAddress }]
    input.ledger.subaddresses = [{ id: subaddress.id, accountId: account.id, majorIndex: 0, minorIndex: 0, address: scope.walletAddress, state: 'AVAILABLE' }]
    const realConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    input.config = {
      downvoteRewardsPct: realConfig.downvoteRewardsPct,
      postingFeeRewardsPct: realConfig.postingFeeRewardsPct,
      territoryFeeRewardsPct: realConfig.territoryFeeRewardsPct,
      boostRewardsPct: realConfig.boostRewardsPct,
      walletlessTipRewardsPct: realConfig.walletlessTipRewardsPct
    }
    input.ledger.config = { ...input.config }
    // The precondition view reads the reserve THROUGH the ledger projection.
    input.ledger.reserve = input.reserve

    const cleanup = async () => {
      await db.$transaction([
        db.paymentTransactionProof.deleteMany({ where: { rewardsJournal: { walletAddress: scope.walletAddress } } }),
        db.rewardsWalletTransaction.deleteMany({ where: { walletAddress: scope.walletAddress } }),
        db.rewardsWalletReconciliation.deleteMany({ where: { walletAddress: scope.walletAddress } })
      ])
      if (created.earns.length > 0) await db.earn.deleteMany({ where: { id: { in: created.earns } } })
      if (created.payouts.length > 0) await db.rewardPayout.deleteMany({ where: { id: { in: created.payouts } } })
      if (created.distributions.length > 0) await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
      if (created.subaddresses.length > 0) await db.subaddressIndex.deleteMany({ where: { id: { in: created.subaddresses } } })
      if (created.accounts.length > 0) await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
      if (created.users.length > 0) await db.user.deleteMany({ where: { id: { in: created.users } } })
    }

    return {
      base,
      input,
      collectLaterCompatibleEvidence: laterCompatibleEvidence(base.approvedEvidence, base.verification),
      collectLostSurvivingProof: async () => {
        const unresolved = await legacyRepairFixture({ withSurvivingProof: false })
        expect(unresolved.verification.status).toBe('unresolved')
        const fresh = structuredClone(base.approvedEvidence)
        fresh.collectionStartedAt = LATER_OBSERVED_AT
        fresh.observedAt = LATER_OBSERVED_AT
        fresh.boundary = { height: fresh.boundary.height + LATER_ADVANCE, blockHash: LATER_TIP_HASH }
        fresh.walletHeight = fresh.boundary.height + 1
        fresh.paymentVerifications = [unresolved.verification]
        return fresh
      },
      daemon: boundaryDaemonFor(input.boundary),
      cleanup
    }
  }

  const applyLegacy = (seed, manifest, overrides = {}) => applyRewardsReconciliation({
    models: db,
    manifest,
    evidence: seed.base.approvedEvidence,
    confirmedDigest: manifest.digest,
    backupReference: 'isolated-fixture-snapshot',
    writersPaused: true,
    ...overrides
  }, {
    collectEvidence: seed.collectLaterCompatibleEvidence,
    daemon: seed.daemon,
    ...overrides.deps
  })

  test('legacy: builder -> guarded APPLY backfills one journal row from reverified surviving evidence', async () => {
    const seed = await seedLegacyBackfill()
    try {
      const manifest = buildRewardsReconciliation(seed.input)
      expect(manifest.issues).toEqual([])
      const before = await protectedSnapshot(db)
      expect(await applyLegacy(seed, manifest)).toMatchObject({ applied: true, digest: manifest.digest })
      const row = await db.rewardsWalletTransaction.findUnique({
        where: {
          network_walletAddress_txHash: {
            network: verifiedFixtureIds.SCOPE.network,
            walletAddress: verifiedFixtureIds.SCOPE.walletAddress,
            txHash: verifiedFixtureIds.LEGACY_HASH
          }
        }
      })
      expect(row).toMatchObject({
        kind: 'PAYOUT',
        state: 'RELAYED',
        relayProvenance: LEGACY_BACKFILL_REASON,
        principalPiconeros: 60n,
        networkFeePiconeros: 7n,
        relayAttemptedAt: null,
        dispatchId: null,
        captureContractVersion: null,
        claimDigest: null,
        paymentClaims: null,
        proofId: null
      })
      expect(row.relayedAt.toISOString()).toBe(VERIFIED_OBSERVED_AT)
      // The backfill creates neither a new send nor a PaymentTransactionProof row.
      expect(await db.paymentTransactionProof.count()).toBe(0)
      // Protected reward contracts and the recorded payout rows never move.
      expect(await protectedSnapshot(db)).toEqual(before)
      expect(await db.rewardsWalletReconciliation.count({ where: { digest: manifest.digest, kind: 'APPLY' } })).toBe(1)
      // Exact replay: a no-op.
      expect(await applyLegacy(seed, manifest)).toMatchObject({ applied: false })
    } finally {
      await seed.cleanup()
    }
  })

  test('legacy: a fresh collection that lost the surviving proof refuses before any insert', async () => {
    const seed = await seedLegacyBackfill()
    try {
      const manifest = buildRewardsReconciliation(seed.input)
      const before = await protectedSnapshot(db)
      await expect(applyLegacy(seed, manifest, { deps: { collectEvidence: seed.collectLostSurvivingProof } }))
        .rejects.toThrow(/no longer verifies complete/)
      expect(await db.rewardsWalletTransaction.count({ where: { txHash: verifiedFixtureIds.LEGACY_HASH } })).toBe(0)
      expect(await protectedSnapshot(db)).toEqual(before)
      expect(await db.rewardsWalletReconciliation.count({ where: { kind: 'APPLY' } })).toBe(0)
    } finally {
      await seed.cleanup()
    }
  })

  test('legacy: every other relayProof-carrying insert still refuses', async () => {
    const seed = await seedLegacyBackfill()
    try {
      const manifest = buildRewardsReconciliation(seed.input)
      const insert = structuredClone(manifest.operations.find(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction'))
      expect(insert.reason).toBe(LEGACY_BACKFILL_REASON)
      const fresh = await seed.collectLaterCompatibleEvidence()
      const run = (ops, options) => db.$transaction(tx => applyRepairOperations(tx, ops, options))
      const options = { evidence: seed.base.approvedEvidence, freshEvidence: fresh, evidenceDigest: manifest.evidenceDigest }

      // A different reason is never the legacy backfill.
      const wrongReason = structuredClone(insert)
      wrongReason.reason = 'wallet-history-relay'
      await expect(run([wrongReason], options)).rejects.toThrow(/only the independently reverified legacy backfill insert may carry a relay proof/)

      // A capture-era proof may never backfill a journal.
      const captureEra = structuredClone(insert)
      captureEra.relayProof = {
        ...captureEra.relayProof,
        captureMode: 'CAPTURE_V1',
        dispatchId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        claimDigest: 'ab'.repeat(32),
        proofInventory: { proofId: 'x', revision: 1 },
        survivingEvidenceDigest: null
      }
      await expect(run([captureEra], options)).rejects.toThrow(/independently surviving legacy proof/)

      // A changed surviving-evidence digest in the fresh collection refuses.
      const movedProof = structuredClone(fresh)
      movedProof.paymentVerifications[0].survivingEvidenceDigest = 'ef'.repeat(32)
      await expect(run([insert], { ...options, freshEvidence: movedProof }))
        .rejects.toThrow(/substantive facts|surviving evidence|capture mode/)

      expect(await db.rewardsWalletTransaction.count({ where: { txHash: verifiedFixtureIds.LEGACY_HASH } })).toBe(0)
    } finally {
      await seed.cleanup()
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

// Task 6: versioned CLI/CHECK publishing and freshness coherence. A CHECK binds
// the CURRENT pre-repair audit identity and the measured drift, and is only
// published while a short consistent re-read proves the collection still
// matches the DB it was collected from. The publisher fixtures are fake models
// driven from the verified fixture's audited input, so the CLI itself never
// touches a live DB; the verified fixture's own throwaway rows live in the
// isolated database and are released in afterAll.
;(ISOLATED_DB ? describe : describe.skip)('versioned CLI CHECK publishing and freshness coherence (isolated DB only)', () => {
  afterAll(async () => {
    await closeVerifiedRepairFixtures()
  })

  // Synthetic encrypted-envelope bytes (throwaway, never real key material) so
  // the REAL #1 proof-store inventory path computes a real integrity digest
  // over them, exactly like the shared audit-snapshot suite does.
  const syntheticProofRow = proof => proof == null
    ? null
    : {
        id: proof.proofId,
        revision: proof.revision,
        masterKeyVersion: proof.masterKeyVersion,
        bindingVersion: proof.bindingVersion,
        envelopeVersion: proof.envelopeVersion,
        payloadVersion: proof.payloadVersion,
        claimDigest: proof.claimDigest,
        bindingDigest: proof.bindingDigest,
        dataNonce: Buffer.from([1, 2, 3, 4]),
        dataTag: Buffer.from([5, 6, 7, 8]),
        ciphertext: Buffer.from([9, 10, 11, 12]),
        wrapNonce: Buffer.from([13, 14, 15, 16]),
        wrapTag: Buffer.from([17, 18, 19, 20]),
        wrappedDek: Buffer.from([21, 22, 23, 24])
      }

  // Shared snapshot delegates plus the audit create collector, driven locally
  // from the verified fixture's audited input: every read returns exactly the
  // fixture rows (overridable per group for staleness scenarios), so the CLI's
  // shared-snapshot fingerprint is deterministic and no live DB is touched by
  // the CLI under test. The audit create COLLECTS its arguments into `calls`.
  function checkPublisherModels (f, calls, overrides = {}) {
    const input = f.input
    const ledger = input.ledger
    const groupRows = name => overrides[name] ?? (async () => ledger[name].map(row => structuredClone(row)))
    const findMany = name => async () => groupRows(name)()
    const journalFindUnique = name => async ({ where }) =>
      (await groupRows(name)()).find(row => String(row.id) === String(where.id)) ?? null
    const models = {
      moneroAccount: {
        findFirst: async ({ where }) => {
          const row = ledger.accounts.find(account => account.label === where.label && account.network === where.network)
          return row == null ? null : { ...row }
        }
      },
      subaddressIndex: { findMany: findMany('subaddresses') },
      feeObservation: { findMany: findMany('receipts') },
      observedDownvote: { findMany: findMany('downvotes') },
      rewardPayout: { findMany: findMany('payouts') },
      rewardDistribution: { findMany: findMany('distributions') },
      rewardsWalletTransaction: { findMany: findMany('transactions'), findUnique: journalFindUnique('transactions') },
      escrowWalletTransaction: { findMany: findMany('escrowTransactions'), findUnique: journalFindUnique('escrowTransactions') },
      bountyPayment: { findMany: findMany('bountyPayments') },
      observedBounty: { findMany: findMany('observedBounties') },
      observedBountyReceipt: { findMany: findMany('observedBountyReceipts') },
      item: { findMany: findMany('items') },
      earn: { findMany: findMany('earns') },
      platformFeeConfig: { findUnique: async () => ({ ...input.config }) },
      paymentTransactionProof: {
        findUnique: async ({ where }) => {
          const declared = (ledger.proofInventory ?? [])
            .find(entry => String(entry?.proof?.proofId ?? '') === String(where.id))
          return syntheticProofRow(declared?.proof ?? null)
        }
      },
      rewardsWalletReconciliation: {
        findUnique: async () => null,
        create: async ({ data }) => {
          calls.push(data)
          return { ...data }
        }
      },
      $transaction: async (fn, _options) => fn(models)
    }
    return models
  }

  const publisherDeps = (f, models, log) => ({
    models,
    scope: () => f.input.scope,
    collectEvidence: async () => f.approvedEvidence,
    log
  })

  test('CHECK binds current pre-repair fingerprint and measured drift', async () => {
    const f = await verifiedRepairFixture()
    const calls = []
    const result = await runCli(['--publish-check'], publisherDeps(f, checkPublisherModels(f, calls), jest.fn()))
    const data = calls.find(call => call.kind === 'CHECK')
    expect(data.ledgerFingerprint).toBe(result.manifest.ledgerFingerprint)
    expect(data.positiveDriftPiconeros.toString()).toBe(result.manifest.before.positiveDriftPiconeros)
    // The CHECK binds the exact approved manifest generation: digest, evidence
    // digest, boundary and scope.
    expect(result).toMatchObject({ mode: 'publish-check', published: true, digest: result.manifest.digest })
    expect(data).toMatchObject({
      digest: result.manifest.digest,
      evidenceDigest: result.manifest.evidenceDigest,
      network: f.input.scope.network,
      walletAddress: f.input.scope.walletAddress,
      height: f.input.boundary.height,
      blockHash: f.input.boundary.blockHash
    })
    // The stored evidence is the explicit v2 collection: contract version,
    // observation window and the safe verifier versions it was built from.
    expect(data.report.evidence.evidenceVersion).toBe(2)
    expect(data.report.evidence.observedAt).toBe(VERIFIED_OBSERVED_AT)
    expect(data.report.evidence.paymentVerifications[0]).toMatchObject({
      verificationVersion: f.verification.verificationVersion,
      verifierVersion: f.verification.verifierVersion,
      sdkVersion: f.verification.sdkVersion
    })
  })

  test('a ledger change between collection and publication aborts the stale CHECK before the audit row', async () => {
    const f = await verifiedRepairFixture()
    const calls = []
    let distributionReads = 0
    const models = checkPublisherModels(f, calls, {
      distributions: async () => {
        distributionReads += 1
        const rows = f.input.ledger.distributions.map(row => structuredClone(row))
        // The audited snapshot moves AFTER the collection read: the second
        // read (the publication consistency check) no longer fingerprints what
        // the manifest bound.
        if (distributionReads >= 2) rows[0].opsAvailablePiconeros += 1n
        return rows
      }
    })
    await expect(runCli(['--publish-check'], publisherDeps(f, models, jest.fn())))
      .rejects.toThrow(/stale/)
    // Never labeled current: no CHECK row is persisted for a stale collection.
    expect(calls).toEqual([])
  })

  test('an old-format report refuses an unapplied repair before any fresh collection or write', async () => {
    const f = await verifiedRepairFixture()
    const calls = []
    const manifest = buildRewardsReconciliation(f.input)
    // A pre-v2 report: correctly self-digested, but it can never authorize a
    // NEW unapplied repair.
    const legacy = structuredClone(manifest)
    legacy.version = 1
    legacy.digest = manifestDigest(legacy)
    const collector = jest.fn(async () => f.approvedEvidence)
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const reportPath = path.join(dir, 'legacy-report.json')
      writeFileSync(reportPath, JSON.stringify({ manifest: legacy, evidence: f.approvedEvidence }))
      await expect(runCli([
        '--apply', reportPath,
        '--confirm', legacy.digest,
        '--backup-reference', 'pre-repair-snapshot',
        '--writers-paused'
      ], {
        models: checkPublisherModels(f, calls),
        scope: () => f.input.scope,
        daemon: { getBlockHashByHeight: async () => f.input.boundary.blockHash },
        collectEvidence: collector,
        log: () => {}
      })).rejects.toThrow(/unsupported manifest version/)
      // The refusal precedes the trusted recheck and every write: no
      // collection ran and no audit row (or any other write) exists.
      expect(collector).not.toHaveBeenCalled()
      expect(calls).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('decisions JSON can never supply payment-verification or proof-key authority', async () => {
    const f = await verifiedRepairFixture()
    const plain = await runCli([], publisherDeps(f, checkPublisherModels(f, []), jest.fn()))
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const forgedPath = path.join(dir, 'forged-decisions.json')
      writeFileSync(forgedPath, JSON.stringify({
        receipts: {},
        // Fabricated authority of every JSON flavor: collected verifications,
        // proof keys, relay proofs and master-key material. None of it may
        // change the manifest the CLI builds.
        paymentVerifications: structuredClone(f.approvedEvidence.paymentVerifications),
        proofKeys: { 1: Buffer.alloc(32, 7).toString('base64') },
        relayProofs: { [f.journal.txHash]: { forged: true } },
        txProofMasterKeys: 'forged'
      }))
      const forged = await runCli(['--decisions', forgedPath], publisherDeps(f, checkPublisherModels(f, []), jest.fn()))
      expect(forged.manifest.digest).toBe(plain.manifest.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a hand-forged report evidence refuses an unapplied repair before any write', async () => {
    const f = await verifiedRepairFixture()
    const calls = []
    const manifest = buildRewardsReconciliation(f.input)
    const forgedEvidence = structuredClone(f.approvedEvidence)
    // A projected field outside the chain-facts and verifier-closure surface:
    // the evidence digest moves while every earlier gate still passes, so the
    // refusal is exactly the approved-evidence digest precondition.
    forgedEvidence.collectionStartedAt = '2026-10-06T11:00:00.000Z'
    const dir = mkdtempSync(path.join(tmpdir(), 'rewards-repair-'))
    try {
      const reportPath = path.join(dir, 'forged-report.json')
      writeFileSync(reportPath, JSON.stringify({ manifest, evidence: forgedEvidence }))
      await expect(runCli([
        '--apply', reportPath,
        '--confirm', manifest.digest,
        '--backup-reference', 'pre-repair-snapshot',
        '--writers-paused'
      ], {
        models: checkPublisherModels(f, calls),
        scope: () => f.input.scope,
        daemon: { getBlockHashByHeight: async () => f.input.boundary.blockHash },
        collectEvidence: async () => f.approvedEvidence,
        log: () => {}
      })).rejects.toThrow(/evidence does not match the approved evidence digest/)
      expect(calls).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('one effective reserve: an env change re-binds the CLI fingerprint and stale-dates prior authorization', async () => {
    const f = await verifiedRepairFixture()
    const base = await runCli([], publisherDeps(f, checkPublisherModels(f, []), jest.fn()))
    process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS = '2500000000'
    try {
      const overridden = await runCli([], publisherDeps(f, checkPublisherModels(f, []), jest.fn()))
      // The audited effective reserve moved, so both the totals and the audit
      // identity moved: an authorization minted under the old reserve can
      // never clear against the new one (and vice versa).
      expect(overridden.manifest.before.reservePiconeros).not.toBe(base.manifest.before.reservePiconeros)
      expect(overridden.manifest.ledgerFingerprint).not.toBe(base.manifest.ledgerFingerprint)
    } finally {
      delete process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS
    }
  })

  test('no secret sentinel reaches the CLI logs or the published CHECK report arguments', async () => {
    const f = await verifiedRepairFixture()
    const calls = []
    const log = jest.fn()
    const sentinels = {
      PLATFORM_REWARDS_SPEND_KEY: `spend-sentinel-${'f'.repeat(24)}`,
      PLATFORM_REWARDS_VIEW_KEY: `view-sentinel-${'e'.repeat(24)}`,
      BOUNTY_ESCROW_SPEND_KEY: `escrow-spend-sentinel-${'d'.repeat(24)}`
    }
    for (const [key, value] of Object.entries(sentinels)) process.env[key] = value
    try {
      const result = await runCli(['--publish-check'], publisherDeps(f, checkPublisherModels(f, calls), log))
      expect(result.published).toBe(true)
    } finally {
      for (const key of Object.keys(sentinels)) delete process.env[key]
    }
    const logged = log.mock.calls.map(args => args.join(' ')).join('\n')
    // Prisma columns carry BigInt money: serialize through the same decimal
    // widening the report JSON itself uses.
    const stored = JSON.stringify(calls, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
    for (const sentinel of Object.values(sentinels)) {
      expect(logged).not.toContain(sentinel)
      expect(stored).not.toContain(sentinel)
    }
    // No key/envelope material or byte fields anywhere in the stored CHECK.
    expect(stored).not.toMatch(/privateSpendKey|privateViewKey|spendKey|viewKey|mnemonic|ciphertext|dataNonce|dataTag|wrappedDek/)
    // The report stays the closed {manifest, evidence} wrapper.
    for (const data of calls) {
      expect(Object.keys(data.report).sort()).toEqual(['evidence', 'manifest'])
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
