import { Prisma } from '@prisma/client'
import {
  assertRepairPreconditions,
  journalRelayEvidenceMismatch,
  manifestDigest,
  normalizeEvidence,
  readRepairLedger
} from '@/api/monero/rewardsReconciliation'

// Atomic application of an approved accounting repair manifest (rewards
// accounting repair §8, Task 13). The manifest is the ONLY repair authority:
// this module verifies the operator confirmed its exact SHA-256 digest, then
// applies its CLOSED operation vocabulary inside ONE Serializable transaction
// that re-reads every precondition first. Any mismatch throws and rolls back
// every financial correction AND the audit row together — there is no partial
// repair.
//
// Replay safety is structural: an APPLY audit row is unique by manifest digest,
// and the digest check runs BEFORE the precondition comparison, so re-running
// an already-applied manifest after later legitimate activity is still a
// no-op while a different (unapplied) manifest can never slip through.
//
// This module never signs, sends, sweeps, opens a wallet, imports a signer /
// delivery / recovery operation, or accepts an arbitrary Prisma table / field
// mutation: the dispatcher below is a closed allowlist.

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
// transition must carry (validated against the approved evidence).
const OPERATION_KEYS = new Set(['kind', 'table', 'id', 'txHash', 'key', 'network', 'walletAddress', 'before', 'after', 'relayProof', 'reason', 'sweepAccounting'])

const RELAY_PROOF_FIELDS = ['txHash', 'accountIndex', 'height', 'feePiconeros', 'destinations']

// Closed update allowlists per table. Payout/Earn rows, reward totals, payout
// states/hashes and a distribution's actual opsSwept principal/hash can never
// appear in a before/after pair. A journal `state`/`relayedAt` pair is accepted
// ONLY as the proved PREPARED-with-attempt -> RELAYED transition (validated in
// applyUpdate); it can never touch a payout row.
const UPDATE_FIELDS = {
  FeeObservation: new Set(['piconeros', 'rewardsPiconeros', 'walletReceipt']),
  RewardsWalletTransaction: new Set(['networkFeePiconeros', 'state', 'relayedAt']),
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

// The approved evidence projection a journal transition may rely on: the scoped
// outgoing facts plus the wallet-owned address set. Built ONCE per apply; the
// evidence itself was digest-verified by assertRepairPreconditions before any
// financial write.
function prepareRelayEvidence (evidence) {
  if (evidence == null) return null
  const normalized = normalizeEvidence(evidence)
  return {
    scope: normalized.scope,
    ownedAddresses: new Set([
      normalized.scope?.walletAddress,
      ...normalized.derivation.derived.map(entry => entry.address)
    ].filter(Boolean)),
    outgoing: normalized.outgoing
  }
}

function sameDestinationSet (a, b) {
  const key = list => list.map(destination => `${destination.address}:${destination.amountPiconeros}`).sort().join('|')
  return key(a) === key(b)
}

// A PREPARED-with-attempt -> RELAYED transition is authorized ONLY by an exact
// evidence linkage: the operation must carry a `relayProof` naming the scoped
// transaction, and the approved evidence must contain the CONFIRMED owned
// outgoing entry whose account/height/fee/destinations match the proof exactly.
// The recorded relay ATTEMPT alone NEVER authorizes the transition.
function assertRelayProof (operation, context) {
  if (!context?.relayEvidence) {
    throw new Error('repair operation: a journal state transition requires the approved chain evidence')
  }
  const proof = operation.relayProof
  if (proof == null) {
    throw new Error('repair operation: a journal state transition requires its exact relayProof')
  }
  requirePlainObject(proof, 'relayProof')
  requireExactKeys(proof, RELAY_PROOF_FIELDS, 'relayProof')
  const txHash = requireHash(proof.txHash, 'relayProof.txHash')
  if (txHash !== operation.txHash) {
    throw new Error('repair operation: the relay proof hash does not match the journal update')
  }
  const accountIndex = requireSafeInteger(proof.accountIndex, 'relayProof.accountIndex')
  const height = requireSafeInteger(proof.height, 'relayProof.height')
  requireDecimal(proof.feePiconeros, 'relayProof.feePiconeros')
  if (!Array.isArray(proof.destinations) || proof.destinations.length === 0) {
    throw new Error('repair operation: the relay proof must carry its exact destinations')
  }
  for (const destination of proof.destinations) {
    requirePlainObject(destination, 'relayProof destination')
    requireExactKeys(destination, ['address', 'amountPiconeros'], 'relayProof destination')
    if (typeof destination.address !== 'string' || destination.address.trim() === '') {
      throw new Error('repair operation: a relay proof destination address is not configured')
    }
    requireDecimal(destination.amountPiconeros, 'relayProof destination amount')
  }

  const evidence = context.relayEvidence
  if (evidence.scope?.network !== operation.network || evidence.scope?.walletAddress !== operation.walletAddress) {
    throw new Error('repair operation: the approved evidence scope does not match the journal update')
  }
  const entry = evidence.outgoing.find(candidate =>
    candidate.txHash === txHash &&
    candidate.accountIndex === accountIndex &&
    candidate.isConfirmed === true &&
    candidate.inTxPool !== true)
  if (!entry) {
    throw new Error('repair operation: the approved evidence does not prove a confirmed outgoing relay for this transaction')
  }
  if (entry.height !== height || entry.feePiconeros !== proof.feePiconeros) {
    throw new Error('repair operation: the relay proof height/fee do not match the approved evidence')
  }
  if (!sameDestinationSet(entry.destinations, proof.destinations)) {
    throw new Error('repair operation: the relay proof destinations do not match the approved evidence')
  }
  return entry
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

  // A state transition is ONLY the proved PREPARED-with-attempt -> RELAYED pair:
  // state and relayedAt always travel together, the before state is PREPARED,
  // relayedAt was unset and becomes a real timestamp, and the transaction must
  // be proven by matching approved chain evidence (a relay attempt is not a
  // relay). Any other state transition — and any payout state — is refused.
  const hasState = Object.prototype.hasOwnProperty.call(operation.before, 'state')
  const hasRelayedAt = Object.prototype.hasOwnProperty.call(operation.before, 'relayedAt')
  if (hasState || hasRelayedAt) {
    if (operation.table !== 'RewardsWalletTransaction' || !hasState || !hasRelayedAt) {
      throw new Error('repair operation: only a proved PREPARED -> RELAYED journal transition may change state/relayedAt')
    }
    if (operation.before.state !== 'PREPARED' || operation.after.state !== 'RELAYED') {
      throw new Error('repair operation: the only journal state transition is PREPARED -> RELAYED')
    }
    if (operation.before.relayedAt !== null) {
      throw new Error('repair operation: an unresolved relay has no relayedAt yet')
    }
    if (typeof operation.after.relayedAt !== 'string') {
      throw new Error('repair operation: a proved relay transition carries a real relayedAt timestamp')
    }
    // Exact approved chain evidence: a confirmed owned outgoing entry matching
    // hash, account, height, fee and destinations; plus the row's own journal
    // facts (members / sweep destination / consolidation self-transfer) must
    // match that same entry.
    const entry = assertRelayProof(operation, context)
    const row = await tx.rewardsWalletTransaction.findUnique({
      where: {
        network_walletAddress_txHash: {
          network: operation.network,
          walletAddress: operation.walletAddress,
          txHash: operation.txHash
        }
      }
    })
    if (!row || row.state !== 'PREPARED' || row.relayedAt != null) {
      throw new Error('repair operation: the journal row is not an unresolved PREPARED relay')
    }
    if (row.relayAttemptedAt == null) {
      throw new Error('repair operation: the journal row has no recorded relay attempt')
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
    if (entry.feePiconeros == null || finalFee !== BigInt(entry.feePiconeros)) {
      throw new Error('repair operation: the transitioned journal fee does not match the approved relay fee')
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

// One proved journal row insert (a confirmed wallet relay the journal never
// recorded). Only RELAYED facts with a real hash and parseable closed metadata
// are accepted; `relayAttemptedAt` must be null (an attempted-but-unresolved
// send is never inserted as a fact).
async function applyJournalInsert (tx, operation) {
  const after = operation.after
  requirePlainObject(after, 'after')
  requireExactKeys(after, JOURNAL_INSERT_FIELDS, 'RewardsWalletTransaction insert')
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
    if (operation.relayProof != null) throw new Error('repair operation: an insert does not carry a relay proof')
    if (operation.table === 'FeeObservation') return await applyFeeObservationInsert(tx, operation)
    if (operation.table === 'RewardsWalletTransaction') return await applyJournalInsert(tx, operation)
    throw new Error('repair operation: inserts are limited to verified receipts and proved journal rows')
  }
  throw new Error('repair operation: unknown operation kind')
}

/**
 * Apply the closed operation vocabulary of an approved manifest. Every update
 * matches its before values and requires exactly one affected row; any mismatch
 * or constraint failure throws so the caller's transaction rolls back. A
 * PREPARED -> RELAYED journal transition additionally requires the APPROVED
 * evidence to prove the exact relay (pass it as `options.evidence`).
 *
 * @param {object} tx Prisma transaction client.
 * @param {object[]} operations the manifest's approved operations.
 * @param {object} [options] `{ evidence }` — the approved chain evidence.
 */
export async function applyRepairOperations (tx, operations, options = {}) {
  if (!Array.isArray(operations)) throw new Error('applyRepairOperations: an operations array is required')
  const context = { relayEvidence: prepareRelayEvidence(options.evidence) }
  for (const operation of operations) await applyOperation(tx, operation, context)
}

/**
 * Atomically apply an operator-confirmed accounting repair manifest.
 *
 * @param {object} input
 * @param {object} input.models Prisma client (an interactive transaction is opened here).
 * @param {object} input.manifest the approved manifest.
 * @param {string} input.confirmedDigest the SHA-256 the operator confirmed.
 * @param {string} input.backupReference the verified pre-repair backup reference.
 * @param {boolean} input.writersPaused explicit acknowledgement that financial writers are paused.
 * @param {object} input.evidence the approved evidence the manifest was built from.
 * @returns {Promise<{applied: boolean, digest: string}>} `applied:false` on an exact replay.
 */
export async function applyRewardsReconciliation ({
  models,
  manifest,
  confirmedDigest,
  backupReference,
  writersPaused,
  evidence
} = {}) {
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

  return await models.$transaction(async tx => {
    // Replay first: an already-applied manifest is a no-op even after later
    // legitimate activity changed the preconditions.
    const applied = await tx.rewardsWalletReconciliation.findUnique({
      where: { digest_kind: { digest: manifest.digest, kind: 'APPLY' } }
    })
    if (applied) return { applied: false, digest: manifest.digest }

    const ledger = await readRepairLedger(tx, manifest.scope)
    assertRepairPreconditions(manifest, ledger, evidence)
    await applyRepairOperations(tx, manifest.operations, { evidence })

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
        report: manifest,
        backupReference,
        appliedAt: new Date()
      }
    })
    return { applied: true, digest: manifest.digest }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 })
}
