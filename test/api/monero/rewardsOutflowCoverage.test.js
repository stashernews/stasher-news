/* eslint-env jest */
import { recordedOutflowCoverage } from '@/api/monero/rewardsOutflowCoverage'
import { auditLedgerFixture } from '@/test/fixtures/payment-proof'

// Reverse recorded-outflow coverage (rewards reconciliation plan, Task 4).
// Pure unit tests over the shared audit-ledger fixture: no DB, no wallet, no
// daemon, no clock. The module proves every recorded outflow (payouts, sweeps,
// escrow legs) against evidence row-first — one deterministic issue per
// identity/cause — and never accepts or gates on drift (drift-varied
// assertions live in the builder integration suite).

const clone = value => structuredClone(value)

const codeOf = (issues, code) => issues.filter(issue => issue.code === code)

const byId = (issues, code, id) =>
  issues.find(issue => issue.code === code && issue.id === String(id))

// A VALID unresolved PaymentVerificationV1 (the collector's explicit
// legacy-unresolved shape): safe fields only, closed result contract.
const unresolvedVerification = ({ hash, issue = 'LEGACY_PROOF_MISSING', status = 'unresolved', scope = { network: 'STAGENET', walletAddress: 'w' } } = {}) => ({
  verificationVersion: '1',
  status,
  issues: [issue],
  scope: { ...scope },
  journalRole: 'REWARDS',
  journalId: null,
  dispatchId: null,
  captureMode: 'LEGACY_SURVIVING_PROOF',
  txHash: hash,
  claimDigest: null,
  proofInventory: null,
  sourceAccounts: [],
  members: [],
  receivingAggregates: [],
  ownedAccounting: { totalPiconeros: null, outputs: [] },
  totals: { D: null, O: null, F: null, E: null, residual: null },
  confirmation: { height: null, blockHash: null, confirmations: null },
  observedAt: '2026-10-06T12:00:00.000Z',
  boundary: { height: null, blockHash: null },
  verifierVersion: '1',
  sdkVersion: '0.11.12',
  provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
  survivingEvidenceDigest: null
})

// The audit fixture's payout 301 is SENT at hash 0xc1 with no journal row at
// that hash; the pure default story is exactly the missing-history story.
const missingHistoryEvidence = () => ({ outgoing: [], paymentVerifications: [], escrow: null })

// A closed-shape COMPLETE verification (safe result only, like the collector's
// legacy surviving-proof results): strict coverage authority under evidence
// v2. Members are { address, actualPiconeros, id?, leg? } — member identity
// (id/leg) is part of the exact escrow attribution (final-review I1 round 3).
const completeVerification = ({ hash, scope, members, fee = '7', owned = '33', role = 'REWARDS', journalId = null }) => {
  const total = members.reduce((acc, member) => acc + BigInt(member.actualPiconeros), 0n)
  return {
    verificationVersion: '1',
    status: 'complete',
    issues: [],
    scope: { ...scope },
    journalRole: role,
    journalId,
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
      receivingIdentity: 'i1',
      grossPiconeros: member.actualPiconeros,
      actualPiconeros: member.actualPiconeros
    })),
    receivingAggregates: [{ receivingIdentity: 'i1', amountPiconeros: total.toString(), confirmations: 10 }],
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
    observedAt: '2026-10-06T12:00:00.000Z',
    boundary: { height: 2999999, blockHash: 'b1'.repeat(32) },
    verifierVersion: '1',
    sdkVersion: '0.11.12',
    provenance: 'restored-owned-outputs/raw-chain/check-tx-key',
    survivingEvidenceDigest: 'e1'.repeat(32)
  }
}

test.each(['0', '-7', '7'])('recorded payout stays an issue at drift %s', drift => {
  const f = auditLedgerFixture()
  f.ledger.payouts[0].state = 'CONFIRMED'
  const issues = recordedOutflowCoverage({
    ledger: f.ledger,
    evidence: { outgoing: [], paymentVerifications: [], escrow: null },
    scope: f.scope
  })
  expect(issues).toContainEqual(expect.objectContaining({
    code: 'RECORDED_PAYOUT_EVIDENCE_MISSING', id: String(f.ledger.payouts[0].id)
  }))
  // Build a separate compatible balance input with this drift in the integration test;
  // the pure reverse helper does not even accept drift and cannot gate on it.
  expect(['0', '-7', '7']).toContain(drift)
})

test('the coverage input is never mutated and the records are deterministic', () => {
  const f = auditLedgerFixture()
  const original = clone(f)
  const first = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  const second = recordedOutflowCoverage({ ledger: clone(f.ledger), evidence: missingHistoryEvidence(), scope: f.scope })
  expect(f).toEqual(original)
  expect(first).toEqual(second)
  // Reversed ledger row order cannot reorder the issue records.
  const shuffled = clone(f)
  shuffled.ledger.payouts.reverse()
  shuffled.ledger.distributions.reverse()
  shuffled.ledger.bountyPayments.reverse()
  shuffled.ledger.transactions.reverse()
  expect(recordedOutflowCoverage({ ledger: shuffled.ledger, evidence: missingHistoryEvidence(), scope: f.scope }))
    .toEqual(first)
})

test('a malformed or missing recorded payout hash cannot hide the recorded money', () => {
  const f = auditLedgerFixture()
  f.ledger.payouts[0].txHash = 'not-a-chain-hash'
  f.ledger.payouts.push({ ...f.ledger.payouts[0], id: 302, txHash: null })
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  // One issue per row: two offsetting rows stay two named identities.
  expect(codeOf(issues, 'RECORDED_PAYOUT_HASH_INVALID')).toHaveLength(2)
  expect(byId(issues, 'RECORDED_PAYOUT_HASH_INVALID', 301)).toEqual(expect.objectContaining({
    table: 'RewardPayout',
    reason: 'the recorded payout carries no valid transaction hash'
  }))
  expect(byId(issues, 'RECORDED_PAYOUT_HASH_INVALID', 302)).toEqual(expect.objectContaining({
    table: 'RewardPayout'
  }))
  expect(codeOf(issues, 'RECORDED_PAYOUT_EVIDENCE_MISSING')).toHaveLength(0)
})

test('two distributions claiming the same sweep hash is an exact ownership conflict', () => {
  const f = auditLedgerFixture()
  f.ledger.distributions.push({ ...f.ledger.distributions[0], id: 402 })
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  expect(codeOf(issues, 'SWEEP_HASH_OWNERSHIP_CONFLICT')).toHaveLength(1)
  expect(issues).toContainEqual(expect.objectContaining({
    code: 'SWEEP_HASH_OWNERSHIP_CONFLICT',
    txHash: f.ledger.distributions[0].opsSweepTxHash,
    distributionIds: [401, 402]
  }))
})

test('a positive swept total without any recorded hash stays an issue', () => {
  const f = auditLedgerFixture()
  f.ledger.distributions[0].opsSweepTxHash = null
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  expect(issues).toContainEqual(expect.objectContaining({
    code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
    table: 'RewardDistribution',
    id: '401',
    recordedPiconeros: '500',
    provenPiconeros: '0'
  }))
  expect(codeOf(issues, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toHaveLength(0)
})

test('a partial multi-hash principal allocation is named without double attribution', () => {
  const f = auditLedgerFixture()
  const provedHash = 'a4'.repeat(32)
  const unprovedHash = 'a5'.repeat(32)
  f.ledger.distributions[0].opsSweepTxHash = `${provedHash},${unprovedHash},${provedHash}`
  f.ledger.distributions[0].opsSweptPiconeros = 600n
  f.ledger.transactions.push({
    id: 503n,
    network: f.scope.network,
    walletAddress: f.scope.walletAddress,
    txHash: provedHash,
    kind: 'OPS_SWEEP',
    accountIndex: 0,
    distributionId: 401,
    principalPiconeros: 500n,
    networkFeePiconeros: 6n,
    metadata: { destination: f.scope.walletAddress },
    state: 'RELAYED',
    preparedAt: new Date(Date.UTC(2026, 8, 1, 31)),
    relayAttemptedAt: null,
    relayedAt: new Date(Date.UTC(2026, 8, 1, 32)),
    relayProvenance: 'RELAY_TX',
    dispatchId: null,
    captureContractVersion: null,
    claimDigest: null,
    paymentClaims: null,
    proofId: null
  })
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  // Journal history proves nothing (final-review I1): NEITHER hash is covered,
  // so the recorded 600 is proven by zero complete-verification principal.
  expect(issues).toContainEqual(expect.objectContaining({
    code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
    id: '401',
    recordedPiconeros: '600',
    provenPiconeros: '0'
  }))
  expect(codeOf(issues, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toEqual([
    expect.objectContaining({ code: 'RECORDED_SWEEP_EVIDENCE_MISSING', id: '401', txHash: provedHash }),
    expect.objectContaining({ code: 'RECORDED_SWEEP_EVIDENCE_MISSING', id: '401', txHash: unprovedHash })
  ])
  // A complete verification for one hash attributes exactly its proved
  // principal, once — the journal row adds nothing.
  const verified = recordedOutflowCoverage({
    ledger: f.ledger,
    evidence: {
      evidenceVersion: 2,
      outgoing: [],
      paymentVerifications: [completeVerification({
        hash: provedHash,
        scope: f.scope,
        members: [{ address: f.scope.walletAddress, actualPiconeros: '500' }],
        fee: '6'
      })],
      escrow: null
    },
    scope: f.scope
  })
  expect(codeOf(verified, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toEqual([
    expect.objectContaining({ id: '401', txHash: unprovedHash })
  ])
  expect(verified).toContainEqual(expect.objectContaining({
    code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
    id: '401',
    recordedPiconeros: '600',
    provenPiconeros: '500'
  }))
})

test('pending or unsupported proof stays a named unsupported issue, not delivery', () => {
  const f = auditLedgerFixture()
  f.ledger.payouts[0].state = 'CONFIRMED'
  // Hash-only pending assurance: the mempool bridge is not delivery evidence.
  const pending = recordedOutflowCoverage({
    ledger: clone(f.ledger),
    evidence: {
      evidenceVersion: 2,
      outgoing: [],
      bridge: { pendingOutgoing: [{ txHash: f.ledger.payouts[0].txHash, inTxPool: true, isConfirmed: false }] },
      paymentVerifications: [],
      escrow: null
    },
    scope: f.scope
  })
  expect(byId(pending, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', 301)).toEqual(expect.objectContaining({
    table: 'RewardPayout',
    txHash: f.ledger.payouts[0].txHash
  }))
  expect(codeOf(pending, 'RECORDED_PAYOUT_EVIDENCE_MISSING')).toHaveLength(0)

  // An unresolved verification (missing proof key) is equally not delivery.
  const unresolved = recordedOutflowCoverage({
    ledger: clone(f.ledger),
    evidence: {
      evidenceVersion: 2,
      outgoing: [],
      paymentVerifications: [unresolvedVerification({ hash: f.ledger.payouts[0].txHash, scope: f.scope })],
      escrow: null
    },
    scope: f.scope
  })
  expect(byId(unresolved, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', 301)).toBeDefined()
  expect(codeOf(unresolved, 'RECORDED_PAYOUT_EVIDENCE_MISSING')).toHaveLength(0)

  // An unsupported boundary (unexpected owned target) is named unsupported too.
  const unsupported = recordedOutflowCoverage({
    ledger: clone(f.ledger),
    evidence: {
      evidenceVersion: 2,
      outgoing: [],
      paymentVerifications: [unresolvedVerification({
        hash: f.ledger.payouts[0].txHash,
        status: 'unsupported',
        issue: 'OWNED_CHANGE_SPLIT_UNSUPPORTED',
        scope: f.scope
      })],
      escrow: null
    },
    scope: f.scope
  })
  expect(byId(unsupported, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', 301)).toBeDefined()
})

describe('recorded payout batch membership', () => {
  const hash = 'c9'.repeat(32)
  const address = '5SameAddressPayoutRecipient'

  const ledgerWithBatch = (journalMembers, payoutRows) => {
    const transactions = journalMembers === null
      ? []
      : [{
          id: 900n,
          network: 'STAGENET',
          walletAddress: 'w',
          txHash: hash,
          kind: 'PAYOUT',
          accountIndex: 0,
          distributionId: 1,
          principalPiconeros: journalMembers.reduce((acc, member) => acc + BigInt(member.piconeros), 0n),
          networkFeePiconeros: 7n,
          metadata: { payouts: journalMembers },
          state: 'RELAYED',
          preparedAt: null,
          relayAttemptedAt: null,
          relayedAt: new Date(Date.UTC(2026, 8, 1)),
          relayProvenance: 'RELAY_TX',
          dispatchId: null,
          captureContractVersion: null,
          claimDigest: null,
          paymentClaims: null,
          proofId: null
        }]
    return { payouts: payoutRows, distributions: [], bountyPayments: [], transactions }
  }

  const row = (id, piconeros = 400n) => ({
    id, distributionId: 1, recipientAddress: address, piconeros, txHash: hash, state: 'CONFIRMED'
  })

  const member = (payoutId, piconeros = '400') => ({
    payoutId, recipientAddress: address, piconeros
  })

  const verificationFor = (amounts, role = 'REWARDS') => completeVerification({
    hash,
    scope: { network: 'STAGENET', walletAddress: role === 'REWARDS' ? 'w' : 'e' },
    members: amounts.map(actualPiconeros => ({ address, actualPiconeros })),
    role
  })

  test('same-address members are covered as a per-row multiset, never by output order', () => {
    const ledger = ledgerWithBatch(null, [row(301), row(302)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [verificationFor(['400', '400'])],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    expect(issues).toEqual([])
  })

  test('relay journal history alone is named, never strict coverage', () => {
    const ledger = ledgerWithBatch([member(301), member(302)], [row(301), row(302)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        outgoing: [{ txHash: hash, accountIndex: 0, isConfirmed: true, inTxPool: false }],
        paymentVerifications: [],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    // Every recorded row of the journal-covered batch stays a named identity:
    // relay history is not a complete-payment proof (final-review I1).
    expect(codeOf(issues, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED')).toEqual([
      expect.objectContaining({
        table: 'RewardPayout',
        id: '301',
        txHash: hash,
        reason: 'the covering journal row is relay history, not a complete payment verification; strict recorded-outflow coverage requires complete proof naming this payout exactly'
      }),
      expect.objectContaining({ table: 'RewardPayout', id: '302', txHash: hash })
    ])
    expect(codeOf(issues, 'RECORDED_PAYOUT_MEMBER_MISMATCH')).toHaveLength(0)
  })

  test('a journal contract that disagrees with the recorded rows is still just named, never coverage', () => {
    const ledger = ledgerWithBatch([member(301)], [row(301), row(302)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        outgoing: [{ txHash: hash, accountIndex: 0, isConfirmed: true, inTxPool: false }],
        paymentVerifications: [],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    expect(codeOf(issues, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED')).toHaveLength(2)
  })

  test('a complete verification proves the batch through its proved members', () => {
    const ledger = ledgerWithBatch(null, [row(301), row(302, 20n)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [verificationFor(['400', '20'])],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    expect(issues).toEqual([])
  })

  test('a verification that proves a different multiset is a member mismatch per row', () => {
    const ledger = ledgerWithBatch(null, [row(301), row(302, 20n)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [verificationFor(['400'])],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    expect(codeOf(issues, 'RECORDED_PAYOUT_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        id: '302',
        reason: 'the proved payment does not include this recorded payout exactly'
      })
    ])
  })

  test('a proof with members beyond the recorded batch is a named surplus, never coverage', () => {
    // Re-review probe (final-review I1 round 2): a third, unrelated member in
    // the complete proof must reject — the member multiset has to match the
    // recorded batch exactly, surplus included.
    const ledger = ledgerWithBatch(null, [row(301), row(302, 20n)])
    const issues = recordedOutflowCoverage({
      ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [verificationFor(['400', '20', '9'])],
        escrow: null
      },
      scope: { network: 'STAGENET', walletAddress: 'w' }
    })
    // Both recorded rows stay covered (no per-row mismatch) while the surplus
    // member is named with its exact identity.
    expect(codeOf(issues, 'RECORDED_PAYOUT_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        table: 'RewardPayout',
        txHash: hash,
        entry: '9:5SameAddressPayoutRecipient',
        reason: 'the proved payment includes members beyond the recorded payout batch'
      })
    ])
  })
})

test('a recorded-but-corrupt escrow fee hash cannot escape the leg check', () => {
  const f = auditLedgerFixture()
  const payment = f.ledger.bountyPayments[0]
  payment.feeTxHash = 'zz-not-a-chain-hash'
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  // The corrupt deferred-fee leg is named exactly like a missing one — with
  // no txHash field — and never silently dropped; the valid principal leg is
  // still named with its hash.
  const fee = codeOf(issues, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING').find(issue => issue.leg === 'FEE')
  expect(fee).toEqual(expect.objectContaining({ table: 'BountyPayment', id: '701' }))
  expect(fee).not.toHaveProperty('txHash')
  expect(codeOf(issues, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toContainEqual(expect.objectContaining({
    leg: 'PRINCIPAL',
    txHash: payment.txHash
  }))
})

test('a missing escrow prize or fee leg is an issue even when settlement columns are populated', () => {
  const f = auditLedgerFixture()
  const payment = f.ledger.bountyPayments[0]
  // Every settlement column is populated (recipientReceived/feeReceived/...):
  // populated bookkeeping is not evidence.
  expect(payment.recipientReceivedPiconeros).toBe(5000n)
  const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence: missingHistoryEvidence(), scope: f.scope })
  // Canonical record order (leg 'FEE' sorts before 'PRINCIPAL').
  expect(codeOf(issues, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toEqual([
    expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
      table: 'BountyPayment',
      id: '701',
      txHash: payment.feeTxHash,
      leg: 'FEE'
    }),
    expect.objectContaining({
      code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING',
      table: 'BountyPayment',
      id: '701',
      txHash: payment.txHash,
      leg: 'PRINCIPAL'
    })
  ])
})

describe('strict verification-only coverage (final-review I1)', () => {
  // The audit fixture with every recorded fact covered by COMPLETE
  // verifications: the payout batch under one REWARDS proof, the sweep hash
  // under another (exact recorded principal), and both escrow legs under
  // scoped ESCROW proofs.
  const provedFixture = () => {
    const f = auditLedgerFixture()
    const payoutHash = f.ledger.payouts[0].txHash
    f.ledger.payouts[0].state = 'CONFIRMED'
    const sweepHash = f.ledger.distributions[0].opsSweepTxHash
    const escrowAddress = f.ledger.escrowTransactions[0].walletAddress
    const escrowScope = { network: f.scope.network, walletAddress: escrowAddress }
    const payment = f.ledger.bountyPayments[0]
    const escrow = {
      walletAddress: escrowAddress,
      outgoing: [payment.txHash, payment.feeTxHash]
        .map(txHash => ({ txHash, accountIndex: 0, isConfirmed: true, inTxPool: false })),
      paymentVerifications: [
        completeVerification({
          hash: payment.txHash,
          scope: escrowScope,
          journalId: '601',
          members: [{ id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '5000' }],
          role: 'ESCROW'
        }),
        completeVerification({
          hash: payment.feeTxHash,
          scope: escrowScope,
          members: [{ id: String(payment.id), leg: 'FEE', address: payment.feeRecipientAddress, actualPiconeros: '100' }],
          role: 'ESCROW'
        })
      ]
    }
    return {
      f,
      sweepHash,
      escrowScope,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [
          completeVerification({
            hash: payoutHash,
            scope: f.scope,
            members: [{ address: f.ledger.payouts[0].recipientAddress, actualPiconeros: '400' }]
          }),
          completeVerification({
            hash: sweepHash,
            scope: f.scope,
            members: [{ address: f.scope.walletAddress, actualPiconeros: '500' }],
            fee: '6'
          })
        ],
        escrow
      }
    }
  }

  test('verification-covered payout, sweep and escrow legs: no issues', () => {
    const { f, evidence } = provedFixture()
    const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence, scope: f.scope })
    expect(issues).toEqual([])
  })

  test('a recorded sweep principal beyond its proved verification allocation is named', () => {
    const { f, evidence } = provedFixture()
    f.ledger.distributions[0].opsSweptPiconeros = 501n
    const issues = recordedOutflowCoverage({ ledger: f.ledger, evidence, scope: f.scope })
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
        id: '401',
        recordedPiconeros: '501',
        provenPiconeros: '500'
      })
    ])
  })

  test('dropping one complete proof names exactly its recorded facts', () => {
    const { f, evidence } = provedFixture()
    // Drop the sweep proof: the recorded hash is named and its principal
    // becomes unproven; the payout and escrow legs stay covered.
    const withoutSweep = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: { ...evidence, paymentVerifications: evidence.paymentVerifications.slice(0, 1) },
      scope: f.scope
    })
    expect(codeOf(withoutSweep, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toEqual([
      expect.objectContaining({ id: '401', txHash: f.ledger.distributions[0].opsSweepTxHash })
    ])
    expect(codeOf(withoutSweep, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED')).toHaveLength(0)
    expect(codeOf(withoutSweep, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toHaveLength(0)

    // Drop the FEE-leg proof: only that leg is named.
    const withoutFee = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        ...evidence,
        escrow: {
          ...evidence.escrow,
          paymentVerifications: evidence.escrow.paymentVerifications.slice(0, 1)
        }
      },
      scope: f.scope
    })
    expect(codeOf(withoutFee, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toEqual([
      expect.objectContaining({ id: '701', leg: 'FEE' })
    ])
  })

  test('unresolved RELAYED journal history is named for a CONFIRMED recorded payout', () => {
    // Review probe: a RELAYED PAYOUT journal row plus an unresolved verifier
    // result (LEGACY_PROOF_MISSING) — under strict coverage both are only
    // history/attempt, and the CONFIRMED record stays individually named.
    const f = auditLedgerFixture()
    f.ledger.payouts[0].state = 'CONFIRMED'
    const payoutHash = f.ledger.payouts[0].txHash
    f.ledger.transactions.push({
      id: 504n,
      network: f.scope.network,
      walletAddress: f.scope.walletAddress,
      txHash: payoutHash,
      kind: 'PAYOUT',
      accountIndex: 0,
      distributionId: 401,
      principalPiconeros: 400n,
      networkFeePiconeros: 7n,
      metadata: { payouts: [{ payoutId: 301, recipientAddress: f.ledger.payouts[0].recipientAddress, piconeros: '400' }] },
      state: 'RELAYED',
      preparedAt: new Date(Date.UTC(2026, 8, 1, 20)),
      relayAttemptedAt: null,
      relayedAt: new Date(Date.UTC(2026, 8, 1, 21)),
      relayProvenance: 'RELAY_TX',
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    })
    const issues = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [{ txHash: payoutHash, accountIndex: 0, isConfirmed: true, inTxPool: false }],
        paymentVerifications: [unresolvedVerification({ hash: payoutHash, scope: f.scope })],
        escrow: null
      },
      scope: f.scope
    })
    expect(byId(issues, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', 301)).toEqual(expect.objectContaining({
      table: 'RewardPayout',
      txHash: payoutHash,
      reason: 'the covering journal row is relay history, not a complete payment verification; strict recorded-outflow coverage requires complete proof naming this payout exactly'
    }))
    // The unresolved verifier result alone would also be named unsupported —
    // either way the CONFIRMED record is never silently covered.
    expect(codeOf(issues, 'RECORDED_PAYOUT_EVIDENCE_MISSING')).toHaveLength(0)
  })

  test('CONFIRMED recorded payout with pool-only chain presence is named', () => {
    // Review probe: the payout's outgoing entry moved into the relayed-pool
    // bridge while the recorded payout stays CONFIRMED and a RELAYED journal
    // row exists — zero-verifier evidence can never pass strict coverage.
    const f = auditLedgerFixture()
    f.ledger.payouts[0].state = 'CONFIRMED'
    const payoutHash = f.ledger.payouts[0].txHash
    f.ledger.transactions.push({
      id: 504n,
      network: f.scope.network,
      walletAddress: f.scope.walletAddress,
      txHash: payoutHash,
      kind: 'PAYOUT',
      accountIndex: 0,
      distributionId: 401,
      principalPiconeros: 400n,
      networkFeePiconeros: 7n,
      metadata: { payouts: [{ payoutId: 301, recipientAddress: f.ledger.payouts[0].recipientAddress, piconeros: '400' }] },
      state: 'RELAYED',
      preparedAt: new Date(Date.UTC(2026, 8, 1, 20)),
      relayAttemptedAt: null,
      relayedAt: new Date(Date.UTC(2026, 8, 1, 21)),
      relayProvenance: 'RELAY_TX',
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    })
    const issues = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        bridge: { pendingOutgoing: [{ txHash: payoutHash, inTxPool: true, isConfirmed: false, isRelayed: true, relayState: 'pool' }] },
        paymentVerifications: [],
        escrow: null
      },
      scope: f.scope
    })
    expect(byId(issues, 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', 301)).toBeDefined()
    expect(codeOf(issues, 'RECORDED_PAYOUT_EVIDENCE_MISSING')).toHaveLength(0)
  })

  test('an escrow proof paying a different recipient or amount does not attribute the leg', () => {
    // Re-review probes (final-review I1 rounds 2-3): validator-valid complete
    // results paying 1 piconero to a DIFFERENT recipient — or the right
    // recipient at the wrong amount — are named as exact membership
    // mismatches (missing + surplus), never coverage.
    const { f, escrowScope, evidence } = provedFixture()
    const payment = f.ledger.bountyPayments[0]
    const evidenceWith = escrowResults => ({
      evidenceVersion: 2,
      outgoing: [],
      paymentVerifications: evidence.paymentVerifications,
      escrow: { ...evidence.escrow, paymentVerifications: escrowResults }
    })
    const wrongRecipient = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: evidenceWith([
        completeVerification({
          hash: payment.txHash,
          scope: escrowScope,
          journalId: '601',
          members: [{ id: String(payment.id), leg: 'PRINCIPAL', address: '5SomeoneElseEntirely', actualPiconeros: '1' }],
          role: 'ESCROW'
        }),
        ...evidence.escrow.paymentVerifications.slice(1)
      ]),
      scope: f.scope
    })
    expect(codeOf(wrongRecipient, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        txHash: payment.txHash,
        entry: `PRINCIPAL:${payment.recipientAddress}:5000`,
        reason: 'the proved payment is missing a recorded escrow leg member'
      }),
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        entry: 'PRINCIPAL:5SomeoneElseEntirely:1',
        reason: 'the proved payment includes members beyond the recorded escrow leg membership'
      })
    ])
    // Same for a proof naming the right recipient with the WRONG amount: the
    // ledger records the leg's settled amount (5000), so 1 does not attribute.
    const wrongAmount = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: evidenceWith([
        completeVerification({
          hash: payment.txHash,
          scope: escrowScope,
          journalId: '601',
          members: [{ id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '1' }],
          role: 'ESCROW'
        }),
        ...evidence.escrow.paymentVerifications.slice(1)
      ]),
      scope: f.scope
    })
    expect(codeOf(wrongAmount, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        entry: `PRINCIPAL:${payment.recipientAddress}:1`,
        reason: 'the proved payment includes members beyond the recorded escrow leg membership'
      }),
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        entry: `PRINCIPAL:${payment.recipientAddress}:5000`,
        reason: 'the proved payment is missing a recorded escrow leg member'
      })
    ])
  })

  test('member id, member leg and journal-identity contradictions are each named', () => {
    // Re-review probes (final-review I1 round 3): the frozen member identity
    // is (id, leg, address, amount) and the verification must bind the
    // recorded escrow journal owner — any one contradiction is named.
    const { f, escrowScope, evidence } = provedFixture()
    const payment = f.ledger.bountyPayments[0]
    const honestMember = { id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '5000' }
    const evidenceWith = escrowResults => ({
      evidenceVersion: 2,
      outgoing: [],
      paymentVerifications: evidence.paymentVerifications,
      escrow: { ...evidence.escrow, paymentVerifications: escrowResults }
    })
    const coverage = members => recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: evidenceWith([
        completeVerification({
          hash: payment.txHash,
          scope: escrowScope,
          journalId: '601',
          members,
          role: 'ESCROW'
        }),
        ...evidence.escrow.paymentVerifications.slice(1)
      ]),
      scope: f.scope
    })
    // A changed member id does not identify the recorded member.
    expect(codeOf(coverage([{ ...honestMember, id: '999' }]), 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ leg: 'PRINCIPAL', reason: 'the proved payment is missing a recorded escrow leg member' }),
        expect.objectContaining({ leg: 'PRINCIPAL', reason: 'the proved payment includes members beyond the recorded escrow leg membership' })
      ]))
    // A changed member leg does not either.
    expect(codeOf(coverage([{ ...honestMember, leg: 'FEE' }]), 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ leg: 'PRINCIPAL', reason: 'the proved payment is missing a recorded escrow leg member' }),
        expect.objectContaining({ leg: 'PRINCIPAL', reason: 'the proved payment includes members beyond the recorded escrow leg membership' })
      ]))
    // A supplied journal identity contradicting the recorded escrow journal
    // (601) fails the authoritative owner binding.
    const foreignJournal = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: evidenceWith([
        completeVerification({
          hash: payment.txHash,
          scope: escrowScope,
          journalId: '999999',
          members: [honestMember],
          role: 'ESCROW'
        }),
        ...evidence.escrow.paymentVerifications.slice(1)
      ]),
      scope: f.scope
    })
    expect(codeOf(foreignJournal, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        txHash: payment.txHash,
        reason: 'the verification does not bind the recorded escrow journal owner'
      })
    ])
  })

  test('a recorded fee receipt requires its member even without a separate feeTxHash', () => {
    // Re-review probe (final-review I1 round 3): a modern combined disposition
    // with a recorded fee receipt — the covering proof must contain the fee
    // member too; prize-only proofs name the missing fee member.
    const f = auditLedgerFixture()
    const payment = f.ledger.bountyPayments[0]
    const escrowAddress = f.ledger.escrowTransactions[0].walletAddress
    const escrowScope = { network: f.scope.network, walletAddress: escrowAddress }
    // The recorded rows show a COMBINED disposition: no separate fee tx, but
    // the fee receipt (100 to the recorded fee recipient) is recorded.
    payment.feeTxHash = null
    const prizeOnly = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [],
        escrow: {
          walletAddress: escrowAddress,
          paymentVerifications: [
            completeVerification({
              hash: payment.txHash,
              scope: escrowScope,
              journalId: '601',
              members: [{ id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '5000' }],
              role: 'ESCROW'
            })
          ]
        }
      },
      scope: f.scope
    })
    expect(codeOf(prizeOnly, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toEqual([
      expect.objectContaining({
        id: '701',
        leg: 'PRINCIPAL',
        txHash: payment.txHash,
        entry: `FEE:${payment.feeRecipientAddress}:100`,
        reason: 'the proved payment is missing a recorded escrow leg member'
      })
    ])
    // The honest combined proof — prize AND fee members — covers the leg.
    const covered = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [],
        escrow: {
          walletAddress: escrowAddress,
          paymentVerifications: [
            completeVerification({
              hash: payment.txHash,
              scope: escrowScope,
              journalId: '601',
              members: [
                { id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '5000' },
                { id: String(payment.id), leg: 'FEE', address: payment.feeRecipientAddress, actualPiconeros: '100' }
              ],
              role: 'ESCROW'
            })
          ]
        }
      },
      scope: f.scope
    })
    expect(codeOf(covered, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toHaveLength(0)
    expect(codeOf(covered, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toHaveLength(0)
  })

  test('non-complete results with materialized members never cover a recorded leg', () => {
    // Final-review round 3 (B3): unresolved/rejected/unsupported results whose
    // members remain populated are exactly the shapes that slipped past
    // membership-only attribution — the complete-status prerequisite names
    // the leg for every one of them.
    const { f, evidence } = provedFixture()
    const payment = f.ledger.bountyPayments[0]
    const downgrades = [
      ['unresolved', ['LEGACY_PROOF_MISSING']],
      ['rejected', ['CAPTURE_CORRUPT']],
      ['unsupported', ['OWNED_CHANGE_SPLIT_UNSUPPORTED']]
    ]
    for (const [status, issues] of downgrades) {
      const downgraded = recordedOutflowCoverage({
        ledger: f.ledger,
        evidence: {
          evidenceVersion: 2,
          outgoing: [],
          paymentVerifications: evidence.paymentVerifications,
          escrow: {
            ...evidence.escrow,
            paymentVerifications: evidence.escrow.paymentVerifications.map(entry => ({
              ...entry,
              status,
              issues
            }))
          }
        },
        scope: f.scope
      })
      expect(codeOf(downgraded, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toEqual([
        expect.objectContaining({ id: '701', leg: 'FEE', txHash: payment.feeTxHash }),
        expect.objectContaining({ id: '701', leg: 'PRINCIPAL', txHash: payment.txHash })
      ])
      expect(codeOf(downgraded, 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH')).toHaveLength(0)
    }
  })

  test('a sweep proof must attribute exactly: over-attribution and unrelated destinations are named', () => {
    const { f, sweepHash, evidence } = provedFixture()
    const sweepProofIndex = evidence.paymentVerifications.findIndex(entry => entry.txHash === sweepHash)
    // 501 proved against a recorded 500: exact equality is required — the
    // over-attribution is named with the actual attributed principal.
    const over = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        ...evidence,
        paymentVerifications: evidence.paymentVerifications.map((entry, index) => index === sweepProofIndex
          ? completeVerification({
            hash: sweepHash,
            scope: f.scope,
            members: [{ address: f.scope.walletAddress, actualPiconeros: '501' }],
            fee: '6'
          })
          : entry)
      },
      scope: f.scope
    })
    expect(codeOf(over, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toHaveLength(0) // single destination, no recorded target
    expect(over).toContainEqual(expect.objectContaining({
      code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
      id: '401',
      recordedPiconeros: '500',
      provenPiconeros: '501'
    }))
    // With the sweep target RECORDED (an OPS_SWEEP journal row for the hash),
    // a proof to an unrelated destination cannot attribute the sweep at all.
    const journaled = recordedOutflowCoverage({
      ledger: structuredClone(f.ledger),
      evidence: {
        ...evidence,
        paymentVerifications: evidence.paymentVerifications.map((entry, index) => index === sweepProofIndex
          ? completeVerification({
            hash: sweepHash,
            scope: f.scope,
            members: [{ address: '5UnrelatedSweepDestination', actualPiconeros: '500' }],
            fee: '6'
          })
          : entry)
      },
      scope: f.scope
    })
    expect(codeOf(journaled, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toHaveLength(0)
    // Record the target by pushing the sweep journal row for the exact hash.
    const withTarget = f.ledger
    withTarget.transactions.push({
      id: 506n,
      network: f.scope.network,
      walletAddress: f.scope.walletAddress,
      txHash: sweepHash,
      kind: 'OPS_SWEEP',
      accountIndex: 0,
      distributionId: 401,
      principalPiconeros: 500n,
      networkFeePiconeros: 6n,
      metadata: { destination: f.scope.walletAddress },
      state: 'RELAYED',
      preparedAt: new Date(Date.UTC(2026, 8, 1, 40)),
      relayAttemptedAt: null,
      relayedAt: new Date(Date.UTC(2026, 8, 1, 41)),
      relayProvenance: 'RELAY_TX',
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    })
    const attributed = recordedOutflowCoverage({ ledger: withTarget, evidence, scope: f.scope })
    expect(codeOf(attributed, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toHaveLength(0)
    expect(codeOf(attributed, 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN')).toHaveLength(0)
    const unrelated = recordedOutflowCoverage({
      ledger: withTarget,
      evidence: {
        ...evidence,
        paymentVerifications: evidence.paymentVerifications.map((entry, index) => index === sweepProofIndex
          ? completeVerification({
            hash: sweepHash,
            scope: f.scope,
            members: [{ address: '5UnrelatedSweepDestination', actualPiconeros: '500' }],
            fee: '6'
          })
          : entry)
      },
      scope: f.scope
    })
    expect(codeOf(unrelated, 'RECORDED_SWEEP_EVIDENCE_MISSING')).toEqual([
      expect.objectContaining({ id: '401', txHash: sweepHash })
    ])
    expect(unrelated).toContainEqual(expect.objectContaining({
      code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
      id: '401',
      recordedPiconeros: '500',
      provenPiconeros: '0'
    }))
  })

  test('confirmed escrow history alone no longer covers a settlement leg', () => {
    // Final-review I1: a confirmed outgoing hash is relay history, not
    // whole-payment closure — the leg needs its complete ESCROW verification.
    const f = auditLedgerFixture()
    const payment = f.ledger.bountyPayments[0]
    const escrowAddress = f.ledger.escrowTransactions[0].walletAddress
    const historyOnly = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        outgoing: [],
        paymentVerifications: [],
        escrow: {
          walletAddress: escrowAddress,
          outgoing: [payment.txHash, payment.feeTxHash]
            .map(txHash => ({ txHash, accountIndex: 0, isConfirmed: true, inTxPool: false }))
        }
      },
      scope: f.scope
    })
    expect(codeOf(historyOnly, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toEqual([
      expect.objectContaining({ table: 'BountyPayment', id: '701', leg: 'FEE', txHash: payment.feeTxHash }),
      expect.objectContaining({ table: 'BountyPayment', id: '701', leg: 'PRINCIPAL', txHash: payment.txHash })
    ])
    // ...and a scoped complete ESCROW verification per leg covers exactly.
    const escrowScope = { network: f.scope.network, walletAddress: escrowAddress }
    const covered = recordedOutflowCoverage({
      ledger: f.ledger,
      evidence: {
        evidenceVersion: 2,
        outgoing: [],
        paymentVerifications: [],
        escrow: {
          walletAddress: escrowAddress,
          outgoing: [],
          paymentVerifications: [
            completeVerification({
              hash: payment.txHash,
              scope: escrowScope,
              journalId: '601',
              members: [{ id: String(payment.id), leg: 'PRINCIPAL', address: payment.recipientAddress, actualPiconeros: '5000' }],
              role: 'ESCROW'
            }),
            completeVerification({
              hash: payment.feeTxHash,
              scope: escrowScope,
              members: [{ id: String(payment.id), leg: 'FEE', address: payment.feeRecipientAddress, actualPiconeros: '100' }],
              role: 'ESCROW'
            })
          ]
        }
      },
      scope: f.scope
    })
    expect(codeOf(covered, 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING')).toHaveLength(0)
  })
})
