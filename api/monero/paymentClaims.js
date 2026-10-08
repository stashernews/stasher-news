import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'

// Canonical payment-claims codec (Finding #1, Task 1).
//
// `PaymentClaimsV1` is the immutable, authenticated description of one Monero
// payment: what the platform contracted to pay, to which receiving identities,
// from which source accounts, with which fee policy, and the built change
// destination. It binds a payment's structure — never mutable journal state
// (dates, attempts, relay bookkeeping). Every ID/amount/index/version is an
// explicit canonical decimal string; unused identity/terms fields are explicit
// nulls. The digest is a domain-separated SHA-256 over an ASCII-key-sorted
// canonical UTF-8 JSON form, so object-key order and member-array order can
// never change the authenticated facts while any value/membership change does.
//
// Addresses are validated by decoding the base58 body, re-deriving the
// Keccak-256 checksum, requiring the exact network prefix (MAINNET 18/19/42,
// STAGENET 24/25/36) and checking that both public keys are canonical points on
// the ed25519 curve. The receiving identity is derived from network + the
// spend/view key pair — the address text itself is never the identity, so an
// integrated alias aggregates with its primary address while retaining its
// payment-ID claim on the member record.

const APPLICATION = 'stashernews/monero/payment'
const FORMAT_VERSION = '1'
const CLAIMS_DIGEST_DOMAIN = 'stashernews/monero/payment-claims/v1\0'

const NETWORK_PREFIXES = Object.freeze({
  MAINNET: Object.freeze({ PRIMARY: 18, INTEGRATED: 19, SUBADDRESS: 42 }),
  STAGENET: Object.freeze({ PRIMARY: 24, INTEGRATED: 25, SUBADDRESS: 36 })
})

const REWARDS_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])
const ESCROW_KINDS = new Set(['AWARD', 'RECLAIM', 'ROLLOVER', 'LEGACY_SEPARATE_FEE'])
const MEMBER_LEGS = new Set(['FEE', 'LEGACY_SEPARATE_FEE', 'PRINCIPAL'])
const FEE_MODES = new Set(['NONE', 'SUBTRACT_LAST'])

const CLAIMS_KEYS = [
  'application', 'bindingVersion', 'captureContractVersion', 'dispatchId',
  'journalRole', 'scope', 'txHash', 'kind', 'sourceAccounts', 'distributionId',
  'bountyPaymentId', 'itemId', 'networkFeePiconeros', 'principalPiconeros',
  'frozenTerms', 'feePolicy', 'members', 'receivingAggregates', 'ownedTargets',
  'change'
]
const SCOPE_KEYS = ['network', 'walletAddress']
const MEMBER_KEYS = [
  'id', 'leg', 'address', 'type', 'paymentId', 'receivingIdentity',
  'grossPiconeros', 'actualPiconeros'
]
const AGGREGATE_KEYS = ['receivingIdentity', 'amountPiconeros']
const OWNED_TARGET_KEYS = ['accountIndex', 'subaddressIndex', 'address', 'amountPiconeros']
const CHANGE_KEYS = ['accountIndex', 'subaddressIndex', 'address']
const FROZEN_TERMS_KEYS = ['recipientAddress', 'prizePiconeros', 'feePiconeros', 'feeRecipientAddress']
const FEE_POLICY_KEYS = ['mode', 'legs']
const FEE_LEG_KEYS = ['memberId', 'leg', 'grossPiconeros', 'actualPiconeros']

const INVALID = 'PAYMENT_CLAIMS_INVALID'
const UNSUPPORTED = 'PAYMENT_CLAIMS_UNSUPPORTED_VALUE'
const ADDRESS = 'PAYMENT_CLAIMS_ADDRESS'
const AMOUNT = 'PAYMENT_CLAIMS_AMOUNT'
const INCONSISTENT = 'PAYMENT_CLAIMS_INCONSISTENT'

const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/
const CANONICAL_POSITIVE = /^[1-9][0-9]*$/
const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const IDENTITY = /^(?:MAINNET|STAGENET)\/[0-9a-f]{64}\/[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fail (code) {
  throw new Error(code)
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto === null || proto === Object.prototype) return true
  // Cross-realm plain objects (e.g. a structuredClone() result under Jest's vm
  // modules): the prototype is that realm's Object.prototype and is itself the
  // top of a plain chain. Date/Map/class instances have a non-null grand
  // prototype and stay rejected.
  return Object.getPrototypeOf(proto) === null && Object.prototype.toString.call(value) === '[object Object]'
}

// Exact closed whitelist: missing and extra keys are both refused.
function requireExactKeys (value, keys, code) {
  if (!isPlainObject(value)) fail(code)
  const actual = Object.keys(value)
  if (actual.length !== keys.length) fail(code)
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code)
  }
  return value
}

function canonicalAmount (value, code = AMOUNT) {
  if (typeof value !== 'string' || !CANONICAL_UNSIGNED.test(value)) fail(code)
  return value
}

function canonicalPositiveId (value, code = INVALID) {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE.test(value)) fail(code)
  return value
}

function assertCurvePoint (keyHex) {
  let point
  try {
    point = ed25519.ExtendedPoint.fromHex(keyHex)
  } catch {
    fail(ADDRESS)
  }
  if (Buffer.from(point.toRawBytes()).toString('hex') !== keyHex) fail(ADDRESS)
}

/**
 * Decode one Monero address body with its checksum, network prefix and curve
 * points validated. The identity is derived from the network and the
 * spend/view key pair, never from the address text.
 *
 * @param {string} address base58 address (primary, subaddress or integrated)
 * @param {string} network 'MAINNET' | 'STAGENET'
 * @returns {{identity: string, type: string, spendKey: string, viewKey: string, paymentId: string|null}}
 */
export function decodeReceivingIdentity (address, network) {
  const prefixes = NETWORK_PREFIXES[network]
  if (!prefixes) fail(ADDRESS)
  if (typeof address !== 'string' || address.length === 0 || address.trim() !== address) fail(ADDRESS)

  let bytes
  try {
    bytes = base58xmr.decode(address)
  } catch {
    fail(ADDRESS)
  }

  let type = null
  if (bytes.length === 77) {
    if (bytes[0] !== prefixes.INTEGRATED) fail(ADDRESS)
    type = 'INTEGRATED'
  } else if (bytes.length === 69) {
    if (bytes[0] === prefixes.PRIMARY) type = 'PRIMARY'
    else if (bytes[0] === prefixes.SUBADDRESS) type = 'SUBADDRESS'
    else fail(ADDRESS)
  } else {
    fail(ADDRESS)
  }

  const bodyEnd = bytes.length - 4
  const checksum = keccak256(bytes.subarray(0, bodyEnd))
  if (checksum.slice(0, 8) !== Buffer.from(bytes.subarray(bodyEnd)).toString('hex')) fail(ADDRESS)

  const spendKey = Buffer.from(bytes.subarray(1, 33)).toString('hex')
  const viewKey = Buffer.from(bytes.subarray(33, 65)).toString('hex')
  const paymentId = type === 'INTEGRATED' ? Buffer.from(bytes.subarray(65, 73)).toString('hex') : null
  assertCurvePoint(spendKey)
  assertCurvePoint(viewKey)

  return { identity: `${network}/${spendKey}/${viewKey}`, type, spendKey, viewKey, paymentId }
}

function requireAddress (value, network, { allowIntegrated = false } = {}) {
  const decoded = decodeReceivingIdentity(value, network)
  if (!allowIntegrated && decoded.type === 'INTEGRATED') fail(INVALID)
  return decoded
}

// --- canonical JSON ----------------------------------------------------------

function asciiCompare (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function serializeCanonical (value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    // Only finite, positive-zero-safe JSON numbers. BigInts and unsafe
    // coercions must be normalized to canonical decimal strings by callers.
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(UNSUPPORTED)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const parts = []
    for (let i = 0; i < value.length; i++) parts.push(serializeCanonical(value[i]))
    return `[${parts.join(',')}]`
  }
  if (type === 'object') {
    if (!isPlainObject(value)) fail(UNSUPPORTED)
    if (Object.getOwnPropertySymbols(value).length > 0) fail(UNSUPPORTED)
    const parts = []
    for (const key of Object.keys(value).sort(asciiCompare)) {
      parts.push(`${JSON.stringify(key)}:${serializeCanonical(value[key])}`)
    }
    return `{${parts.join(',')}}`
  }
  fail(UNSUPPORTED)
}

/**
 * Canonical UTF-8 JSON for hashing: recursively ASCII-sorts object keys, keeps
 * array order, rejects unsupported JS values (bigint, undefined, functions,
 * symbols, non-finite numbers, class/Date/Map instances) instead of
 * stringifying arbitrary objects.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalPaymentJson (value) {
  return serializeCanonical(value)
}

// --- claims normalization ----------------------------------------------------

function normalizeScope (value, network) {
  requireExactKeys(value, SCOPE_KEYS, INVALID)
  if (value.network !== network) fail(INVALID)
  const wallet = requireAddress(value.walletAddress, network)
  if (wallet.type !== 'PRIMARY') fail(INVALID)
  return { network, walletAddress: value.walletAddress }
}

function normalizeKind (value, journalRole) {
  if (journalRole === 'REWARDS') {
    if (typeof value !== 'string' || !REWARDS_KINDS.has(value)) fail(INVALID)
    return value
  }
  if (journalRole === 'ESCROW') {
    if (typeof value !== 'string' || !ESCROW_KINDS.has(value)) fail(INVALID)
    return value
  }
  fail(INVALID)
}

function normalizeSourceAccounts (value) {
  if (!Array.isArray(value) || value.length === 0) fail(INVALID)
  const seen = new Set()
  for (const account of value) {
    if (typeof account !== 'string' || !CANONICAL_UNSIGNED.test(account)) fail(INVALID)
    if (seen.has(account)) fail(INCONSISTENT)
    seen.add(account)
  }
  return [...value].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
}

function normalizeFrozenTerms (value, network) {
  if (value === null) return null
  requireExactKeys(value, FROZEN_TERMS_KEYS, INVALID)
  requireAddress(value.recipientAddress, network)
  const prizePiconeros = canonicalAmount(value.prizePiconeros)
  const feePiconeros = canonicalAmount(value.feePiconeros)
  let feeRecipientAddress = null
  if (value.feeRecipientAddress !== null) {
    requireAddress(value.feeRecipientAddress, network)
    feeRecipientAddress = value.feeRecipientAddress
  }
  if ((BigInt(feePiconeros) === 0n) !== (feeRecipientAddress === null)) fail(INCONSISTENT)
  return { recipientAddress: value.recipientAddress, prizePiconeros, feePiconeros, feeRecipientAddress }
}

function normalizeMemberLeg (leg, journalRole, kind) {
  if (typeof leg !== 'string' || !MEMBER_LEGS.has(leg)) fail(INVALID)
  if (journalRole === 'REWARDS' && leg !== 'PRINCIPAL') fail(INVALID)
  if (journalRole === 'ESCROW') {
    if (kind === 'LEGACY_SEPARATE_FEE' && leg !== 'LEGACY_SEPARATE_FEE') fail(INVALID)
    if (kind !== 'LEGACY_SEPARATE_FEE' && leg === 'LEGACY_SEPARATE_FEE') fail(INVALID)
  }
  return leg
}

function compareMembers (a, b) {
  const aId = BigInt(a.id)
  const bId = BigInt(b.id)
  if (aId !== bId) return aId < bId ? -1 : 1
  return asciiCompare(a.leg, b.leg)
}

function normalizeMembers (value, network, journalRole, kind) {
  if (!Array.isArray(value)) fail(INVALID)
  const seen = new Set()
  const members = value.map(raw => {
    requireExactKeys(raw, MEMBER_KEYS, INVALID)
    const id = canonicalPositiveId(raw.id)
    const leg = normalizeMemberLeg(raw.leg, journalRole, kind)
    const key = `${id}\u0000${leg}`
    if (seen.has(key)) fail(INCONSISTENT)
    seen.add(key)
    const decoded = requireAddress(raw.address, network, { allowIntegrated: true })
    if (raw.type !== decoded.type) fail(INCONSISTENT)
    if (raw.paymentId !== decoded.paymentId) fail(INCONSISTENT)
    if (raw.receivingIdentity !== decoded.identity) fail(INCONSISTENT)
    const grossPiconeros = canonicalAmount(raw.grossPiconeros)
    const actualPiconeros = canonicalAmount(raw.actualPiconeros)
    if (BigInt(actualPiconeros) > BigInt(grossPiconeros)) fail(INCONSISTENT)
    return {
      id,
      leg,
      address: raw.address,
      type: decoded.type,
      paymentId: decoded.paymentId,
      receivingIdentity: decoded.identity,
      grossPiconeros,
      actualPiconeros
    }
  })
  return members.sort(compareMembers)
}

function memberKey (id, leg) {
  return `${id}\u0000${leg}`
}

function normalizeFeePolicy (value, members, networkFeePiconeros) {
  requireExactKeys(value, FEE_POLICY_KEYS, INVALID)
  if (typeof value.mode !== 'string' || !FEE_MODES.has(value.mode)) fail(INVALID)
  if (!Array.isArray(value.legs)) fail(INVALID)

  const membersByKey = new Map(members.map(member => [memberKey(member.id, member.leg), member]))
  const covered = new Set()
  const legs = value.legs.map(raw => {
    requireExactKeys(raw, FEE_LEG_KEYS, INVALID)
    const memberId = canonicalPositiveId(raw.memberId)
    const leg = raw.leg
    if (typeof leg !== 'string' || !MEMBER_LEGS.has(leg)) fail(INVALID)
    const key = memberKey(memberId, leg)
    const member = membersByKey.get(key)
    if (!member) fail(INCONSISTENT)
    // Fee legs are injective over members (final-review M1): every member is
    // covered EXACTLY once — a duplicate leg and an omitted member are both
    // refusals, never a silently skewed subtraction contract.
    if (covered.has(key)) fail(INCONSISTENT)
    covered.add(key)
    const grossPiconeros = canonicalAmount(raw.grossPiconeros)
    const actualPiconeros = canonicalAmount(raw.actualPiconeros)
    if (member.grossPiconeros !== grossPiconeros || member.actualPiconeros !== actualPiconeros) fail(INCONSISTENT)
    return { memberId, leg, grossPiconeros, actualPiconeros }
  })
  if (legs.length !== members.length || covered.size !== members.length) fail(INCONSISTENT)

  const totalGross = members.reduce((sum, member) => sum + BigInt(member.grossPiconeros), 0n)
  const totalActual = members.reduce((sum, member) => sum + BigInt(member.actualPiconeros), 0n)
  if (value.mode === 'NONE') {
    if (totalGross !== totalActual) fail(INCONSISTENT)
  } else {
    if (members.length === 0) fail(INCONSISTENT)
    const networkFee = BigInt(networkFeePiconeros)
    if (totalGross - totalActual !== networkFee) fail(INCONSISTENT)
    for (let i = 0; i < legs.length; i++) {
      const expected = i === legs.length - 1
        ? BigInt(legs[i].grossPiconeros) - networkFee
        : BigInt(legs[i].grossPiconeros)
      if (BigInt(legs[i].actualPiconeros) !== expected) fail(INCONSISTENT)
    }
  }
  return { mode: value.mode, legs }
}

function deriveReceivingAggregates (members) {
  const totals = new Map()
  for (const member of members) {
    totals.set(member.receivingIdentity, (totals.get(member.receivingIdentity) ?? 0n) + BigInt(member.actualPiconeros))
  }
  return [...totals.entries()]
    .map(([receivingIdentity, amountPiconeros]) => ({ receivingIdentity, amountPiconeros: amountPiconeros.toString() }))
    .sort((a, b) => asciiCompare(a.receivingIdentity, b.receivingIdentity))
}

function normalizeReceivingAggregates (value, members) {
  if (!Array.isArray(value)) fail(INVALID)
  const derived = deriveReceivingAggregates(members)
  if (value.length !== derived.length) fail(INCONSISTENT)
  for (const raw of value) {
    requireExactKeys(raw, AGGREGATE_KEYS, INVALID)
    if (typeof raw.receivingIdentity !== 'string' || !IDENTITY.test(raw.receivingIdentity)) fail(INVALID)
    canonicalAmount(raw.amountPiconeros)
  }
  const sorted = [...value]
    .map(raw => ({ receivingIdentity: raw.receivingIdentity, amountPiconeros: raw.amountPiconeros }))
    .sort((a, b) => asciiCompare(a.receivingIdentity, b.receivingIdentity))
  for (let i = 0; i < derived.length; i++) {
    if (sorted[i].receivingIdentity !== derived[i].receivingIdentity) fail(INCONSISTENT)
    if (sorted[i].amountPiconeros !== derived[i].amountPiconeros) fail(INCONSISTENT)
  }
  return derived
}

function normalizeOwnedTargets (value, network) {
  if (!Array.isArray(value)) fail(INVALID)
  const seen = new Set()
  const targets = value.map(raw => {
    requireExactKeys(raw, OWNED_TARGET_KEYS, INVALID)
    const accountIndex = canonicalAmount(raw.accountIndex)
    const subaddressIndex = canonicalAmount(raw.subaddressIndex)
    const key = `${accountIndex}\u0000${subaddressIndex}`
    if (seen.has(key)) fail(INCONSISTENT)
    seen.add(key)
    requireAddress(raw.address, network)
    return { accountIndex, subaddressIndex, address: raw.address, amountPiconeros: canonicalAmount(raw.amountPiconeros) }
  })
  return targets.sort((a, b) => {
    const aAccount = BigInt(a.accountIndex)
    const bAccount = BigInt(b.accountIndex)
    if (aAccount !== bAccount) return aAccount < bAccount ? -1 : 1
    const aSub = BigInt(a.subaddressIndex)
    const bSub = BigInt(b.subaddressIndex)
    if (aSub !== bSub) return aSub < bSub ? -1 : 1
    return asciiCompare(a.address, b.address)
  })
}

function normalizeChange (value, network) {
  if (value === null) return null
  requireExactKeys(value, CHANGE_KEYS, INVALID)
  requireAddress(value.address, network)
  return {
    accountIndex: canonicalAmount(value.accountIndex),
    subaddressIndex: canonicalAmount(value.subaddressIndex),
    address: value.address
  }
}

function freeze (value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Validate a closed `PaymentClaimsV1` input and return the canonical, frozen
 * claims. Unknown keys (including mutable journal state such as dates,
 * attempts or observedAt) are refused; all amounts/ids/indexes/versions are
 * canonical decimal strings; unused identity/terms fields must be explicit
 * nulls.
 *
 * @param {object} input
 * @returns {object} canonical PaymentClaimsV1
 */
export function normalizePaymentClaims (input) {
  requireExactKeys(input, CLAIMS_KEYS, INVALID)
  if (input.application !== APPLICATION) fail(INVALID)
  if (input.bindingVersion !== FORMAT_VERSION) fail(INVALID)
  if (input.captureContractVersion !== FORMAT_VERSION) fail(INVALID)
  if (typeof input.dispatchId !== 'string' || !UUID.test(input.dispatchId)) fail(INVALID)
  if (input.journalRole !== 'REWARDS' && input.journalRole !== 'ESCROW') fail(INVALID)
  const journalRole = input.journalRole
  requireExactKeys(input.scope, SCOPE_KEYS, INVALID)
  if (input.scope.network !== 'MAINNET' && input.scope.network !== 'STAGENET') fail(INVALID)
  const network = input.scope.network
  const scope = normalizeScope(input.scope, network)
  if (typeof input.txHash !== 'string' || !LOWER_HEX_64.test(input.txHash)) fail(INVALID)
  const txHash = input.txHash
  const kind = normalizeKind(input.kind, journalRole)
  const sourceAccounts = normalizeSourceAccounts(input.sourceAccounts)

  let distributionId = null
  let bountyPaymentId = null
  let itemId = null
  let frozenTerms = null
  if (journalRole === 'REWARDS') {
    if (input.bountyPaymentId !== null || input.itemId !== null || input.frozenTerms !== null) fail(INCONSISTENT)
    if (input.distributionId !== null) distributionId = canonicalPositiveId(input.distributionId)
  } else {
    if (input.distributionId !== null) fail(INCONSISTENT)
    bountyPaymentId = canonicalPositiveId(input.bountyPaymentId)
    itemId = canonicalPositiveId(input.itemId)
    if (input.frozenTerms === null) fail(INCONSISTENT)
    frozenTerms = normalizeFrozenTerms(input.frozenTerms, network)
  }

  const networkFeePiconeros = canonicalAmount(input.networkFeePiconeros)
  const principalPiconeros = canonicalAmount(input.principalPiconeros)
  const members = normalizeMembers(input.members, network, journalRole, kind)
  const principal = members.reduce((sum, member) => sum + BigInt(member.grossPiconeros), 0n)
  if (principal !== BigInt(principalPiconeros)) fail(INCONSISTENT)

  const feePolicy = normalizeFeePolicy(input.feePolicy, members, networkFeePiconeros)
  const receivingAggregates = normalizeReceivingAggregates(input.receivingAggregates, members)
  const ownedTargets = normalizeOwnedTargets(input.ownedTargets, network)
  const change = normalizeChange(input.change, network)

  if (journalRole === 'REWARDS' && kind === 'CONSOLIDATION') {
    if (members.length !== 0 || principalPiconeros !== '0' || ownedTargets.length === 0) fail(INCONSISTENT)
  }

  return freeze({
    application: APPLICATION,
    bindingVersion: FORMAT_VERSION,
    captureContractVersion: FORMAT_VERSION,
    dispatchId: input.dispatchId,
    journalRole,
    scope,
    txHash,
    kind,
    sourceAccounts,
    distributionId,
    bountyPaymentId,
    itemId,
    networkFeePiconeros,
    principalPiconeros,
    frozenTerms,
    feePolicy,
    members,
    receivingAggregates,
    ownedTargets,
    change
  })
}

/**
 * Domain-separated SHA-256 of the canonical claims JSON.
 *
 * @param {object} claims PaymentClaimsV1 (normalized or valid input)
 * @returns {string} lowercase 64-char hex digest
 */
export function paymentClaimDigest (claims) {
  const canonical = normalizePaymentClaims(claims)
  return createHash('sha256')
    .update(CLAIMS_DIGEST_DOMAIN)
    .update(canonicalPaymentJson(canonical), 'utf8')
    .digest('hex')
}

function normalizeVersion (value, code = INVALID) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) fail(code)
    return String(value)
  }
  if (typeof value !== 'string' || !CANONICAL_POSITIVE.test(value)) fail(code)
  return value
}

/**
 * Authenticated binding header for a claims envelope: the claim digest plus
 * the exact format versions and the actual master-key version. Format versions
 * are normalized to canonical decimal strings so a Prisma Int and a
 * provider-returned integer produce the same binding.
 *
 * @param {object} claims PaymentClaimsV1
 * @param {{masterKeyVersion: number|string, envelopeVersion: number|string, payloadVersion: number|string}} versions
 * @returns {{application: string, bindingVersion: string, masterKeyVersion: string, envelopeVersion: string, payloadVersion: string, claimDigest: string}}
 */
export function paymentBinding (claims, versions = {}) {
  requireExactKeys(versions, ['masterKeyVersion', 'envelopeVersion', 'payloadVersion'], INVALID)
  const masterKeyVersion = normalizeVersion(versions.masterKeyVersion)
  const envelopeVersion = normalizeVersion(versions.envelopeVersion)
  const payloadVersion = normalizeVersion(versions.payloadVersion)
  if (envelopeVersion !== FORMAT_VERSION) fail(INVALID)
  if (payloadVersion !== FORMAT_VERSION) fail(INVALID)
  return freeze({
    application: APPLICATION,
    bindingVersion: FORMAT_VERSION,
    masterKeyVersion,
    envelopeVersion,
    payloadVersion,
    claimDigest: paymentClaimDigest(claims)
  })
}
