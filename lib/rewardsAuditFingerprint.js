import { createHash } from 'node:crypto'
import { canonicalPaymentJson } from '@/api/monero/paymentClaims'

// Pure, closed safe accounting projection + versioned hash + strict freshness
// comparison for the rewards accounting audit (rewards reconciliation plan,
// Task 1). This module reads no DB, opens no wallet, imports no key provider
// and never mutates its input: it is a total function from the supplied
// snapshot rows to a canonical object and a `accounting:v2:` digest.
//
// The projection carries COMPLETE DB input rows before any lossy normalizer or
// drop filter. Its field lists are a closed contract (the plan's projection
// inventory): unknown fields — including envelope/cipher bytes, key material,
// confirmation counters and wall-clock stamps — can never enter the
// fingerprint, and every inventoried field is always represented:
//   - a present, well-formed value is canonicalized (BigInt → decimal string,
//     Date/ISO string → ISO string, hex hashes → lowercase);
//   - a legitimately nullable column keeps null;
//   - a malformed value becomes a closed `{ invalid: true, kind, raw? }`
//     marker so an unreadable monetary row is retained for issue reporting
//     instead of disappearing (the builder emits the named issue);
//   - an EXPECTED column that is absent is an error (fail closed).
//
// Excluded from the fingerprint by construction: wall-clock collection time,
// chain tip, confirmations that merely advance, drift/accountingUncertain
// flags, prior audits, cipher bytes and key availability. Key availability and
// chain validity are separately rechecked by their own tasks.

export const ACCOUNTING_FINGERPRINT_VERSION = 2

const FINGERPRINT_PREFIX = 'accounting:v2:'
const FINGERPRINT_DOMAIN = 'stashernews/rewards/accounting-audit/v2\0'
const CURRENT_FINGERPRINT_RE = /^accounting:v2:[0-9a-f]{64}$/

const CANONICAL_AMOUNT_RE = /^(0|[1-9][0-9]*)$/
const CANONICAL_UNSIGNED_RE = /^(0|[1-9][0-9]*)$/
const CHAIN_HASH_RE = /^[0-9a-f]{64}$/

const REWARDS_NETWORKS = new Set(['MAINNET', 'STAGENET'])

const CONFIG_PCT_FIELDS = Object.freeze([
  'downvoteRewardsPct',
  'postingFeeRewardsPct',
  'territoryFeeRewardsPct',
  'boostRewardsPct',
  'walletlessTipRewardsPct'
])

const RESERVE_FIELDS = Object.freeze(['feeHeadroomPiconeros', 'dustFloorPiconeros'])

// ---------------------------------------------------------------------------
// Closed value projectors
// ---------------------------------------------------------------------------

// Raw text is retained on invalid markers only for primitive values: never
// stringify objects (they can be huge or cyclic) and never include whatever
// non-primitive was injected.
function rawPart (value) {
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return { raw: String(value) }
  }
  return {}
}

const invalidMarker = (kind, value) => ({ invalid: true, kind, ...rawPart(value) })

// Structural (realm-safe) checks: values may originate in another vm realm
// (structuredClone, jest workers), so `instanceof` and prototype identity are
// not reliable brand checks here.
const isDateObject = value =>
  value !== null && typeof value === 'object' &&
  Object.prototype.toString.call(value) === '[object Date]'

const isPlainObject = value =>
  value !== null && typeof value === 'object' &&
  Object.prototype.toString.call(value) === '[object Object]'

function projectAmount (value) {
  if (value === null) return null
  // BigInt piconeros are the contract; canonical decimal strings are accepted
  // as their exact equivalent. JS numbers are never money here.
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && CANONICAL_AMOUNT_RE.test(value)) return value
  return invalidMarker('AMOUNT', value)
}

function projectHash (value) {
  if (value === null) return null
  if (typeof value === 'string' && CHAIN_HASH_RE.test(value)) return value
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase()
  // A malformed hash keeps its raw text visible (never silently normalized).
  return invalidMarker('HASH', value)
}

function projectInt (value) {
  if (value === null) return null
  if (Number.isSafeInteger(value)) return value
  return invalidMarker('INT', value)
}

// Canonical identity projection (final-review M1): the canonical unsigned
// decimal STRING is the closed ID form. A safe nonnegative JS number, its
// BigInt form and its canonical decimal string are the SAME exact identity
// and must project identically — the audit identifier can never depend on
// which JS representation carried the value. Unsupported forms (negative
// values, numbers at or above 2^53, non-canonical strings) become explicit
// invalid markers — never rounded, never reinterpreted.
function projectId (value) {
  if (value === null) return null
  if (typeof value === 'bigint' && value >= 0n) return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && CANONICAL_UNSIGNED_RE.test(value)) return value
  return invalidMarker('ID', value)
}

function projectString (value) {
  if (value === null) return null
  if (typeof value === 'string') return value
  return invalidMarker('STRING', value)
}

function projectBoolean (value) {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  return invalidMarker('BOOLEAN', value)
}

// Date instances and their ISO-string form are the SAME canonical instant.
// The time is re-derived through this realm's constructor so cross-realm
// Date objects canonicalize identically to their ISO strings.
function projectTimestamp (value) {
  if (value === null) return null
  if (isDateObject(value)) {
    const time = value.getTime()
    if (!Number.isNaN(time)) return new Date(time).toISOString()
    return invalidMarker('TIMESTAMP', value)
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return invalidMarker('TIMESTAMP', value)
}

// Prisma Json columns: JSON-native values only, recursively. Unknown members
// (undefined, functions, Dates, class instances, Buffers) become invalid
// markers so nothing disappears silently and nothing breaks serialization.
function projectJson (value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) return invalidMarker('JSON', value)
    return Object.is(value, -0) ? 0 : value
  }
  if (type === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(item => projectJson(item))
  if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return { invalid: true, kind: 'JSON' }
    const out = {}
    for (const key of Object.keys(value)) out[key] = projectJson(value[key])
    return out
  }
  return { invalid: true, kind: 'JSON' }
}

// ---------------------------------------------------------------------------
// Closed row projectors (the plan's exact projection inventory)
// ---------------------------------------------------------------------------

function projectRow (label, row, spec) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`accountingAuditProjection: ${label} row must be an object`)
  }
  const out = {}
  for (const [key, project] of Object.entries(spec)) {
    if (!(key in row)) throw new Error(`accountingAuditProjection: ${label}.${key} is required`)
    out[key] = project(row[key])
  }
  return out
}

// Sort by the canonical serialization of the projected row: input order can
// never change the projection, and duplicates are retained (never collapsed).
function projectGroup (name, rows, spec) {
  if (!Array.isArray(rows)) throw new Error(`accountingAuditProjection: ledger.${name} must be an array`)
  const decorated = rows.map(row => {
    const projected = projectRow(`ledger.${name}[]`, row, spec)
    return { projected, json: canonicalPaymentJson(projected) }
  })
  decorated.sort((a, b) => (a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
  return decorated.map(entry => entry.projected)
}

const LEDGER_ROW_SPECS = {
  accounts: {
    id: projectId,
    label: projectString,
    network: projectString,
    address: projectString
  },
  subaddresses: {
    id: projectId,
    accountId: projectId,
    majorIndex: projectInt,
    minorIndex: projectInt,
    address: projectString,
    state: projectString
  },
  receipts: {
    id: projectId,
    txHash: projectHash,
    feeType: projectString,
    postId: projectId,
    subName: projectString,
    payInId: projectId,
    recipientMajor: projectInt,
    recipientMinor: projectInt,
    walletReceipt: projectBoolean,
    state: projectString,
    piconeros: projectAmount,
    rewardsPiconeros: projectAmount,
    donationRewardsPct: projectInt,
    height: projectInt,
    confirmedAt: projectTimestamp
  },
  downvotes: {
    id: projectId,
    txHash: projectHash,
    paymentId: projectString,
    postId: projectId,
    downvoterId: projectId,
    state: projectString,
    piconeros: projectAmount,
    height: projectInt,
    confirmedAt: projectTimestamp
  },
  payouts: {
    id: projectId,
    distributionId: projectId,
    curatorId: projectId,
    recipientAddress: projectString,
    piconeros: projectAmount,
    state: projectString,
    txHash: projectHash
  },
  distributions: {
    id: projectId,
    status: projectString,
    periodStart: projectTimestamp,
    periodEnd: projectTimestamp,
    poolPiconeros: projectAmount,
    distributedPiconeros: projectAmount,
    rolledOverPiconeros: projectAmount,
    payoutCount: projectInt,
    opsInflowPiconeros: projectAmount,
    opsRolledOverPiconeros: projectAmount,
    opsAvailablePiconeros: projectAmount,
    opsSweptPiconeros: projectAmount,
    opsSweepState: projectString,
    opsSweepTxHash: projectHash,
    opsNetworkFeesAccountedPiconeros: projectAmount
  },
  transactions: {
    id: projectId,
    network: projectString,
    walletAddress: projectString,
    txHash: projectHash,
    kind: projectString,
    accountIndex: projectInt,
    distributionId: projectId,
    principalPiconeros: projectAmount,
    networkFeePiconeros: projectAmount,
    metadata: projectJson,
    state: projectString,
    preparedAt: projectTimestamp,
    relayAttemptedAt: projectTimestamp,
    relayedAt: projectTimestamp,
    relayProvenance: projectString,
    dispatchId: projectString,
    captureContractVersion: projectInt,
    claimDigest: projectString,
    paymentClaims: projectJson,
    proofId: projectString
  },
  escrowTransactions: {
    id: projectId,
    network: projectString,
    walletAddress: projectString,
    txHash: projectHash,
    dispatchId: projectString,
    proofId: projectString,
    captureContractVersion: projectInt,
    claimDigest: projectString,
    paymentClaims: projectJson,
    kind: projectString,
    leg: projectString,
    bountyPaymentId: projectId,
    itemId: projectId,
    accountIndex: projectInt,
    principalPiconeros: projectAmount,
    networkFeePiconeros: projectAmount,
    metadata: projectJson,
    state: projectString,
    preparedAt: projectTimestamp,
    relayAttemptedAt: projectTimestamp,
    relayedAt: projectTimestamp,
    relayProvenance: projectString
  },
  bountyPayments: {
    id: projectId,
    itemId: projectId,
    winnerUserId: projectId,
    kind: projectString,
    piconeros: projectAmount,
    feePiconeros: projectAmount,
    recipientAddress: projectString,
    feeRecipientAddress: projectString,
    state: projectString,
    txHash: projectHash,
    feeTxHash: projectHash,
    feePendingAt: projectTimestamp,
    networkFeePiconeros: projectAmount,
    recipientReceivedPiconeros: projectAmount,
    feeReceivedPiconeros: projectAmount,
    feeSettlementNetworkFeePiconeros: projectAmount,
    sentAt: projectTimestamp,
    confirmedAt: projectTimestamp,
    height: projectInt
  },
  observedBounties: {
    id: projectId,
    postId: projectId,
    payerId: projectId,
    recipientAccountId: projectId,
    paymentId: projectString,
    txHash: projectHash,
    piconeros: projectAmount,
    state: projectString,
    height: projectInt,
    confirmedAt: projectTimestamp
  },
  observedBountyReceipts: {
    id: projectId,
    bountyId: projectId,
    txHash: projectHash,
    piconeros: projectAmount,
    height: projectInt,
    detectedAt: projectTimestamp
  },
  items: {
    id: projectId,
    bountyPiconeros: projectAmount,
    bountyFeePiconeros: projectAmount
  },
  earns: {
    id: projectId,
    userId: projectId,
    distributionId: projectId,
    piconeros: projectAmount
  }
}

// Safe proof inventory entries: the owner journal identity, a chain-addressable
// reference, and the #1 store's inventory record (safe metadata + integrity
// digests). Envelope bytes can never enter: only the closed field set below is
// projected, and an inventory record that is null (missing/broken proof row) is
// retained as null.
function projectProofEntry (entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('accountingAuditProjection: ledger.proofInventory[] entry must be an object')
  }
  for (const key of ['owner', 'reference', 'proof']) {
    if (!(key in entry)) throw new Error(`accountingAuditProjection: ledger.proofInventory[].${key} is required`)
  }
  const owner = entry.owner
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new Error('accountingAuditProjection: ledger.proofInventory[].owner must be an object')
  }
  for (const key of ['journalRole', 'journalId']) {
    if (!(key in owner)) throw new Error(`accountingAuditProjection: ledger.proofInventory[].owner.${key} is required`)
  }
  const reference = entry.reference
  if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new Error('accountingAuditProjection: ledger.proofInventory[].reference must be an object')
  }
  const REFERENCE_SPEC = {
    txHash: projectHash,
    kind: projectString,
    dispatchId: projectString,
    leg: projectString,
    bountyPaymentId: projectId,
    itemId: projectId
  }
  const proof = entry.proof
  let projectedProof = null
  if (proof !== null) {
    if (typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error('accountingAuditProjection: ledger.proofInventory[].proof must be an object or null')
    }
    const PROOF_SPEC = {
      proofId: projectString,
      revision: projectInt,
      masterKeyVersion: projectInt,
      bindingVersion: projectInt,
      envelopeVersion: projectInt,
      payloadVersion: projectInt,
      claimDigest: projectString,
      bindingDigest: projectString,
      envelopeIntegrityDigest: projectString
    }
    projectedProof = projectRow('ledger.proofInventory[].proof', proof, PROOF_SPEC)
  }
  return {
    owner: projectRow('ledger.proofInventory[].owner', owner, {
      journalRole: projectString,
      journalId: projectId
    }),
    reference: projectRow('ledger.proofInventory[].reference', reference, REFERENCE_SPEC),
    proof: projectedProof
  }
}

// ---------------------------------------------------------------------------
// Top-level inputs
// ---------------------------------------------------------------------------

function requireScope (scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('accountingAuditProjection: a scope is required')
  }
  if (!REWARDS_NETWORKS.has(scope.network)) {
    throw new Error('accountingAuditProjection: scope.network must be MAINNET or STAGENET')
  }
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress === '') {
    throw new Error('accountingAuditProjection: scope.walletAddress is required')
  }
  return {
    network: scope.network,
    walletAddress: scope.walletAddress,
    // Downvotes pay the rewards wallet's PRIMARY address (the webhook /
    // attribution path): the receiving scope is derived from the proven scope
    // at (major 0, minor 0) — never an invented per-row minor index.
    downvoteReceivingScope: { majorIndex: 0, minorIndex: 0, address: scope.walletAddress }
  }
}

function requireConfig (config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('accountingAuditProjection: a config object is required')
  }
  const out = {}
  for (const key of CONFIG_PCT_FIELDS) {
    if (!(key in config)) throw new Error(`accountingAuditProjection: config.${key} is required`)
    out[key] = projectInt(config[key])
  }
  return out
}

function requireReserve (reserve) {
  if (reserve === null || typeof reserve !== 'object' || Array.isArray(reserve)) {
    throw new Error('accountingAuditProjection: a reserve object is required')
  }
  const out = {}
  for (const key of RESERVE_FIELDS) {
    if (!(key in reserve)) throw new Error(`accountingAuditProjection: reserve.${key} is required`)
    out[key] = projectAmount(reserve[key])
  }
  return out
}

/**
 * Closed safe accounting projection: the canonical, order-independent,
 * JSON-safe form of one audit snapshot input. Consumes
 * `{ scope, ledger, config, reserve }` (rows as read by the snapshot reader)
 * and never mutates them.
 *
 * @param {object} input
 * @returns {object} canonical projection (all BigInts/Dates canonicalized)
 */
export function accountingAuditProjection (input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('accountingAuditProjection: an input object is required')
  }
  const scope = requireScope(input.scope)
  if (input.ledger === null || typeof input.ledger !== 'object' || Array.isArray(input.ledger)) {
    throw new Error('accountingAuditProjection: a ledger object is required')
  }
  const ledger = {}
  for (const [name, spec] of Object.entries(LEDGER_ROW_SPECS)) {
    ledger[name] = projectGroup(name, input.ledger[name], spec)
  }
  const proofEntries = input.ledger.proofInventory
  if (!Array.isArray(proofEntries)) {
    throw new Error('accountingAuditProjection: ledger.proofInventory must be an array')
  }
  ledger.proofInventory = proofEntries
    .map(projectProofEntry)
    .sort((a, b) => {
      const ja = canonicalPaymentJson(a)
      const jb = canonicalPaymentJson(b)
      return ja < jb ? -1 : ja > jb ? 1 : 0
    })
  return { scope, ledger, config: requireConfig(input.config), reserve: requireReserve(input.reserve) }
}

/**
 * Domain-separated versioned audit fingerprint of one snapshot input:
 * `'accounting:v2:' + sha256(domain ‖ canonical(projection))`.
 *
 * @param {object} input `{ scope, ledger, config, reserve }`
 * @returns {string} `'accounting:v2:'` + 64 lowercase hex chars
 */
export function accountingAuditFingerprint (input) {
  const projection = accountingAuditProjection(input)
  return FINGERPRINT_PREFIX + createHash('sha256')
    .update(FINGERPRINT_DOMAIN)
    .update(canonicalPaymentJson(projection), 'utf8')
    .digest('hex')
}

/**
 * Strict freshness comparison: the stored fingerprint is current only when it
 * is EXACTLY the current v2 fingerprint string. Legacy bare hashes, v1
 * strings, null and any malformed current value are stale (fail closed).
 *
 * @param {*} stored previously published fingerprint (any legacy form)
 * @param {*} current freshly computed fingerprint
 * @returns {boolean}
 */
export function isCurrentAccountingFingerprint (stored, current) {
  if (typeof current !== 'string' || !CURRENT_FINGERPRINT_RE.test(current)) return false
  return stored === current
}
