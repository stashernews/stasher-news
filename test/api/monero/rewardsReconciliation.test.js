/* eslint-env jest */
import {
  assertRepairPreconditions,
  buildRewardsReconciliation,
  ledgerPreconditionFingerprint,
  manifestDigest,
  readRepairLedger,
  rebuildOpsSnapshots
} from '@/api/monero/rewardsReconciliation'
import { summarizeRewardsLedger } from '@/api/monero/rewardsLedger'
import { accountingAuditFingerprint } from '@/lib/rewardsAuditFingerprint'
import { auditLedgerFixture, paymentChainFixture, paymentFixture } from '@/test/fixtures/payment-proof'
import { opsCarry } from '@/lib/rewardsAccounting'
import { decodeReceivingIdentity, normalizePaymentClaims, paymentClaimDigest } from '@/api/monero/paymentClaims'
import { validatePaymentVerification, verifyLegacyPaymentTransaction } from '@/api/monero/paymentVerification'
import {
  FI,
  approvedIncomingClassification,
  syntheticRewardsEvidence,
  withApprovedIncomingClassification,
  withMigrationClassifiedFunding
} from '../../fixtures/rewards-accounting-evidence'
import {
  RELAY_PROOF_FIELDS,
  VERIFIED_OBSERVED_AT,
  closeVerifiedRepairFixtures,
  legacyRepairFixture,
  verifiedFixtureIds,
  verifiedRepairFixture
} from '@/test/fixtures/rewards-payment-verification'

// Synthetic manifest tests (rewards accounting repair §8, Task 12). Pure: no
// DB, no wallet, no daemon. The fixture's exact money story is documented in
// test/fixtures/rewards-accounting-evidence.js.

const clone = value => structuredClone(value)
const codesOf = manifest => manifest.issues.map(issue => issue.code)
const approve = () => withApprovedIncomingClassification(syntheticRewardsEvidence())

// The pre-proof-era synthetic story under strict recorded-outflow coverage
// (final-review I1): its SENT/CONFIRMED payout batch is covered only by a
// RELAYED journal row and its escrow legs only by confirmed escrow history —
// operational relay history, never complete-payment proofs — so the strict
// audit names each recorded fact instead of silently passing. Totals,
// operations and reward contracts are unchanged by the naming.
const STORY_CODES = [
  'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
  'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
  'RECORDED_PAYOUT_PROOF_UNSUPPORTED',
  'RECORDED_PAYOUT_PROOF_UNSUPPORTED'
]

const operationFor = (manifest, table, idOrHash) =>
  manifest.operations.find(op => op.table === table && (op.id === idOrHash || op.txHash === idOrHash))

test('dry-run preserves frozen terms and contracts while listing exact corrections', () => {
  const input = syntheticRewardsEvidence()
  const original = structuredClone(input)
  const manifest = buildRewardsReconciliation(input)
  expect(input).toEqual(original)
  expect(manifest.digest).toBe(manifestDigest(manifest))
  expect(manifest.operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: 'FeeObservation', id: 1, before: { walletReceipt: true }, after: { walletReceipt: false } }),
    expect.objectContaining({ table: 'RewardsWalletTransaction', txHash: 'f1'.repeat(32), after: expect.objectContaining({ networkFeePiconeros: '7' }) })
  ]))
  expect(manifest.after.positiveDriftPiconeros).toBe('0')
  expect(manifest.after.protectedRewardsFingerprint).toBe(manifest.before.protectedRewardsFingerprint)
})

describe('synthetic fixture money story', () => {
  test('hot receipts 144, external principal 70, costs 12, wallet total 62 vs unlocked 52', () => {
    const input = approve()
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.version).toBe(2)
    expect(manifest.accountingFingerprintVersion).toBe(2)
    expect(manifest.scope).toEqual(FI.SCOPE)
    expect(manifest.boundary).toEqual(FI.BOUNDARY)
    expect(manifest.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    // The manifest binds the SHARED v2 audit identity over its snapshot input.
    expect(manifest.ledgerFingerprint).toBe(accountingAuditFingerprint({
      scope: input.scope, ledger: input.ledger, config: input.config, reserve: input.reserve
    }))
    expect(manifest.protectedRewardsFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.before).toMatchObject({
      receiptsPiconeros: '160',
      rewardsPiconeros: '140',
      opsPiconeros: '20',
      totalSentPiconeros: '70',
      totalNetworkFeesPiconeros: '5',
      ledgerBalancePiconeros: '85',
      walletTotalPiconeros: '62',
      differencePiconeros: '23',
      positiveDriftPiconeros: '23',
      opsPendingPiconeros: '5',
      nextPoolPiconeros: '0'
    })
    expect(manifest.after).toMatchObject({
      receiptsPiconeros: '144',
      rewardsPiconeros: '100',
      opsPiconeros: '44',
      totalSentPiconeros: '70',
      totalNetworkFeesPiconeros: '12',
      ledgerBalancePiconeros: '62',
      walletTotalPiconeros: '62',
      differencePiconeros: '0',
      positiveDriftPiconeros: '0',
      opsPendingPiconeros: '22'
    })
    // Wallet total 62 and unlocked 52 are separate recorded values.
    expect(input.evidence.balances.unlockedPiconeros).toBe('52')
    expect(manifest.before.walletTotalPiconeros).not.toBe(manifest.before.unlockedPiconeros)
  })

  test('fees are counted once per hash even when one payout hash serves two members', () => {
    const manifest = buildRewardsReconciliation(approve())
    const feeOps = manifest.operations.filter(op => op.table === 'RewardsWalletTransaction')
    expect(feeOps).toHaveLength(1)
    expect(feeOps[0].txHash).toBe(FI.TX.PAYOUT)
    expect(manifest.after.totalNetworkFeesPiconeros).toBe('12') // 7 + 3 + 2, not 14
    expect(manifest.after.totalSentPiconeros).toBe('70') // 60 counted once + 10
    expect(manifest.after.outstandingRewardsPiconeros).toBe('8') // pending payout commitment stays owed
  })

  test('historical nominal rollover 140 is corrected to net 139 / rewards 100', () => {
    const manifest = buildRewardsReconciliation(approve())
    const op = operationFor(manifest, 'FeeObservation', 2)
    expect(op).toMatchObject({
      kind: 'update',
      before: { piconeros: '140', rewardsPiconeros: null },
      after: { piconeros: '139', rewardsPiconeros: '100' }
    })
  })

  test('distribution ops snapshot is rebuilt from the original source allocation terms', () => {
    const manifest = buildRewardsReconciliation(approve())
    const op = operationFor(manifest, 'RewardDistribution', 1)
    expect(op).toMatchObject({
      kind: 'update',
      before: {
        opsInflowPiconeros: '20',
        opsRolledOverPiconeros: '0',
        opsAvailablePiconeros: '20'
      },
      after: {
        opsInflowPiconeros: '39',
        opsRolledOverPiconeros: '0',
        opsAvailablePiconeros: '39'
      },
      sweepAccounting: { recordedPiconeros: '0', provenPiconeros: '10', recordedHash: null }
    })
  })

  // Final-review Important regression: the schema migration marks identified
  // funding accruals walletReceipt=false BEFORE the repair manifest runs. The
  // historical distribution snapshot still carries their phantom ops
  // contribution, so the manifest must reconstruct (from the mandated funding
  // predicate) and remove it exactly once — never blanket-subtract every
  // ineligible row, and never subtract again after an APPLY.
  test('a migration-classified funding accrual is reconstructed exactly once, not by blanket subtraction', () => {
    const migrated = withApprovedIncomingClassification(
      withMigrationClassifiedFunding(syntheticRewardsEvidence())
    )
    const manifest = buildRewardsReconciliation(migrated)
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    const op = operationFor(manifest, 'RewardDistribution', 1)
    expect(op).toMatchObject({
      before: { opsInflowPiconeros: '20', opsRolledOverPiconeros: '0', opsAvailablePiconeros: '20' },
      after: { opsInflowPiconeros: '39', opsRolledOverPiconeros: '0', opsAvailablePiconeros: '39' }
    })
    // Same corrected acceptance as the pre-migration cash-eligible fixture:
    // the phantom contribution does not survive a "clean" reconciliation.
    expect(manifest.after).toMatchObject({
      receiptsPiconeros: '144',
      rewardsPiconeros: '100',
      opsPiconeros: '44',
      opsPendingPiconeros: '22',
      positiveDriftPiconeros: '0'
    })

    // A non-identified ineligible row is NOT subtracted: only the identified
    // funding accrual contributes the reconstruction.
    const unrelated = withMigrationClassifiedFunding(syntheticRewardsEvidence())
    unrelated.ledger.receipts.push({
      id: 99,
      txHash: 'ee'.repeat(32),
      feeType: 'BOUNTY_FEE',
      subName: null,
      walletReceipt: false,
      state: 'CONFIRMED',
      piconeros: 7n,
      rewardsPiconeros: null,
      donationRewardsPct: null,
      recipientMajor: 0,
      recipientMinor: 0,
      height: null,
      confirmedAt: new Date(FI.DATE.FUNDING),
      postId: 999,
      payInId: null
    })
    const unrelatedManifest = buildRewardsReconciliation(unrelated)
    expect(operationFor(unrelatedManifest, 'RewardDistribution', 1).after.opsInflowPiconeros).toBe('39')

    // Simulate the APPLY: once the stored snapshot equals the corrected target,
    // regenerating emits no reconstruction at all (delta 0).
    const appliedInput = withApprovedIncomingClassification(
      withMigrationClassifiedFunding(syntheticRewardsEvidence())
    )
    appliedInput.ledger.distributions[0].opsInflowPiconeros = 39n
    appliedInput.ledger.distributions[0].opsAvailablePiconeros = 39n
    const regenerated = buildRewardsReconciliation(appliedInput)
    expect(codesOf(regenerated)).toEqual(STORY_CODES)
    expect(regenerated.operations.filter(operation => operation.table === 'RewardDistribution')).toEqual([])
  })

  // Final-review Important regression: signed ops debt is a contractual value.
  // A negative snapshot propagates into the next distribution's carry and later
  // income repays it; none of it is malformed evidence or stale uncertainty.
  test('signed ops debt propagates and is repaid by later income without stale uncertainty', () => {
    const d1 = {
      id: 1,
      periodStart: 0,
      periodEnd: 100,
      opsInflowPiconeros: 0n,
      opsRolledOverPiconeros: 0n,
      opsAvailablePiconeros: 0n,
      opsSweptPiconeros: 0n,
      opsNetworkFeesAccountedPiconeros: 10n
    }
    const d2 = {
      id: 2,
      periodStart: 100,
      periodEnd: 200,
      opsInflowPiconeros: 5n,
      opsRolledOverPiconeros: 0n,
      opsAvailablePiconeros: 5n,
      opsSweptPiconeros: 0n,
      opsNetworkFeesAccountedPiconeros: 10n
    }
    // The repair corrects D1's ops inflow by -10: the debt rolls into D2.
    const corrected = rebuildOpsSnapshots([d1, d2], new Map([[1, -10n]]))
    expect(corrected[0].opsAvailablePiconeros).toBe(-10n)
    expect(corrected[1].opsRolledOverPiconeros).toBe(-10n)
    expect(corrected[1].opsAvailablePiconeros).toBe(-5n)
    expect(opsCarry({ distribution: corrected[1], totalNetworkFeesPiconeros: 10n, provenSweptPiconeros: 0n })).toBe(-5n)

    // A negative snapshot with zero proven sweep is known debt, not uncertainty.
    const ledger = summarizeRewardsLedger({ payouts: [], distributions: corrected, transactions: [], scope: FI.SCOPE })
    expect(ledger.accountingUncertain).toBe(false)

    // Later income repays it: carry -5 + inflow 9 -> available 4, still certain.
    const d3 = {
      id: 3,
      periodStart: 200,
      periodEnd: 300,
      opsInflowPiconeros: 9n,
      opsRolledOverPiconeros: -5n,
      opsAvailablePiconeros: 4n,
      opsSweptPiconeros: 0n,
      opsNetworkFeesAccountedPiconeros: 10n
    }
    const repaid = summarizeRewardsLedger({ payouts: [], distributions: [...corrected, d3], transactions: [], scope: FI.SCOPE })
    expect(repaid.accountingUncertain).toBe(false)
    expect(opsCarry({ distribution: d3, totalNetworkFeesPiconeros: 10n, provenSweptPiconeros: 0n })).toBe(4n)
  })

  test('settlement metadata is recovered from escrow history without touching contracts', () => {
    const manifest = buildRewardsReconciliation(approve())
    const award = operationFor(manifest, 'BountyPayment', 21)
    expect(award).toMatchObject({
      before: {
        feeRecipientAddress: null,
        networkFeePiconeros: null,
        recipientReceivedPiconeros: null,
        feeReceivedPiconeros: null
      },
      after: {
        feeRecipientAddress: FI.ADDRESS.COLD,
        networkFeePiconeros: '3',
        recipientReceivedPiconeros: '100',
        feeReceivedPiconeros: '17'
      }
    })
    const rollover = operationFor(manifest, 'BountyPayment', 22)
    expect(rollover).toMatchObject({
      before: { networkFeePiconeros: null, recipientReceivedPiconeros: null, feeReceivedPiconeros: null },
      after: { networkFeePiconeros: '1', recipientReceivedPiconeros: '139', feeReceivedPiconeros: '0' }
    })
    for (const op of manifest.operations.filter(o => o.table === 'BountyPayment')) {
      for (const frozen of ['piconeros', 'state', 'txHash', 'feePiconeros', 'recipientAddress']) {
        expect(op.after).not.toHaveProperty(frozen)
      }
    }
  })

  test('a legacy deferred fee leg is recovered from its own escrow feeTxHash evidence', () => {
    const input = approve()
    const payment = input.ledger.bountyPayments.find(row => row.id === 21)
    const prizeTx = 'ab'.repeat(32)
    const feeTx = 'ac'.repeat(32)
    payment.txHash = prizeTx
    payment.feeTxHash = feeTx
    input.evidence.escrow.outgoing.push(
      {
        txHash: prizeTx,
        accountIndex: 0,
        feePiconeros: '1',
        destinations: [{ address: FI.ADDRESS.CURATOR_ONE, amountPiconeros: '100' }],
        height: FI.HEIGHT.AWARD,
        inTxPool: false,
        isConfirmed: true,
        isRelayed: true,
        isSelfTransfer: false,
        relayState: 'confirmed'
      },
      {
        txHash: feeTx,
        accountIndex: 0,
        feePiconeros: '2',
        destinations: [{ address: FI.ADDRESS.COLD, amountPiconeros: '20' }],
        height: FI.HEIGHT.AWARD,
        inTxPool: false,
        isConfirmed: true,
        isRelayed: true,
        isSelfTransfer: false,
        relayState: 'confirmed'
      }
    )
    const manifest = buildRewardsReconciliation(input)
    const op = operationFor(manifest, 'BountyPayment', 21)
    expect(op).toMatchObject({
      after: {
        networkFeePiconeros: '1',
        recipientReceivedPiconeros: '100',
        feeRecipientAddress: FI.ADDRESS.COLD,
        feeReceivedPiconeros: '20',
        feeSettlementNetworkFeePiconeros: '2'
      }
    })
    expect(op.after).not.toHaveProperty('state')
    expect(op.after).not.toHaveProperty('piconeros')
    expect(op.after).not.toHaveProperty('txHash')
  })

  test('reward contracts and allocations stay immutable; the reward-side deficit is explicit debt', () => {
    const manifest = buildRewardsReconciliation(approve())
    expect(manifest.after.protectedRewardsFingerprint).toBe(manifest.before.protectedRewardsFingerprint)
    expect(manifest.operations.map(op => op.table)).not.toContain('RewardPayout')
    expect(manifest.operations.map(op => op.table)).not.toContain('Earn')
    expect(manifest.operations.filter(op => op.table === 'RewardDistribution')).toHaveLength(1)
    expect(manifest.after.fundingDeficitPiconeros).toBe('40') // 140 booked vs 100 chain-funded
    expect(manifest.before.fundingDeficitPiconeros).toBe('0') // not recognized before repair
  })
})

describe('explicit operator decisions', () => {
  test('no decision for the unbooked incoming 5 is UNKNOWN_INCOMING and never auto-inserted', () => {
    const manifest = buildRewardsReconciliation(syntheticRewardsEvidence())
    expect(codesOf(manifest)).toContain('UNKNOWN_INCOMING')
    expect(manifest.operations.some(op => op.kind === 'insert' && op.table === 'FeeObservation')).toBe(false)
    // No positive phantom remains: the chain surplus is reported, not booked.
    expect(manifest.after.positiveDriftPiconeros).toBe('0')
    expect(manifest.after.differencePiconeros).toBe('-5')
  })

  test('an approved classification binds source, split, index and confirmedAt from evidence', () => {
    const manifest = buildRewardsReconciliation(approve())
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    const insert = manifest.operations.find(op => op.kind === 'insert' && op.table === 'FeeObservation')
    expect(insert.before).toBeNull()
    expect(insert.key).toEqual({ txHash: FI.TX.INCOMING, recipientMajor: 0, recipientMinor: 0 })
    expect(insert.after).toMatchObject({
      txHash: FI.TX.INCOMING,
      feeType: 'BOUNTY_FEE',
      piconeros: '5',
      rewardsPiconeros: '0',
      walletReceipt: true,
      state: 'CONFIRMED',
      recipientMajor: 0,
      recipientMinor: 0,
      height: FI.HEIGHT.INCOMING,
      confirmedAt: FI.DATE.INCOMING
    })
    expect(manifest.after.positiveDriftPiconeros).toBe('0')
    expect(manifest.after.receiptsPiconeros).toBe('144')
  })

  test('an ignored-flag caller cannot delete issues', () => {
    const manifest = buildRewardsReconciliation(syntheticRewardsEvidence(), { ignoreIssues: true })
    expect(codesOf(manifest)).toContain('UNKNOWN_INCOMING')
  })

  test('a positive phantom drift is reported and blocks while evidence is incomplete', () => {
    const input = approve()
    input.evidence.escrow = null // the funding accrual can no longer be identified as noncash
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.issues.length).toBeGreaterThan(0)
    expect(Number(manifest.after.positiveDriftPiconeros)).toBeGreaterThan(0)
  })
})

describe('evidence integrity issues', () => {
  test('wrong wallet or network is a scope mismatch', () => {
    const input = approve()
    input.evidence.scope = { ...input.evidence.scope, walletAddress: '5SomeOtherWallet' }
    expect(codesOf(buildRewardsReconciliation(input))).toContain('SCOPE_MISMATCH')

    const journal = approve()
    journal.ledger.transactions[0].walletAddress = '5SomeOtherWallet'
    const manifest = buildRewardsReconciliation(journal)
    expect(codesOf(manifest)).toContain('SCOPE_MISMATCH')
  })

  test('restore height above the verified first activity is refused', () => {
    const input = approve()
    input.evidence.restoreHeight = 5000
    input.evidence.restoreProvenance = 'earliest-db-inflow'
    expect(codesOf(buildRewardsReconciliation(input))).toContain('RESTORE_ABOVE_FIRST_EVIDENCE')

    // A restore at or below the verified first activity is safe.
    const proven = approve()
    proven.evidence.restoreHeight = 5000
    proven.evidence.restoreProvenance = 'verified-first-activity'
    proven.evidence.firstActivityHeight = 6000
    expect(codesOf(buildRewardsReconciliation(proven))).toEqual(STORY_CODES)
  })

  test('incomplete derivation, unsynced height and a moved boundary block the manifest', () => {
    const derivation = approve()
    derivation.evidence.derivation.complete = false
    expect(codesOf(buildRewardsReconciliation(derivation))).toContain('INCOMPLETE_DERIVATION')

    const unsynced = approve()
    // Scanned count one short of boundary index + 1: the boundary block itself
    // is unscanned.
    unsynced.evidence.walletHeight = FI.BOUNDARY.height
    expect(codesOf(buildRewardsReconciliation(unsynced))).toContain('UNSYNCED_HEIGHT')

    const moved = approve()
    moved.evidence.daemon.tipAfter = { height: FI.BOUNDARY.height + 1, blockHash: 'ff'.repeat(32) }
    expect(codesOf(buildRewardsReconciliation(moved))).toContain('BOUNDARY_CHANGED')
  })

  test('a mismatched ledger fingerprint never silently clears the evidence digest', () => {
    const input = approve()
    input.ledgerFingerprint = 'f'.repeat(64)
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.ledgerFingerprint).not.toBe(input.ledgerFingerprint)
    // v2 identity: the shared `accounting:v2:` audit fingerprint.
    expect(manifest.ledgerFingerprint).toMatch(/^accounting:v2:[0-9a-f]{64}$/)
  })
})

describe('inbound/receipt anomalies', () => {
  test('an unmatched booked receipt blocks the manifest', () => {
    const input = approve()
    input.ledger.receipts.push({
      id: 4,
      txHash: 'e8'.repeat(32),
      feeType: 'POSTING',
      subName: null,
      walletReceipt: true,
      state: 'CONFIRMED',
      piconeros: 11n,
      rewardsPiconeros: null,
      donationRewardsPct: null,
      recipientMajor: 0,
      recipientMinor: 0,
      height: 2999450,
      confirmedAt: new Date(FI.DATE.DIST_START),
      postId: null,
      payInId: null
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('UNMATCHED_BOOKED_RECEIPT')
  })

  test('a noncash row with chain evidence is a conflict, never silently re-cashed', () => {
    const input = approve()
    input.ledger.receipts[1].walletReceipt = false
    expect(codesOf(buildRewardsReconciliation(input))).toContain('NONCASH_ROW_HAS_CHAIN_EVIDENCE')
  })

  test('a non-CONFIRMED booked receipt is not mature enough to repair', () => {
    const input = approve()
    input.ledger.receipts[1].state = 'DETECTED'
    expect(codesOf(buildRewardsReconciliation(input))).toContain('UNMATURED_RECEIPT')
  })

  test('two ledger rows claiming one chain output is ambiguous pairing', () => {
    const input = approve()
    input.ledger.receipts.push({
      ...input.ledger.receipts[1],
      id: 5
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('AMBIGUOUS_PAIRING')
  })

  test('a rollover without frozen booked-prize evidence is not split by guesswork', () => {
    const input = approve()
    input.ledger.items = []
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('UNVERIFIED_ROLLOVER_SPLIT')
    expect(operationFor(manifest, 'FeeObservation', 2)).toBeUndefined()
  })

  test('a historical percentage-source correction needs period config evidence or a decision', () => {
    const makeInput = () => {
      const input = approve()
      input.ledger.receipts.push({
        id: 6,
        txHash: 'e7'.repeat(32),
        feeType: 'POSTING',
        subName: null,
        walletReceipt: true,
        state: 'CONFIRMED',
        piconeros: 100n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        recipientMajor: 0,
        recipientMinor: 0,
        height: 2999400,
        confirmedAt: new Date('2026-09-06T00:00:00.000Z'),
        postId: 303,
        payInId: null
      })
      input.evidence.incoming.push({
        txHash: 'e7'.repeat(32),
        accountIndex: 0,
        subaddressIndex: 0,
        amountPiconeros: '90',
        height: 2999400,
        inTxPool: false,
        isConfirmed: true,
        fromOwnTransaction: false,
        isSelfTransfer: false
      })
      return input
    }
    const blocked = buildRewardsReconciliation(makeInput())
    expect(codesOf(blocked)).toContain('UNVERIFIED_ALLOCATION')
    expect(operationFor(blocked, 'FeeObservation', 6)).toBeUndefined()

    const decided = makeInput()
    decided.decisions.periodConfigs = [{
      from: FI.DATE.DIST_START,
      to: FI.DATE.DIST_END,
      verified: true,
      config: { downvoteRewardsPct: 100, postingFeeRewardsPct: 70, territoryFeeRewardsPct: 30, boostRewardsPct: 30, walletlessTipRewardsPct: 70 }
    }]
    const manifest = buildRewardsReconciliation(decided)
    expect(codesOf(manifest)).not.toContain('UNVERIFIED_ALLOCATION')
    expect(operationFor(manifest, 'FeeObservation', 6)).toMatchObject({
      before: { piconeros: '100' },
      after: { piconeros: '90' }
    })
  })
})

describe('outgoing classification and pending bridge', () => {
  test('an unexplained external outgoing blocks the manifest and is never guessed', () => {
    const input = approve()
    const hash = 'ee'.repeat(32)
    input.evidence.outgoing.push({
      txHash: hash,
      accountIndex: 0,
      feePiconeros: '1',
      destinations: [{ address: '5UnknownExternalDestination', amountPiconeros: '9' }],
      height: 2999800,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    })
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('UNKNOWN_OUTGOING')
    expect(manifest.operations.some(op => op.txHash === hash)).toBe(false)
  })

  test('missing destinations or fee evidence blocks that outgoing and its corrections', () => {
    const noDestinations = approve()
    noDestinations.evidence.outgoing[0].destinations = []
    const manifestA = buildRewardsReconciliation(noDestinations)
    expect(codesOf(manifestA)).toContain('MISSING_DESTINATIONS')
    expect(operationFor(manifestA, 'RewardsWalletTransaction', FI.TX.PAYOUT)).toBeUndefined()

    const noFee = approve()
    noFee.evidence.outgoing[0].feePiconeros = null
    const manifestB = buildRewardsReconciliation(noFee)
    expect(codesOf(manifestB)).toContain('MISSING_OUTGOING_FEE')
    expect(operationFor(manifestB, 'RewardsWalletTransaction', FI.TX.PAYOUT)).toBeUndefined()
  })

  test('a duplicate journal hash with conflicting facts is a material conflict', () => {
    const input = approve()
    input.ledger.transactions.push({
      ...input.ledger.transactions[0],
      kind: 'OPS_SWEEP',
      principalPiconeros: 10n,
      metadata: { destination: FI.ADDRESS.OPS }
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('DUPLICATE_HASH_CONFLICT')
  })

  test('a pending relay attempt with mempool evidence is an explicit bridge item', () => {
    const manifest = buildRewardsReconciliation(approve())
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.after.outstandingRewardsPiconeros).toBe('8')
    expect(manifest.after.totalNetworkFeesPiconeros).toBe('12') // pending fee 1 is never an expense
  })

  test('an attempted journal row with no chain evidence blocks rather than guessing', () => {
    const input = approve()
    input.evidence.bridge.pendingOutgoing = []
    expect(codesOf(buildRewardsReconciliation(input))).toContain('PENDING_ATTEMPT_UNRESOLVED')

    const unrelayed = approve()
    unrelayed.evidence.bridge.pendingOutgoing[0] = {
      ...unrelayed.evidence.bridge.pendingOutgoing[0],
      inTxPool: false,
      isRelayed: false,
      relayState: 'unrelayed'
    }
    expect(codesOf(buildRewardsReconciliation(unrelayed))).toContain('PENDING_ATTEMPT_UNRESOLVED')
  })

  test('a pending outgoing without any ledger membership blocks', () => {
    const input = approve()
    input.evidence.bridge.pendingOutgoing.push({
      txHash: 'ed'.repeat(32),
      accountIndex: 0,
      feePiconeros: '2',
      destinations: [{ address: '5UnknownPendingDestination', amountPiconeros: '3' }],
      inTxPool: true,
      isConfirmed: false,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'pool'
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('UNKNOWN_PENDING_OUTGOING')
  })

  test('a confirmed journal row with no wallet history blocks', () => {
    const input = approve()
    input.evidence.outgoing = input.evidence.outgoing.filter(o => o.txHash !== FI.TX.CONSOLIDATION)
    expect(codesOf(buildRewardsReconciliation(input))).toContain('JOURNAL_ROW_NOT_ON_CHAIN')
  })
})

describe('ops snapshot provenance', () => {
  test('a nonzero first-row carry without verified provenance blocks APPLY', () => {
    const input = approve()
    input.ledger.distributions[0] = {
      ...input.ledger.distributions[0],
      opsRolledOverPiconeros: 5n,
      opsAvailablePiconeros: 25n
    }
    expect(codesOf(buildRewardsReconciliation(input))).toContain('UNVERIFIED_FIRST_CARRY')

    const proven = approve()
    proven.ledger.distributions[0] = {
      ...proven.ledger.distributions[0],
      opsRolledOverPiconeros: 5n,
      opsAvailablePiconeros: 25n
    }
    proven.opsCarryProvenance = { 1: { verified: true, source: 'audited-genesis-snapshot' } }
    expect(codesOf(buildRewardsReconciliation(proven))).not.toContain('UNVERIFIED_FIRST_CARRY')
  })
})

describe('rebuildOpsSnapshots', () => {
  const row = (overrides) => ({
    id: 1,
    periodEnd: 100,
    opsInflowPiconeros: 20n,
    opsRolledOverPiconeros: 0n,
    opsAvailablePiconeros: 20n,
    opsSweptPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 0n,
    ...overrides
  })

  test('sorts by periodEnd then id, applies receipt deltas and does not mutate inputs', () => {
    const a = row({ id: 2, periodEnd: 200 })
    const b = row({ id: 1, periodEnd: 100 })
    const input = [a, b]
    const rebuilt = rebuildOpsSnapshots(input, new Map([[2, 7n]]))
    expect(rebuilt.map(r => r.id)).toEqual([1, 2])
    expect(rebuilt[1].opsInflowPiconeros).toBe(27n)
    // carry propagates from the corrected prior row: 20 available -> 27 + 20
    expect(rebuilt[1].opsAvailablePiconeros).toBe(47n)
    expect(input[0]).toEqual(a)
    expect(input[1]).toEqual(b)
  })

  test('propagates carry chronologically through preserved checkpoints', () => {
    const rows = [
      row({ id: 1, periodEnd: 100, opsInflowPiconeros: 20n, opsAvailablePiconeros: 20n, opsNetworkFeesAccountedPiconeros: 0n }),
      row({ id: 2, periodEnd: 200, opsInflowPiconeros: 5n, opsAvailablePiconeros: 25n, opsNetworkFeesAccountedPiconeros: 3n, opsSweptPiconeros: 4n }),
      row({ id: 3, periodEnd: 300, opsInflowPiconeros: 2n, opsAvailablePiconeros: 0n, opsNetworkFeesAccountedPiconeros: 9n })
    ]
    const rebuilt = rebuildOpsSnapshots(rows, new Map([[1, 10n]]), new Map([[1, 4n]]))
    // row2 carry = 30 − 4 − (3 − 0) = 23; row3 carry = (5+23) − 4 − (9 − 3) = 18
    expect(rebuilt[1].opsRolledOverPiconeros).toBe(23n)
    expect(rebuilt[1].opsAvailablePiconeros).toBe(28n)
    expect(rebuilt[2].opsRolledOverPiconeros).toBe(18n)
    expect(rebuilt[2].opsAvailablePiconeros).toBe(20n)
  })

  test('a de-duplicated proved swept amount substitutes for the recorded sweep', () => {
    const rows = [
      row({ id: 1, periodEnd: 100, opsInflowPiconeros: 30n, opsAvailablePiconeros: 30n }),
      row({ id: 2, periodEnd: 200 })
    ]
    const withoutProof = rebuildOpsSnapshots(rows, new Map())
    const withProof = rebuildOpsSnapshots(rows, new Map(), new Map([[1, 12n]]))
    expect(withoutProof[1].opsRolledOverPiconeros).toBe(30n)
    expect(withProof[1].opsRolledOverPiconeros).toBe(18n)
  })

  test('corrected carry stays consistent immediately and after a modeled next distribution', () => {
    const input = approve()
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.after.opsPendingPiconeros).toBe('22')

    const dist1 = input.ledger.distributions[0]
    const deltas = new Map([[1, 19n]]) // −20 phantom funding + 39 rollover ops
    const provenSwept = new Map([[1, 10n]])
    const corrected = rebuildOpsSnapshots([dist1], deltas, provenSwept)
    expect(corrected[0]).toMatchObject({
      opsInflowPiconeros: 39n,
      opsRolledOverPiconeros: 0n,
      opsAvailablePiconeros: 39n
    })
    const nextRow = row({
      id: 2,
      periodEnd: Date.parse('2026-09-15T00:00:00.000Z'),
      opsInflowPiconeros: 0n,
      opsAvailablePiconeros: 0n,
      opsNetworkFeesAccountedPiconeros: 12n
    })
    const rebuilt = rebuildOpsSnapshots([dist1, nextRow], deltas, provenSwept)
    expect(rebuilt[1].opsRolledOverPiconeros).toBe(17n)
    expect(rebuilt[1].opsRolledOverPiconeros).toBe(opsCarry({
      distribution: rebuilt[0],
      totalNetworkFeesPiconeros: 12n,
      provenSweptPiconeros: provenSwept.get(1)
    }))
  })
})

describe('ledger attribution conflicts', () => {
  test('a journal member naming no recorded payout is a material conflict', () => {
    const input = approve()
    const row = input.ledger.transactions.find(entry => entry.txHash === FI.TX.PAYOUT)
    row.metadata.payouts[0].payoutId = 999
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('JOURNAL_MEMBER_UNKNOWN')
    expect(codesOf(manifest)).not.toContain('UNKNOWN_OUTGOING')
  })

  test('a journal member that disagrees with the recorded payout is a material conflict', () => {
    const input = approve()
    const row = input.ledger.transactions.find(entry => entry.txHash === FI.TX.PAYOUT)
    row.metadata.payouts[0].piconeros = '41'
    expect(codesOf(buildRewardsReconciliation(input))).toContain('JOURNAL_MEMBER_MISMATCH')
  })

  test('duplicate recorded sweep-hash ownership is an exact material conflict', () => {
    const input = approve()
    input.ledger.distributions[0].opsSweepTxHash = FI.TX.SWEEP
    input.ledger.distributions.push({
      ...input.ledger.distributions[0],
      id: 2,
      periodStart: new Date('2026-09-08T00:00:00.000Z'),
      periodEnd: new Date('2026-09-15T00:00:00.000Z'),
      opsSweepTxHash: FI.TX.SWEEP
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('SWEEP_HASH_OWNERSHIP_CONFLICT')
  })

  test('a payout member from another distribution is a material conflict', () => {
    const input = approve()
    const row = input.ledger.transactions.find(entry => entry.txHash === FI.TX.PAYOUT)
    row.distributionId = 2
    expect(codesOf(buildRewardsReconciliation(input))).toContain('JOURNAL_MEMBER_MISMATCH')
  })

  test('a malformed recorded sweep hash is an exact material issue', () => {
    const input = approve()
    input.ledger.distributions[0].opsSweepTxHash = 'not-a-hash'
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('SWEEP_HASH_MALFORMED')
  })

  test('an empty recorded sweep hash is absent, not malformed', () => {
    // The shared ledger accepts '' as no recorded hashes; the manifest must
    // match that acceptance exactly (no blocking issue on clean evidence).
    const input = approve()
    input.ledger.distributions[0].opsSweepTxHash = ''
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).not.toContain('SWEEP_HASH_MALFORMED')
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.after.positiveDriftPiconeros).toBe('0')
  })

  test('unclassified ledger uncertainty materializes as LEDGER_UNCERTAINTY', () => {
    const input = approve()
    // The distribution records the sweep hash with a zero recorded total while
    // the journal proves 10: the shared union reports uncertainty that no
    // specific check classifies, so the catch-all must block (never issues: []).
    input.ledger.distributions[0].opsSweepTxHash = FI.TX.SWEEP
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('LEDGER_UNCERTAINTY')
    expect(codesOf(manifest)).not.toContain('SWEEP_HASH_MALFORMED')
  })

  test('a missing persisted fee proven by owned history emits only the correction', () => {
    const input = approve()
    const row = input.ledger.transactions.find(entry => entry.txHash === FI.TX.PAYOUT)
    row.networkFeePiconeros = null
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).not.toContain('JOURNAL_FEE_INVALID')
    expect(codesOf(manifest)).not.toContain('LEDGER_UNCERTAINTY')
    expect(codesOf(manifest)).not.toContain('MISSING_OUTGOING_FEE')
    expect(operationFor(manifest, 'RewardsWalletTransaction', FI.TX.PAYOUT)).toMatchObject({
      before: { networkFeePiconeros: null },
      after: { networkFeePiconeros: '7' }
    })
    expect(manifest.after.totalNetworkFeesPiconeros).toBe('12')
  })
})

describe('rollover split repair independent of the amount', () => {
  test('an existing net rollover with a legacy NULL split is still corrected', () => {
    const input = approve()
    input.ledger.receipts[1].piconeros = 139n
    const manifest = buildRewardsReconciliation(input)
    const op = operationFor(manifest, 'FeeObservation', 2)
    expect(op).toMatchObject({ before: { rewardsPiconeros: null }, after: { rewardsPiconeros: '100' } })
    expect(op.before).not.toHaveProperty('piconeros')
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.after.receiptsPiconeros).toBe('144')
    expect(manifest.after.positiveDriftPiconeros).toBe('0')
    expect(manifest.after.fundingDeficitPiconeros).toBe('39') // 139 booked as rewards vs the frozen 100
  })

  test('an existing net rollover with a wrong split is corrected to the frozen prize', () => {
    const input = approve()
    input.ledger.receipts[1].piconeros = 139n
    input.ledger.receipts[1].rewardsPiconeros = 120n
    const op = operationFor(buildRewardsReconciliation(input), 'FeeObservation', 2)
    expect(op).toMatchObject({ before: { rewardsPiconeros: '120' }, after: { rewardsPiconeros: '100' } })
    expect(op.before).not.toHaveProperty('piconeros')
  })
})

describe('classification semantics', () => {
  test('a donation classification counts its scaled share exactly once', () => {
    const input = approve()
    input.decisions.receipts[FI.TX.INCOMING] = {
      ...approvedIncomingClassification(),
      feeType: 'DONATE',
      rewardsPiconeros: '5',
      donationRewardsPct: 100
    }
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.after.nextPoolPiconeros).toBe('5') // was double-counted as 10
    expect(manifest.after.receiptsPiconeros).toBe('144')
    expect(manifest.after.rewardsPiconeros).toBe('105')
  })

  test('a classification that contradicts the source or the evidence is refused', () => {
    const wrongSplit = approve()
    wrongSplit.decisions.receipts[FI.TX.INCOMING] = { ...approvedIncomingClassification(), rewardsPiconeros: '5' }
    const manifestA = buildRewardsReconciliation(wrongSplit)
    expect(codesOf(manifestA)).toContain('INCOMPLETE_CLASSIFICATION')
    expect(manifestA.operations.some(op => op.kind === 'insert' && op.table === 'FeeObservation')).toBe(false)

    const wrongHeight = approve()
    wrongHeight.decisions.receipts[FI.TX.INCOMING] = { ...approvedIncomingClassification(), height: 1 }
    expect(codesOf(buildRewardsReconciliation(wrongHeight))).toContain('INCOMPLETE_CLASSIFICATION')

    const unverified = approve()
    delete unverified.decisions.receipts[FI.TX.INCOMING].verified
    expect(codesOf(buildRewardsReconciliation(unverified))).toContain('INCOMPLETE_CLASSIFICATION')
  })

  test('a historical percentage classification must match the period verified terms, not today config', () => {
    const makeInput = (rewardsPiconeros, withTerms = true) => {
      const input = approve()
      input.decisions.receipts[FI.TX.INCOMING] = {
        ...approvedIncomingClassification(),
        feeType: 'POSTING',
        rewardsPiconeros,
        confirmedAt: '2026-09-06T00:00:00.000Z'
      }
      if (withTerms) {
        input.decisions.periodConfigs = [{
          from: FI.DATE.DIST_START,
          to: FI.DATE.DIST_END,
          verified: true,
          config: {
            downvoteRewardsPct: 100,
            postingFeeRewardsPct: 50,
            territoryFeeRewardsPct: 30,
            boostRewardsPct: 30,
            walletlessTipRewardsPct: 70
          }
        }]
      }
      return input
    }
    // Verified historical 50%: rewards 2 / ops 3 — accepted, and the period
    // ops recomputation books the same 3 ops (base delta 19 + 3 => inflow 42).
    const historical = buildRewardsReconciliation(makeInput('2'))
    expect(codesOf(historical)).not.toContain('INCOMPLETE_CLASSIFICATION')
    const insert = historical.operations.find(op => op.kind === 'insert' && op.table === 'FeeObservation')
    expect(insert.after).toMatchObject({ feeType: 'POSTING', piconeros: '5', rewardsPiconeros: '2' })
    expect(operationFor(historical, 'RewardDistribution', 1).after.opsInflowPiconeros).toBe('42')

    // Today's config books 70% -> 3 rewards: rejected against the historical terms.
    const todaysConfig = buildRewardsReconciliation(makeInput('3'))
    expect(codesOf(todaysConfig)).toContain('INCOMPLETE_CLASSIFICATION')
    expect(todaysConfig.operations.some(op => op.kind === 'insert' && op.table === 'FeeObservation')).toBe(false)

    // No verified historical terms: fail closed, never fall back to today's config.
    const noTerms = buildRewardsReconciliation(makeInput('2', false))
    expect(codesOf(noTerms)).toContain('INCOMPLETE_CLASSIFICATION')
  })
})

describe('historical period allocation rounding', () => {
  test('ops deltas aggregate percentage sources exactly like the shared reader', () => {
    const input = approve()
    const hashA = 'e1'.repeat(32)
    const hashB = 'e2'.repeat(32)
    input.ledger.receipts.push(
      {
        id: 8,
        txHash: hashA,
        feeType: 'POSTING',
        subName: null,
        walletReceipt: true,
        state: 'CONFIRMED',
        piconeros: 1n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        recipientMajor: 0,
        recipientMinor: 0,
        height: 2999400,
        confirmedAt: new Date('2026-09-06T00:00:00.000Z'),
        postId: 303,
        payInId: null
      },
      {
        id: 9,
        txHash: hashB,
        feeType: 'POSTING',
        subName: null,
        walletReceipt: true,
        state: 'CONFIRMED',
        piconeros: 1n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        recipientMajor: 0,
        recipientMinor: 0,
        height: 2999401,
        confirmedAt: new Date('2026-09-06T01:00:00.000Z'),
        postId: 304,
        payInId: null
      }
    )
    input.evidence.incoming.push(
      {
        txHash: hashA,
        accountIndex: 0,
        subaddressIndex: 0,
        amountPiconeros: '3',
        height: 2999400,
        inTxPool: false,
        isConfirmed: true,
        fromOwnTransaction: false,
        isSelfTransfer: false
      },
      {
        txHash: hashB,
        accountIndex: 0,
        subaddressIndex: 0,
        amountPiconeros: '1',
        height: 2999401,
        inTxPool: false,
        isConfirmed: true,
        fromOwnTransaction: false,
        isSelfTransfer: false
      }
    )
    input.decisions.periodConfigs = [{
      from: FI.DATE.DIST_START,
      to: FI.DATE.DIST_END,
      verified: true,
      config: {
        downvoteRewardsPct: 100,
        postingFeeRewardsPct: 70,
        territoryFeeRewardsPct: 30,
        boostRewardsPct: 30,
        walletlessTipRewardsPct: 70
      }
    }]
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).not.toContain('UNVERIFIED_ALLOCATION')
    // Before: aggregate 2 -> floor(2*70/100)=1 reward, ops 1
    // After:  aggregate 4 -> floor(4*70/100)=2 rewards, ops 2  => +1
    // Combined with the stock fixture delta 19 => 20, i.e. inflow 40 (never 39).
    const op = operationFor(manifest, 'RewardDistribution', 1)
    expect(op.after.opsInflowPiconeros).toBe('40')
    expect(op.after.opsAvailablePiconeros).toBe('40')
  })
})

describe('downvote pairing', () => {
  test('a downvote at a different height is a conflict, never a silent match', () => {
    const input = approve()
    const hash = 'e0'.repeat(32)
    input.ledger.downvotes.push({
      id: 7,
      txHash: hash,
      paymentId: null,
      postId: null,
      downvoterId: null,
      piconeros: 7n,
      state: 'CONFIRMED',
      height: 1,
      confirmedAt: new Date(FI.DATE.INCOMING)
    })
    input.evidence.incoming.push({
      txHash: hash,
      accountIndex: 0,
      subaddressIndex: 0,
      amountPiconeros: '7',
      height: FI.HEIGHT.INCOMING,
      inTxPool: false,
      isConfirmed: true,
      fromOwnTransaction: false,
      isSelfTransfer: false
    })
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('DOWNVOTE_HEIGHT_MISMATCH')
    expect(codesOf(manifest)).not.toContain('UNKNOWN_INCOMING')
  })

  test('duplicate downvote rows for one hash are ambiguous', () => {
    const input = approve()
    const hash = 'e0'.repeat(32)
    input.ledger.downvotes.push(
      { id: 7, txHash: hash, paymentId: null, postId: null, downvoterId: null, piconeros: 7n, state: 'CONFIRMED', height: 2999900, confirmedAt: new Date(FI.DATE.INCOMING) },
      { id: 8, txHash: hash, paymentId: null, postId: null, downvoterId: null, piconeros: 7n, state: 'CONFIRMED', height: 2999900, confirmedAt: new Date(FI.DATE.INCOMING) }
    )
    input.evidence.incoming.push({
      txHash: hash,
      accountIndex: 0,
      subaddressIndex: 0,
      amountPiconeros: '7',
      height: 2999900,
      inTxPool: false,
      isConfirmed: true,
      fromOwnTransaction: false,
      isSelfTransfer: false
    })
    expect(codesOf(buildRewardsReconciliation(input))).toContain('AMBIGUOUS_DOWNVOTE_PAIRING')
  })
})

describe('decision provenance and shared fingerprint', () => {
  test('reviewed decision provenance is covered by the digest', () => {
    const a = approve()
    a.opsCarryProvenance = { 1: { verified: true, source: 'proof A' } }
    const b = approve()
    b.opsCarryProvenance = { 1: { verified: true, source: 'proof B' } }
    const manifestA = buildRewardsReconciliation(a)
    const manifestB = buildRewardsReconciliation(b)
    expect(manifestA.decisionsDigest).not.toBe(manifestB.decisionsDigest)
    expect(manifestA.digest).not.toBe(manifestB.digest)
  })

  test('a changed reviewed period config changes the digest too', () => {
    const make = pct => {
      const input = approve()
      input.decisions.periodConfigs = [{
        from: FI.DATE.DIST_START,
        to: FI.DATE.DIST_END,
        verified: true,
        config: { downvoteRewardsPct: 100, postingFeeRewardsPct: pct, territoryFeeRewardsPct: 30, boostRewardsPct: 30, walletlessTipRewardsPct: 70 }
      }]
      return input
    }
    expect(buildRewardsReconciliation(make(70)).digest)
      .not.toBe(buildRewardsReconciliation(make(50)).digest)
  })

  test('the manifest ledger fingerprint is the shared v2 audit identity, not the union digest', () => {
    const input = withApprovedIncomingClassification(syntheticRewardsEvidence())
    const manifest = buildRewardsReconciliation(input)
    // v2 manifests bind the Task 1 audit fingerprint over the snapshot input;
    // the money-union digest is no longer an accounting authority.
    expect(manifest.ledgerFingerprint).toBe(accountingAuditFingerprint({
      scope: input.scope, ledger: input.ledger, config: input.config, reserve: input.reserve
    }))
    const union = summarizeRewardsLedger({
      payouts: input.ledger.payouts,
      distributions: input.ledger.distributions,
      transactions: input.ledger.transactions,
      scope: input.scope
    })
    expect(manifest.ledgerFingerprint).not.toBe(union.unionFingerprint)
    // Any snapshot input mutation moves the bound identity.
    const changed = structuredClone(input)
    changed.ledger.distributions[0].opsSweepState = 'SWEPT'
    expect(buildRewardsReconciliation(changed).ledgerFingerprint)
      .not.toBe(manifest.ledgerFingerprint)
  })
})

describe('canonical manifest digest', () => {
  test('recomputation only excludes the digest field itself', () => {
    const manifest = buildRewardsReconciliation(approve())
    expect(manifest.digest).toBe(manifestDigest(manifest))
    expect(manifestDigest({ ...manifest, digest: 'a'.repeat(64) })).toBe(manifest.digest)
    expect(manifestDigest({ ...manifest, digest: 'b'.repeat(64) })).toBe(manifest.digest)
    const tampered = clone(manifest)
    tampered.operations[0].after.piconeros = '999'
    expect(manifestDigest(tampered)).not.toBe(manifest.digest)
  })

  test('fact and operation list order never changes the digest', () => {
    const forward = approve()
    const shuffled = approve()
    shuffled.ledger.receipts.reverse()
    shuffled.ledger.payouts.reverse()
    shuffled.ledger.transactions.reverse()
    shuffled.ledger.bountyPayments.reverse()
    shuffled.ledger.earns.reverse()
    shuffled.evidence.incoming.reverse()
    shuffled.evidence.outgoing.reverse()
    expect(buildRewardsReconciliation(shuffled).digest).toBe(buildRewardsReconciliation(forward).digest)
  })

  test('the manifest is JSON-safe: every money value is a decimal string', () => {
    const manifest = buildRewardsReconciliation(approve())
    const moneyKeys = [
      'receiptsPiconeros', 'rewardsPiconeros', 'opsPiconeros', 'totalSentPiconeros',
      'totalNetworkFeesPiconeros', 'outstandingRewardsPiconeros', 'ledgerBalancePiconeros',
      'walletTotalPiconeros', 'differencePiconeros', 'positiveDriftPiconeros',
      'nextPoolPiconeros', 'opsPendingPiconeros', 'reservePiconeros',
      'fundingDeficitPiconeros', 'explicitDebtPiconeros'
    ]
    for (const state of ['before', 'after']) {
      for (const key of moneyKeys) {
        if (manifest[state][key] === undefined) continue
        expect(typeof manifest[state][key]).toBe('string')
        expect(manifest[state][key]).toMatch(/^-?\d+$/)
      }
    }
    for (const op of manifest.operations) {
      for (const values of [op.before, op.after]) {
        if (values == null) continue
        for (const value of Object.values(values)) {
          if (typeof value === 'bigint') throw new Error(`BigInt escaped into ${op.table} before/after`)
        }
      }
    }
    expect(() => JSON.stringify(manifest)).not.toThrow()
  })
})

// =============================================================================
// v2 repair preconditions (rewards reconciliation Task 2): readRepairLedger
// delegates to the ONE shared audit snapshot (same selects, scope proof and
// receipt visibility as the audit), and the apply preconditions verify the
// fresh read IS a current v2 snapshot read while the protected reward
// contracts and the money-union digest keep their existing roles.
// =============================================================================

function freshRepairFixture (mutate) {
  const f = auditLedgerFixture()
  if (mutate) mutate(f)
  const models = {
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) =>
        f.ledger.accounts.find(a => a.label === where.label && a.network === where.network) ?? null)
    },
    subaddressIndex: {
      findMany: jest.fn(async ({ where }) =>
        f.ledger.subaddresses.filter(row => where.accountId.in.includes(row.accountId)))
    },
    feeObservation: { findMany: jest.fn(async () => f.ledger.receipts) },
    observedDownvote: { findMany: jest.fn(async () => f.ledger.downvotes) },
    rewardPayout: { findMany: jest.fn(async () => f.ledger.payouts) },
    rewardDistribution: { findMany: jest.fn(async () => f.ledger.distributions) },
    rewardsWalletTransaction: {
      findMany: jest.fn(async ({ where } = {}) =>
        f.ledger.transactions.filter(row =>
          row.network === where?.network && row.walletAddress === where?.walletAddress)),
      findUnique: jest.fn(async () => null)
    },
    escrowWalletTransaction: {
      findMany: jest.fn(async () => f.ledger.escrowTransactions),
      findUnique: jest.fn(async () => null)
    },
    bountyPayment: { findMany: jest.fn(async () => f.ledger.bountyPayments) },
    observedBounty: { findMany: jest.fn(async () => f.ledger.observedBounties) },
    observedBountyReceipt: { findMany: jest.fn(async () => f.ledger.observedBountyReceipts) },
    item: {
      findMany: jest.fn(async ({ where }) =>
        f.ledger.items.filter(row => where.id.in.includes(row.id)))
    },
    earn: { findMany: jest.fn(async () => f.ledger.earns) },
    platformFeeConfig: { findUnique: jest.fn(async () => f.config) },
    paymentTransactionProof: { findUnique: jest.fn(async () => null) }
  }
  return { f, models }
}

const preconditionLedger = f => ({
  receipts: f.ledger.receipts,
  downvotes: f.ledger.downvotes,
  payouts: f.ledger.payouts,
  distributions: f.ledger.distributions,
  transactions: f.ledger.transactions,
  bountyPayments: f.ledger.bountyPayments,
  observedBounties: f.ledger.observedBounties,
  observedBountyReceipts: f.ledger.observedBountyReceipts,
  items: f.ledger.items,
  earns: f.ledger.earns,
  escrowTransactions: f.ledger.escrowTransactions,
  proofInventory: f.ledger.proofInventory,
  accounts: f.ledger.accounts,
  subaddresses: f.ledger.subaddresses,
  reserve: f.reserve
})

describe('v2 repair preconditions', () => {
  test('readRepairLedger delegates to the shared snapshot: full groups, config, reserve and v2 identity', async () => {
    const { f, models } = freshRepairFixture()
    const ledger = await readRepairLedger(models, f.scope)

    expect(ledger.accountingFingerprint).toMatch(/^accounting:v2:[0-9a-f]{64}$/)
    expect(ledger.accountingFingerprintVersion).toBe(2)
    expect(ledger.config).toEqual(f.config)
    expect(ledger.reserve).toEqual(f.reserve)
    expect(ledger.scope).toEqual(f.scope)
    for (const group of [
      'receipts', 'downvotes', 'payouts', 'distributions', 'transactions',
      'bountyPayments', 'observedBounties', 'observedBountyReceipts', 'items',
      'earns', 'escrowTransactions', 'proofInventory', 'accounts', 'subaddresses'
    ]) {
      expect(Array.isArray(ledger[group])).toBe(true)
    }
    expect(ledger.receipts).toHaveLength(f.ledger.receipts.length)
    expect(ledger.proofInventory).toHaveLength(2)
    expect(ledger.escrowTransactions).toHaveLength(1)
    expect(ledger.earns).toEqual(f.ledger.earns)
  })

  test('the repair read keeps the COMPLETE audited receipt group (final-review I3)', async () => {
    // A metadata-only row (no chain hash, no positive material amount) is not
    // an observable monetary row: it is excluded from the builder's monetary
    // working set but RETAINED in the repair read — the shared snapshot is the
    // fingerprint/precondition authority and is never pre-filtered on the way
    // out.
    const { f, models } = freshRepairFixture(f => {
      f.ledger.receipts.push({
        id: 109n,
        txHash: null,
        feeType: 'BOOST',
        postId: null,
        subName: null,
        payInId: null,
        recipientMajor: 0,
        recipientMinor: 0,
        walletReceipt: false,
        state: 'DETECTED',
        piconeros: 0n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        height: null,
        confirmedAt: null
      })
    })
    const ledger = await readRepairLedger(models, f.scope)
    expect(ledger.receipts.map(row => row.id)).toEqual(f.ledger.receipts.map(row => row.id))
    expect(ledger.receipts.some(row => row.id === 109n)).toBe(true)
    expect(ledger.receipts.map(row => row.id)).toContain(104n)
    // ONE shared identity: the repair read's fingerprint IS the audit
    // snapshot's own identity over the same complete groups — the same value
    // the CHECK race guard, APPLY and the public ledger reader compare.
    expect(ledger.accountingFingerprint).toBe(accountingAuditFingerprint({
      scope: ledger.scope, ledger, config: ledger.config, reserve: ledger.reserve
    }))
  })

  const metadataRowLedger = mutateRow => {
    const fresh = freshRepairFixture(f => {
      f.ledger.receipts.push({
        id: 109n,
        txHash: null,
        feeType: 'BOOST',
        postId: null,
        subName: null,
        payInId: null,
        recipientMajor: 0,
        recipientMinor: 0,
        walletReceipt: false,
        state: 'DETECTED',
        piconeros: 0n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        height: null,
        confirmedAt: null
      })
      if (mutateRow) mutateRow(f)
    })
    return fresh
  }

  const metadataRowEvidence = scope => ({
    scope,
    boundary: { height: 1, blockHash: 'aa'.repeat(32) },
    outgoing: [],
    incoming: [],
    bridge: { pendingIncoming: [], pendingOutgoing: [] }
  })

  test('builder, CHECK and APPLY fingerprint the FULL snapshot identity (final-review I3)', async () => {
    const { f, models } = metadataRowLedger()
    const ledger = await readRepairLedger(models, f.scope)
    const manifest = buildRewardsReconciliation({
      scope: f.scope,
      boundary: { height: 1, blockHash: 'aa'.repeat(32) },
      evidence: metadataRowEvidence(f.scope),
      ledger,
      decisions: {},
      config: ledger.config,
      reserve: ledger.reserve,
      opsCarryProvenance: {}
    })
    // The manifest binds exactly the shared snapshot identity (the public
    // reader identity) even though a zero/hashless receipt row exists.
    expect(manifest.ledgerFingerprint).toBe(ledger.accountingFingerprint)
    // The metadata-only row is excluded from the monetary working set: it is
    // neither named as an unmatched booking nor moved any money total.
    expect(manifest.issues.some(issue =>
      issue.code === 'UNMATCHED_BOOKED_RECEIPT' && String(issue.id) === '109')).toBe(false)
    const withoutMetadataRow = await (async () => {
      const fresh = freshRepairFixture()
      const ledger = await readRepairLedger(fresh.models, fresh.f.scope)
      return buildRewardsReconciliation({
        scope: fresh.f.scope,
        boundary: { height: 1, blockHash: 'aa'.repeat(32) },
        evidence: metadataRowEvidence(fresh.f.scope),
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
    })()
    expect(manifest.after.receiptsPiconeros)
      .toBe(withoutMetadataRow.after.receiptsPiconeros)
  })

  test.each([
    ['update', f => {
      const row = f.ledger.receipts.find(candidate => candidate.id === 109n)
      row.feeType = 'DONATE'
    }],
    ['insert', f => {
      f.ledger.receipts.push({
        id: 110n,
        txHash: null,
        feeType: 'BOOST',
        postId: null,
        subName: null,
        payInId: null,
        recipientMajor: 0,
        recipientMinor: 0,
        walletReceipt: false,
        state: 'DETECTED',
        piconeros: 0n,
        rewardsPiconeros: null,
        donationRewardsPct: null,
        height: null,
        confirmedAt: null
      })
    }],
    ['delete', f => {
      f.ledger.receipts = f.ledger.receipts.filter(candidate => candidate.id !== 109n)
    }]
  ])('a %s of a zero/hashless receipt row moves the shared identity and refuses the apply (final-review I3)',
    async (_label, mutate) => {
      const approved = metadataRowLedger()
      const approvedLedger = await readRepairLedger(approved.models, approved.f.scope)
      const evidence = metadataRowEvidence(approved.f.scope)
      const manifest = buildRewardsReconciliation({
        scope: approved.f.scope,
        boundary: { height: 1, blockHash: 'aa'.repeat(32) },
        evidence,
        ledger: approvedLedger,
        decisions: {},
        config: approvedLedger.config,
        reserve: approvedLedger.reserve,
        opsCarryProvenance: {}
      })
      expect(manifest.ledgerFingerprint).toBe(approvedLedger.accountingFingerprint)

      const changed = metadataRowLedger(mutate)
      const changedLedger = await readRepairLedger(changed.models, changed.f.scope)
      expect(changedLedger.accountingFingerprint).not.toBe(manifest.ledgerFingerprint)
      // APPLY's authoritative comparator refuses: the fine-grained
      // precondition view and the shared audit catch-all both cover the
      // excluded row (fail closed — a discrepancy can never be cleared by a
      // stale CHECK against a moved identity).
      expect(() => assertRepairPreconditions(manifest, changedLedger, evidence))
        .toThrow(/changed since the manifest was approved/)
    })

  test('raw-formed malformed amounts keep the RAW visibility rule (final-review B2)', async () => {
    // A raw `7`, `'07'` or `'+7'` is NOT an observable monetary row under the
    // shared raw rule — even though the normalizer can read every form. The
    // monetary working set follows the RAW classification; the FULL snapshot
    // still fingerprints the row.
    const base = freshRepairFixture()
    const baseLedger = await readRepairLedger(base.models, base.f.scope)
    const baseManifest = buildRewardsReconciliation({
      scope: base.f.scope,
      boundary: { height: 1, blockHash: 'aa'.repeat(32) },
      evidence: metadataRowEvidence(base.f.scope),
      ledger: baseLedger,
      decisions: {},
      config: baseLedger.config,
      reserve: baseLedger.reserve,
      opsCarryProvenance: {}
    })
    for (const raw of [7, '07', '+7']) {
      const fresh = freshRepairFixture(f => {
        f.ledger.receipts.push({
          id: 108n,
          txHash: null,
          feeType: 'BOOST',
          postId: null,
          subName: null,
          payInId: null,
          recipientMajor: 0,
          recipientMinor: 0,
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: raw,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          height: null,
          confirmedAt: null
        })
      })
      const ledger = await readRepairLedger(fresh.models, fresh.f.scope)
      const manifest = buildRewardsReconciliation({
        scope: fresh.f.scope,
        boundary: { height: 1, blockHash: 'aa'.repeat(32) },
        evidence: metadataRowEvidence(fresh.f.scope),
        ledger,
        decisions: {},
        config: ledger.config,
        reserve: ledger.reserve,
        opsCarryProvenance: {}
      })
      // Raw rule: excluded from the monetary working set — no money moved and
      // the row is never named as an unmatched booking.
      expect(manifest.after.receiptsPiconeros).toBe(baseManifest.after.receiptsPiconeros)
      expect(manifest.issues.some(issue => String(issue.id) === '108')).toBe(false)
      // ...while the complete snapshot retains and fingerprints the row.
      expect(ledger.receipts.some(row => row.id === 108n)).toBe(true)
      expect(ledger.accountingFingerprint).not.toBe(baseLedger.accountingFingerprint)
    }
  })

  test('a scope that is not the registered platform_rewards wallet is refused', async () => {
    const { f, models } = freshRepairFixture()
    await expect(readRepairLedger(models, {
      network: f.scope.network,
      walletAddress: f.scope.walletAddress + 'x'
    })).rejects.toThrow(/registered platform_rewards/)
  })

  test('the precondition fingerprint covers the v2 snapshot groups and the reserve', () => {
    const base = () => {
      const f = auditLedgerFixture()
      return { ledger: preconditionLedger(f), config: f.config }
    }
    const baseFingerprint = () => {
      const { ledger, config } = base()
      return ledgerPreconditionFingerprint(ledger, config)
    }
    const fingerprint = fn => {
      const { ledger, config } = base()
      fn(ledger)
      return ledgerPreconditionFingerprint(ledger, config)
    }
    const reference = baseFingerprint()
    expect(reference).toMatch(/^[0-9a-f]{64}$/)

    // Reordering every input list cannot change the fingerprint.
    const { ledger: reordered, config } = base()
    for (const group of Object.keys(reordered)) {
      if (Array.isArray(reordered[group])) reordered[group] = [...reordered[group]].reverse()
    }
    expect(ledgerPreconditionFingerprint(reordered, config)).toBe(reference)

    // Each v2-only group is covered: escrow facts, proof inventory, identity
    // rows, subaddress states and the audited reserve inputs.
    expect(fingerprint(l => { l.escrowTransactions[0].state = 'CONFIRMED' })).not.toBe(reference)
    expect(fingerprint(l => { l.proofInventory[0].proof.revision = 2 })).not.toBe(reference)
    expect(fingerprint(l => { l.proofInventory[1].proof = null })).not.toBe(reference)
    expect(fingerprint(l => { l.accounts[0].address = '5DIFFERENT' })).not.toBe(reference)
    expect(fingerprint(l => { l.subaddresses[0].state = 'ASSIGNED' })).not.toBe(reference)
    expect(fingerprint(l => { l.reserve.feeHeadroomPiconeros = '1000000001' })).not.toBe(reference)
    // ...and the previously covered groups stay covered.
    expect(fingerprint(l => { l.receipts[0].piconeros = 701n })).not.toBe(reference)
    expect(fingerprint(l => { l.earns[0].piconeros = 251n })).not.toBe(reference)
  })

  test('a fresh precondition read without a current v2 identity is refused', () => {
    const f = auditLedgerFixture()
    const legacy = {
      ...preconditionLedger(f),
      config: f.config
      // no accountingFingerprint / accountingFingerprintVersion: a legacy-shaped
      // read that did not go through the shared v2 snapshot.
    }
    const approved = {
      scope: f.scope,
      boundary: { height: 1, blockHash: 'aa'.repeat(32) },
      evidenceDigest: 'bb'.repeat(32),
      ledgerFingerprint: 'cc'.repeat(32),
      protectedRewardsFingerprint: 'dd'.repeat(32),
      preconditionFingerprint: 'ee'.repeat(32),
      issues: [],
      operations: []
    }
    const evidence = {
      scope: f.scope,
      boundary: { height: 1, blockHash: 'aa'.repeat(32) }
    }
    expect(() => assertRepairPreconditions(approved, legacy, evidence))
      .toThrow(/current v2 accounting snapshot/)
  })
})

describe('v2 evidence authorization (pure)', () => {
  test('payment verifications authorize repair only under the v2 evidence contract', () => {
    const input = approve()
    input.evidence.paymentVerifications = [{ fabricated: true, status: 'complete' }]
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('EVIDENCE_VERSION_UNSUPPORTED')
    expect(manifest.operations.filter(op => op.after?.state === 'RELAYED')).toEqual([])
  })

  test('a v2 evidence collection indexes its verifications; garbage is named, never honored', () => {
    const input = approve()
    input.evidence.evidenceVersion = 2
    input.evidence.collectionStartedAt = FI.DATE.INCOMING
    input.evidence.observedAt = FI.DATE.INCOMING
    input.evidence.paymentVerifications = [{ fabricated: true, status: 'complete' }]
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('PAYMENT_VERIFICATION_INVALID')
    expect(codesOf(manifest)).not.toContain('EVIDENCE_VERSION_UNSUPPORTED')
    expect(manifest.operations.filter(op => op.after?.state === 'RELAYED')).toEqual([])
  })

  test('the pre-proof-era synthetic story never promotes a relay on its own', () => {
    const manifest = buildRewardsReconciliation(approve())
    // Strict recorded-outflow coverage names the story's journal-only payout
    // batch and history-only escrow legs (final-review I1); it never
    // fabricates a promotion or a complete proof for them.
    expect(codesOf(manifest)).toEqual(STORY_CODES)
    expect(manifest.operations.some(op => op.relayProof !== undefined)).toBe(false)
    expect(manifest.operations.filter(op => op.after?.state === 'RELAYED')).toEqual([])
  })

  test('without the mempool bridge evidence the synthetic attempt stays unresolved', () => {
    const input = approve()
    input.evidence.bridge.pendingOutgoing = []
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('PENDING_ATTEMPT_UNRESOLVED')
    expect(manifest.operations.filter(op => op.after?.state === 'RELAYED')).toEqual([])
  })
})

// =============================================================================
// Reverse recorded-outflow coverage (rewards reconciliation Task 4): every
// recorded payout/sweep/escrow leg is proved row-first against journal +
// chain evidence or a complete verification — independent of any drift
// computation (no aggregate-drift guard). Journal-less historical inserts are
// the legacy complete-surviving-evidence backfill only; destination-only or
// tx-hash-only inputs insert nothing.
// =============================================================================

const OUTFLOW_HASH = 'dd'.repeat(32)
const OUTFLOW_INCOMING_HASH = 'de'.repeat(32)

// A journal-less legacy payout candidate: the recorded payout row carries the
// hash, no journal row and no verification exist.
function withMissingHistoryPayout (input, { withOutgoing = false } = {}) {
  const out = structuredClone(input)
  out.ledger.payouts.push({
    id: 77,
    distributionId: 1,
    curatorId: 77,
    recipientAddress: FI.ADDRESS.CURATOR_ONE,
    piconeros: 7n,
    txHash: OUTFLOW_HASH,
    state: 'CONFIRMED'
  })
  if (withOutgoing) {
    out.evidence.outgoing.push({
      txHash: OUTFLOW_HASH,
      accountIndex: 0,
      feePiconeros: '1',
      destinations: [{ address: FI.ADDRESS.CURATOR_ONE, amountPiconeros: '7' }],
      height: FI.HEIGHT.PAYOUT,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    })
  }
  return out
}

// Equal-and-opposite errors at net zero: an unbooked +7 wallet inflow against
// an unrecorded -7 payout whose delivery AND fee are entirely unprovable.
const withMissingHistoryStory = input => {
  const out = withMissingHistoryPayout(input)
  out.evidence.incoming.push({
    txHash: OUTFLOW_INCOMING_HASH,
    accountIndex: 0,
    subaddressIndex: 0,
    amountPiconeros: '7',
    height: 2999950,
    inTxPool: false,
    isConfirmed: true,
    fromOwnTransaction: false,
    isSelfTransfer: false
  })
  return out
}

const withNetDrift = (drift, mutate = input => input) => {
  const input = mutate(withApprovedIncomingClassification(syntheticRewardsEvidence()))
  const probe = buildRewardsReconciliation(input)
  const current = BigInt(probe.after.differencePiconeros)
  // difference = ledgerBalance - walletTotal: realize `drift` exactly.
  const total = (BigInt(input.evidence.balances.totalPiconeros) + current - BigInt(drift)).toString()
  input.evidence.balances.totalPiconeros = total
  input.evidence.balances.accounts = { 0: total }
  return input
}

describe('reverse recorded-outflow coverage through the manifest (Task 4)', () => {
  // Final-review I1: the synthetic story's journal-only payout batch and
  // history-only escrow legs are individually named through the manifest —
  // never silently covered by relay history.
  test('the synthetic story names every journal-only payout and history-only escrow leg', () => {
    const manifest = buildRewardsReconciliation(approve())
    expect(manifest.issues).toEqual([
      expect.objectContaining({
        code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
        table: 'BountyPayment',
        id: '21',
        leg: 'PRINCIPAL',
        txHash: FI.TX.AWARD
      }),
      expect.objectContaining({
        code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
        table: 'BountyPayment',
        id: '22',
        leg: 'PRINCIPAL',
        txHash: FI.TX.ROLLOVER
      }),
      expect.objectContaining({
        code: 'RECORDED_PAYOUT_PROOF_UNSUPPORTED',
        table: 'RewardPayout',
        id: '11',
        txHash: FI.TX.PAYOUT
      }),
      expect.objectContaining({
        code: 'RECORDED_PAYOUT_PROOF_UNSUPPORTED',
        table: 'RewardPayout',
        id: '12',
        txHash: FI.TX.PAYOUT
      })
    ])
    // The recorded debits and reward contracts survive the naming untouched.
    expect(manifest.before.totalSentPiconeros).toBe(manifest.after.totalSentPiconeros)
    expect(manifest.operations.some(op => op.table === 'RewardPayout' || op.table === 'Earn')).toBe(false)
  })

  // All three drift cases through ACTUAL manifest issues: the reverse checks
  // never gate on drift.
  test.each(['0', '-7', '7'])('recorded missing history stays an issue at net drift %s', drift => {
    const input = withNetDrift(drift, withMissingHistoryStory)
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.after.differencePiconeros).toBe(drift)
    expect(manifest.issues).toContainEqual(expect.objectContaining({
      code: 'RECORDED_PAYOUT_EVIDENCE_MISSING',
      table: 'RewardPayout',
      id: '77',
      txHash: OUTFLOW_HASH
    }))
    expect(codesOf(manifest)).toContain('UNKNOWN_INCOMING')
    // The recorded delivery survives: the paid ledger debit is unchanged.
    expect(manifest.before.totalSentPiconeros).toBe(manifest.after.totalSentPiconeros)
    // Reward contracts are never touched by the coverage pass.
    expect(manifest.operations.some(op => op.table === 'RewardPayout' || op.table === 'Earn')).toBe(false)
  })

  test('a destination-only recorded payout proof inserts nothing', () => {
    const input = withMissingHistoryPayout(approve(), { withOutgoing: true })
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.issues).toContainEqual(expect.objectContaining({
      code: 'RECORDED_PAYOUT_EVIDENCE_MISSING',
      id: '77'
    }))
    expect(manifest.operations.filter(op => op.txHash === OUTFLOW_HASH)).toEqual([])
  })

  // Plan Task 4 Step 4: a MISSING fee is a named issue even while the net
  // drift is zero — the balance offset never absorbs a fee-specific gap.
  test('a missing fee stays named while the net drift is zero', () => {
    const input = withNetDrift('0', base => {
      const out = structuredClone(base)
      // The payout journal's relayed fee and the wallet-history fee are both
      // unreadable: the fee is unprovable from any evidence.
      const journal = out.ledger.transactions.find(entry => entry.txHash === FI.TX.PAYOUT)
      journal.networkFeePiconeros = null
      const outgoing = out.evidence.outgoing.find(entry => entry.txHash === FI.TX.PAYOUT)
      outgoing.feePiconeros = null
      return out
    })
    const manifest = buildRewardsReconciliation(input)
    expect(manifest.after.differencePiconeros).toBe('0')
    expect(codesOf(manifest)).toContain('MISSING_OUTGOING_FEE')
  })

  test('an unresolved legacy verification keeps the recorded debit and inserts nothing', async () => {
    const base = await legacyRepairFixture()
    const unresolved = await (async () => {
      const chain = paymentChainFixture()
      const hash = verifiedFixtureIds.LEGACY_HASH
      return verifyLegacyPaymentTransaction({
        contract: {
          scope: verifiedFixtureIds.SCOPE,
          txHash: hash,
          journalRole: 'REWARDS',
          journalId: null,
          owner: { kind: 'PAYOUT', distributionId: '1', bountyPaymentId: null, itemId: null },
          members: [
            { id: '11', leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_A, type: 'PRIMARY', paymentId: null, grossPiconeros: '40', actualPiconeros: '40' },
            { id: '12', leg: 'PRINCIPAL', address: verifiedFixtureIds.ADDRESS_B, type: 'SUBADDRESS', paymentId: null, grossPiconeros: '20', actualPiconeros: '20' }
          ],
          recordedFeePiconeros: null
        },
        session: {
          ...chain.session,
          rawByHash: { ...chain.session.rawByHash, [hash]: { ...chain.session.rawByHash[chain.txHash], txHash: hash } },
          ownershipFor: candidate => (candidate === hash
            ? { owned: chain.session.ownedOutputs, inputSources: chain.session.ownershipFor(chain.txHash).inputSources }
            : { owned: [], inputSources: [] })
        },
        observedAt: VERIFIED_OBSERVED_AT,
        survivingProofProvider: null
      })
    })()
    expect(unresolved.status).toBe('unresolved')
    const input = base.input
    input.evidence.paymentVerifications = [unresolved]
    input.ledger.transactions = []
    input.ledger.payouts = [
      { id: 11, distributionId: 1, curatorId: 11, recipientAddress: verifiedFixtureIds.ADDRESS_A, piconeros: 40n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'SENT' },
      { id: 12, distributionId: 1, curatorId: 12, recipientAddress: verifiedFixtureIds.ADDRESS_B, piconeros: 20n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'CONFIRMED' }
    ]
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('RECORDED_PAYOUT_PROOF_UNSUPPORTED')
    expect(manifest.operations.filter(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction')).toEqual([])
    // Missing proof key: the paid ledger debit is unchanged.
    expect(manifest.before.totalSentPiconeros).toBe(manifest.after.totalSentPiconeros)
  })
})

// A complete LEGACY_SURVIVING_PROOF verification whose proved membership is
// authoritatively frozen (single sweep leg to COLD). Safe result shape only.
function completeSweepVerification ({ hash, scope, amount = '500', fee = '7', owned = '15' } = {}) {
  const decoded = decodeReceivingIdentity(verifiedFixtureIds.COLD, scope.network)
  return {
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...scope },
    journalRole: 'REWARDS',
    journalId: null,
    dispatchId: null,
    captureMode: 'LEGACY_SURVIVING_PROOF',
    txHash: hash,
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: ['0'],
    members: [{
      id: '1',
      leg: 'PRINCIPAL',
      address: verifiedFixtureIds.COLD,
      type: decoded.type,
      paymentId: null,
      receivingIdentity: decoded.identity,
      grossPiconeros: amount,
      actualPiconeros: amount
    }],
    receivingAggregates: [{ receivingIdentity: decoded.identity, amountPiconeros: amount, confirmations: 10 }],
    ownedAccounting: {
      totalPiconeros: owned,
      outputs: [{ outputIndex: 0, accountIndex: 0, subaddressIndex: 0, amountPiconeros: owned, isSpent: false }]
    },
    totals: {
      D: (BigInt(owned) + BigInt(fee) + BigInt(amount)).toString(),
      O: owned,
      F: fee,
      E: amount,
      residual: '0'
    },
    confirmation: { height: 2999990, blockHash: 'cd'.repeat(32), confirmations: 10 },
    observedAt: VERIFIED_OBSERVED_AT,
    boundary: { height: 2999999, blockHash: 'cd'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'ce'.repeat(32)
  }
}

// A complete LEGACY_SURVIVING_PROOF ESCROW verification (collected by #1 from
// the escrow wallet, keyed on the bounty settlement leg hash). Safe result
// shape only; the fixture addresses are opaque strings, never decoded here.
// `id` is the canonical escrow member id — the bounty payment id.
function completeEscrowVerification ({ hash, scope, address, amount = '139', fee = '1', owned = '1', id = '1' } = {}) {
  const total = (BigInt(owned) + BigInt(fee) + BigInt(amount)).toString()
  return {
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...scope },
    journalRole: 'ESCROW',
    journalId: null,
    dispatchId: null,
    captureMode: 'LEGACY_SURVIVING_PROOF',
    txHash: hash,
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: ['0'],
    members: [{
      id,
      leg: 'PRINCIPAL',
      address,
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: 'escrow-recipient-identity',
      grossPiconeros: amount,
      actualPiconeros: amount
    }],
    receivingAggregates: [{ receivingIdentity: 'escrow-recipient-identity', amountPiconeros: amount, confirmations: 10 }],
    ownedAccounting: {
      totalPiconeros: owned,
      outputs: [{ outputIndex: 0, accountIndex: 0, subaddressIndex: 0, amountPiconeros: owned, isSpent: false }]
    },
    totals: { D: total, O: owned, F: fee, E: amount, residual: '0' },
    confirmation: { height: 2999990, blockHash: 'cd'.repeat(32), confirmations: 10 },
    observedAt: VERIFIED_OBSERVED_AT,
    boundary: { height: 2999999, blockHash: 'cd'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'cf'.repeat(32)
  }
}

describe('escrow recorded-source coherence through the builder (fix round 4)', () => {
  // Safe complete-result doubles pin attribution, not real proof availability.
  // Claims use the real codec/digest and synthetic checksum-valid addresses.
  const fixture = ({ combined = false, owner = '701' } = {}) => {
    const input = approve()
    const base = paymentFixture()
    const members = combined
      ? base.members.map((member, index) => ({ ...member, id: owner, leg: index === 0 ? 'PRINCIPAL' : 'FEE', actualPiconeros: index === 0 ? '40' : '13' }))
      : [{ ...base.members[0], id: owner, leg: 'PRINCIPAL', grossPiconeros: '47', actualPiconeros: '40' }]
    const claims = normalizePaymentClaims(paymentFixture({
      journalRole: 'ESCROW',
      kind: 'AWARD',
      distributionId: null,
      bountyPaymentId: owner,
      itemId: '301',
      members,
      principalPiconeros: combined ? '60' : '47',
      feeSubtractedFromLast: true,
      frozenTerms: {
        recipientAddress: members[0].address,
        prizePiconeros: combined ? '40' : '47',
        feePiconeros: combined ? '20' : '0',
        feeRecipientAddress: combined ? base.members[1].address : null
      }
    }))
    const payment = {
      ...auditLedgerFixture().ledger.bountyPayments[0],
      id: 701,
      itemId: 301,
      kind: 'AWARD',
      state: 'CONFIRMED',
      txHash: claims.txHash,
      feeTxHash: null,
      recipientAddress: claims.frozenTerms.recipientAddress,
      feeRecipientAddress: base.members[1].address,
      piconeros: combined ? 40n : 47n,
      feePiconeros: combined ? 20n : 0n,
      recipientReceivedPiconeros: 40n,
      feeReceivedPiconeros: combined ? 13n : null,
      networkFeePiconeros: 7n
    }
    const journal = {
      ...auditLedgerFixture().ledger.escrowTransactions[0],
      id: 601,
      bountyPaymentId: 701,
      itemId: 301,
      kind: 'AWARD',
      leg: 'DISPOSITION',
      network: claims.scope.network,
      walletAddress: claims.scope.walletAddress,
      txHash: claims.txHash,
      state: 'RELAYED',
      paymentClaims: claims,
      claimDigest: paymentClaimDigest(claims)
    }
    const verification = completeEscrowVerification({
      hash: claims.txHash,
      scope: claims.scope,
      address: payment.recipientAddress,
      amount: '40',
      fee: '7',
      id: owner
    })
    verification.journalId = '601'
    verification.members = claims.members.map(member => ({ ...member }))
    verification.receivingAggregates = claims.receivingAggregates.map(aggregate => ({ ...aggregate, confirmations: 10 }))
    verification.totals.E = claims.members.reduce((sum, member) => sum + BigInt(member.actualPiconeros), 0n).toString()
    verification.totals.D = (BigInt(verification.totals.E) + 8n).toString()
    expect(validatePaymentVerification(verification)).toBe(true)
    input.ledger.bountyPayments = [payment]
    input.ledger.escrowTransactions = [journal]
    input.evidence.evidenceVersion = 2
    input.evidence.escrow = { walletAddress: claims.scope.walletAddress, outgoing: [], paymentVerifications: [verification] }
    return { input, payment, journal, verification }
  }
  const issues = input => buildRewardsReconciliation(input).issues.filter(issue => issue.table === 'BountyPayment' && String(issue.id) === '701')

  test.each(['601', '999999'])('C1: a contradictory recorded journal owner cannot become journal-less (proof journal %s)', journalId => {
    const { input, journal, verification } = fixture()
    journal.bountyPaymentId = 999
    verification.journalId = journalId
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      leg: 'PRINCIPAL',
      reason: 'the verification does not bind the recorded escrow journal owner'
    })]))
  })

  test('C2: digest-valid claims must belong to the recorded journal/payment', () => {
    const { input } = fixture({ owner: '999' })
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      leg: 'PRINCIPAL',
      reason: 'the recorded escrow claims do not bind the recorded journal and payment owner'
    })]))
  })

  test('C3: captured zero-fee terms never hide a recorded fee receipt', () => {
    const { input, payment } = fixture()
    payment.feeReceivedPiconeros = 100n
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      leg: 'PRINCIPAL',
      entry: `FEE:${payment.feeRecipientAddress}:100`
    })]))
  })

  test.each([null, 'not-a-hash'])('B4: the recorded principal with hash %p remains named after normalization', txHash => {
    const { input, payment } = fixture()
    payment.txHash = txHash
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING', leg: 'PRINCIPAL'
    })]))
  })

  test('B5: captured receipt 40 cannot replace recorded settlement 100', () => {
    const { input, payment } = fixture()
    payment.recipientReceivedPiconeros = 100n
    expect(issues(input)).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      leg: 'PRINCIPAL',
      entry: `PRINCIPAL:${payment.recipientAddress}:100`
    })]))
  })

  test('honest combined disposition satisfies both claims and recorded receipts', () => {
    const { input } = fixture({ combined: true })
    expect(issues(input)).toEqual([])
  })

  test('captured combined membership still covers genuinely unrecovered receipts', () => {
    const { input, payment } = fixture({ combined: true })
    payment.recipientReceivedPiconeros = null
    payment.feeReceivedPiconeros = null
    expect(issues(input)).toEqual([])
  })

  test('only an absent journal uses journal-less recorded settlement attribution', () => {
    const { input, verification } = fixture()
    input.ledger.escrowTransactions = []
    verification.journalId = null
    expect(issues(input)).toEqual([])
  })
})

describe('legacy complete-payment backfill (Task 4)', () => {
  // The journal-less legacy payout candidate from the Task 3 fixture: real
  // verifier over the fake chain with an in-memory surviving key provider —
  // no proof-store row exists or is created anywhere.
  const legacyBackfillInput = async () => {
    const base = await legacyRepairFixture()
    const verification = base.verification
    expect(verification.status).toBe('complete')
    expect(verification.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    const input = base.input
    input.ledger.transactions = []
    input.ledger.payouts = [
      { id: 11, distributionId: 1, curatorId: 11, recipientAddress: verifiedFixtureIds.ADDRESS_A, piconeros: 40n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'SENT' },
      { id: 12, distributionId: 1, curatorId: 12, recipientAddress: verifiedFixtureIds.ADDRESS_B, piconeros: 20n, txHash: verifiedFixtureIds.LEGACY_HASH, state: 'CONFIRMED' }
    ]
    return { input, verification }
  }

  test('a proved journal-less legacy payout backfills one closed legacy journal row', async () => {
    const { input, verification } = await legacyBackfillInput()
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toEqual([])
    const inserts = manifest.operations.filter(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction')
    expect(inserts).toHaveLength(1)
    const insert = inserts[0]
    expect(insert.reason).toBe('legacy-complete-payment-backfill')
    expect(insert.before).toBeNull()
    expect(insert.key).toEqual({
      network: input.scope.network,
      walletAddress: input.scope.walletAddress,
      txHash: verifiedFixtureIds.LEGACY_HASH
    })
    expect(insert.after).toMatchObject({
      network: input.scope.network,
      walletAddress: input.scope.walletAddress,
      txHash: verifiedFixtureIds.LEGACY_HASH,
      kind: 'PAYOUT',
      state: 'RELAYED',
      accountIndex: 0,
      distributionId: 1,
      principalPiconeros: '60',
      networkFeePiconeros: String(verification.totals.F),
      relayAttemptedAt: null,
      relayedAt: VERIFIED_OBSERVED_AT,
      relayProvenance: 'legacy-complete-payment-backfill',
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    })
    expect(insert.after.metadata).toEqual({
      payouts: [
        { payoutId: 11, recipientAddress: verifiedFixtureIds.ADDRESS_A, piconeros: '40' },
        { payoutId: 12, recipientAddress: verifiedFixtureIds.ADDRESS_B, piconeros: '20' }
      ]
    })
    // The insert carries the same closed v2 relayProof: legacy surviving
    // capture, null journal/dispatch/claim/proof inventory, exact surviving
    // evidence digest — and no proof-store row reference anywhere.
    expect(Object.keys(insert.relayProof).sort()).toEqual(RELAY_PROOF_FIELDS)
    expect(insert.relayProof).toMatchObject({
      version: 2,
      evidenceDigest: manifest.evidenceDigest,
      journalRole: 'REWARDS',
      journalId: null,
      dispatchId: null,
      captureMode: 'LEGACY_SURVIVING_PROOF',
      txHash: verifiedFixtureIds.LEGACY_HASH,
      claimDigest: null,
      proofInventory: null,
      survivingEvidenceDigest: verification.survivingEvidenceDigest,
      observedAt: VERIFIED_OBSERVED_AT
    })
    expect(insert.relayProof.totals).toEqual(verification.totals)
    // The backfilled fact resolves the recorded payouts in the after-ledger.
    expect(manifest.after.totalNetworkFeesPiconeros).toBe(String(verification.totals.F))
  })

  test('a proved journal-less recorded sweep backfills its journal row without naming a coverage gap', () => {
    const hash = 'df'.repeat(32)
    const cold = verifiedFixtureIds.COLD
    const input = approve()
    input.ledger.distributions[0].opsSweepTxHash = hash
    input.ledger.distributions[0].opsSweptPiconeros = 500n
    input.evidence.outgoing.push({
      txHash: hash,
      accountIndex: 0,
      feePiconeros: '7',
      destinations: [{ address: cold, amountPiconeros: '500' }],
      height: FI.HEIGHT.SWEEP,
      inTxPool: false,
      isConfirmed: true,
      isRelayed: true,
      isSelfTransfer: false,
      relayState: 'confirmed'
    })
    input.evidence.paymentVerifications = [completeSweepVerification({ hash, scope: input.scope })]
    input.evidence.evidenceVersion = 2
    input.evidence.collectionStartedAt = FI.DATE.INCOMING
    input.evidence.observedAt = FI.DATE.INCOMING
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).not.toContain('RECORDED_SWEEP_EVIDENCE_MISSING')
    expect(codesOf(manifest)).not.toContain('RECORDED_SWEEP_PRINCIPAL_UNPROVEN')
    const inserts = manifest.operations.filter(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].after).toMatchObject({
      kind: 'OPS_SWEEP',
      state: 'RELAYED',
      distributionId: 1,
      principalPiconeros: '500',
      networkFeePiconeros: '7',
      metadata: { destination: cold },
      relayedAt: VERIFIED_OBSERVED_AT,
      relayProvenance: 'legacy-complete-payment-backfill',
      dispatchId: null,
      proofId: null
    })
    expect(inserts[0].relayProof.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    expect(Object.keys(inserts[0].relayProof).sort()).toEqual(RELAY_PROOF_FIELDS)
  })

  test('an unsupported owned internal target is named and never inserted', async () => {
    const { input } = await legacyBackfillInput()
    const verification = {
      ...input.evidence.paymentVerifications[0],
      status: 'unsupported',
      issues: ['OWNED_CHANGE_SPLIT_UNSUPPORTED'],
      survivingEvidenceDigest: null
    }
    input.evidence.paymentVerifications = [verification]
    const manifest = buildRewardsReconciliation(input)
    expect(codesOf(manifest)).toContain('RECORDED_PAYOUT_PROOF_UNSUPPORTED')
    expect(manifest.operations.filter(op => op.kind === 'insert' && op.table === 'RewardsWalletTransaction')).toEqual([])
  })

  test('collected ESCROW verifications cover a settlement leg missing from escrow history', () => {
    const input = approve()
    const escrowScope = { network: input.scope.network, walletAddress: FI.ADDRESS.ESCROW }
    // The rollover payment's prize leg is absent from the escrow history.
    input.evidence.escrow.outgoing = input.evidence.escrow.outgoing.filter(entry => entry.txHash !== FI.TX.ROLLOVER)
    const missing = buildRewardsReconciliation(input)
    expect(codesOf(missing)).toContain('RECORDED_ESCROW_LEG_EVIDENCE_MISSING')

    // The collector's own ESCROW verifications cover EVERY leg through the
    // manifest flow: normalization projects them, and the reverse check binds
    // them instead of naming the legs (final-review I1: complete verifications
    // are the only escrow-leg coverage).
    input.evidence.evidenceVersion = 2
    input.evidence.escrow.paymentVerifications = [
      completeEscrowVerification({
        hash: FI.TX.ROLLOVER,
        scope: escrowScope,
        address: FI.ADDRESS.WALLET,
        id: '22'
      }),
      completeEscrowVerification({
        hash: FI.TX.AWARD,
        scope: escrowScope,
        address: FI.ADDRESS.CURATOR_ONE,
        amount: '100',
        id: '21'
      })
    ]
    const covered = buildRewardsReconciliation(input)
    expect(codesOf(covered)).not.toContain('RECORDED_ESCROW_LEG_EVIDENCE_MISSING')
    // Final-review I1 rounds 2-3: a validator-valid complete verification
    // paying a DIFFERENT recipient (whatever its member id) does not carry the
    // recorded leg member — the leg stays named through the manifest flow.
    const wrongRecipient = structuredClone(input)
    wrongRecipient.evidence.escrow.paymentVerifications = [
      completeEscrowVerification({
        hash: FI.TX.AWARD,
        scope: escrowScope,
        address: FI.ADDRESS.CURATOR_TWO,
        amount: '1',
        id: '21'
      }),
      completeEscrowVerification({
        hash: FI.TX.ROLLOVER,
        scope: escrowScope,
        address: FI.ADDRESS.WALLET,
        id: '22'
      })
    ]
    const wrongCodes = codesOf(buildRewardsReconciliation(wrongRecipient))
    expect(wrongCodes).toContain('RECORDED_ESCROW_LEG_MEMBER_MISMATCH')
    expect(wrongCodes).not.toContain('RECORDED_ESCROW_LEG_EVIDENCE_MISSING')
    // The v1-shaped same evidence (no version marker) keeps building as a
    // historical artifact: collected verifications never authorize repair.
    const historical = structuredClone(input)
    historical.evidence.evidenceVersion = 1
    expect(codesOf(buildRewardsReconciliation(historical))).toContain('RECORDED_ESCROW_LEG_EVIDENCE_MISSING')
  })
})

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

;(ISOLATED_DB ? describe : describe.skip)('v2 evidence-bound promotion (isolated DB only)', () => {
  afterAll(async () => {
    await closeVerifiedRepairFixtures()
  })

  test('the verified collection promotes the attempted PREPARED row exactly once', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const manifest = buildRewardsReconciliation(f.input)
    const promotions = manifest.operations.filter(op => op.after?.state === 'RELAYED')
    expect(promotions).toHaveLength(1)
    expect(codesOf(manifest)).toEqual([])
    expect(promotions[0].after.relayedAt).toBe('2026-10-06T12:00:00.000Z')
    expect(promotions[0].after.relayProvenance).toBe('chain-proof-observation')
    expect(promotions[0].relayProof.version).toBe(2)
    expect(f.input.ledger.transactions[0].state).toBe('PREPARED')
  })

  test('the v2 precondition comparator accepts the approved snapshot and refuses any change', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const manifest = buildRewardsReconciliation(f.input)
    const ledger = {
      ...f.input.ledger,
      accountingFingerprint: manifest.ledgerFingerprint,
      accountingFingerprintVersion: 2
    }
    expect(assertRepairPreconditions(manifest, ledger, f.approvedEvidence)).toBe(true)

    // Any post-approval ledger change refuses the apply: the fine-grained
    // precondition view names ledger/term/config changes...
    const changed = { ...ledger, transactions: [...ledger.transactions] }
    changed.transactions[0] = { ...changed.transactions[0], networkFeePiconeros: 9n }
    expect(() => assertRepairPreconditions(manifest, changed, f.approvedEvidence))
      .toThrow(/approved ledger, item terms or fee config changed/)

    // ...and the shared v2 audit identity is the catch-all for snapshot facts
    // outside that view (distribution status/payoutCount/opsSweepState).
    const sweepState = { ...ledger, distributions: [{ ...ledger.distributions[0], opsSweepState: 'SWEPT' }] }
    expect(() => assertRepairPreconditions(manifest, sweepState, f.approvedEvidence))
      .toThrow(/scoped ledger changed/)

    // The approved evidence digest binds the collection (observation included).
    const tamperedEvidence = { ...f.approvedEvidence, observedAt: '2026-10-06T12:00:01.000Z' }
    expect(() => assertRepairPreconditions(manifest, ledger, tamperedEvidence))
      .toThrow(/approved evidence digest/)
  })
})
