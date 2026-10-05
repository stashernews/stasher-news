/* eslint-env jest */
import { buildRewardsReconciliation, manifestDigest, rebuildOpsSnapshots } from '@/api/monero/rewardsReconciliation'
import { summarizeRewardsLedger } from '@/api/monero/rewardsLedger'
import { opsCarry } from '@/lib/rewardsAccounting'
import {
  FI,
  approvedIncomingClassification,
  syntheticRewardsEvidence,
  withApprovedIncomingClassification,
  withMigrationClassifiedFunding
} from '../../fixtures/rewards-accounting-evidence'

// Synthetic manifest tests (rewards accounting repair §8, Task 12). Pure: no
// DB, no wallet, no daemon. The fixture's exact money story is documented in
// test/fixtures/rewards-accounting-evidence.js.

const clone = value => structuredClone(value)
const codesOf = manifest => manifest.issues.map(issue => issue.code)
const approve = () => withApprovedIncomingClassification(syntheticRewardsEvidence())

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
    expect(codesOf(manifest)).toEqual([])
    expect(manifest.version).toBe(1)
    expect(manifest.scope).toEqual(FI.SCOPE)
    expect(manifest.boundary).toEqual(FI.BOUNDARY)
    expect(manifest.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.ledgerFingerprint).toMatch(/^[0-9a-f]{64}$/)
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
    expect(codesOf(manifest)).toEqual([])
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
    expect(codesOf(regenerated)).toEqual([])
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
    expect(codesOf(manifest)).toEqual([])
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
    expect(codesOf(buildRewardsReconciliation(proven))).toEqual([])
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
    expect(manifest.ledgerFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('inbound/receipt anomalies', () => {
  test('an unmatched booked receipt blocks the manifest', () => {
    const input = approve()
    input.ledger.receipts.push({
      id: 4,
      txHash: 'e8'.repeat(32),
      feeType: 'POSTING',
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
    expect(codesOf(manifest)).toEqual([])
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
    expect(codesOf(manifest)).toEqual([])
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
    expect(codesOf(manifest)).toEqual([])
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
    expect(codesOf(manifest)).toEqual([])
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
      { id: 7, txHash: hash, piconeros: 7n, state: 'CONFIRMED', height: 2999900, confirmedAt: new Date(FI.DATE.INCOMING) },
      { id: 8, txHash: hash, piconeros: 7n, state: 'CONFIRMED', height: 2999900, confirmedAt: new Date(FI.DATE.INCOMING) }
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

  test('the manifest ledger fingerprint matches the shared ledger contract', () => {
    const input = withApprovedIncomingClassification(syntheticRewardsEvidence())
    const manifest = buildRewardsReconciliation(input)
    const raw = syntheticRewardsEvidence()
    const expected = summarizeRewardsLedger({
      payouts: raw.ledger.payouts,
      distributions: raw.ledger.distributions,
      transactions: raw.ledger.transactions,
      scope: raw.scope
    })
    expect(manifest.ledgerFingerprint).toBe(expected.fingerprint)
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
