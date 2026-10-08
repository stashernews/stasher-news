// Authenticated payment-proof envelope (Finding #1, Task 2).
//
// Seals a ProofPayloadV1 (the pre-relay built-transaction facts captured by
// the sending wallet) into a self-authenticating EnvelopeV1 that is bound to
// the canonical PaymentClaimsV1 of exactly one payment, and opens envelopes
// back into validated payloads. No DB, wallet, logger or env policy lives
// here: the master key always comes from an injected provider (production
// entry points default to `createPaymentProofKeyProvider(process.env)`).
//
// Construction (pinned by test):
//   KEK  = HKDF-SHA256(masterKey, salt, 'stashernews/monero/tx-proof/kek/v1', 32)
//   salt = canonicalPaymentJson({ masterKeyVersion: String(version), registry: 'tx-proof' })
//   AAD  = canonicalPaymentJson({ binding, domain: 'stashernews/monero/tx-proof/aad/v1', purpose })
//   data = AES-256-GCM(canonicalPaymentJson(payload))     under a fresh random DEK
//   wrap = AES-256-GCM(DEK)                               under the KEK, purpose 'wrap'
//
// Both GCM layers authenticate the claims binding (claim digest + versions),
// so an envelope sealed for one payment can never be opened against another:
// swapped claims fail authentication BEFORE any key is touched, and every
// authenticated byte is covered by a GCM tag. Envelope masterKeyVersion is the
// actual key-generation number (a positive safe integer, matching Task 3's
// Int column); every version inside the binding/AAD/salt is the canonical
// decimal string form. Claim/payload correspondence with the raw chain is
// deliberately NOT asserted here — that independent gate is Task 5's; this
// module only proves the payload is the one that was sealed for these claims.
//
// Memory hygiene: the DEK, KEK and the provider-returned master-key copy are
// zeroed in `finally`. Honest limits of JS/WASM: the canonical payload string
// and its parsed object cannot be scrubbed (immutable strings, GC), OpenSSL
// may retain internal copies of key material, and buffers already handed to
// libuv/crypto cannot be recalled. This is best-effort defense in depth, not
// a hard guarantee — the durable protection is that raw DEKs are never
// persisted anywhere (only the KEK-wrapped form leaves this module).
//
// Errors are fixed uppercase codes only; no underlying library message, key
// material, or plaintext ever reaches a thrown error.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { scalarFromHexLE } from './paymentKeyStructure'
import {
  canonicalPaymentJson,
  decodeReceivingIdentity,
  normalizePaymentClaims,
  paymentBinding
} from './paymentClaims'

const ENVELOPE_VERSION = '1'
const PAYLOAD_VERSION = '1'
const KEK_INFO = 'stashernews/monero/tx-proof/kek/v1'
const AAD_DOMAIN = 'stashernews/monero/tx-proof/aad/v1'
const SALT_REGISTRY = 'tx-proof'

const DEK_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_HEX = 64

const REQUEST_INVALID = 'TXPROOF_REQUEST_INVALID'
const PROVIDER_INVALID = 'TXPROOF_PROVIDER_INVALID'
const ENVELOPE_INVALID = 'TXPROOF_ENVELOPE_INVALID'
const CLAIM_DIGEST_MISMATCH = 'TXPROOF_CLAIM_DIGEST_MISMATCH'
const AUTH_FAILED = 'TXPROOF_ENVELOPE_AUTH_FAILED'
const PAYLOAD_INVALID = 'TXPROOF_PAYLOAD_INVALID'

const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/
const CANONICAL_UNSIGNED = /^(0|[1-9][0-9]*)$/

const ENVELOPE_KEYS = [
  'bindingDigest', 'bindingVersion', 'claimDigest', 'ciphertext', 'dataNonce',
  'dataTag', 'envelopeVersion', 'masterKeyVersion', 'payloadVersion',
  'wrapNonce', 'wrapTag', 'wrappedDek'
]
const PAYLOAD_KEYS = ['additionalKeyCount', 'builtStructure', 'keyBundleHex', 'payloadVersion']
const BUILT_KEYS = [
  'actualDestinations', 'additionalPublicKeys', 'changeAddress',
  'changeAmountPiconeros', 'mainPublicKey', 'networkFeePiconeros',
  'outputKeys', 'txHash'
]
const DESTINATION_KEYS = ['address', 'amountPiconeros']

function fail (code) {
  throw new Error(code)
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto === null || proto === Object.prototype) return true
  // Cross-realm plain objects (e.g. a structuredClone() result under Jest's
  // vm modules): the prototype is that realm's Object.prototype and is itself
  // the top of a plain chain. Date/Map/class instances have a non-null grand
  // prototype and stay rejected. Mirrors paymentClaims.js.
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

function isBytes (value) {
  return value instanceof Uint8Array
}

function freeze (value) {
  // Typed-array views (Buffers) cannot be frozen in V8 — skip them; the
  // containing envelope/payload objects are still frozen.
  if (isBytes(value)) return value
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freeze(value[key])
    Object.freeze(value)
  }
  return value
}

function scrub (buffer) {
  if (isBytes(buffer)) buffer.fill(0)
}

function assertProvider (keyProvider) {
  if (keyProvider === null || typeof keyProvider !== 'object' ||
    typeof keyProvider.getMasterKey !== 'function' ||
    typeof keyProvider.getCurrentVersion !== 'function') {
    fail(PROVIDER_INVALID)
  }
}

function assertMasterKeyBytes (masterKey) {
  if (!isBytes(masterKey) || masterKey.length !== DEK_BYTES) fail(PROVIDER_INVALID)
}

// Secret-scalar chunk validation for the captured key bundle: the SDK's
// getKey() string is the concatenation of little-endian SECRET scalars
// (main first, then one per output) — NOT public points (final-review C1).
function requireSecretScalarChunk (chunk) {
  if (typeof chunk !== 'string' || !LOWER_HEX_64.test(chunk)) fail(PAYLOAD_INVALID)
  try {
    scalarFromHexLE(chunk)
  } catch {
    fail(PAYLOAD_INVALID)
  }
}

// Optional POPULATED public facts are validated as canonical curve points
// when present; null stays the honest "the SDK did not expose this" value.
function requireOptionalCanonicalPoint (value) {
  if (value === null) return
  if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) fail(PAYLOAD_INVALID)
  let point
  try {
    point = ed25519.ExtendedPoint.fromHex(value)
  } catch {
    fail(PAYLOAD_INVALID)
  }
  // Reject non-canonical encodings (including scalars ≥ the curve order that
  // would decode non-uniquely): the encoding must round-trip byte for byte.
  if (Buffer.from(point.toRawBytes()).toString('hex') !== value) fail(PAYLOAD_INVALID)
}

function requirePayloadAddress (value, network) {
  if (typeof value !== 'string') fail(PAYLOAD_INVALID)
  try {
    decodeReceivingIdentity(value, network)
  } catch {
    fail(PAYLOAD_INVALID)
  }
}

function requireCanonicalAmount (value) {
  if (typeof value !== 'string' || !CANONICAL_UNSIGNED.test(value)) fail(PAYLOAD_INVALID)
}

/**
 * Structural validation of a ProofPayloadV1: exact closed shapes, canonical
 * amounts/hashes, and the SECRET key-bundle contract — the bundle is the
 * concatenation of little-endian secret scalars (main first, then exactly
 * `additionalKeyCount` additional secrets), each strictly inside
 * 0 < s < curve order (final-review C1). The OPTIONAL populated public built
 * facts (mainPublicKey/additionalPublicKeys/outputKeys) must be canonical
 * point encodings when present and explicit null when the SDK did not expose
 * them; they are NEVER required to equal the secret bundle — confirmed raw
 * chain structure supplies the later independent correspondence gate
 * (Task 5). Populated built change fields are validated; an unavailable
 * change amount stays explicit null and pairs with a null change address.
 * Fields the SDK did not populate must be explicit null.
 */
function validateProofPayload (payload, network) {
  requireExactKeys(payload, PAYLOAD_KEYS, PAYLOAD_INVALID)
  if (payload.payloadVersion !== PAYLOAD_VERSION) fail(PAYLOAD_INVALID)
  if (!Number.isSafeInteger(payload.additionalKeyCount) || payload.additionalKeyCount < 0) fail(PAYLOAD_INVALID)

  const bundle = payload.keyBundleHex
  if (typeof bundle !== 'string' ||
    !HEX_BYTES.test(bundle) ||
    bundle.length === 0 ||
    bundle.length % KEY_HEX !== 0 ||
    bundle.length !== KEY_HEX * (1 + payload.additionalKeyCount)) {
    fail(PAYLOAD_INVALID)
  }
  for (let offset = 0; offset < bundle.length; offset += KEY_HEX) {
    requireSecretScalarChunk(bundle.slice(offset, offset + KEY_HEX))
  }

  const built = payload.builtStructure
  requireExactKeys(built, BUILT_KEYS, PAYLOAD_INVALID)
  if (typeof built.txHash !== 'string' || !LOWER_HEX_64.test(built.txHash)) fail(PAYLOAD_INVALID)
  requireCanonicalAmount(built.networkFeePiconeros)

  if (!Array.isArray(built.actualDestinations)) fail(PAYLOAD_INVALID)
  for (const destination of built.actualDestinations) {
    requireExactKeys(destination, DESTINATION_KEYS, PAYLOAD_INVALID)
    requirePayloadAddress(destination.address, network)
    requireCanonicalAmount(destination.amountPiconeros)
  }

  if (built.changeAddress !== null) requirePayloadAddress(built.changeAddress, network)
  if (built.changeAmountPiconeros !== null) requireCanonicalAmount(built.changeAmountPiconeros)
  if (built.changeAddress === null && built.changeAmountPiconeros !== null) fail(PAYLOAD_INVALID)

  // Populated public facts: canonical points when present, explicit null when
  // the SDK never exposed them. Deliberately NO equality requirement against
  // the secret bundle — the bundle and the published extra keys are different
  // representations of the same tx secrets (r*G, r_i*G or r_i*B), and the
  // kind-aware correspondence gate runs later against the confirmed chain.
  if (built.mainPublicKey !== null && built.mainPublicKey !== undefined) {
    requireOptionalCanonicalPoint(built.mainPublicKey)
  }
  if (built.additionalPublicKeys !== null && built.additionalPublicKeys !== undefined) {
    if (!Array.isArray(built.additionalPublicKeys) ||
      built.additionalPublicKeys.length !== payload.additionalKeyCount) {
      fail(PAYLOAD_INVALID)
    }
    for (const key of built.additionalPublicKeys) requireOptionalCanonicalPoint(key)
  }
  if (built.outputKeys !== null && built.outputKeys !== undefined) {
    if (!Array.isArray(built.outputKeys) || built.outputKeys.length === 0) fail(PAYLOAD_INVALID)
    for (const key of built.outputKeys) requireOptionalCanonicalPoint(key)
  }
}

const kekSalt = version => Buffer.from(
  canonicalPaymentJson({ masterKeyVersion: String(version), registry: SALT_REGISTRY }),
  'utf8'
)

function deriveKek (masterKey, version) {
  return Buffer.from(hkdfSync('sha256', masterKey, kekSalt(version), KEK_INFO, DEK_BYTES))
}

const aadFor = (binding, purpose) => Buffer.from(
  canonicalPaymentJson({ binding, domain: AAD_DOMAIN, purpose }),
  'utf8'
)

function requireBytes (value, length) {
  if (!isBytes(value) || value.length !== length) fail(ENVELOPE_INVALID)
}

// Strict structural validation BEFORE any key material is touched.
function validateEnvelopeShape (envelope) {
  requireExactKeys(envelope, ENVELOPE_KEYS, ENVELOPE_INVALID)
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) fail(ENVELOPE_INVALID)
  if (envelope.payloadVersion !== PAYLOAD_VERSION) fail(ENVELOPE_INVALID)
  if (envelope.bindingVersion !== ENVELOPE_VERSION) fail(ENVELOPE_INVALID)
  if (!Number.isSafeInteger(envelope.masterKeyVersion) || envelope.masterKeyVersion <= 0) fail(ENVELOPE_INVALID)
  for (const digest of ['claimDigest', 'bindingDigest']) {
    const value = envelope[digest]
    if (typeof value !== 'string' || !LOWER_HEX_64.test(value)) fail(ENVELOPE_INVALID)
  }
  requireBytes(envelope.dataNonce, NONCE_BYTES)
  requireBytes(envelope.wrapNonce, NONCE_BYTES)
  requireBytes(envelope.dataTag, TAG_BYTES)
  requireBytes(envelope.wrapTag, TAG_BYTES)
  requireBytes(envelope.wrappedDek, DEK_BYTES)
  if (!isBytes(envelope.ciphertext) || envelope.ciphertext.length === 0) fail(ENVELOPE_INVALID)
}

function bindingDigest (binding) {
  return createHash('sha256').update(canonicalPaymentJson(binding), 'utf8').digest('hex')
}

function decryptGcm (key, nonce, aad, ciphertext, tag) {
  let update = null
  let final = null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    update = decipher.update(ciphertext)
    final = decipher.final()
    return Buffer.concat([update, final])
  } catch {
    // GCM failure or any crypto-layer problem: one fixed code, never the
    // library message.
    fail(AUTH_FAILED)
  } finally {
    // update() exposes unauthenticated plaintext before final() verifies GCM.
    // Scrub mutable chunks on failure AND after copying on success. Immutable
    // JS strings and crypto-provider internal memory remain best-effort limits.
    scrub(update)
    scrub(final)
  }
}

/**
 * Seal a validated ProofPayloadV1 into a frozen EnvelopeV1 bound to the
 * canonical claims. A fresh random 32-byte DEK encrypts the canonical payload
 * JSON; the DEK is wrapped under an HKDF-derived KEK of the provider's current
 * master key. Both layers authenticate the claims binding.
 *
 * @param {{claims: object, payload: object, keyProvider: object}} request
 * @returns {frozen EnvelopeV1} exactly twelve fields; byte fields are Buffers
 */
export function sealPaymentProof (request) {
  requireExactKeys(request, ['claims', 'payload', 'keyProvider'], REQUEST_INVALID)
  const { claims, payload, keyProvider } = request

  const normalizedClaims = normalizePaymentClaims(claims)
  validateProofPayload(payload, normalizedClaims.scope.network)
  assertProvider(keyProvider)

  const currentVersion = keyProvider.getCurrentVersion()
  if (!Number.isSafeInteger(currentVersion) || currentVersion <= 0) fail(PROVIDER_INVALID)
  const masterKey = keyProvider.getMasterKey(currentVersion)
  // Best-effort hygiene on EVERY path (final-review M3): even a provider
  // returning a malformed buffer (assertMasterKeyBytes throws) has handed us
  // secret bytes — zero them rather than leak them. Honest limits: the
  // canonical payload string and the parsed payload object are immutable JS
  // strings/objects and cannot be scrubbed (GC only).
  let dek = null
  let kek = null
  let plaintext = null
  try {
    assertMasterKeyBytes(masterKey)
    dek = randomBytes(DEK_BYTES)

    const binding = paymentBinding(normalizedClaims, {
      masterKeyVersion: currentVersion,
      envelopeVersion: ENVELOPE_VERSION,
      payloadVersion: PAYLOAD_VERSION
    })
    kek = deriveKek(masterKey, currentVersion)

    const dataNonce = randomBytes(NONCE_BYTES)
    const wrapNonce = randomBytes(NONCE_BYTES)

    const dataCipher = createCipheriv('aes-256-gcm', dek, dataNonce)
    dataCipher.setAAD(aadFor(binding, 'data'))
    plaintext = Buffer.from(canonicalPaymentJson(payload), 'utf8')
    const ciphertext = Buffer.concat([
      dataCipher.update(plaintext),
      dataCipher.final()
    ])
    const dataTag = dataCipher.getAuthTag()

    const wrapCipher = createCipheriv('aes-256-gcm', kek, wrapNonce)
    wrapCipher.setAAD(aadFor(binding, 'wrap'))
    const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()])
    const wrapTag = wrapCipher.getAuthTag()

    return freeze({
      envelopeVersion: ENVELOPE_VERSION,
      payloadVersion: PAYLOAD_VERSION,
      bindingVersion: binding.bindingVersion,
      masterKeyVersion: currentVersion,
      claimDigest: binding.claimDigest,
      bindingDigest: bindingDigest(binding),
      dataNonce,
      dataTag,
      ciphertext,
      wrapNonce,
      wrapTag,
      wrappedDek
    })
  } finally {
    scrub(plaintext)
    scrub(dek)
    scrub(kek)
    scrub(masterKey)
  }
}

/**
 * Open an EnvelopeV1 against the EXPECTED authoritative claims and return the
 * validated ProofPayloadV1 (frozen). The claims/binding AAD is always
 * reconstructed from the caller-supplied claims — never from anything the
 * envelope carries — so an envelope copied from another payment fails
 * authentication before any key is touched.
 *
 * @param {{claims: object, envelope: object, keyProvider: object}} request
 * @returns {frozen ProofPayloadV1}
 */
export function openPaymentProof (request) {
  requireExactKeys(request, ['claims', 'envelope', 'keyProvider'], REQUEST_INVALID)
  const { claims, envelope, keyProvider } = request

  const normalizedClaims = normalizePaymentClaims(claims)
  validateEnvelopeShape(envelope)
  assertProvider(keyProvider)

  const expectedBinding = paymentBinding(normalizedClaims, {
    masterKeyVersion: envelope.masterKeyVersion,
    envelopeVersion: envelope.envelopeVersion,
    payloadVersion: envelope.payloadVersion
  })
  if (expectedBinding.claimDigest !== envelope.claimDigest ||
    bindingDigest(expectedBinding) !== envelope.bindingDigest) {
    fail(CLAIM_DIGEST_MISMATCH)
  }

  const masterKey = keyProvider.getMasterKey(envelope.masterKeyVersion)

  // Best-effort hygiene on EVERY path (final-review M3): malformed provider
  // buffers, failed decryptions and validation refusals all scrub the key
  // material and the decrypted plaintext buffer. Honest limits: the plaintext
  // string handed to JSON.parse and the parsed payload object are immutable
  // JS values that cannot be scrubbed (GC only).
  let kek = null
  let dek = null
  let plaintext = null
  try {
    assertMasterKeyBytes(masterKey)
    kek = deriveKek(masterKey, envelope.masterKeyVersion)
    dek = decryptGcm(
      kek,
      envelope.wrapNonce,
      aadFor(expectedBinding, 'wrap'),
      Buffer.from(envelope.wrappedDek),
      Buffer.from(envelope.wrapTag)
    )
    plaintext = decryptGcm(
      dek,
      envelope.dataNonce,
      aadFor(expectedBinding, 'data'),
      Buffer.from(envelope.ciphertext),
      Buffer.from(envelope.dataTag)
    )

    let parsed
    try {
      parsed = JSON.parse(plaintext.toString('utf8'))
    } catch {
      fail(PAYLOAD_INVALID)
    }
    validateProofPayload(parsed, normalizedClaims.scope.network)
    return freeze(parsed)
  } finally {
    scrub(plaintext)
    scrub(dek)
    scrub(kek)
    scrub(masterKey)
  }
}
