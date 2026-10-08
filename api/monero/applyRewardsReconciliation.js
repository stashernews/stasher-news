import { Prisma } from '@prisma/client'
import { daemonClient } from '@/api/monero/daemonClient'
import { collectRewardsWalletEvidence } from '@/api/monero/rewardsWalletEvidence'
import { loadPaymentProof } from '@/api/monero/paymentProofStore'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import {
  assertCompatiblePaymentReverification,
  LEGACY_BACKFILL_REASON,
  RELAY_PROOF_VERSION,
  RELAY_PROVENANCE,
  validateJournalRelayProof
} from '@/api/monero/rewardsRelayProof'
import {
  assertRepairPreconditions,
  chainFactsFingerprint,
  journalRelayEvidenceMismatch,
  manifestDigest,
  normalizeEvidence,
  readRepairLedger
} from '@/api/monero/rewardsReconciliation'
import { readRewardsAuditReserve } from '@/api/monero/rewardsAuditSnapshot'
import { ACCOUNTING_FINGERPRINT_VERSION } from '@/lib/rewardsAuditFingerprint'
import { paymentVerificationFacts, validatePaymentVerification } from '@/api/monero/paymentVerification'

// Atomic application of an approved accounting repair manifest (rewards
// accounting repair §8, Task 13; guarded re-verification Task 5). The manifest
// is the ONLY repair authority: this module verifies the operator confirmed
// its exact SHA-256 digest, then — BEFORE any mutation — re-verifies the
// cryptographic evidence with a FRESH read-only collection (never a report's
// serialized success flag): the approved boundary block must still be
// canonical, the stable chain facts must be unchanged, and every complete
// payment the manifest relied on — in BOTH wallet roles, each under its own
// bound scope — must re-verify complete with identical substantive facts
// through #1's real verifier. Only then are the CLOSED
// operation vocabulary applied inside ONE Serializable transaction that
// re-reads every precondition first. Any mismatch throws and rolls back every
// financial correction AND the audit row together — there is no partial
// repair.
//
// Replay safety is structural: an APPLY audit row is unique by manifest
// digest, and the exact-digest check runs BEFORE the expensive chain
// re-verification (outside the transaction) and again inside the transaction,
// so re-running an already-applied manifest after later legitimate activity —
// even with lost proof keys — is still a no-op while a different (unapplied)
// manifest can never slip through.
//
// This module never signs, sends, sweeps, opens a wallet, imports a signer /
// delivery / recovery operation, or accepts an arbitrary Prisma table / field
// mutation: the dispatcher below is a closed allowlist. Its ONLY new state
// mutation is the proved rewards PREPARED -> RELAYED journal transition plus
// the independently reverified journal-less legacy backfill insert (Task 4).

const NETWORKS = new Set(['STAGENET', 'MAINNET'])
const FEE_TYPES = new Set([
  'POSTING',
  'TERRITORY_CREATE',
  'TERRITORY_BILLING',
  'TERRITORY_UNARCHIVE',
  'TERRITORY_UPDATE',
  'DONATE',
  'TIP_UNWALLETED',
  'BOOST',
  'BOUNTY_FEE',
  'BOUNTY_ROLLOVER'
])
const JOURNAL_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])
const TX_HASH_RE = /^[0-9a-f]{64}$/
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/
// The contractual signed ops fields may legitimately be negative (ops debt).
// Everything else (principal, fees, receipt amounts, reward splits) stays
// nonnegative.
const SIGNED_DECIMAL_RE = /^-?(0|[1-9][0-9]*)$/
const SIGNED_MONEY_FIELDS = new Set(['opsRolledOverPiconeros', 'opsAvailablePiconeros'])

// The ONLY operation fields a manifest may carry. `sweepAccounting` is
// informational (recorded vs proven sweep principal) and is never applied;
// `relayProof` is the exact evidence linkage a PREPARED -> RELAYED journal
// transition must carry (the closed v2 contract, validated against BOTH the
// approved and the fresh verifier facts) — or, for inserts, exactly the
// independently reverified legacy backfill of Task 4.
const OPERATION_KEYS = new Set(['kind', 'table', 'id', 'txHash', 'key', 'network', 'walletAddress', 'before', 'after', 'relayProof', 'reason', 'sweepAccounting'])

// Closed update allowlists per table. Payout/Earn rows, reward totals, payout
// states/hashes and a distribution's actual opsSwept principal/hash can never
// appear in a before/after pair. A journal `state`/`relayedAt`/`relayProvenance`
// triple is accepted ONLY as the proved PREPARED-with-attempt -> RELAYED
// transition (validated in applyUpdate); it can never touch a payout row.
const UPDATE_FIELDS = {
  FeeObservation: new Set(['piconeros', 'rewardsPiconeros', 'walletReceipt']),
  RewardsWalletTransaction: new Set(['networkFeePiconeros', 'state', 'relayedAt', 'relayProvenance']),
  BountyPayment: new Set(['feeRecipientAddress', 'networkFeePiconeros', 'recipientReceivedPiconeros', 'feeReceivedPiconeros', 'feeSettlementNetworkFeePiconeros']),
  RewardDistribution: new Set(['opsInflowPiconeros', 'opsRolledOverPiconeros', 'opsAvailablePiconeros']),
  Item: new Set(['bountyFeePiconeros'])
}

// Nullable money columns (a NULL means "not yet known", never zero).
const NULLABLE_MONEY = new Set([
  'rewardsPiconeros',
  'networkFeePiconeros',
  'recipientReceivedPiconeros',
  'feeReceivedPiconeros',
  'feeSettlementNetworkFeePiconeros',
  'bountyFeePiconeros'
])

const FEE_OBSERVATION_INSERT_FIELDS = [
  'txHash',
  'feeType',
  'piconeros',
  'rewardsPiconeros',
  'walletReceipt',
  'state',
  'recipientMajor',
  'recipientMinor',
  'height',
  'confirmedAt',
  'payInId',
  'postId',
  'subName',
  'donationRewardsPct'
]

const JOURNAL_INSERT_FIELDS = [
  'network',
  'walletAddress',
  'txHash',
  'kind',
  'state',
  'accountIndex',
  'distributionId',
  'principalPiconeros',
  'networkFeePiconeros',
  'metadata',
  'relayAttemptedAt'
]

// The legacy journal-less backfill insert (rewards reconciliation Task 4) is
// the ONLY insert that may carry a relayProof, and it must carry every
// proof-era capture column EXPLICITLY NULL plus the observation/provenance the
// insert records. Every other insert shape — and any capture value other than
// null — is refused.
const LEGACY_BACKFILL_INSERT_FIELDS = [
  ...JOURNAL_INSERT_FIELDS,
  'relayedAt',
  'relayProvenance',
  'dispatchId',
  'captureContractVersion',
  'claimDigest',
  'paymentClaims',
  'proofId'
]
const LEGACY_NULL_CAPTURE_COLUMNS = new Set([
  'dispatchId',
  'captureContractVersion',
  'claimDigest',
  'paymentClaims',
  'proofId'
])

// The relayProof's substantive fields — exactly the fields of #1's stable
// `paymentVerificationFacts` projection minus the verifier's status/issue echo
// (which the completeness checks own). These must equal BOTH the approved and
// the fresh verifier facts.
const RELAY_PROOF_SUBSTANCE_FIELDS = Object.freeze([
  'scope', 'journalRole', 'journalId', 'dispatchId', 'captureMode', 'txHash',
  'claimDigest', 'proofInventory', 'sourceAccounts', 'members',
  'receivingAggregates', 'ownedAccounting', 'totals', 'confirmation', 'provenance'
])

function requirePlainObject (value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`repair operation: ${label} must be a plain object`)
  }
}

function requireExactKeys (value, fields, label) {
  const keys = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`repair operation: ${label} must carry exactly the approved fields`)
  }
}

function requireDecimal (value, label, { nullable = false, signed = false } = {}) {
  if (value == null) {
    if (nullable) return null
    throw new Error(`repair operation: ${label} must be an exact ${signed ? 'signed ' : 'nonnegative '}decimal string`)
  }
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL_RE : DECIMAL_RE).test(value)) {
    throw new Error(`repair operation: ${label} must be an exact ${signed ? 'signed ' : 'nonnegative '}decimal string`)
  }
  return BigInt(value)
}

function requireSafeInteger (value, label, { nullable = false } = {}) {
  if (value == null) {
    if (nullable) return null
    throw new Error(`repair operation: ${label} must be a safe integer`)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`repair operation: ${label} must be a nonnegative safe integer`)
  }
  return value
}

function requireHash (value, label) {
  if (typeof value !== 'string' || !TX_HASH_RE.test(value)) {
    throw new Error(`repair operation: ${label} must be a 64-hex transaction hash`)
  }
  return value
}

// Convert one manifest field (always a JSON-safe value) to the Prisma column
// value. Unknown fields were already rejected by the caller.
function toColumnValue (field, value) {
  switch (field) {
    case 'walletReceipt':
      if (typeof value !== 'boolean') throw new Error('repair operation: walletReceipt must be a boolean')
      return value
    case 'state':
      if (typeof value !== 'string' || value === '') throw new Error('repair operation: state must be a non-empty string')
      return value
    case 'relayProvenance':
      if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error('repair operation: relayProvenance must be a non-empty string or null')
      }
      return value
    case 'relayedAt': {
      if (value == null) return null
      if (typeof value !== 'string') throw new Error('repair operation: relayedAt must be a valid timestamp or null')
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) throw new Error('repair operation: relayedAt must be a valid timestamp or null')
      return date
    }
    case 'feeRecipientAddress':
      if (value == null || (typeof value === 'string' && value !== '')) return value ?? null
      throw new Error('repair operation: feeRecipientAddress must be a non-empty string or null')
    default:
      return requireDecimal(value, field, {
        nullable: NULLABLE_MONEY.has(field),
        signed: SIGNED_MONEY_FIELDS.has(field)
      })
  }
}

// Deterministic comparison form for fact objects (sorted keys at every level,
// array order preserved — member order is itself a substantive fact).
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const verifiedVerification = (evidence, txHash, label) => {
  const found = (evidence?.verificationsByHash?.get(txHash)) ?? null
  if (!found || !validatePaymentVerification(found)) {
    throw new Error(`repair operation: the ${label} evidence does not carry a safe REWARDS verification for this transaction`)
  }
  return found
}

// The approved evidence projection a journal transition may rely on: the scoped
// outgoing facts, the wallet-owned address set and the scoped REWARDS payment
// verifications (v2 contract). Built ONCE per apply; the approved evidence
// itself was digest-verified by assertRepairPreconditions before any financial
// write, while the fresh projection is NEVER authority on its own — the #1
// store re-checks key access and proof authentication independently.
function prepareRelayEvidence (evidence) {
  if (evidence == null) return null
  const normalized = normalizeEvidence(evidence)
  return {
    scope: normalized.scope,
    ownedAddresses: new Set([
      normalized.scope?.walletAddress,
      ...normalized.derivation.derived.map(entry => entry.address)
    ].filter(Boolean)),
    outgoing: normalized.outgoing,
    verificationsByHash: new Map(normalized.paymentVerifications
      .filter(entry => entry?.journalRole === 'REWARDS')
      .map(entry => [entry.txHash, entry]))
  }
}

function sameDestinationSet (a, b) {
  const key = list => list.map(destination => `${destination.address}:${destination.amountPiconeros}`).sort().join('|')
  return key(a) === key(b)
}

// A PREPARED-with-attempt -> RELAYED transition is authorized ONLY by the
// closed v2 relayProof (rewards reconciliation plan Task 5): the proof must be
// the exact substantive projection of BOTH the approved and the fresh verifier
// facts for the scoped transaction, must carry the approved observation (the
// recorded `relayedAt`) and the approved evidence generation digest, and the
// approved evidence must contain the CONFIRMED owned outgoing entry whose
// height/fee/destinations match the proved payment. The recorded relay ATTEMPT
// alone NEVER authorizes the transition, and a truncated/destination-only v1
// relayProof is refused even when the old exact destination match would pass.
function assertRelayProof (operation, context) {
  const evidence = context?.relayEvidence
  if (!evidence) {
    throw new Error('repair operation: a journal state transition requires the approved chain evidence')
  }
  if (!context.freshEvidence) {
    throw new Error('repair operation: a journal state transition requires the fresh re-verification evidence')
  }
  const proof = operation.relayProof
  if (proof == null) {
    throw new Error('repair operation: a journal state transition requires its exact relayProof')
  }
  if (!validateJournalRelayProof(proof) || proof.version !== RELAY_PROOF_VERSION) {
    throw new Error('repair operation: the relay proof is not the closed v2 relayProof contract')
  }
  const txHash = proof.txHash
  if (txHash !== operation.txHash) {
    throw new Error('repair operation: the relay proof hash does not match the journal update')
  }
  if (proof.journalRole !== 'REWARDS') {
    throw new Error('repair operation: the relay proof does not bind a REWARDS verification')
  }
  if (context.evidenceDigest == null || proof.evidenceDigest !== context.evidenceDigest) {
    throw new Error('repair operation: the relay proof was not built from the approved evidence generation')
  }
  if (evidence.scope?.network !== operation.network || evidence.scope?.walletAddress !== operation.walletAddress) {
    throw new Error('repair operation: the approved evidence scope does not match the journal update')
  }
  if (proof.scope.network !== operation.network || proof.scope.walletAddress !== operation.walletAddress) {
    throw new Error('repair operation: the relay proof scope does not match the journal update')
  }

  // Both evidence generations must prove the SAME complete payment, and the
  // proof's own observation is the APPROVED one (a later recheck time never
  // rewrites the recorded relay observation). The substantive comparison is
  // over #1's stable-facts projection (confirmation is height + block hash;
  // advancing confirmation counts and later spending never enter it).
  const approved = verifiedVerification(evidence, txHash, 'approved')
  const fresh = verifiedVerification(context.freshEvidence, txHash, 'fresh')
  if (approved.status !== 'complete' || fresh.status !== 'complete') {
    throw new Error('repair operation: the relay proof requires a complete approved and fresh verification')
  }
  if (String(proof.journalId) !== String(approved.journalId) ||
    String(proof.journalId) !== String(fresh.journalId)) {
    throw new Error('repair operation: the relay proof does not bind the authoritative journal owner')
  }
  if (proof.observedAt !== approved.observedAt) {
    throw new Error('repair operation: the relay proof observation is not the approved observation')
  }
  if (fresh.verificationVersion !== approved.verificationVersion ||
    fresh.verifierVersion !== approved.verifierVersion || fresh.sdkVersion !== approved.sdkVersion) {
    throw new Error('repair operation: the fresh verification came from another verifier generation')
  }
  if ((fresh.survivingEvidenceDigest ?? null) !== (approved.survivingEvidenceDigest ?? null)) {
    throw new Error('repair operation: the fresh verification no longer carries the same surviving evidence')
  }
  const proofSubstance = Object.fromEntries(RELAY_PROOF_SUBSTANCE_FIELDS.map(field => [field, proof[field]]))
  const factsOf = verification => Object.fromEntries(
    RELAY_PROOF_SUBSTANCE_FIELDS.map(field => [field, verification[field]]))
  const approvedFacts = factsOf(paymentVerificationFacts(approved))
  if (canonicalJson(proofSubstance) !== canonicalJson(approvedFacts) ||
    canonicalJson(proofSubstance) !== canonicalJson(factsOf(paymentVerificationFacts(fresh)))) {
    throw new Error('repair operation: the relay proof does not match the approved and fresh verifier facts')
  }

  const confirmedEntries = evidence.outgoing.filter(candidate =>
    candidate.txHash === txHash &&
    candidate.isConfirmed === true &&
    candidate.inTxPool !== true)
  if (confirmedEntries.length !== 1) {
    throw new Error('repair operation: the approved evidence does not prove a confirmed outgoing relay for this transaction')
  }
  const entry = confirmedEntries[0]
  if (entry.height !== proof.confirmation.height || entry.feePiconeros !== proof.totals.F) {
    throw new Error('repair operation: the relay proof height/fee do not match the approved evidence')
  }
  // For payments with proved external members, the approved evidence outgoing
  // destinations must be exactly those members (self-transfers carry no
  // external members — their owned-destination semantics are checked through
  // journalRelayEvidenceMismatch below).
  if (approved.members.length > 0 && !sameDestinationSet(
    entry.destinations,
    approved.members.map(member => ({ address: member.address, amountPiconeros: member.actualPiconeros })))) {
    throw new Error('repair operation: the approved evidence destinations do not match the proved payment members')
  }
  return { entry, proof }
}

function delegateFor (tx, table) {
  const delegate = {
    FeeObservation: tx.feeObservation,
    RewardsWalletTransaction: tx.rewardsWalletTransaction,
    BountyPayment: tx.bountyPayment,
    RewardDistribution: tx.rewardDistribution,
    Item: tx.item
  }[table]
  if (!delegate || typeof delegate.updateMany !== 'function') {
    throw new Error(`repair operation: unsupported table ${table}`)
  }
  return delegate
}

// One compare-before-write update. The `where` carries the operation's exact
// approved identity and `before` values; an affected-row count other than
// exactly one means the row changed (or vanished) since approval and refuses
// the whole transaction.
//
// RewardsWalletTransaction updates are bound to the journal identity
// `(network, walletAddress, txHash)`. The ONLY state change the closed
// vocabulary accepts is a proved PREPARED-with-attempt -> RELAYED transition
// (a real `relayedAt` recorded, optionally together with the exact proved fee);
// every other state transition — and any payout state — is refused.
async function applyUpdate (tx, operation, context) {
  const allowed = UPDATE_FIELDS[operation.table]
  if (!allowed) throw new Error(`repair operation: table ${operation.table} is not an approved update target`)
  requirePlainObject(operation.before, 'before')
  requirePlainObject(operation.after, 'after')
  const beforeKeys = Object.keys(operation.before).sort()
  const afterKeys = Object.keys(operation.after).sort()
  if (beforeKeys.length === 0 || beforeKeys.join(',') !== afterKeys.join(',')) {
    throw new Error('repair operation: before and after must change the same non-empty field set')
  }
  for (const field of beforeKeys) {
    if (!allowed.has(field)) {
      throw new Error(`repair operation: field ${field} is not an approved ${operation.table} correction`)
    }
  }

  const where = {}
  const data = {}
  if (operation.table === 'RewardsWalletTransaction') {
    if (typeof operation.txHash !== 'string' || operation.id != null || operation.key != null) {
      throw new Error('repair operation: journal updates target exactly one txHash')
    }
    if (typeof operation.network !== 'string' || typeof operation.walletAddress !== 'string' || operation.walletAddress.trim() === '') {
      throw new Error('repair operation: journal updates must bind the approved network and wallet address')
    }
    where.txHash = requireHash(operation.txHash, 'txHash')
    where.network = operation.network
    where.walletAddress = operation.walletAddress
  } else {
    if (!Number.isSafeInteger(operation.id) || operation.id <= 0 || operation.txHash != null || operation.key != null) {
      throw new Error(`repair operation: ${operation.table} updates target exactly one id`)
    }
    if (operation.network != null || operation.walletAddress != null) {
      throw new Error(`repair operation: ${operation.table} updates do not carry a journal scope`)
    }
    if (operation.relayProof != null) {
      throw new Error(`repair operation: ${operation.table} updates do not carry a relay proof`)
    }
    where.id = operation.id
  }

  // A state transition is ONLY the proved PREPARED-with-attempt -> RELAYED
  // triple: state, relayedAt and relayProvenance always travel together, the
  // before state is PREPARED with everything unset, relayedAt becomes the
  // APPROVED observation time with the closed provenance, and the transition
  // must be proven by the closed v2 relayProof matching BOTH the approved and
  // the fresh verifier facts (a relay attempt is not a relay). Any other state
  // transition — and any payout state — is refused.
  const hasState = Object.prototype.hasOwnProperty.call(operation.before, 'state')
  const hasRelayedAt = Object.prototype.hasOwnProperty.call(operation.before, 'relayedAt')
  const hasRelayProvenance = Object.prototype.hasOwnProperty.call(operation.before, 'relayProvenance')
  if (hasState || hasRelayedAt || hasRelayProvenance) {
    if (operation.table !== 'RewardsWalletTransaction' || !hasState || !hasRelayedAt || !hasRelayProvenance) {
      throw new Error('repair operation: only a proved PREPARED -> RELAYED journal transition may change state/relayedAt/relayProvenance')
    }
    if (operation.before.state !== 'PREPARED' || operation.after.state !== 'RELAYED') {
      throw new Error('repair operation: the only journal state transition is PREPARED -> RELAYED')
    }
    if (operation.before.relayedAt !== null) {
      throw new Error('repair operation: an unresolved relay has no relayedAt yet')
    }
    if (operation.before.relayProvenance !== null) {
      throw new Error('repair operation: an unresolved relay has no relay provenance yet')
    }
    if (typeof operation.after.relayedAt !== 'string') {
      throw new Error('repair operation: a proved relay transition carries a real relayedAt timestamp')
    }
    if (operation.after.relayProvenance !== RELAY_PROVENANCE) {
      throw new Error('repair operation: a proved relay transition carries the closed relay provenance')
    }
    // Exact approved + fresh verifier facts: the closed v2 relayProof, the
    // confirmed owned outgoing entry matching height/fee/destinations; plus the
    // row's own journal facts (members / sweep destination / consolidation
    // self-transfer) must match that same entry.
    const { entry, proof } = assertRelayProof(operation, context)
    // The ORIGINAL digest-bound approved observation remains the operation's
    // relayedAt: a diverging (e.g. fresh recheck) time can never be recorded.
    if (operation.after.relayedAt !== proof.observedAt) {
      throw new Error('repair operation: a proved relay transition records the approved observation as relayedAt')
    }
    const row = await tx.rewardsWalletTransaction.findUnique({
      where: {
        network_walletAddress_txHash: {
          network: operation.network,
          walletAddress: operation.walletAddress,
          txHash: operation.txHash
        }
      }
    })
    if (!row || row.state !== 'PREPARED' || row.relayedAt != null || row.relayProvenance != null) {
      throw new Error('repair operation: the journal row is not an unresolved PREPARED relay')
    }
    if (row.relayAttemptedAt == null) {
      throw new Error('repair operation: the journal row has no recorded relay attempt')
    }
    if (String(proof.journalId) !== String(row.id)) {
      throw new Error('repair operation: the relay proof does not bind the authoritative journal owner')
    }
    const mismatch = journalRelayEvidenceMismatch({
      row: { kind: row.kind, metadata: row.metadata, principalPiconeros: row.principalPiconeros },
      entry,
      scope: { network: operation.network, walletAddress: operation.walletAddress },
      ownedAddresses: context.relayEvidence.ownedAddresses
    })
    if (mismatch) {
      throw new Error(`repair operation: the approved evidence does not prove the journal relay (${mismatch})`)
    }
    const finalFee = Object.prototype.hasOwnProperty.call(operation.after, 'networkFeePiconeros')
      ? requireDecimal(operation.after.networkFeePiconeros, 'networkFeePiconeros')
      : row.networkFeePiconeros
    if (proof.totals?.F == null || entry.feePiconeros == null || finalFee !== BigInt(proof.totals.F)) {
      throw new Error('repair operation: the transitioned journal fee does not match the approved relay fee')
    }
    // Captured proof-era fees are immutable: a CAPTURE_V1 promotion can never
    // change the recorded fee in the same pair — the only allowed fee movement
    // is the legacy surviving-evidence correction.
    if (proof.captureMode === 'CAPTURE_V1' &&
      Object.prototype.hasOwnProperty.call(operation.after, 'networkFeePiconeros') &&
      operation.before.networkFeePiconeros !== operation.after.networkFeePiconeros) {
      throw new Error('repair operation: a captured relay fee can never change')
    }
    where.relayAttemptedAt = { not: null }
  } else if (operation.relayProof != null) {
    throw new Error('repair operation: a relay proof is only valid with a PREPARED -> RELAYED transition')
  }

  for (const field of beforeKeys) {
    where[field] = toColumnValue(field, operation.before[field])
    data[field] = toColumnValue(field, operation.after[field])
  }

  // A repaired distribution snapshot must be internally consistent:
  // available = inflow + rolled. A negative carry/available is legitimate
  // signed debt; a triple that violates the contractual relation is malformed
  // evidence and is refused before any write.
  if (operation.table === 'RewardDistribution' &&
    Object.prototype.hasOwnProperty.call(data, 'opsInflowPiconeros') &&
    Object.prototype.hasOwnProperty.call(data, 'opsRolledOverPiconeros') &&
    Object.prototype.hasOwnProperty.call(data, 'opsAvailablePiconeros') &&
    data.opsAvailablePiconeros !== data.opsInflowPiconeros + data.opsRolledOverPiconeros) {
    throw new Error('repair operation: the corrected distribution snapshot violates available = inflow + rolled')
  }

  const { count } = await delegateFor(tx, operation.table).updateMany({ where, data })
  if (count !== 1) {
    throw new Error(`repair operation: expected exactly one matching ${operation.table} row, found ${count}; rolled back`)
  }
}

// One verified missing-receipt insert (operator-classified inbound). The row
// must be an already final chain fact: CONFIRMED, walletReceipt true, an exact
// reward split within the amount, a bound receiving index and a real
// verified timestamp.
async function applyFeeObservationInsert (tx, operation) {
  const after = operation.after
  requirePlainObject(after, 'after')
  requireExactKeys(after, FEE_OBSERVATION_INSERT_FIELDS, 'FeeObservation insert')
  requirePlainObject(operation.key, 'key')
  if (operation.id != null) throw new Error('repair operation: receipt inserts are keyed by hash and receiving index')
  const txHash = requireHash(after.txHash, 'txHash')
  if (txHash !== requireHash(operation.key.txHash, 'key.txHash')) {
    throw new Error('repair operation: receipt insert key does not match the inserted hash')
  }
  const major = requireSafeInteger(operation.key.recipientMajor, 'key.recipientMajor')
  const minor = requireSafeInteger(operation.key.recipientMinor, 'key.recipientMinor')
  if (after.recipientMajor !== major || after.recipientMinor !== minor) {
    throw new Error('repair operation: receipt insert key does not match the inserted receiving index')
  }
  if (!FEE_TYPES.has(after.feeType)) throw new Error('repair operation: unknown fee type in receipt insert')
  if (after.walletReceipt !== true) throw new Error('repair operation: an inserted receipt must be a wallet receipt')
  if (after.state !== 'CONFIRMED') throw new Error('repair operation: an inserted receipt must be CONFIRMED')
  const piconeros = requireDecimal(after.piconeros, 'piconeros')
  const rewardsPiconeros = requireDecimal(after.rewardsPiconeros, 'rewardsPiconeros')
  if (rewardsPiconeros > piconeros) throw new Error('repair operation: the reward split cannot exceed the receipt amount')
  const confirmedAt = new Date(after.confirmedAt)
  if (typeof after.confirmedAt !== 'string' || Number.isNaN(confirmedAt.getTime())) {
    throw new Error('repair operation: an inserted receipt requires a verified timestamp')
  }
  const donationRewardsPct = after.donationRewardsPct == null
    ? null
    : requireSafeInteger(after.donationRewardsPct, 'donationRewardsPct')
  if (donationRewardsPct != null && donationRewardsPct > 100) {
    throw new Error('repair operation: donationRewardsPct must be within 0..100')
  }
  if (after.subName != null && typeof after.subName !== 'string') {
    throw new Error('repair operation: subName must be a string or null')
  }
  await tx.feeObservation.create({
    data: {
      txHash,
      feeType: after.feeType,
      piconeros,
      rewardsPiconeros,
      walletReceipt: true,
      state: 'CONFIRMED',
      recipientMajor: major,
      recipientMinor: minor,
      height: requireSafeInteger(after.height, 'height', { nullable: true }),
      confirmedAt,
      payInId: requireSafeInteger(after.payInId, 'payInId', { nullable: true }),
      postId: requireSafeInteger(after.postId, 'postId', { nullable: true }),
      subName: after.subName ?? null,
      donationRewardsPct
    }
  })
}

// One proved journal row insert. Two closed shapes exist: the historical
// no-relay-proof insert (a confirmed wallet relay the journal never recorded;
// RELAYED fact, null attempt) and — carrying a relayProof — EXACTLY the
// independently reverified journal-less legacy backfill of Task 4. Every other
// insert shape, and any other relayProof-carrying insert, is refused.
async function applyJournalInsert (tx, operation, context) {
  const after = operation.after
  requirePlainObject(after, 'after')
  requirePlainObject(operation.key, 'key')
  if (operation.id != null) throw new Error('repair operation: journal inserts are keyed by network/wallet/hash')
  const network = after.network
  if (!NETWORKS.has(network)) throw new Error('repair operation: unsupported journal network')
  if (typeof after.walletAddress !== 'string' || after.walletAddress.trim() === '') {
    throw new Error('repair operation: the journal wallet address is not configured')
  }
  const txHash = requireHash(after.txHash, 'txHash')
  if (network !== operation.key.network || after.walletAddress !== operation.key.walletAddress ||
    txHash !== requireHash(operation.key.txHash, 'key.txHash')) {
    throw new Error('repair operation: journal insert key does not match the inserted row')
  }
  if (operation.relayProof != null) {
    return await applyLegacyBackfillInsert(tx, operation, context, { network, walletAddress: after.walletAddress, txHash })
  }
  requireExactKeys(after, JOURNAL_INSERT_FIELDS, 'RewardsWalletTransaction insert')
  if (!JOURNAL_KINDS.has(after.kind)) throw new Error('repair operation: unknown journal kind')
  if (after.state !== 'RELAYED') throw new Error('repair operation: only a proved RELAYED journal row may be inserted')
  if (after.relayAttemptedAt !== null) throw new Error('repair operation: an inserted journal row is never an unresolved relay attempt')
  const principalPiconeros = requireDecimal(after.principalPiconeros, 'principalPiconeros')
  const networkFeePiconeros = requireDecimal(after.networkFeePiconeros, 'networkFeePiconeros')
  if (after.kind === 'CONSOLIDATION' && principalPiconeros !== 0n) {
    throw new Error('repair operation: a consolidation journal row has zero principal')
  }
  requirePlainObject(after.metadata, 'metadata')
  try {
    JSON.stringify(after.metadata)
  } catch {
    throw new Error('repair operation: journal metadata must be JSON-safe')
  }

  await tx.rewardsWalletTransaction.create({
    data: {
      network,
      walletAddress: after.walletAddress,
      txHash,
      kind: after.kind,
      state: 'RELAYED',
      accountIndex: requireSafeInteger(after.accountIndex, 'accountIndex'),
      distributionId: requireSafeInteger(after.distributionId, 'distributionId', { nullable: true }),
      principalPiconeros,
      networkFeePiconeros,
      metadata: after.metadata,
      relayAttemptedAt: null
    }
  })
}

// ONE proved journal row insert the plan mandates (rewards reconciliation
// Tasks 4+5): the builder's journal-less LEGACY complete-payment backfill. It
// is the ONLY insert that may carry a relayProof. The insert keeps every
// proof-era capture column explicitly NULL, records the APPROVED observation
// as `relayedAt` (never a reconstructed broadcast time) with the legacy
// backfill provenance, and its closed v2 relayProof must re-verify against
// BOTH the approved and the fresh verifier facts with the exact surviving
// evidence digest and frozen membership. This creates neither a new send nor a
// PaymentTransactionProof row.
async function applyLegacyBackfillInsert (tx, operation, context, identity) {
  const after = operation.after
  if (operation.reason !== LEGACY_BACKFILL_REASON) {
    throw new Error('repair operation: only the independently reverified legacy backfill insert may carry a relay proof')
  }
  requireExactKeys(after, LEGACY_BACKFILL_INSERT_FIELDS, 'legacy backfill insert')
  if (!JOURNAL_KINDS.has(after.kind)) throw new Error('repair operation: unknown journal kind')
  if (after.state !== 'RELAYED') throw new Error('repair operation: only a proved RELAYED journal row may be inserted')
  if (after.relayAttemptedAt !== null) throw new Error('repair operation: an inserted journal row is never an unresolved relay attempt')
  if (typeof after.relayedAt !== 'string' || Number.isNaN(Date.parse(after.relayedAt))) {
    throw new Error('repair operation: a legacy backfill insert records the approved observation as relayedAt')
  }
  if (after.relayProvenance !== LEGACY_BACKFILL_REASON) {
    throw new Error('repair operation: a legacy backfill insert records the legacy backfill provenance')
  }
  for (const column of LEGACY_NULL_CAPTURE_COLUMNS) {
    if (after[column] !== null) {
      throw new Error(`repair operation: a legacy backfill insert keeps ${column} explicitly null`)
    }
  }
  const principalPiconeros = requireDecimal(after.principalPiconeros, 'principalPiconeros')
  const networkFeePiconeros = requireDecimal(after.networkFeePiconeros, 'networkFeePiconeros')
  if (after.kind === 'CONSOLIDATION' && principalPiconeros !== 0n) {
    throw new Error('repair operation: a consolidation journal row has zero principal')
  }
  requirePlainObject(after.metadata, 'metadata')
  try {
    JSON.stringify(after.metadata)
  } catch {
    throw new Error('repair operation: journal metadata must be JSON-safe')
  }

  const evidence = context?.relayEvidence
  if (!evidence || !context.freshEvidence) {
    throw new Error('repair operation: a legacy backfill insert requires the approved and fresh re-verification evidence')
  }
  const proof = operation.relayProof
  if (!validateJournalRelayProof(proof) || proof.version !== RELAY_PROOF_VERSION) {
    throw new Error('repair operation: the relay proof is not the closed v2 relayProof contract')
  }
  if (proof.captureMode !== 'LEGACY_SURVIVING_PROOF') {
    throw new Error('repair operation: only a complete independently surviving legacy proof may backfill a journal')
  }
  if (proof.journalRole !== 'REWARDS' || proof.journalId !== null || proof.dispatchId !== null ||
    proof.claimDigest !== null || proof.proofInventory !== null ||
    proof.survivingEvidenceDigest == null) {
    throw new Error('repair operation: the legacy backfill proof carries no capture identity and its exact surviving evidence digest')
  }
  if (context.evidenceDigest == null || proof.evidenceDigest !== context.evidenceDigest) {
    throw new Error('repair operation: the relay proof was not built from the approved evidence generation')
  }
  if (proof.scope.network !== identity.network || proof.scope.walletAddress !== identity.walletAddress ||
    proof.txHash !== identity.txHash) {
    throw new Error('repair operation: the relay proof does not bind the inserted journal scope')
  }

  // Both evidence generations must still prove the SAME complete legacy
  // payment; the recorded relayedAt stays the APPROVED observation.
  const approved = verifiedVerification(evidence, identity.txHash, 'approved')
  const fresh = verifiedVerification(context.freshEvidence, identity.txHash, 'fresh')
  if (approved.status !== 'complete' || fresh.status !== 'complete' ||
    approved.captureMode !== 'LEGACY_SURVIVING_PROOF' || fresh.captureMode !== 'LEGACY_SURVIVING_PROOF') {
    throw new Error('repair operation: a legacy backfill requires a complete approved and fresh surviving-proof verification')
  }
  if (String(fresh.journalId) !== String(approved.journalId)) {
    throw new Error('repair operation: the fresh verification binds another journal identity')
  }
  if (fresh.verificationVersion !== approved.verificationVersion ||
    fresh.verifierVersion !== approved.verifierVersion || fresh.sdkVersion !== approved.sdkVersion) {
    throw new Error('repair operation: the fresh verification came from another verifier generation')
  }
  if ((fresh.survivingEvidenceDigest ?? null) !== (approved.survivingEvidenceDigest ?? null) ||
    proof.survivingEvidenceDigest !== approved.survivingEvidenceDigest) {
    throw new Error('repair operation: the legacy backfill surviving evidence digest changed between collections')
  }
  if (proof.observedAt !== approved.observedAt || after.relayedAt !== approved.observedAt) {
    throw new Error('repair operation: the backfill observation is the approved observation')
  }
  const proofSubstance = Object.fromEntries(RELAY_PROOF_SUBSTANCE_FIELDS.map(field => [field, proof[field]]))
  const factsOf = verification => Object.fromEntries(
    RELAY_PROOF_SUBSTANCE_FIELDS.map(field => [field, verification[field]]))
  // The legacy backfill proof intentionally binds NO journal identity
  // (`journalId` is null); approved-vs-fresh journal equality was asserted
  // above, so the substantive comparison excludes that field on both sides.
  const withoutJournalIdentity = substance => {
    const { journalId, ...rest } = substance
    return rest
  }
  if (canonicalJson(withoutJournalIdentity(proofSubstance)) !==
    canonicalJson(withoutJournalIdentity(factsOf(paymentVerificationFacts(approved)))) ||
    canonicalJson(withoutJournalIdentity(proofSubstance)) !==
      canonicalJson(withoutJournalIdentity(factsOf(paymentVerificationFacts(fresh))))) {
    throw new Error('repair operation: the relay proof does not match the approved and fresh verifier facts')
  }
  if (networkFeePiconeros !== BigInt(proof.totals.F)) {
    throw new Error('repair operation: the inserted fee is the proved legacy fee')
  }

  // Exact frozen membership and authoritative ownership: the recorded members
  // in the metadata are exactly the proved payment members, and NO scoped
  // journal row may already claim the hash.
  const mismatch = journalRelayEvidenceMismatch({
    row: { kind: after.kind, metadata: after.metadata, principalPiconeros },
    entry: {
      destinations: approved.members.map(member => ({ address: member.address, amountPiconeros: member.actualPiconeros }))
    },
    scope: { network: identity.network, walletAddress: identity.walletAddress },
    ownedAddresses: evidence.ownedAddresses
  })
  if (mismatch) {
    throw new Error(`repair operation: the approved evidence does not prove the legacy backfill (${mismatch})`)
  }
  const existing = await tx.rewardsWalletTransaction.findUnique({
    where: {
      network_walletAddress_txHash: {
        network: identity.network,
        walletAddress: identity.walletAddress,
        txHash: identity.txHash
      }
    }
  })
  if (existing) {
    throw new Error('repair operation: a journal row already records this transaction')
  }

  await tx.rewardsWalletTransaction.create({
    data: {
      network: identity.network,
      walletAddress: identity.walletAddress,
      txHash: identity.txHash,
      kind: after.kind,
      state: 'RELAYED',
      accountIndex: requireSafeInteger(after.accountIndex, 'accountIndex'),
      distributionId: requireSafeInteger(after.distributionId, 'distributionId', { nullable: true }),
      principalPiconeros,
      networkFeePiconeros,
      metadata: after.metadata,
      relayAttemptedAt: null,
      relayedAt: new Date(after.relayedAt),
      relayProvenance: after.relayProvenance,
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      // A Json column's JS null is a STORED JSON null — the legacy row's
      // explicitly-null capture tuple needs the SQL NULL.
      paymentClaims: Prisma.DbNull,
      proofId: null
    }
  })
}

async function applyOperation (tx, operation, context) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('repair operation: a plain operation object is required')
  }
  for (const key of Object.keys(operation)) {
    if (!OPERATION_KEYS.has(key)) throw new Error(`repair operation: unknown operation field ${key}`)
  }
  if (typeof operation.reason !== 'string' || operation.reason === '') {
    throw new Error('repair operation: every correction carries an exact reason')
  }
  if (operation.kind === 'update') return await applyUpdate(tx, operation, context)
  if (operation.kind === 'insert') {
    if (operation.before !== null) throw new Error('repair operation: an insert must have a null before')
    if (operation.table === 'FeeObservation') {
      if (operation.relayProof != null) throw new Error('repair operation: an insert does not carry a relay proof')
      return await applyFeeObservationInsert(tx, operation)
    }
    if (operation.table === 'RewardsWalletTransaction') return await applyJournalInsert(tx, operation, context)
    if (operation.relayProof != null) throw new Error('repair operation: an insert does not carry a relay proof')
    throw new Error('repair operation: inserts are limited to verified receipts and proved journal rows')
  }
  throw new Error('repair operation: unknown operation kind')
}

/**
 * Apply the closed operation vocabulary of an approved manifest. Every update
 * matches its before values and requires exactly one affected row; any mismatch
 * or constraint failure throws so the caller's transaction rolls back. A
 * PREPARED -> RELAYED journal transition requires the closed v2 relayProof to
 * match BOTH the approved evidence (`options.evidence`, digest-bound via
 * `options.evidenceDigest`) and the fresh re-verification collection
 * (`options.freshEvidence`).
 *
 * @param {object} tx Prisma transaction client.
 * @param {object[]} operations the manifest's approved operations.
 * @param {object} [options] `{ evidence, freshEvidence, evidenceDigest }`.
 */
export async function applyRepairOperations (tx, operations, options = {}) {
  if (!Array.isArray(operations)) throw new Error('applyRepairOperations: an operations array is required')
  const context = {
    relayEvidence: prepareRelayEvidence(options.evidence),
    freshEvidence: prepareRelayEvidence(options.freshEvidence ?? null),
    evidenceDigest: typeof options.evidenceDigest === 'string' ? options.evidenceDigest : null
  }
  for (const operation of operations) await applyOperation(tx, operation, context)
}

// The #1 store error codes that mean the TX proof master keys are unavailable
// (as opposed to a corrupt capture).
const TXPROOF_KEY_UNAVAILABLE_CODES = new Set([
  'TXPROOF_KEY_VERSION_MISSING',
  'TXPROOF_PROVIDER_INVALID',
  'TXPROOF_REGISTRY_INVALID',
  'TXPROOF_REGISTRY_KEY_INVALID',
  'TXPROOF_KEY_VERSION_INVALID'
])

const storeErrorCode = err => String(err?.message ?? '').split(':')[0]

// Exact replay probe: an APPLY audit row unique by manifest digest. The row's
// scope must match the manifest scope — a digest collision across scopes is
// corruption and refuses.
async function exactAppliedDigestExists (models, digest, scope) {
  const applied = await models.rewardsWalletReconciliation.findUnique({
    where: { digest_kind: { digest, kind: 'APPLY' } }
  })
  if (!applied) return false
  if (applied.network !== scope?.network || applied.walletAddress !== scope?.walletAddress) {
    throw new Error('applyRewardsReconciliation: the recorded APPLY audit row does not match the manifest scope')
  }
  return true
}

// All NEW versions only: a legacy-shaped manifest (or a manifest predating the
// current v2 audit identity) can never authorize a NEW unapplied repair.
// Proof-era authority additionally requires the v2 evidence contract.
function assertSupportedRepairVersions (manifest, evidence) {
  if (manifest.version !== 2) {
    throw new Error('applyRewardsReconciliation: an unsupported manifest version cannot authorize a new repair')
  }
  if (manifest.accountingFingerprintVersion !== ACCOUNTING_FINGERPRINT_VERSION) {
    throw new Error('applyRewardsReconciliation: the manifest predates the current accounting fingerprint version')
  }
  const evidenceVerifications = Array.isArray(evidence?.paymentVerifications)
    ? evidence.paymentVerifications
    : []
  const escrowVerifications = Array.isArray(evidence?.escrow?.paymentVerifications)
    ? evidence.escrow.paymentVerifications
    : []
  if ((evidenceVerifications.length > 0 || escrowVerifications.length > 0) &&
    normalizeEvidence(evidence).evidenceVersion !== 2) {
    throw new Error('applyRewardsReconciliation: payment verifications authorize repair only under the v2 evidence contract')
  }
}

// The approved boundary block must STILL be canonical on the live chain: a
// reorg below the approved boundary invalidates every fact the manifest was
// built from.
async function assertApprovedBoundaryCanonical (boundary, daemon) {
  if (typeof daemon?.getBlockHashByHeight !== 'function') {
    throw new Error('applyRewardsReconciliation: a daemon with getBlockHashByHeight is required to re-verify the approved boundary')
  }
  const liveHash = String(await daemon.getBlockHashByHeight(boundary.height)).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(liveHash) || liveHash !== boundary.blockHash) {
    throw new Error('applyRewardsReconciliation: the approved boundary block hash is no longer canonical; a new manifest and review are required')
  }
}

// Key-availability and authenticated-proof recheck through the #1 store (never
// through serialized user-supplied fresh evidence): every declared scoped
// proof is re-authenticated with real envelope crypto inside the applying
// transaction, its current store inventory must equal the declared snapshot
// inventory (a rotation with writers paused cannot slip through), and a
// complete fresh verification of the same payment — from the declared owner's
// OWN wallet role (final-review I2: REWARDS facts from the top-level
// collection, ESCROW facts from the nested escrow collection) — must agree
// with the store.
const freshVerificationsForRole = (fresh, role) => (role === 'ESCROW'
  ? fresh?.escrow?.paymentVerifications
  : fresh?.paymentVerifications)

async function assertProofInventoryAndKeyAccess (tx, ledger, fresh, keyProvider) {
  const declared = Array.isArray(ledger?.proofInventory) ? ledger.proofInventory : []
  for (const entry of declared) {
    if (entry?.proof == null) {
      throw new Error('applyRewardsReconciliation: a scoped journal declares a proof that cannot be read; key access cannot be re-verified')
    }
    let loaded
    try {
      loaded = await loadPaymentProof({
        models: tx,
        journalRole: entry.owner?.journalRole,
        journalId: entry.owner?.journalId,
        keyProvider
      })
    } catch (err) {
      const code = storeErrorCode(err)
      if (TXPROOF_KEY_UNAVAILABLE_CODES.has(code)) {
        throw new Error('applyRewardsReconciliation: the TX proof master keys are unavailable; a repair cannot re-verify the captured payments')
      }
      if (code === '' || err?.name === 'TypeError') throw err
      throw new Error(`applyRewardsReconciliation: the captured proof failed the store re-check (${code})`)
    }
    if (canonicalJson(loaded.inventory) !== canonicalJson(entry.proof)) {
      throw new Error('applyRewardsReconciliation: the stored proof revision/identity changed since approval; a rotation with paused writers is not applicable')
    }
    if (entry.owner?.journalRole === 'REWARDS' || entry.owner?.journalRole === 'ESCROW') {
      const role = entry.owner.journalRole
      const freshEntry = (Array.isArray(freshVerificationsForRole(fresh, role))
        ? freshVerificationsForRole(fresh, role)
        : [])
        .find(candidate => candidate?.txHash === entry.reference?.txHash &&
          String(candidate?.journalId ?? '') === String(entry.owner?.journalId))
      if (freshEntry && freshEntry.status === 'complete' && freshEntry.proofInventory != null &&
        canonicalJson(freshEntry.proofInventory) !== canonicalJson(loaded.inventory)) {
        throw new Error('applyRewardsReconciliation: the fresh collection disagrees with the stored proof inventory')
      }
    }
  }
}

// The APPLY audit row: the stored report is a WRAPPER around the untouched
// approved manifest plus the separately recorded `reverifiedAt` (the fresh
// collection's observation, when the collection carries one) — the manifest
// and its digest-bound `observedAt` are never regenerated.
async function insertApplyAudit (tx, manifest, backupReference, reverifiedAt) {
  const reverified = typeof reverifiedAt === 'string' && !Number.isNaN(Date.parse(reverifiedAt))
    ? reverifiedAt
    : null
  await tx.rewardsWalletReconciliation.create({
    data: {
      digest: manifest.digest,
      kind: 'APPLY',
      network: manifest.scope.network,
      walletAddress: manifest.scope.walletAddress,
      height: manifest.boundary.height,
      blockHash: manifest.boundary.blockHash,
      ledgerFingerprint: manifest.ledgerFingerprint,
      evidenceDigest: manifest.evidenceDigest,
      positiveDriftPiconeros: BigInt(manifest.after.positiveDriftPiconeros),
      report: { manifest, reverifiedAt: reverified },
      backupReference,
      appliedAt: new Date()
    }
  })
}

/**
 * Atomically apply an operator-confirmed accounting repair manifest, guarded
 * by a fresh cryptographic re-verification. The exact-digest replay probe
 * runs BEFORE any expensive chain verification (an already-applied manifest is
 * a no-op without adapting legacy operations), then the fresh read-only
 * collection happens OUTSIDE the financial transaction (never inside the 30s
 * interactive transaction, never inside a retried write): the approved
 * boundary must still be canonical, the stable chain facts unchanged, and
 * every complete approved payment must re-verify complete with identical
 * substantive facts.
 *
 * @param {object} input
 * @param {object} input.models Prisma client (an interactive transaction is opened here).
 * @param {object} input.manifest the approved manifest.
 * @param {string} input.confirmedDigest the SHA-256 the operator confirmed.
 * @param {string} input.backupReference the verified pre-repair backup reference.
 * @param {boolean} input.writersPaused explicit acknowledgement that financial writers are paused.
 * @param {object} input.evidence the approved evidence the manifest was built from.
 * @param {object} [deps] injectable seams (tests); production defaults.
 * @param {Function} [deps.collectEvidence] the trusted read-only collector
 *   (default #1 `collectRewardsWalletEvidence`); function-injected for tests.
 * @param {object} [deps.daemon] daemon client for the boundary canonical check.
 * @param {object} [deps.keyProvider] TX proof key provider (default built from the environment).
 * @returns {Promise<{applied: boolean, digest: string}>} `applied:false` on an exact replay.
 */
export async function applyRewardsReconciliation ({
  models,
  manifest,
  confirmedDigest,
  backupReference,
  writersPaused,
  evidence
} = {}, deps = {}) {
  const { collectEvidence = collectRewardsWalletEvidence, daemon = daemonClient } = deps
  if (!writersPaused) {
    throw new Error('applyRewardsReconciliation: paused financial writers are required before an apply')
  }
  if (typeof backupReference !== 'string' || backupReference.trim() === '') {
    throw new Error('applyRewardsReconciliation: a verified backup reference is required')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('applyRewardsReconciliation: an approved manifest is required')
  }
  if (confirmedDigest !== manifest.digest || manifestDigest(manifest) !== manifest.digest) {
    throw new Error('applyRewardsReconciliation: manifest confirmation mismatch')
  }
  if (!Array.isArray(manifest.issues) || manifest.issues.length > 0) {
    throw new Error('applyRewardsReconciliation: unresolved accounting evidence')
  }
  if (typeof models?.$transaction !== 'function') {
    throw new Error('applyRewardsReconciliation: models.$transaction is required')
  }

  // Replay first — BEFORE any fresh collection, boundary check or evidence
  // comparison: an already-applied manifest is a no-op even after later
  // legitimate activity, lost proof keys or a changed chain.
  if (await exactAppliedDigestExists(models, manifest.digest, manifest.scope)) {
    return { applied: false, digest: manifest.digest }
  }

  assertSupportedRepairVersions(manifest, evidence)

  // Fresh read-only collection, strictly before the financial transaction.
  const fresh = await collectEvidence({ models, scope: manifest.scope })

  await assertApprovedBoundaryCanonical(manifest.boundary, daemon)

  // Stable confirmed chain facts must be unchanged; the tip may advance while
  // the approved facts still hold. Then every complete approved payment must
  // re-verify complete with identical substantive facts.
  if (chainFactsFingerprint(fresh) !== chainFactsFingerprint(evidence)) {
    throw new Error('applyRewardsReconciliation: the fresh scan shows changed chain facts; a new manifest and review are required')
  }
  assertCompatiblePaymentReverification({ approved: evidence, fresh, approvedBoundary: manifest.boundary })

  const keyProvider = deps.keyProvider ?? createPaymentProofKeyProvider(process.env)
  return await models.$transaction(async tx => {
    // Serializable CAS: a concurrent application (or a DB change that moved
    // the world under us) is caught here before any write.
    if (await exactAppliedDigestExists(tx, manifest.digest, manifest.scope)) {
      return { applied: false, digest: manifest.digest }
    }
    const ledger = await readRepairLedger(tx, manifest.scope, { reserve: readRewardsAuditReserve() })
    assertRepairPreconditions(manifest, ledger, evidence)
    await assertProofInventoryAndKeyAccess(tx, ledger, fresh, keyProvider)
    await applyRepairOperations(tx, manifest.operations, {
      evidence,
      freshEvidence: fresh,
      evidenceDigest: manifest.evidenceDigest
    })
    await insertApplyAudit(tx, manifest, backupReference, fresh.observedAt)
    return { applied: true, digest: manifest.digest }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 })
}
