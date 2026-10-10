import {
  paymentVerificationFacts,
  validatePaymentVerification
} from '@/api/monero/paymentVerification'

// Closed version-2 relay-proof operation construction (rewards reconciliation
// plan, Task 3). PURE: this module reads no DB, opens no wallet, signs
// nothing, relays nothing and never mutates its inputs. It is the ONLY
// authority for turning one verifier-checked confirmed whole payment into the
// journal's PREPARED -> RELAYED update operation, and it fails closed: every
// refusal carries a fixed `code` (never arbitrary SDK errors) and no
// operation is produced unless EVERY contract check passes.
//
// The exact relayProof field list is a closed contract shared with the APPLY
// dispatcher (plan Task 5): `version, evidenceDigest, verificationVersion,
// scope, journalRole, journalId, dispatchId, captureMode, txHash, claimDigest,
// proofInventory, sourceAccounts, members, receivingAggregates,
// ownedAccounting, totals, confirmation, verifierVersion, sdkVersion,
// provenance, survivingEvidenceDigest, observedAt`. The substantive fields are
// projected through #1's `paymentVerificationFacts` (stable historical facts
// only: confirmation is height + block hash, aggregates drop advancing
// confirmation counts, owned outputs drop the later `isSpent` state); the
// operation identity fields (`version`, `evidenceDigest`, `observedAt`) plus
// the verifier identity fields and the surviving-evidence digest close the
// shape. Volatile facts and the result's status/issue echo never enter it.
//
// `observedAt` is the facts-checked-at time of the approved collection — the
// operation's `relayedAt` records when the relay was PROVEN, never a
// reconstructed broadcast time.

export const RELAY_PROOF_VERSION = 2
export const RELAY_PROVENANCE = 'chain-proof-observation'
export const RELAY_OPERATION_REASON = 'confirmed-complete-payment'

const RELAY_PROOF_FIELDS = Object.freeze([
  'version', 'evidenceDigest', 'verificationVersion', 'scope', 'journalRole',
  'journalId', 'dispatchId', 'captureMode', 'txHash', 'claimDigest',
  'proofInventory', 'sourceAccounts', 'members', 'receivingAggregates',
  'ownedAccounting', 'totals', 'confirmation', 'verifierVersion', 'sdkVersion',
  'provenance', 'survivingEvidenceDigest', 'observedAt'
])

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const refusal = (code, reason) => {
  const error = new Error(`${code}: ${reason}`)
  error.name = 'RewardsRelayProofRefusal'
  error.code = code
  return error
}

const HEX_64 = /^[0-9a-f]{64}$/
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NETWORKS = new Set(['STAGENET', 'MAINNET'])
const CAPTURE_MODES = new Set(['CAPTURE_V1', 'LEGACY_SURVIVING_PROOF'])

// Deterministic comparison form for fact objects: object keys sorted at every
// level, array order preserved (member order is itself a substantive fact).
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Closed-shape validator for the shared v2 relayProof contract (plan Task 5).
 * The APPLY dispatcher accepts a relayProof only when this holds; the
 * substantive comparison against the approved AND fresh verifier facts is the
 * caller's (it needs both collections). Never throws — returns a boolean.
 *
 * @param {object} proof a candidate relayProof
 * @returns {boolean}
 */
export function validateJournalRelayProof (proof) {
  if (!isPlainObject(proof)) return false
  if (Object.keys(proof).sort().join(',') !== RELAY_PROOF_FIELDS.slice().sort().join(',')) return false
  if (proof.version !== RELAY_PROOF_VERSION) return false
  if (typeof proof.evidenceDigest !== 'string' || !HEX_64.test(proof.evidenceDigest)) return false
  if (proof.journalRole !== 'REWARDS' && proof.journalRole !== 'ESCROW') return false
  if (!isPlainObject(proof.scope) || !NETWORKS.has(proof.scope.network) ||
    typeof proof.scope.walletAddress !== 'string' || proof.scope.walletAddress === '') return false
  if (proof.journalId !== null &&
    (typeof proof.journalId !== 'string' || !CANONICAL_UNSIGNED.test(proof.journalId))) return false
  if (proof.dispatchId !== null &&
    (typeof proof.dispatchId !== 'string' || !UUID_RE.test(proof.dispatchId))) return false
  if (!CAPTURE_MODES.has(proof.captureMode)) return false
  if (typeof proof.txHash !== 'string' || !HEX_64.test(proof.txHash)) return false
  if (proof.claimDigest !== null &&
    (typeof proof.claimDigest !== 'string' || !HEX_64.test(proof.claimDigest))) return false
  if (proof.proofInventory !== null && !isPlainObject(proof.proofInventory)) return false
  if (!Array.isArray(proof.sourceAccounts) ||
    !proof.sourceAccounts.every(account => typeof account === 'string' && CANONICAL_UNSIGNED.test(account))) return false
  if (!Array.isArray(proof.members) || proof.members.some(member => !isPlainObject(member))) return false
  if (!Array.isArray(proof.receivingAggregates) ||
    proof.receivingAggregates.some(aggregate => !isPlainObject(aggregate))) return false
  if (!isPlainObject(proof.ownedAccounting) || !Array.isArray(proof.ownedAccounting.outputs)) return false
  if (!isPlainObject(proof.totals)) return false
  if (!isPlainObject(proof.confirmation) ||
    !(proof.confirmation.height === null || Number.isSafeInteger(proof.confirmation.height)) ||
    !(proof.confirmation.blockHash === null ||
      (typeof proof.confirmation.blockHash === 'string' && HEX_64.test(proof.confirmation.blockHash)))) return false
  if (typeof proof.verifierVersion !== 'string' || proof.verifierVersion === '') return false
  if (typeof proof.sdkVersion !== 'string' || proof.sdkVersion === '') return false
  if (typeof proof.provenance !== 'string' || proof.provenance === '') return false
  if (proof.survivingEvidenceDigest !== null &&
    (typeof proof.survivingEvidenceDigest !== 'string' || !HEX_64.test(proof.survivingEvidenceDigest))) return false
  if (typeof proof.observedAt !== 'string' || Number.isNaN(Date.parse(proof.observedAt))) return false
  // Capture-mode cross constraints mirror the verifier's own result contract:
  // a capture-era proof carries its capture identity and no surviving digest;
  // a legacy surviving-evidence proof carries no capture identity at all.
  if (proof.captureMode === 'CAPTURE_V1' &&
    (proof.dispatchId === null || proof.claimDigest === null || proof.proofInventory === null ||
      proof.survivingEvidenceDigest !== null)) return false
  if (proof.captureMode === 'LEGACY_SURVIVING_PROOF' &&
    (proof.dispatchId !== null || proof.claimDigest !== null || proof.proofInventory !== null)) return false
  return true
}

// Role-scoped verification slots: a REWARDS entry binds to the collection's
// top-level wallet scope, an ESCROW entry to the nested escrow wallet scope
// (final-review I2). The slot identity carries role, scope and hash, so
// same-hash results from the two wallet roles can never alias each other.
const slotEntries = value => (Array.isArray(value) ? value : [])

const verificationEntries = evidence => [
  ...slotEntries(evidence?.paymentVerifications).map(entry => ({
    entry,
    role: 'REWARDS',
    network: evidence?.scope?.network ?? null,
    walletAddress: evidence?.scope?.walletAddress ?? null
  })),
  ...slotEntries(evidence?.escrow?.paymentVerifications).map(entry => ({
    entry,
    role: 'ESCROW',
    network: evidence?.scope?.network ?? null,
    walletAddress: evidence?.escrow?.walletAddress ?? null
  }))
]

const slotKey = item => `${item.role}:${item.network}:${item.walletAddress}:${item.entry.txHash}`

// Conflict-safe slot index (final-review I2; fix round 2): two results for
// one role/scope/hash bind the slot only when they are the SAME journal
// identity with identical substantive facts AND the same surviving-proof
// identity (the stable facts projection excludes the surviving evidence
// digest, so it is compared separately). Any disagreement poisons the slot
// (null) — and a poisoned slot is a REFUSAL downstream, never a skip, whether
// or not the approved collection relied on it.
const slotIndex = items => {
  const index = new Map()
  for (const item of items) {
    const key = slotKey(item)
    const prior = index.get(key)
    if (prior !== undefined) {
      if (prior === null ||
        String(prior.journalId) !== String(item.entry.journalId) ||
        (prior.survivingEvidenceDigest ?? null) !== (item.entry.survivingEvidenceDigest ?? null) ||
        canonicalJson(paymentVerificationFacts(prior)) !==
          canonicalJson(paymentVerificationFacts(item.entry))) {
        index.set(key, null)
      }
      continue
    }
    index.set(key, item.entry)
  }
  return index
}

/**
 * Guarded re-verification comparison (plan Task 5; final-review I2): the
 * fresh read-only collection must still prove EVERY complete payment the
 * approved collection proved — in BOTH wallet roles, each under its own
 * independently bound scope — with IDENTICAL substantive facts. Advancing
 * confirmation counts, the advancing fresh boundary and the later recheck
 * time are permitted, while the approved mined height/block hash stays
 * canonical. Fresh absence, a pool downgrade, key loss or any other
 * non-complete downgraded result invalidates a complete proof; a conflicting
 * duplicate for one role/scope/hash never binds; and a NEW complete fact the
 * approved audit never carried requires a new manifest and review. Approved
 * evidence stays separate from the fresh verification: nothing here mutates
 * either input.
 *
 * @param {{
 *   approved: object,
 *   fresh: object,
 *   approvedBoundary: {height: number, blockHash: string}
 * }} request the approved normalized collection, the fresh collection and the
 *   manifest's approved boundary.
 * @returns {void} throws on every incompatibility.
 */
export function assertCompatiblePaymentReverification ({ approved, fresh, approvedBoundary } = {}) {
  if (!isPlainObject(approved) || !isPlainObject(fresh)) {
    throw new Error('re-verification: the approved and fresh collections are required')
  }
  // The fresh tip may advance, but never below the approved boundary — and at
  // the approved boundary height the approved block hash must still stand.
  if (isPlainObject(fresh.boundary) && Number.isSafeInteger(fresh.boundary.height) &&
    isPlainObject(approvedBoundary) && Number.isSafeInteger(approvedBoundary.height) &&
    (fresh.boundary.height < approvedBoundary.height ||
      (fresh.boundary.height === approvedBoundary.height &&
        fresh.boundary.blockHash !== approvedBoundary.blockHash))) {
    throw new Error('re-verification: the fresh collection boundary is behind or off the approved boundary')
  }

  const approvedItems = verificationEntries(approved)
  const freshItems = verificationEntries(fresh)
  if (approvedItems.length === 0 && freshItems.length === 0) return

  // Proof-era authority binds both collections to the v2 evidence contract
  // with an explicit fresh observation time (never a report's success flag).
  // The checks run whenever ANY role carries verifications — nested escrow
  // facts are as binding as top-level rewards facts.
  if (approved.evidenceVersion !== 2 || fresh.evidenceVersion !== 2) {
    throw new Error('re-verification: payment verifications authorize repair only under the v2 evidence contract')
  }
  if (typeof fresh.observedAt !== 'string' || Number.isNaN(Date.parse(fresh.observedAt))) {
    throw new Error('re-verification: the fresh collection carries no observation time')
  }
  if (!isPlainObject(approved.scope) || !isPlainObject(fresh.scope) ||
    approved.scope.network !== fresh.scope.network ||
    approved.scope.walletAddress !== fresh.scope.walletAddress) {
    throw new Error('re-verification: the fresh collection scope does not match the approved collection')
  }
  // The escrow wallet is its own independently bound scope: a collection with
  // ESCROW facts must name the SAME registered escrow wallet on both sides.
  if (approvedItems.some(item => item.role === 'ESCROW') || freshItems.some(item => item.role === 'ESCROW')) {
    if (typeof approved.escrow?.walletAddress !== 'string' || approved.escrow.walletAddress === '' ||
      approved.escrow.walletAddress !== fresh.escrow?.walletAddress) {
      throw new Error('re-verification: the fresh collection escrow scope does not match the approved collection')
    }
  }
  for (const { entry } of [...approvedItems, ...freshItems]) {
    if (!isPlainObject(entry) || !validatePaymentVerification(entry)) {
      throw new Error('re-verification: a collected payment verification is not a safe PaymentVerificationV1 result')
    }
  }
  // Independent scope binding: each result must carry its own slot's role and
  // wallet identity — a misplaced result (an ESCROW result in the rewards
  // slot, or any result naming another wallet) never authorizes coverage.
  for (const { entry, role, network, walletAddress } of [...approvedItems, ...freshItems]) {
    if (entry.journalRole !== role ||
      entry.scope?.network !== network ||
      entry.scope?.walletAddress !== walletAddress) {
      throw new Error(`re-verification: ${slotKey({ entry, role, network, walletAddress })} is bound to another wallet scope or journal role`)
    }
  }

  const approvedByKey = slotIndex(approvedItems)
  const freshByKey = slotIndex(freshItems)
  for (const [key, approvedEntry] of [...approvedByKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (approvedEntry === null) {
      throw new Error(`re-verification: the approved collection carries conflicting results for ${key}; a conflict never binds`)
    }
    if (approvedEntry.status !== 'complete') continue
    const freshEntry = freshByKey.get(key)
    if (freshEntry === null) {
      throw new Error(`re-verification: ${key} carries conflicting fresh results; a conflict never re-proves a complete payment`)
    }
    if (!freshEntry) {
      throw new Error(`re-verification: the fresh collection no longer proves ${key}; fresh absence invalidates a complete proof`)
    }
    if (freshEntry.status !== 'complete') {
      throw new Error(`re-verification: ${key} no longer verifies complete (fresh absence, a pool downgrade or lost keys invalidate a complete proof)`)
    }
    if (String(freshEntry.journalId) !== String(approvedEntry.journalId)) {
      throw new Error(`re-verification: ${key} is bound to another journal identity in the fresh collection`)
    }
    if (freshEntry.captureMode !== approvedEntry.captureMode) {
      throw new Error(`re-verification: ${key} changed its capture mode between collections`)
    }
    if (freshEntry.verificationVersion !== approvedEntry.verificationVersion ||
      freshEntry.verifierVersion !== approvedEntry.verifierVersion ||
      freshEntry.sdkVersion !== approvedEntry.sdkVersion) {
      throw new Error(`re-verification: ${key} was re-verified by another verifier generation`)
    }
    if ((freshEntry.survivingEvidenceDigest ?? null) !== (approvedEntry.survivingEvidenceDigest ?? null)) {
      throw new Error(`re-verification: ${key} no longer carries the same surviving evidence`)
    }
    // #1's stable-facts projection carries the comparison: advancing
    // confirmation counts, the advancing boundary and the later recheck time
    // never enter it, while any substantive change does.
    if (canonicalJson(paymentVerificationFacts(freshEntry)) !==
      canonicalJson(paymentVerificationFacts(approvedEntry))) {
      throw new Error(`re-verification: ${key} changed substantive facts; a new manifest and review are required`)
    }
  }
  for (const [key, freshEntry] of [...freshByKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // A conflicting fresh slot is a refusal in its own right — including a
    // slot the approved collection never carried (fix round 2: two freshly
    // complete results disagreeing for one unapproved hash are both hidden by
    // a skip, so the conflict itself refuses).
    if (freshEntry === null) {
      throw new Error(`re-verification: ${key} carries conflicting fresh results; a conflict is itself a refusal`)
    }
    if (freshEntry.status !== 'complete') continue
    const approvedEntry = approvedByKey.get(key)
    if (!approvedEntry || approvedEntry === null || approvedEntry.status !== 'complete') {
      throw new Error(`re-verification: the fresh collection proves ${key} but the approved manifest never carried it; a new manifest and review are required`)
    }
  }
}

// Do the journal's frozen members describe exactly the same multiset of
// payments the verifier proved? Address + exact actual amount, duplicates
// significant, order never significant.
const membersMismatch = (journalMembers, verificationMembers) => {
  if (!Array.isArray(journalMembers) || journalMembers.length === 0) return 'unreadable journal members'
  if (!Array.isArray(verificationMembers) || journalMembers.length !== verificationMembers.length) {
    return 'the proved payment does not have the journal\'s member count'
  }
  const expected = []
  for (const member of journalMembers) {
    const address = typeof member?.recipientAddress === 'string' ? member.recipientAddress : null
    let amount = null
    try {
      amount = member?.piconeros == null ? null : BigInt(member.piconeros)
    } catch {}
    if (address == null || amount == null || amount < 0n) return 'a journal member is unreadable'
    expected.push(`${amount}:${address}`)
  }
  const remaining = verificationMembers.map(member => `${BigInt(member.actualPiconeros)}:${member.address}`)
  for (const wanted of expected) {
    const index = remaining.indexOf(wanted)
    if (index === -1) return 'journal members do not match the proved payment members'
    remaining.splice(index, 1)
  }
  return null
}

const chronologyMismatch = ({ row, verification, collectionStartedAt, collectedAt }) => {
  if (typeof row.preparedAt !== 'string') return 'the journal preparation time is unreadable'
  const preparedAt = Date.parse(row.preparedAt)
  const attemptedAt = Date.parse(row.relayAttemptedAt)
  const observedAt = Date.parse(verification.observedAt)
  if (Number.isNaN(preparedAt) || Number.isNaN(attemptedAt) || Number.isNaN(observedAt)) {
    return 'the preparation/attempt/observation chronology is unreadable'
  }
  if (preparedAt > attemptedAt) return 'the relay attempt precedes the journal preparation'
  if (attemptedAt > observedAt) return 'the observation precedes the recorded relay attempt'
  if (typeof collectionStartedAt !== 'string' || typeof collectedAt !== 'string') {
    return 'the approved collection observation is unreadable'
  }
  const startedAt = Date.parse(collectionStartedAt)
  const collectionObservedAt = Date.parse(collectedAt)
  if (Number.isNaN(startedAt) || Number.isNaN(collectionObservedAt)) {
    return 'the approved collection observation is unreadable'
  }
  if (observedAt < startedAt || observedAt > collectionObservedAt) {
    return 'the observation instant lies outside the approved collection window'
  }
  return null
}

/**
 * Build the single closed v2 relay operation that promotes one attempted
 * PREPARED rewards journal row to RELAYED from proved confirmed
 * complete-payment evidence. Throws (fixed `code`) on every contract breach —
 * the caller records the code as the exact blocking issue.
 *
 * @param {{
 *   row: object,
 *   verification: object,
 *   evidenceDigest: string,
 *   collectionStartedAt?: string|null,
 *   collectedAt?: string|null
 * }} request `row` is the NORMALIZED journal row (safe projection),
 *   `verification` a PaymentVerificationV1 result, `evidenceDigest` the
 *   approved normalized-collection digest, and the two collection instants
 *   bound the approved observation window.
 * @returns {object} the update operation with its closed relayProof
 */
export function buildJournalRelayOperation ({ row, verification, evidenceDigest, collectionStartedAt, collectedAt }) {
  if (!isPlainObject(row) || !isPlainObject(verification)) {
    throw refusal('RELAY_PROOF_REQUEST_INVALID', 'a journal row and a verification result are required')
  }
  if (typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest)) {
    throw refusal('RELAY_PROOF_REQUEST_INVALID', 'the approved evidence digest is required')
  }
  if (!validatePaymentVerification(verification)) {
    throw refusal('RELAY_PROOF_VERIFICATION_INVALID', 'the verification result is not a safe PaymentVerificationV1 object')
  }
  if (verification.status !== 'complete') {
    throw refusal('RELAY_PROOF_NOT_COMPLETE', 'only a complete confirmed whole-payment verification promotes a relay')
  }
  if (verification.journalRole !== 'REWARDS') {
    throw refusal('RELAY_PROOF_ROLE_MISMATCH', 'rewards journal promotion binds a REWARDS verification')
  }
  if (row.state !== 'PREPARED') {
    throw refusal('RELAY_PROOF_STATE_MISMATCH', 'only a PREPARED journal row is promoted')
  }
  if (typeof row.relayAttemptedAt !== 'string') {
    throw refusal('RELAY_PROOF_ATTEMPT_MISSING', 'the journal row records no relay attempt')
  }
  if (verification.txHash !== row.txHash) {
    throw refusal('RELAY_PROOF_TX_MISMATCH', 'the verification proves a different transaction hash')
  }
  if (verification.journalId == null || String(verification.journalId) !== String(row.id)) {
    throw refusal('RELAY_PROOF_JOURNAL_MISMATCH', 'the verification is bound to another journal row identity')
  }
  if (!verification.scope || verification.scope.network !== row.network ||
    verification.scope.walletAddress !== row.walletAddress) {
    throw refusal('RELAY_PROOF_SCOPE_MISMATCH', 'the verification scope does not match the journal row scope')
  }
  const chronology = chronologyMismatch({ row, verification, collectionStartedAt, collectedAt })
  if (chronology !== null) {
    throw refusal(
      observedAtOutsideCollection(verification.observedAt, collectionStartedAt, collectedAt)
        ? 'RELAY_PROOF_OBSERVATION_OUTSIDE_COLLECTION'
        : 'RELAY_PROOF_CHRONOLOGY_MISMATCH',
      chronology)
  }

  // Membership: the journal's frozen authority must be exactly what the
  // verifier proved. (The journal-vs-recorded-ledger membership was already
  // validated by the builder's own journal-fact pass.)
  if (row.kind === 'PAYOUT') {
    const mismatch = membersMismatch(row.metadata?.payouts, verification.members)
    if (mismatch !== null) throw refusal('RELAY_PROOF_MEMBER_MISMATCH', mismatch)
  } else if (row.kind === 'OPS_SWEEP') {
    const destination = row.metadata?.destination
    if (typeof destination !== 'string' || destination === '') {
      throw refusal('RELAY_PROOF_MEMBER_MISMATCH', 'unreadable sweep destination')
    }
    if (verification.members.length !== 1 || verification.members[0].address !== destination) {
      throw refusal('RELAY_PROOF_MEMBER_MISMATCH', 'the proved payment is not the single recorded sweep destination')
    }
    const proved = BigInt(verification.members[0].actualPiconeros)
    if (row.principalPiconeros == null || proved !== row.principalPiconeros) {
      throw refusal('RELAY_PROOF_MEMBER_MISMATCH', 'the proved sweep principal does not match the journal principal')
    }
  } else if (row.kind !== 'CONSOLIDATION') {
    throw refusal('RELAY_PROOF_MEMBER_MISMATCH', 'unknown journal kind')
  }

  // Captured proof-era fees are immutable: the journal's recorded fee must
  // equal the verified raw fee exactly. A legacy row (independently surviving
  // evidence) may carry a missing or wrong bookkeeping fee — the verified raw
  // fee corrects it inside THIS operation, never in a second update.
  const verifiedFee = verification.totals.F
  let feeCorrection = null
  if (verification.captureMode === 'CAPTURE_V1') {
    if (verifiedFee == null || row.networkFeePiconeros == null || row.networkFeePiconeros !== BigInt(verifiedFee)) {
      throw refusal('RELAY_PROOF_FEE_MISMATCH', 'the journal recorded fee contradicts the immutable captured fee')
    }
  } else if (verifiedFee != null && (row.networkFeePiconeros == null || row.networkFeePiconeros !== BigInt(verifiedFee))) {
    feeCorrection = { before: row.networkFeePiconeros == null ? null : row.networkFeePiconeros.toString(), after: verifiedFee }
  }

  const facts = paymentVerificationFacts(verification)
  const relayProof = {
    version: RELAY_PROOF_VERSION,
    evidenceDigest,
    verificationVersion: verification.verificationVersion,
    scope: facts.scope,
    journalRole: facts.journalRole,
    journalId: facts.journalId,
    dispatchId: facts.dispatchId,
    captureMode: facts.captureMode,
    txHash: facts.txHash,
    claimDigest: facts.claimDigest,
    proofInventory: facts.proofInventory,
    sourceAccounts: facts.sourceAccounts,
    members: facts.members,
    receivingAggregates: facts.receivingAggregates,
    ownedAccounting: facts.ownedAccounting,
    totals: facts.totals,
    confirmation: facts.confirmation,
    verifierVersion: verification.verifierVersion,
    sdkVersion: verification.sdkVersion,
    provenance: facts.provenance,
    survivingEvidenceDigest: verification.survivingEvidenceDigest,
    observedAt: verification.observedAt
  }
  if (Object.keys(relayProof).sort().join(',') !== RELAY_PROOF_FIELDS.slice().sort().join(',')) {
    throw refusal('RELAY_PROOF_SHAPE_INVALID', 'the closed relayProof field contract is violated')
  }

  const before = { state: 'PREPARED', relayedAt: null, relayProvenance: null }
  const after = { state: 'RELAYED', relayedAt: verification.observedAt, relayProvenance: RELAY_PROVENANCE }
  if (feeCorrection !== null) {
    before.networkFeePiconeros = feeCorrection.before
    after.networkFeePiconeros = feeCorrection.after
  }
  return {
    kind: 'update',
    table: 'RewardsWalletTransaction',
    txHash: row.txHash,
    network: row.network,
    walletAddress: row.walletAddress,
    before,
    after,
    relayProof,
    reason: RELAY_OPERATION_REASON
  }
}

const observedAtOutsideCollection = (observedAt, collectionStartedAt, collectedAt) => {
  const observed = Date.parse(observedAt)
  const started = typeof collectionStartedAt === 'string' ? Date.parse(collectionStartedAt) : Number.NaN
  const collected = typeof collectedAt === 'string' ? Date.parse(collectedAt) : Number.NaN
  if (Number.isNaN(observed)) return false
  if (!Number.isNaN(started) && observed < started) return true
  return !Number.isNaN(collected) && observed > collected
}

// The provenance/reason shared by the journal-less legacy backfill INSERT the
// reconciliation builder produces from complete independently surviving
// evidence (rewards reconciliation Task 4). Task 5's APPLY allowlist accepts
// exactly this insert.
export const LEGACY_BACKFILL_REASON = 'legacy-complete-payment-backfill'

/**
 * Build the closed v2 relayProof for a proved journal-less legacy candidate's
 * backfill INSERT (rewards reconciliation Task 4). The proof is the SAME
 * closed contract as the promotion operation's, except it binds no journal
 * identity: `journalId`, `dispatchId`, `claimDigest` and `proofInventory` are
 * explicitly null and the exact surviving-evidence digest is carried. Only a
 * COMPLETE `LEGACY_SURVIVING_PROOF` result qualifies — a new signing
 * operation, a capture-era proof or unresolved evidence never backfills.
 *
 * @param {{
 *   verification: object,
 *   evidenceDigest: string
 * }} request `verification` a PaymentVerificationV1 result (validated),
 *   `evidenceDigest` the approved normalized-collection digest.
 * @returns {object} the closed relayProof
 */
export function buildLegacyBackfillRelayProof ({ verification, evidenceDigest }) {
  if (!isPlainObject(verification)) {
    throw refusal('RELAY_PROOF_REQUEST_INVALID', 'a verification result is required')
  }
  if (typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest)) {
    throw refusal('RELAY_PROOF_REQUEST_INVALID', 'the approved evidence digest is required')
  }
  if (!validatePaymentVerification(verification)) {
    throw refusal('RELAY_PROOF_VERIFICATION_INVALID', 'the verification result is not a safe PaymentVerificationV1 object')
  }
  if (verification.status !== 'complete') {
    throw refusal('RELAY_PROOF_NOT_COMPLETE', 'only a complete confirmed whole-payment proof backfills a journal')
  }
  if (verification.captureMode !== 'LEGACY_SURVIVING_PROOF') {
    throw refusal('RELAY_PROOF_NOT_LEGACY', 'only complete independently surviving legacy evidence backfills a journal')
  }
  if (verification.journalRole !== 'REWARDS') {
    throw refusal('RELAY_PROOF_ROLE_MISMATCH', 'the rewards journal backfill binds a REWARDS verification')
  }
  const facts = paymentVerificationFacts(verification)
  const relayProof = {
    version: RELAY_PROOF_VERSION,
    evidenceDigest,
    verificationVersion: verification.verificationVersion,
    scope: facts.scope,
    journalRole: facts.journalRole,
    journalId: null,
    dispatchId: null,
    captureMode: facts.captureMode,
    txHash: facts.txHash,
    claimDigest: null,
    proofInventory: null,
    sourceAccounts: facts.sourceAccounts,
    members: facts.members,
    receivingAggregates: facts.receivingAggregates,
    ownedAccounting: facts.ownedAccounting,
    totals: facts.totals,
    confirmation: facts.confirmation,
    verifierVersion: verification.verifierVersion,
    sdkVersion: verification.sdkVersion,
    provenance: facts.provenance,
    survivingEvidenceDigest: verification.survivingEvidenceDigest,
    observedAt: verification.observedAt
  }
  if (Object.keys(relayProof).sort().join(',') !== RELAY_PROOF_FIELDS.slice().sort().join(',')) {
    throw refusal('RELAY_PROOF_SHAPE_INVALID', 'the closed relayProof field contract is violated')
  }
  return relayProof
}
