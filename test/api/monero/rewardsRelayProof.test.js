/* eslint-env jest */
import { buildRewardsReconciliation } from '@/api/monero/rewardsReconciliation'
import {
  assertCompatiblePaymentReverification,
  buildJournalRelayOperation,
  validateJournalRelayProof
} from '@/api/monero/rewardsRelayProof'
import {
  RELAY_PROOF_FIELDS,
  VERIFIED_ATTEMPTED_AT,
  VERIFIED_COLLECTION_STARTED_AT,
  VERIFIED_OBSERVED_AT,
  VERIFIED_PREPARED_AT,
  closeVerifiedRepairFixtures,
  legacyRepairFixture,
  verifiedFixtureIds,
  verifiedRepairFixture
} from '@/test/fixtures/rewards-payment-verification'

// Deterministic confirmed attempted-PREPARED transition tests (rewards
// reconciliation plan, Task 3). The FIXTURE prepares a real #1 proof pair on
// the dedicated isolated database and verifies it with the REAL verifier over
// a fake read-only chain session; every builder call is PURE (no DB, no
// wallet, no wall clock). Runs only when DATABASE_URL points at
// /stasher_rewards_repair_test; run ONLY via the guarded isolated runner.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const clone = value => structuredClone(value)
const codesOf = manifest => manifest.issues.map(issue => issue.code)
const promotionsOf = manifest => manifest.operations.filter(op => op.after?.state === 'RELAYED')

const isolated = ISOLATED_DB ? describe : describe.skip

isolated('evidence-bound relay promotion (isolated DB only)', () => {
  afterAll(async () => {
    await closeVerifiedRepairFixtures()
  })

  test.each(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])('%s has one observation-bound promotion', async kind => {
    const f = await verifiedRepairFixture({ kind })
    const original = clone(f.input)
    const manifest = buildRewardsReconciliation(f.input)
    const promotions = promotionsOf(manifest)
    expect(promotions).toHaveLength(1)
    expect(promotions[0].after.relayedAt).toBe('2026-10-06T12:00:00.000Z')
    expect(promotions[0].after.relayProvenance).toBe('chain-proof-observation')
    expect(promotions[0].relayProof.version).toBe(2)
    expect(f.input).toEqual(original)
    expect(codesOf(manifest)).toEqual([])
  })

  test('the promotion operation is the exact closed v2 shape bound to the approved evidence', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const manifest = buildRewardsReconciliation(f.input)
    const op = promotionsOf(manifest)[0]
    expect(op).toMatchObject({
      kind: 'update',
      table: 'RewardsWalletTransaction',
      txHash: f.input.ledger.transactions[0].txHash,
      network: f.input.scope.network,
      walletAddress: f.input.scope.walletAddress,
      before: { state: 'PREPARED', relayedAt: null, relayProvenance: null },
      after: { state: 'RELAYED', relayedAt: VERIFIED_OBSERVED_AT, relayProvenance: 'chain-proof-observation' },
      reason: 'confirmed-complete-payment'
    })
    expect(Object.keys(op.relayProof).sort()).toEqual(RELAY_PROOF_FIELDS)
    expect(op.relayProof.evidenceDigest).toBe(manifest.evidenceDigest)
    expect(op.relayProof.verificationVersion).toBe('1')
    expect(op.relayProof.verifierVersion).toBe('1')
    expect(op.relayProof.sdkVersion).toBe('0.11.12')
    expect(op.relayProof.provenance).toBe('restored-owned-outputs/raw-chain/check-tx-key')
    expect(op.relayProof.journalRole).toBe('REWARDS')
    expect(op.relayProof.journalId).toBe(String(f.journal.id))
    expect(op.relayProof.captureMode).toBe('CAPTURE_V1')
    expect(op.relayProof.survivingEvidenceDigest).toBeNull()
    expect(op.relayProof.observedAt).toBe(VERIFIED_OBSERVED_AT)
    // Confirmation is height + block hash ONLY — never an advancing count.
    expect(op.relayProof.confirmation).toEqual({ height: 2999980, blockHash: 'd4'.repeat(32) })
    expect(op.relayProof.receivingAggregates.every(aggregate => !('confirmations' in aggregate))).toBe(true)
    expect(op.relayProof.ownedAccounting.outputs.every(output => !('isSpent' in output))).toBe(true)
    // The proof carries no boundary or status/issue echo beyond the closed list.
    expect(op.relayProof).not.toHaveProperty('boundary')
    expect(op.relayProof).not.toHaveProperty('status')
    expect(op.relayProof).not.toHaveProperty('issues')
    // The evidence digest binds the normalized approved collection.
    expect(manifest.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    // The copied after-ledger carries the same resolved facts exactly once.
    const afterRow = manifest.after
    expect(afterRow.totalNetworkFeesPiconeros).toBe('7')
    expect(afterRow.totalSentPiconeros).toBe('60')
    expect(afterRow.outstandingRewardsPiconeros).toBe('0')
  })

  test('a repeated recipient is matched as a multiset and the principal counts once', async () => {
    // One curator's address is paid twice (payoutId 11 -> 40, payoutId 12 -> 20,
    // both curatorId 7): member identity is per payout row, never per address.
    const f = await verifiedRepairFixture({ kind: 'PAYOUT', repeatedRecipient: true })
    const original = clone(f.input)
    const manifest = buildRewardsReconciliation(f.input)
    expect(codesOf(manifest)).toEqual([])
    const promotions = promotionsOf(manifest)
    expect(promotions).toHaveLength(1)
    expect(promotions[0].after.relayedAt).toBe(VERIFIED_OBSERVED_AT)
    expect(promotions[0].after.relayProvenance).toBe('chain-proof-observation')
    expect(promotions[0].relayProof.version).toBe(2)
    // The proved members are the repeated-recipient multiset itself.
    expect(promotions[0].relayProof.members.map(member => member.actualPiconeros).sort())
      .toEqual(['20', '40'])
    expect(promotions[0].relayProof.members.every(member =>
      member.receivingIdentity === verifiedFixtureIds.IDENTITY_A)).toBe(true)
    // Exact after sums: 60 principal once (not 40), fee 7 once, no debt left.
    expect(manifest.after.totalSentPiconeros).toBe('60')
    expect(manifest.after.totalNetworkFeesPiconeros).toBe('7')
    expect(manifest.after.outstandingRewardsPiconeros).toBe('0')
    expect(f.input).toEqual(original)
  })

  test('OPS_SWEEP and CONSOLIDATION count their fee/principal exactly once', async () => {
    const sweep = buildRewardsReconciliation((await verifiedRepairFixture({ kind: 'OPS_SWEEP' })).input)
    expect(promotionsOf(sweep)).toHaveLength(1)
    expect(sweep.after.totalNetworkFeesPiconeros).toBe('9')
    expect(sweep.after.totalSentPiconeros).toBe('500')

    const consolidation = buildRewardsReconciliation((await verifiedRepairFixture({ kind: 'CONSOLIDATION' })).input)
    expect(promotionsOf(consolidation)).toHaveLength(1)
    expect(consolidation.after.totalNetworkFeesPiconeros).toBe('4')
    expect(consolidation.after.totalSentPiconeros).toBe('0')
  })

  test('reordered inputs and original date forms give the identical manifest without a wall clock', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const base = buildRewardsReconciliation(f.input)

    // Date.now mocked to throw: the builder must never read a wall clock.
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the builder must not read the wall clock')
    })
    const reordered = clone(f.input)
    // DB query-order artifacts: list order never changes the manifest.
    reordered.ledger.payouts.reverse()
    reordered.ledger.earns.reverse()
    reordered.evidence.outgoing.reverse()
    reordered.evidence.paymentVerifications.reverse()
    // Original (non-cloned) date inputs normalize to the same instants: the
    // audit projection treats a Date and its ISO string as the same fact.
    reordered.ledger.transactions[0].preparedAt = new Date(VERIFIED_PREPARED_AT).toISOString()
    reordered.ledger.transactions[0].relayAttemptedAt = new Date(VERIFIED_ATTEMPTED_AT)
    reordered.evidence.observedAt = new Date(VERIFIED_OBSERVED_AT).toISOString()
    const frozenManifest = buildRewardsReconciliation(Object.freeze(reordered))
    nowSpy.mockRestore()

    expect(frozenManifest.digest).toBe(base.digest)
    expect(frozenManifest.operations).toEqual(base.operations)
    expect(frozenManifest.issues).toEqual(base.issues)
  })

  test('a deeply frozen snapshot input builds the same manifest without mutation', async () => {
    const f = await verifiedRepairFixture({ kind: 'OPS_SWEEP' })
    const expected = buildRewardsReconciliation(f.input)
    const freeze = value => {
      if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) freeze(value[key])
        Object.freeze(value)
      }
      return value
    }
    const manifest = buildRewardsReconciliation(freeze(clone(f.input)))
    expect(manifest.digest).toBe(expected.digest)
    expect(promotionsOf(manifest)).toHaveLength(1)
  })

  test.each([
    ['unattempted', { attempted: false }],
    ['already RELAYED', { state: 'RELAYED' }],
    ['NOT_RELAYED', { state: 'NOT_RELAYED' }]
  ])('%s rows never promote', async (_label, options) => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT', ...options })
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(manifest.operations.filter(op => op.table === 'RewardsWalletTransaction')).toEqual([])
  })

  test('a pool-only attempt never promotes and stays an explicit bridge fact', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const outgoing = f.input.evidence.outgoing
    f.input.evidence.bridge.pendingOutgoing.push({
      ...outgoing[0],
      inTxPool: true,
      isConfirmed: false,
      relayState: 'pool'
    })
    f.input.evidence.outgoing = []
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toEqual([])
  })

  test('missing complete proof, missing attempted marker and missing fee yield issues without operations', async () => {
    // No paymentVerifications in the approved collection: the confirmed
    // attempted PREPARED row stays a journal contradiction, unresolved.
    const unproved = await verifiedRepairFixture({ kind: 'PAYOUT' })
    unproved.input.evidence.paymentVerifications = []
    const unprovedManifest = buildRewardsReconciliation(unproved.input)
    expect(promotionsOf(unprovedManifest)).toEqual([])
    expect(codesOf(unprovedManifest)).toContain('JOURNAL_STATE_CONTRADICTION')
    expect(codesOf(unprovedManifest)).toContain('PENDING_ATTEMPT_UNRESOLVED')

    // No attempted marker: the row is inert, never promoted.
    const unattempted = await verifiedRepairFixture({ kind: 'PAYOUT', attempted: false })
    const unattemptedManifest = buildRewardsReconciliation(unattempted.input)
    expect(promotionsOf(unattemptedManifest)).toEqual([])

    // A capture-era row with an unreadable (null) recorded fee contradicts its
    // own immutable capture: issue, never a correction, never a promotion.
    const noFee = await verifiedRepairFixture({ kind: 'PAYOUT' })
    noFee.input.ledger.transactions[0].networkFeePiconeros = null
    const noFeeManifest = buildRewardsReconciliation(noFee.input)
    expect(promotionsOf(noFeeManifest)).toEqual([])
    expect(codesOf(noFeeManifest)).toContain('RELAY_PROOF_FEE_MISMATCH')
    expect(noFeeManifest.operations.filter(op => op.table === 'RewardsWalletTransaction')).toEqual([])
  })

  test('a proof-era captured fee disagreement is a contradiction, never a fee correction', async () => {
    const f = await verifiedRepairFixture({ kind: 'OPS_SWEEP' })
    // The journal recorded 8 but the immutable capture proves 9.
    f.input.ledger.transactions[0].networkFeePiconeros = 8n
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toContain('RELAY_PROOF_FEE_MISMATCH')
    // No fee-correction operation exists for the proof-era row.
    expect(manifest.operations.filter(op =>
      op.table === 'RewardsWalletTransaction' && op.reason === 'wallet-history-fee')).toEqual([])
  })

  test('an observation earlier than the attempt cannot promote', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    // Attempt recorded AFTER the observation instant: chronology is broken.
    f.input.ledger.transactions[0].relayAttemptedAt = new Date('2026-10-06T12:30:00.000Z')
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    // The refused row remains an unresolved attempted relay: exact refusal
    // plus the fail-closed ledger uncertainty.
    expect(codesOf(manifest)).toEqual(['LEDGER_UNCERTAINTY', 'RELAY_PROOF_CHRONOLOGY_MISMATCH'])
  })

  test('an observation beyond the approved collection cannot promote', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    // The approved collection closed before the verification was observed.
    f.input.evidence.collectionStartedAt = '2026-10-06T10:00:00.000Z'
    f.input.evidence.observedAt = '2026-10-06T10:00:00.000Z'
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toEqual(['LEDGER_UNCERTAINTY', 'RELAY_PROOF_OBSERVATION_OUTSIDE_COLLECTION'])
  })

  test('an incomplete verification with closing totals never promotes', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT', rawFeePiconeros: 8, expectIncomplete: true })
    expect(f.verification.status).toBe('rejected')
    expect(f.verification.issues).toContain('FEE_MISMATCH')
    expect(f.verification.totals).toEqual({ D: '100', O: '33', F: '8', E: '60', residual: '-1' })
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toEqual(['LEDGER_UNCERTAINTY', 'RELAY_PROOF_NOT_COMPLETE'])
  })

  test('a journal member that contradicts the proved payment fails without an operation', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    // The frozen journal membership disagrees with the verified members.
    f.input.ledger.transactions[0].metadata.payouts[1].piconeros = '21'
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toContain('RELAY_PROOF_MEMBER_MISMATCH')
  })

  test('a verification bound to another journal identity cannot promote the row', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    f.verification.journalId = '999999'
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toContain('RELAY_PROOF_JOURNAL_MISMATCH')
  })

  test('a non-safe object in the verified collection is an issue and never an authority', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    f.input.evidence.paymentVerifications.push({ fabricated: true, status: 'complete' })
    const manifest = buildRewardsReconciliation(f.input)
    expect(codesOf(manifest)).toContain('PAYMENT_VERIFICATION_INVALID')
    // The genuine verification still binds exactly once.
    expect(promotionsOf(manifest)).toHaveLength(1)
  })

  test('legacy: no surviving proof keeps the attempted row unresolved', async () => {
    const f = await legacyRepairFixture({ withSurvivingProof: false })
    expect(f.verification.status).toBe('unresolved')
    expect(f.verification.issues).toContain('LEGACY_PROOF_MISSING')
    const manifest = buildRewardsReconciliation(f.input)
    expect(promotionsOf(manifest)).toEqual([])
    expect(codesOf(manifest)).toContain('RELAY_PROOF_NOT_COMPLETE')
    expect(codesOf(manifest)).toContain('LEDGER_UNCERTAINTY')
  })

  test('legacy: complete surviving evidence promotes state, observation, provenance and the missing fee in ONE operation', async () => {
    const f = await legacyRepairFixture({ withSurvivingProof: true, recordedFeePiconeros: null })
    expect(f.verification.status).toBe('complete')
    expect(f.verification.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    const manifest = buildRewardsReconciliation(f.input)
    const promotions = promotionsOf(manifest)
    expect(promotions).toHaveLength(1)
    expect(codesOf(manifest)).toEqual([])
    const op = promotions[0]
    // One combined before/after: state + observation + provenance + fee.
    expect(op.before).toEqual({
      state: 'PREPARED', relayedAt: null, relayProvenance: null, networkFeePiconeros: null
    })
    expect(op.after).toEqual({
      state: 'RELAYED', relayedAt: VERIFIED_OBSERVED_AT, relayProvenance: 'chain-proof-observation', networkFeePiconeros: '7'
    })
    // Not two conflicting updates.
    expect(manifest.operations.filter(operation => operation.table === 'RewardsWalletTransaction')).toHaveLength(1)
    expect(op.relayProof.version).toBe(2)
    expect(op.relayProof.captureMode).toBe('LEGACY_SURVIVING_PROOF')
    expect(op.relayProof.survivingEvidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(op.relayProof.dispatchId).toBeNull()
    expect(op.relayProof.claimDigest).toBeNull()
    expect(op.relayProof.proofInventory).toBeNull()
    expect(op.relayProof.totals.F).toBe('7')
    expect(manifest.after.totalNetworkFeesPiconeros).toBe('7')
    expect(manifest.after.totalSentPiconeros).toBe('60')
  })

  test('legacy: a wrong recorded fee is corrected to the independently proved raw fee in the same operation', async () => {
    const f = await legacyRepairFixture({ withSurvivingProof: true, recordedFeePiconeros: '5' })
    const manifest = buildRewardsReconciliation(f.input)
    const op = promotionsOf(manifest)[0]
    expect(op.before.networkFeePiconeros).toBe('5')
    expect(op.after.networkFeePiconeros).toBe('7')
    expect(promotionsOf(manifest)).toHaveLength(1)
  })

  test('buildJournalRelayOperation refuses a fabricated caller result without any store access', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const manifest = buildRewardsReconciliation(f.input)
    const op = promotionsOf(manifest)[0]
    // A valid closed operation can be rebuilt from the approved facts alone:
    // the constructor consumes the NORMALIZED journal row projection.
    const normalizedRow = {
      ...f.input.ledger.transactions[0],
      preparedAt: VERIFIED_PREPARED_AT,
      relayAttemptedAt: VERIFIED_ATTEMPTED_AT,
      relayedAt: null,
      relayProvenance: null
    }
    const rebuilt = buildJournalRelayOperation({
      row: normalizedRow,
      verification: f.verification,
      evidenceDigest: manifest.evidenceDigest,
      collectionStartedAt: VERIFIED_COLLECTION_STARTED_AT,
      collectedAt: VERIFIED_OBSERVED_AT
    })
    expect(rebuilt).toEqual(op)
    // Refusals carry fixed codes, never arbitrary SDK errors.
    for (const mutation of [
      verification => ({ ...verification, status: 'unresolved' }),
      verification => ({ ...verification, journalRole: 'ESCROW' }),
      verification => ({ ...verification, txHash: 'ff'.repeat(32) })
    ]) {
      let code = null
      try {
        buildJournalRelayOperation({
          row: normalizedRow,
          verification: mutation(f.verification),
          evidenceDigest: manifest.evidenceDigest,
          collectionStartedAt: VERIFIED_COLLECTION_STARTED_AT,
          collectedAt: VERIFIED_OBSERVED_AT
        })
      } catch (err) {
        code = err.code
      }
      expect(code).not.toBeNull()
      expect(code).toMatch(/^RELAY_PROOF_[A-Z_]+$/)
    }
  })

  test('the fixture pins the synthetic identity facts used by the promotion', () => {
    expect(verifiedFixtureIds.SCOPE.network).toBe('STAGENET')
    expect(VERIFIED_COLLECTION_STARTED_AT).toBe(VERIFIED_OBSERVED_AT)
  })
})

// Task 5: the guarded APPLY re-verification contract. Pure comparisons over
// the REAL verifier result from the fixture (isolated DB builds the protected
// pair; the comparisons themselves never touch the DB).
isolated('compatible payment re-verification (isolated DB only)', () => {
  const LATER_OBSERVED_AT = '2026-10-06T13:00:00.000Z'
  const LATER_TIP_HASH = 'de'.repeat(32)
  const ADVANCE = 144

  const laterCompatibleEvidence = async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const fresh = structuredClone(f.approvedEvidence)
    fresh.observedAt = LATER_OBSERVED_AT
    fresh.boundary = { height: fresh.boundary.height + ADVANCE, blockHash: LATER_TIP_HASH }
    const verification = fresh.paymentVerifications[0]
    verification.observedAt = LATER_OBSERVED_AT
    verification.boundary = { height: verification.boundary.height + ADVANCE, blockHash: LATER_TIP_HASH }
    verification.confirmation = {
      height: verification.confirmation.height,
      blockHash: verification.confirmation.blockHash,
      confirmations: verification.confirmation.confirmations + ADVANCE
    }
    verification.receivingAggregates = verification.receivingAggregates.map(aggregate => ({
      ...aggregate,
      confirmations: aggregate.confirmations + ADVANCE
    }))
    verification.ownedAccounting = {
      ...verification.ownedAccounting,
      outputs: verification.ownedAccounting.outputs.map(output => ({ ...output, isSpent: true }))
    }
    return { f, approved: f.approvedEvidence, fresh }
  }

  test('advancing confirmations, boundary and recheck time are compatible', async () => {
    const { approved, fresh } = await laterCompatibleEvidence()
    expect(() => assertCompatiblePaymentReverification({
      approved, fresh, approvedBoundary: approved.boundary
    })).not.toThrow()
  })

  test.each([
    ['fresh absence', async fresh => { fresh.paymentVerifications = [] }, /no longer proves/],
    ['a pool downgrade', async fresh => {
      fresh.paymentVerifications = [fresh.paymentVerifications[0]].map(verification => ({
        ...verification,
        status: 'unresolved',
        issues: ['CONFIRMATION_REQUIRED'],
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
      }))
    }, /no longer verifies complete/],
    ['a changed member claim', async fresh => {
      // A member-identity change (same amounts, so the verifier's own closure
      // stays valid) is a substantive fact change.
      fresh.paymentVerifications[0].members[1] = {
        ...fresh.paymentVerifications[0].members[1],
        id: '99'
      }
    }, /changed substantive facts/],
    ['a changed mined block', async fresh => {
      fresh.paymentVerifications[0].confirmation.blockHash = 'ff'.repeat(32)
    }, /changed substantive facts/],
    ['another journal identity', async fresh => {
      fresh.paymentVerifications[0].journalId = '999999'
    }, /another journal identity/],
    ['a capture-mode mix that cannot validate', async fresh => {
      fresh.paymentVerifications[0].survivingEvidenceDigest = 'ef'.repeat(32)
    }, /not a safe PaymentVerificationV1 result/],
    ['a new complete fact the approved audit never had', async fresh => {
      fresh.paymentVerifications.push({
        ...fresh.paymentVerifications[0],
        txHash: 'ee'.repeat(32),
        journalId: '777'
      })
    }, /never carried/],
    ['a boundary behind the approved boundary', async fresh => {
      fresh.boundary = { height: fresh.boundary.height - ADVANCE - 1, blockHash: LATER_TIP_HASH }
    }, /behind or off the approved boundary/],
    ['an invalid fabricated verification', async fresh => {
      fresh.paymentVerifications.push({ fabricated: true, status: 'complete' })
    }, /not a safe PaymentVerificationV1 result/]
  ])('%s is incompatible', async (_label, mutate, expected) => {
    const { approved, fresh } = await laterCompatibleEvidence()
    await mutate(fresh)
    expect(() => assertCompatiblePaymentReverification({
      approved, fresh, approvedBoundary: approved.boundary
    })).toThrow(expected)
  })

  test('the closed relayProof shape is validated against the builder output', async () => {
    const f = await verifiedRepairFixture({ kind: 'PAYOUT' })
    const manifest = buildRewardsReconciliation(f.input)
    const proof = manifest.operations.find(op => op.after?.state === 'RELAYED').relayProof
    expect(validateJournalRelayProof(proof)).toBe(true)
    const truncated = { txHash: proof.txHash, accountIndex: 0, height: 1, feePiconeros: '1', destinations: [] }
    expect(validateJournalRelayProof(truncated)).toBe(false)
    expect(validateJournalRelayProof({ ...proof, version: 1 })).toBe(false)
    const widened = { ...proof, boundary: { height: 1, blockHash: 'ab'.repeat(32) } }
    expect(validateJournalRelayProof(widened)).toBe(false)
    const wrongCaptureIdentity = { ...proof, survivingEvidenceDigest: 'ef'.repeat(32) }
    expect(validateJournalRelayProof(wrongCaptureIdentity)).toBe(false)
  })
})

// Final-review I2: the re-verification gate compares BOTH wallet roles under
// their independently bound scopes — nested ESCROW verifier facts are as
// binding as top-level REWARDS facts. Closed safe result shapes only; the
// comparisons never touch the DB.
describe('compatible payment re-verification covers both wallet roles (final-review I2)', () => {
  const REWARDS_SCOPE = { network: 'STAGENET', walletAddress: '5RewardsGateWallet' }
  const ESCROW_WALLET = '5EscrowGateWallet'
  const ESCROW_SCOPE = { network: 'STAGENET', walletAddress: ESCROW_WALLET }
  const OBSERVED = '2026-10-06T12:00:00.000Z'

  const escrowResult = overrides => ({
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...ESCROW_SCOPE },
    journalRole: 'ESCROW',
    journalId: '77',
    dispatchId: null,
    captureMode: 'LEGACY_SURVIVING_PROOF',
    txHash: 'cd'.repeat(32),
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: ['0'],
    members: [{
      id: '1',
      leg: 'PRINCIPAL',
      address: '5EscrowRecipient',
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: 'escrow-identity',
      grossPiconeros: '139',
      actualPiconeros: '139'
    }],
    receivingAggregates: [{ receivingIdentity: 'escrow-identity', amountPiconeros: '139', confirmations: 10 }],
    ownedAccounting: {
      totalPiconeros: '5',
      outputs: [{ outputIndex: 0, accountIndex: 0, subaddressIndex: 0, amountPiconeros: '5', isSpent: false }]
    },
    totals: { D: '147', O: '5', F: '3', E: '139', residual: '0' },
    confirmation: { height: 2999990, blockHash: 'b1'.repeat(32), confirmations: 10 },
    observedAt: OBSERVED,
    boundary: { height: 2999999, blockHash: 'b1'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'cf'.repeat(32),
    ...structuredClone(overrides ?? {})
  })

  const collection = ({ escrowResults = [], rewardsResults = [], escrowWalletAddress = ESCROW_WALLET, ...overrides } = {}) => ({
    evidenceVersion: 2,
    observedAt: OBSERVED,
    scope: { ...REWARDS_SCOPE },
    boundary: { height: 2999999, blockHash: 'b1'.repeat(32) },
    paymentVerifications: rewardsResults,
    escrow: escrowWalletAddress === null
      ? null
      : { walletAddress: escrowWalletAddress, paymentVerifications: escrowResults },
    ...overrides
  })

  test('an identical nested escrow result re-proves the payment', () => {
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).not.toThrow()
  })

  test('fresh absence of the nested escrow proof invalidates it', () => {
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/no longer proves ESCROW:/)
  })

  test('a fresh non-complete downgrade of the nested escrow proof is refused', () => {
    const downgraded = escrowResult({
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
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [downgraded] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/no longer verifies complete/)
  })

  test('changed nested escrow substantive facts are refused', () => {
    const changed = escrowResult()
    changed.members[0] = { ...changed.members[0], id: '99' }
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [changed] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/changed substantive facts/)
  })

  test('a newly complete fresh escrow fact the approved audit never carried is refused', () => {
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [] }),
      fresh: collection({ escrowResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/never carried/)
  })

  test('an escrow wallet scope disagreement between collections is refused', () => {
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [escrowResult()], escrowWalletAddress: '5AnotherEscrowWallet' }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/escrow scope does not match/)
  })

  test('a nested-only collection still binds the v2 evidence contract and observation', () => {
    // The pre-I2 early return skipped these checks when the TOP-LEVEL list
    // was empty; nested escrow facts are as binding.
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()], evidenceVersion: 1 }),
      fresh: collection({ escrowResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/v2 evidence contract/)
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [escrowResult()], observedAt: null }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/no observation time/)
  })

  test('a result bound to the wrong role or wallet slot never authorizes coverage', () => {
    // The ESCROW result moved into the top-level (REWARDS) slot: a misplaced
    // scope binding is refused, never silently re-attributed.
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ rewardsResults: [escrowResult()] }),
      fresh: collection({ rewardsResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/another wallet scope or journal role/)
  })

  test('conflicting duplicates for one escrow slot never bind', () => {
    const conflicting = escrowResult({ journalId: '88' })
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult(), conflicting] }),
      fresh: collection({ escrowResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting results for ESCROW:/)
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [escrowResult(), conflicting] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting fresh results/)
  })

  test('two conflicting newly complete unapproved fresh results are refused, never skipped', () => {
    // Re-review probe B1 (fix round 2): two freshly complete REWARDS results
    // for an unapproved hash with different journal identities poison the
    // slot — and a poisoned slot REFUSES, it is never skipped (the base
    // behavior refused these; skipping would hide both new facts).
    const rewardsHash = 'ef'.repeat(32)
    const first = escrowResult({ txHash: rewardsHash, journalRole: 'REWARDS', scope: { ...REWARDS_SCOPE }, journalId: '91' })
    const second = escrowResult({ txHash: rewardsHash, journalRole: 'REWARDS', scope: { ...REWARDS_SCOPE }, journalId: '92' })
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({}),
      fresh: collection({ rewardsResults: [first, second] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting fresh results/)
    // ...and the same conflict on the APPROVED side refuses too.
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ rewardsResults: [first, second] }),
      fresh: collection({ rewardsResults: [first] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting results for REWARDS:/)
  })

  test('fresh duplicates differing only in the surviving-proof identity are refused', () => {
    // Re-review probe B1 (fix round 2): the stable facts projection excludes
    // the surviving evidence digest, so duplicate conflict detection must
    // compare it separately — a contradictory second result never collapses
    // into the first.
    const surviving = escrowResult()
    const digestVariant = escrowResult({ survivingEvidenceDigest: 'aa'.repeat(32) })
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult()] }),
      fresh: collection({ escrowResults: [surviving, digestVariant] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting fresh results/)
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [surviving, digestVariant] }),
      fresh: collection({ escrowResults: [escrowResult()] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/conflicting results for ESCROW:/)
  })

  test('same-hash results from the two wallet roles stay separate slots', () => {
    // One hash verified for BOTH wallets: the rewards slot and the escrow
    // slot never alias, and both must survive fresh comparison.
    const hash = 'ce'.repeat(32)
    const rewardsResult = {
      ...escrowResult({ txHash: hash }),
      journalRole: 'REWARDS',
      scope: { ...REWARDS_SCOPE }
    }
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult({ txHash: hash })], rewardsResults: [rewardsResult] }),
      fresh: collection({ escrowResults: [escrowResult({ txHash: hash })], rewardsResults: [rewardsResult] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).not.toThrow()
    // Losing ONLY the escrow half names the escrow slot.
    expect(() => assertCompatiblePaymentReverification({
      approved: collection({ escrowResults: [escrowResult({ txHash: hash })], rewardsResults: [rewardsResult] }),
      fresh: collection({ escrowResults: [], rewardsResults: [rewardsResult] }),
      approvedBoundary: { height: 2999999, blockHash: 'b1'.repeat(32) }
    })).toThrow(/no longer proves ESCROW:/)
  })
})

// A pure regression guard: without the isolated DB the fixture cannot run, so
// at least the closed field contract stays pinned everywhere.
if (!ISOLATED_DB) {
  test('relayProof closed field contract is pinned', () => {
    expect(RELAY_PROOF_FIELDS).toEqual([
      'captureMode', 'claimDigest', 'confirmation', 'dispatchId', 'evidenceDigest',
      'journalId', 'journalRole', 'members', 'observedAt', 'ownedAccounting',
      'proofInventory', 'provenance', 'receivingAggregates', 'sdkVersion',
      'scope', 'sourceAccounts', 'survivingEvidenceDigest', 'totals', 'txHash',
      'verificationVersion', 'verifierVersion', 'version'
    ])
  })
}
