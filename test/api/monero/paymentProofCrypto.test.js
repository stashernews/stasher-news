/* eslint-env jest */

// TX-proof key registry and authenticated payment-proof envelope (Finding #1,
// Task 2). The registry is a separate, lazy, immutable version→key map with a
// mandatory explicit current version; the envelope seals a ProofPayloadV1 with
// a fresh random DEK wrapped under an HKDF-derived KEK, with both AES-GCM
// layers authenticated against the canonical claims binding.
//
// Everything here is synthetic: registry keys are generated in test memory
// (Buffer.alloc patterns, like the brief's pinned test) and no env dump, real
// key, or real secret appears anywhere. Error behavior is asserted by exact
// fixed error-code equality, so no test can pass while a message leaks key
// material, plaintext, or library internals.

import { Cipheriv, Decipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto'

import {
  canonicalPaymentJson,
  normalizePaymentClaims,
  paymentBinding,
  paymentClaimDigest
} from '@/api/monero/paymentClaims'
import { openPaymentProof, sealPaymentProof } from '@/api/monero/paymentProofCrypto'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { paymentFixture, paymentTxFixture } from '../../fixtures/payment-proof'

// --- helpers -----------------------------------------------------------------

const KEY_V1 = Buffer.alloc(32, 1).toString('base64')
const KEY_V2 = Buffer.alloc(32, 2).toString('base64')
const KEY_V3 = Buffer.alloc(32, 3).toString('base64')

const envFor = (versions, current) => ({
  TXPROOF_MASTER_KEYS: JSON.stringify(versions),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: String(current)
})

const providerFor = (versions = { 1: KEY_V1, 2: KEY_V2 }, current = 2) =>
  createPaymentProofKeyProvider(envFor(versions, current))

const claims = () => normalizePaymentClaims(paymentFixture())
const payload = () => paymentTxFixture().proofPayload

const seal = (keyProvider, overrides = {}) => sealPaymentProof({
  claims: overrides.claims ?? claims(),
  payload: overrides.payload ?? payload(),
  keyProvider
})

const open = (envelope, keyProvider, overrides = {}) => openPaymentProof({
  claims: overrides.claims ?? claims(),
  envelope,
  keyProvider
})

// Asserts the call throws an Error whose ENTIRE message is the fixed code —
// exact equality, so any leaked detail (key bytes, payload text, node crypto
// messages) fails the test. The optional label only names the case in the
// failure output; the raw thrown message is never printed (length only), so a
// leaking implementation cannot dump secrets through test diagnostics.
const expectCode = (fn, code, label) => {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  if (!(caught instanceof Error) || caught.message !== code) {
    const got = caught === null ? 'no error' : `an Error (message length ${caught.message.length})`
    throw new Error(`expected fixed error ${code}${label ? ` [${label}]` : ''}; got ${got}`)
  }
}

const flipLastByte = bytes => {
  const copy = Buffer.from(bytes)
  copy[copy.length - 1] ^= 0x01
  return copy
}

const clone = value => structuredClone(value)

describe('best-effort mutable plaintext hygiene', () => {
  afterEach(() => jest.restoreAllMocks())

  test.each(['wrap', 'data'])('scrubs decipher update plaintext on %s authentication failure', layer => {
    const provider = providerFor()
    const envelope = seal(provider)
    const damaged = { ...envelope, [`${layer}Tag`]: flipLastByte(envelope[`${layer}Tag`]) }
    const updates = []
    const original = Decipheriv.prototype.update
    jest.spyOn(Decipheriv.prototype, 'update').mockImplementation(function (...args) {
      const bytes = original.apply(this, args)
      updates.push(bytes)
      return bytes
    })
    expectCode(() => open(damaged, provider), 'TXPROOF_ENVELOPE_AUTH_FAILED')
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  })

  test.each([false, true])('scrubs sealing temporary payload buffer on final refusal %p', refusal => {
    const buffers = []
    const original = Cipheriv.prototype.update
    jest.spyOn(Cipheriv.prototype, 'update').mockImplementation(function (...args) {
      if (Buffer.isBuffer(args[0]) && args[0].length > 32) buffers.push(args[0])
      return original.apply(this, args)
    })
    if (refusal) jest.spyOn(Cipheriv.prototype, 'final').mockImplementation(() => { throw new Error('synthetic-final-refusal') })
    if (refusal) expect(() => seal(providerFor())).toThrow('synthetic-final-refusal')
    else expect(seal(providerFor()).ciphertext.length).toBeGreaterThan(0)
    expect(buffers).toHaveLength(1)
    expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  })
})

// A valid STAGENET ESCROW variant of the default fixture (different journal
// identity ⇒ different claim digest).
const escrowInput = () => {
  const base = paymentFixture()
  return {
    ...base,
    journalRole: 'ESCROW',
    kind: 'AWARD',
    distributionId: null,
    bountyPaymentId: '21',
    itemId: '301',
    frozenTerms: {
      recipientAddress: base.members[0].address,
      prizePiconeros: '40',
      feePiconeros: '20',
      feeRecipientAddress: base.members[1].address
    }
  }
}

// Valid claims variants, each differing from the default in exactly one
// authenticated identity dimension. Every one must fail envelope
// authentication against an envelope sealed for the default claims.
const variantInputs = () => ({
  'different txHash': paymentFixture({ txHash: 'a2'.repeat(32) }),
  'different dispatch': paymentFixture({ dispatchId: '00000000-0000-4000-8000-000000000002' }),
  'different wallet': paymentFixture({
    scope: { network: 'STAGENET', walletAddress: paymentFixture().members[0].address }
  }),
  'different network': paymentFixture({ network: 'MAINNET' }),
  'different members': paymentFixture({ repeatedRecipient: true }),
  'different fee policy': paymentFixture({ feeSubtractedFromLast: true }),
  'different kind': paymentFixture({ kind: 'OPS_SWEEP' }),
  'different distribution': paymentFixture({ distributionId: '2' }),
  'different source accounts': paymentFixture({ sourceAccounts: ['0', '1'] }),
  'different change destination': paymentFixture({
    change: { accountIndex: '0', subaddressIndex: '1', address: paymentFixture().scope.walletAddress }
  }),
  'different network fee': paymentFixture({ networkFeePiconeros: '8' }),
  'different journal role': escrowInput()
})

// --- key provider ------------------------------------------------------------

describe('createPaymentProofKeyProvider', () => {
  test('exposes the locked provider interface and reads the env registry', () => {
    const keys = providerFor()
    expect(typeof keys.getMasterKey).toBe('function')
    expect(typeof keys.getCurrentVersion).toBe('function')
    expect(typeof keys.getRegisteredVersions).toBe('function')
    expect(keys.getCurrentVersion()).toBe(2)
    expect(keys.getRegisteredVersions()).toEqual([1, 2])
    expect(keys.getMasterKey(2).equals(Buffer.alloc(32, 2))).toBe(true)
    expect(keys.getMasterKey('1').equals(Buffer.alloc(32, 1))).toBe(true)
  })

  test('returns a fresh defensive key copy on every call', () => {
    const keys = providerFor()
    const first = keys.getMasterKey(1)
    const second = keys.getMasterKey(1)
    expect(first.equals(second)).toBe(true)
    expect(first).not.toBe(second)
    first.fill(0)
    expect(keys.getMasterKey(1).equals(Buffer.alloc(32, 1))).toBe(true)
  })

  test('getRegisteredVersions returns fresh version-only arrays', () => {
    const keys = providerFor()
    const versions = keys.getRegisteredVersions()
    versions.push(99)
    versions[0] = -5
    expect(keys.getRegisteredVersions()).toEqual([1, 2])
    for (const version of keys.getRegisteredVersions()) {
      expect(Number.isSafeInteger(version)).toBe(true)
      expect(version).toBeGreaterThan(0)
    }
  })

  test('per-version env vars are a supported single source', () => {
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS_V1: KEY_V1,
      TXPROOF_MASTER_KEYS_V2: KEY_V2,
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
    })
    expect(keys.getRegisteredVersions()).toEqual([1, 2])
    expect(keys.getCurrentVersion()).toBe(2)
    const envelope = seal(keys)
    expect(open(envelope, keys)).toEqual(payload())
  })

  test('refuses ambiguous dual JSON + per-version sources', () => {
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1 }),
      TXPROOF_MASTER_KEYS_V3: KEY_V3,
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
    })
    expectCode(() => keys.getRegisteredVersions(), 'TXPROOF_REGISTRY_INVALID', 'dual source versions')
    expectCode(() => keys.getCurrentVersion(), 'TXPROOF_REGISTRY_INVALID', 'dual source current')
    expectCode(() => keys.getMasterKey(1), 'TXPROOF_REGISTRY_INVALID', 'dual source key')
  })

  test('refuses unsupported and unknown providers with a fixed code', () => {
    expectCode(() => createPaymentProofKeyProvider({ TXPROOF_MASTER_KEY_PROVIDER: 'kms' }), 'TXPROOF_PROVIDER_UNSUPPORTED', 'kms')
    expectCode(() => createPaymentProofKeyProvider({ TXPROOF_MASTER_KEY_PROVIDER: 'vault' }), 'TXPROOF_PROVIDER_UNSUPPORTED', 'vault')
    expectCode(() => createPaymentProofKeyProvider({ TXPROOF_MASTER_KEY_PROVIDER: 'ENV' }), 'TXPROOF_PROVIDER_UNSUPPORTED', 'wrong case')
  })

  test('is lazy: creation never needs keys, methods fail closed without them', () => {
    let keys
    expect(() => {
      keys = createPaymentProofKeyProvider({})
    }).not.toThrow()
    expectCode(() => keys.getRegisteredVersions(), 'TXPROOF_REGISTRY_INVALID', 'lazy versions')
    expectCode(() => keys.getCurrentVersion(), 'TXPROOF_REGISTRY_INVALID', 'lazy current')
  })

  test('requires a mandatory canonical current version', () => {
    const missing = createPaymentProofKeyProvider({ TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1 }) })
    expectCode(() => missing.getCurrentVersion(), 'TXPROOF_REGISTRY_INVALID', 'missing current')
    for (const bad of ['02', '0', '-1', '2.0', 'abc']) {
      const keys = createPaymentProofKeyProvider({
        TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1 }),
        TXPROOF_MASTER_KEY_CURRENT_VERSION: bad
      })
      expectCode(() => keys.getCurrentVersion(), 'TXPROOF_REGISTRY_INVALID', `malformed current ${bad}`)
    }
    const unregistered = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: KEY_V1 }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '9'
    })
    expectCode(() => unregistered.getCurrentVersion(), 'TXPROOF_KEY_VERSION_MISSING', 'unregistered current')
  })

  test('refuses malformed registries', () => {
    const cases = {
      'not json': 'not-json',
      'json array': '[1,2]',
      'json string': '"keys"',
      'json null': 'null',
      'empty object': '{}',
      'zero version key': JSON.stringify({ 0: KEY_V1 }),
      'non-canonical version key': JSON.stringify({ '01': KEY_V1 }),
      'negative version key': JSON.stringify({ '-1': KEY_V1 }),
      'non-numeric version key': JSON.stringify({ x: KEY_V1 }),
      'numeric key value': JSON.stringify({ 1: 42 }),
      'null key value': JSON.stringify({ 1: null })
    }
    for (const [name, registry] of Object.entries(cases)) {
      const keys = createPaymentProofKeyProvider({ TXPROOF_MASTER_KEYS: registry, TXPROOF_MASTER_KEY_CURRENT_VERSION: '1' })
      expectCode(() => keys.getRegisteredVersions(), 'TXPROOF_REGISTRY_INVALID', name)
    }
  })

  test('decodes keys defensively: metadata survives malformed key values', () => {
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: 'not valid base64!!', 2: KEY_V2 }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
    })
    expect(keys.getRegisteredVersions()).toEqual([1, 2])
    expect(keys.getCurrentVersion()).toBe(2)
    expectCode(() => keys.getMasterKey(1), 'TXPROOF_REGISTRY_KEY_INVALID', 'malformed value')
    expect(keys.getMasterKey(2).equals(Buffer.alloc(32, 2))).toBe(true)
  })

  test('enforces strict base64: length, alphabet and canonical padding', () => {
    // KEY_V1 ends with one '=' (32 bytes ⇒ 43 data chars + padding). The last
    // data char carries two discarded bits; 'R' has nonzero low bits, so the
    // value decodes to the same 32 bytes but does not re-encode to itself.
    const nonCanonical = KEY_V1.slice(0, 42) + 'R='
    const cases = {
      'garbage alphabet': '!'.repeat(44),
      'too short': Buffer.alloc(31, 1).toString('base64'),
      'too long': Buffer.alloc(33, 1).toString('base64'),
      'missing padding': KEY_V1.slice(0, -1),
      'non-canonical trailing bits': nonCanonical
    }
    for (const [name, value] of Object.entries(cases)) {
      const keys = createPaymentProofKeyProvider({
        TXPROOF_MASTER_KEYS: JSON.stringify({ 1: value }),
        TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
      })
      expectCode(() => keys.getMasterKey(1), 'TXPROOF_REGISTRY_KEY_INVALID', name)
    }
  })

  test('validates master-key version arguments strictly', () => {
    const keys = providerFor()
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '0', '01', '-1', '1.0', 'x', null, undefined]) {
      expectCode(() => keys.getMasterKey(bad), 'TXPROOF_KEY_VERSION_INVALID', `version ${String(bad)}`)
    }
    expectCode(() => keys.getMasterKey(3), 'TXPROOF_KEY_VERSION_MISSING', 'unregistered')
  })
})

// --- seal: envelope structure and construction -------------------------------

describe('sealPaymentProof: envelope structure', () => {
  test('binds fee/member/dispatch and retains old master versions', () => {
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64'), 2: Buffer.alloc(32, 2).toString('base64') }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
    })
    const claims = normalizePaymentClaims(paymentFixture())
    const payload = paymentTxFixture().proofPayload
    const envelope = sealPaymentProof({ claims, payload, keyProvider: keys })
    expect(envelope.masterKeyVersion).toBe(2)
    expect(openPaymentProof({ claims, envelope, keyProvider: keys })).toEqual(payload)
    const changed = normalizePaymentClaims(paymentFixture({ networkFeePiconeros: '8' }))
    expect(() => openPaymentProof({ claims: changed, envelope, keyProvider: keys })).toThrow()
  })

  test('envelope carries exactly the twelve V1 fields with correct shapes', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    expect([...Object.keys(envelope)].sort()).toEqual([
      'bindingDigest', 'bindingVersion', 'ciphertext', 'claimDigest', 'dataNonce',
      'dataTag', 'envelopeVersion', 'masterKeyVersion', 'payloadVersion',
      'wrapNonce', 'wrapTag', 'wrappedDek'
    ])
    expect(envelope.envelopeVersion).toBe('1')
    expect(envelope.payloadVersion).toBe('1')
    expect(envelope.bindingVersion).toBe('1')
    expect(envelope.masterKeyVersion).toBe(2)
    expect(Number.isSafeInteger(envelope.masterKeyVersion)).toBe(true)
    expect(envelope.claimDigest).toBe(paymentClaimDigest(claims()))
    const binding = paymentBinding(claims(), { masterKeyVersion: envelope.masterKeyVersion, envelopeVersion: 1, payloadVersion: 1 })
    expect(envelope.bindingDigest)
      .toBe(createHash('sha256').update(canonicalPaymentJson(binding), 'utf8').digest('hex'))
    expect(envelope.dataNonce).toHaveLength(12)
    expect(envelope.wrapNonce).toHaveLength(12)
    expect(envelope.dataTag).toHaveLength(16)
    expect(envelope.wrapTag).toHaveLength(16)
    expect(envelope.wrappedDek).toHaveLength(32)
    expect(envelope.ciphertext.length).toBeGreaterThan(0)
    for (const bytes of [envelope.dataNonce, envelope.wrapNonce, envelope.dataTag, envelope.wrapTag, envelope.wrappedDek, envelope.ciphertext]) {
      expect(bytes instanceof Uint8Array).toBe(true)
      expect(Buffer.isBuffer(bytes)).toBe(true)
    }
    expect(Object.isFrozen(envelope)).toBe(true)
  })

  test('seals of identical inputs use fresh nonces but identical digests', () => {
    const keys = providerFor()
    const first = seal(keys)
    const second = seal(keys)
    expect(Buffer.compare(first.dataNonce, second.dataNonce)).not.toBe(0)
    expect(Buffer.compare(first.wrapNonce, second.wrapNonce)).not.toBe(0)
    expect(Buffer.compare(first.ciphertext, second.ciphertext)).not.toBe(0)
    expect(first.bindingDigest).toBe(second.bindingDigest)
    expect(first.claimDigest).toBe(second.claimDigest)
    expect(open(first, keys)).toEqual(payload())
    expect(open(second, keys)).toEqual(payload())
  })

  test('refuses requests without exactly claims/payload/keyProvider', () => {
    const keys = providerFor()
    expectCode(() => sealPaymentProof({ claims: claims(), payload: payload() }), 'TXPROOF_REQUEST_INVALID', 'missing keyProvider')
    expectCode(() => sealPaymentProof({ claims: claims(), keyProvider: keys }), 'TXPROOF_REQUEST_INVALID', 'missing payload')
    expectCode(() => sealPaymentProof({ claims: claims(), payload: payload(), keyProvider: keys, extra: 1 }), 'TXPROOF_REQUEST_INVALID', 'extra key')
  })

  test('refuses providers that do not honor the provider contract', () => {
    expectCode(() => sealPaymentProof({ claims: claims(), payload: payload(), keyProvider: null }), 'TXPROOF_PROVIDER_INVALID', 'null provider')
    expectCode(() => sealPaymentProof({ claims: claims(), payload: payload(), keyProvider: {} }), 'TXPROOF_PROVIDER_INVALID', 'empty provider')
    expectCode(() => sealPaymentProof({
      claims: claims(),
      payload: payload(),
      keyProvider: { getCurrentVersion: () => 1 }
    }), 'TXPROOF_PROVIDER_INVALID', 'no getMasterKey')
    expectCode(() => sealPaymentProof({
      claims: claims(),
      payload: payload(),
      keyProvider: { getCurrentVersion: () => 0, getMasterKey: () => Buffer.alloc(32) }
    }), 'TXPROOF_PROVIDER_INVALID', 'zero current version')
    expectCode(() => sealPaymentProof({
      claims: claims(),
      payload: payload(),
      keyProvider: { getCurrentVersion: () => 1, getMasterKey: () => Buffer.alloc(16) }
    }), 'TXPROOF_PROVIDER_INVALID', 'short master key')
  })
})

describe('sealPaymentProof: pinned KEK/AAD construction', () => {
  test('envelope decrypts under the brief formulas via an independent oracle', () => {
    const master = Buffer.alloc(32, 3)
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 7: master.toString('base64') }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '7'
    })
    const sealedClaims = claims()
    const sealedPayload = payload()
    const envelope = seal(keys)

    // Independent reimplementation of the spec (salt, info, AAD, purposes).
    const salt = Buffer.from(canonicalPaymentJson({ masterKeyVersion: '7', registry: 'tx-proof' }), 'utf8')
    const kek = Buffer.from(hkdfSync('sha256', master, salt, 'stashernews/monero/tx-proof/kek/v1', 32))
    const binding = paymentBinding(sealedClaims, { masterKeyVersion: 7, envelopeVersion: 1, payloadVersion: 1 })
    const aad = purpose => Buffer.from(canonicalPaymentJson({
      binding, domain: 'stashernews/monero/tx-proof/aad/v1', purpose
    }), 'utf8')

    // The DEK wrap is authenticated with purpose 'wrap' — decrypting the wrap
    // under the 'data' AAD must fail, which pins each layer to its own AAD.
    expect(() => {
      const wrong = createDecipheriv('aes-256-gcm', kek, Buffer.from(envelope.wrapNonce))
      wrong.setAAD(aad('data'))
      wrong.setAuthTag(Buffer.from(envelope.wrapTag))
      Buffer.concat([wrong.update(Buffer.from(envelope.wrappedDek)), wrong.final()])
    }).toThrow()

    const wrapDecipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(envelope.wrapNonce))
    wrapDecipher.setAAD(aad('wrap'))
    wrapDecipher.setAuthTag(Buffer.from(envelope.wrapTag))
    const dek = Buffer.concat([wrapDecipher.update(Buffer.from(envelope.wrappedDek)), wrapDecipher.final()])
    expect(dek).toHaveLength(32)

    const dataDecipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.dataNonce))
    dataDecipher.setAAD(aad('data'))
    dataDecipher.setAuthTag(Buffer.from(envelope.dataTag))
    const plaintext = Buffer.concat([dataDecipher.update(Buffer.from(envelope.ciphertext)), dataDecipher.final()])
    expect(plaintext.toString('utf8')).toBe(canonicalPaymentJson(sealedPayload))
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual(sealedPayload)
    dek.fill(0)
    kek.fill(0)
  })
})

// --- open: authentication ----------------------------------------------------

describe('openPaymentProof: claim authentication', () => {
  test('every authenticated identity mutation fails envelope authentication', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    for (const [name, variant] of Object.entries(variantInputs())) {
      const swapped = normalizePaymentClaims(variant)
      expectCode(() => open(envelope, keys, { claims: swapped }), 'TXPROOF_CLAIM_DIGEST_MISMATCH', name)
    }
  })

  test('invalid swapped claims fail with fixed claims errors, not envelope errors', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    expectCode(
      () => open(envelope, keys, { claims: paymentFixture({ principalPiconeros: '61' }) }),
      'PAYMENT_CLAIMS_INCONSISTENT',
      'inconsistent principal'
    )
    expectCode(
      () => open(envelope, keys, { claims: { ...paymentFixture(), unknownField: 1 } }),
      'PAYMENT_CLAIMS_INVALID',
      'unknown claims field'
    )
  })

  test('copied envelopes fail authentication even when the other key exists', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    expect(envelope.masterKeyVersion).toBe(2)
    expectCode(() => open({ ...envelope, masterKeyVersion: 1 }, keys), 'TXPROOF_CLAIM_DIGEST_MISMATCH', 'swap to registered key 1')
    expectCode(() => open({ ...envelope, masterKeyVersion: 9 }, keys), 'TXPROOF_CLAIM_DIGEST_MISMATCH', 'swap to unregistered key 9')
  })

  test('any tampering with authenticated bytes fails GCM authentication', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    for (const field of ['dataNonce', 'wrapNonce', 'dataTag', 'wrapTag', 'ciphertext', 'wrappedDek']) {
      expectCode(
        () => open({ ...envelope, [field]: flipLastByte(envelope[field]) }, keys),
        'TXPROOF_ENVELOPE_AUTH_FAILED',
        field
      )
    }
  })

  test('envelope shape is validated before keys are touched', () => {
    const narrowed = providerFor({ 2: KEY_V2 }, 2)
    const envelope = seal(narrowed)
    const broken = { ...envelope, dataTag: envelope.dataTag.subarray(0, 15) }
    expectCode(() => open(broken, narrowed), 'TXPROOF_ENVELOPE_INVALID', 'short data tag')
  })

  test('claims authentication precedes key lookup', () => {
    // Registry that cannot satisfy the envelope's key version at all.
    const rotated = providerFor({ 2: KEY_V2 }, 2)
    const legacy = providerFor({ 1: KEY_V1, 2: KEY_V2 }, 1)
    const legacyEnvelope = seal(legacy)
    expect(legacyEnvelope.masterKeyVersion).toBe(1)
    expectCode(
      () => open(legacyEnvelope, rotated, { claims: normalizePaymentClaims(escrowInput()) }),
      'TXPROOF_CLAIM_DIGEST_MISMATCH',
      'swapped claims before missing key'
    )
  })

  test('mixed-version decrypt: old envelopes stay openable, missing old keys fail fixed', () => {
    const legacy = providerFor({ 1: KEY_V1, 2: KEY_V2 }, 1)
    const current = providerFor({ 1: KEY_V1, 2: KEY_V2 }, 2)
    const legacyEnvelope = seal(legacy)
    const currentEnvelope = seal(current)
    expect(legacyEnvelope.masterKeyVersion).toBe(1)
    expect(currentEnvelope.masterKeyVersion).toBe(2)

    // Rotation that dropped the old key: old envelopes refuse with a fixed code.
    const rotated = providerFor({ 2: KEY_V2 }, 2)
    expectCode(() => open(legacyEnvelope, rotated), 'TXPROOF_KEY_VERSION_MISSING', 'dropped old key')
    expect(open(currentEnvelope, rotated)).toEqual(payload())

    // A registry that retains both versions opens both generations.
    expect(open(legacyEnvelope, legacy)).toEqual(payload())
    expect(open(currentEnvelope, current)).toEqual(payload())
  })
})

describe('openPaymentProof: envelope shape', () => {
  const keys = providerFor()
  let envelope

  beforeAll(() => {
    envelope = seal(keys)
  })

  const brokenCases = () => ({
    'envelope version bumped': { envelopeVersion: '2' },
    'payload version bumped': { payloadVersion: '2' },
    'binding version bumped': { bindingVersion: '2' },
    'zero key version': { masterKeyVersion: 0 },
    'negative key version': { masterKeyVersion: -1 },
    'fractional key version': { masterKeyVersion: 1.5 },
    'string key version': { masterKeyVersion: '2' },
    'unsafe key version': { masterKeyVersion: Number.MAX_SAFE_INTEGER + 1 },
    'uppercase claim digest': { claimDigest: envelope.claimDigest.toUpperCase() },
    'short claim digest': { claimDigest: envelope.claimDigest.slice(0, 63) },
    'nonstring claim digest': { claimDigest: 42 },
    'malformed binding digest': { bindingDigest: 'zz'.repeat(32) },
    'short data nonce': { dataNonce: envelope.dataNonce.subarray(0, 11) },
    'long data nonce': { dataNonce: Buffer.concat([envelope.dataNonce, Buffer.alloc(1)]) },
    'nonstring nonce': { dataNonce: envelope.dataNonce.toString('hex') },
    'short data tag': { dataTag: envelope.dataTag.subarray(0, 15) },
    'long data tag': { dataTag: Buffer.concat([envelope.dataTag, Buffer.alloc(1)]) },
    'short wrap tag': { wrapTag: envelope.wrapTag.subarray(0, 15) },
    'long wrap nonce': { wrapNonce: Buffer.concat([envelope.wrapNonce, Buffer.alloc(1)]) },
    'short wrapped dek': { wrappedDek: envelope.wrappedDek.subarray(0, 31) },
    'long wrapped dek': { wrappedDek: Buffer.concat([envelope.wrappedDek, Buffer.alloc(1)]) },
    'empty ciphertext': { ciphertext: Buffer.alloc(0) },
    'nonstring ciphertext': { ciphertext: envelope.ciphertext.toString('base64') }
  })

  test('structural tampering is refused before any decryption', () => {
    for (const [name, patch] of Object.entries(brokenCases())) {
      expectCode(() => open({ ...envelope, ...patch }, keys), 'TXPROOF_ENVELOPE_INVALID', name)
    }
  })

  test('extra and missing envelope keys are refused', () => {
    expectCode(() => open({ ...envelope, extraField: 1 }, keys), 'TXPROOF_ENVELOPE_INVALID', 'extra key')
    const missingDigest = { ...envelope }
    delete missingDigest.bindingDigest
    expectCode(() => open(missingDigest, keys), 'TXPROOF_ENVELOPE_INVALID', 'missing bindingDigest')
    const missingBytes = { ...envelope }
    delete missingBytes.wrapTag
    expectCode(() => open(missingBytes, keys), 'TXPROOF_ENVELOPE_INVALID', 'missing wrapTag')
  })

  test('refuses requests without exactly claims/envelope/keyProvider', () => {
    expectCode(() => openPaymentProof({ envelope, keyProvider: keys }), 'TXPROOF_REQUEST_INVALID', 'missing claims')
    expectCode(() => openPaymentProof({ claims: claims(), keyProvider: keys }), 'TXPROOF_REQUEST_INVALID', 'missing envelope')
    expectCode(() => openPaymentProof({ claims: claims(), envelope }), 'TXPROOF_REQUEST_INVALID', 'missing keyProvider')
  })
})

// --- ProofPayloadV1 validation -----------------------------------------------

describe('ProofPayloadV1 validation', () => {
  const keys = providerFor()

  const mutated = fn => {
    const value = clone(payload())
    fn(value)
    return value
  }

  const pointHex = () => paymentTxFixture({ populatedPublicKeys: true }).proofPayload.builtStructure.outputKeys[0]

  const invalidCases = () => ({
    'payload version bumped': p => { p.payloadVersion = '2' },
    'extra top-level key': p => { p.unknown = true },
    'missing key bundle': p => { delete p.keyBundleHex },
    'negative key count': p => { p.additionalKeyCount = -1 },
    'fractional key count': p => { p.additionalKeyCount = 1.5 },
    'string key count': p => { p.additionalKeyCount = '3' },
    'count inconsistent with bundle': p => { p.additionalKeyCount = 2 },
    'empty key bundle': p => { p.keyBundleHex = '' },
    'uppercase key bundle': p => { p.keyBundleHex = 'AB'.repeat(32) + p.keyBundleHex.slice(64) },
    'odd-length key bundle': p => { p.keyBundleHex = p.keyBundleHex.slice(1) },
    'truncated key bundle': p => { p.keyBundleHex = p.keyBundleHex.slice(0, -64) },
    'appended key bundle': p => { p.keyBundleHex = p.keyBundleHex + pointHex() },
    'non-point bundle slice': p => { p.keyBundleHex = 'ff'.repeat(32) + p.keyBundleHex.slice(64) },
    'populated main key non-hex': p => { p.builtStructure.mainPublicKey = 'zz'.repeat(32) },
    'populated main key non-canonical': p => { p.builtStructure.mainPublicKey = '02'.repeat(32) },
    'additional keys wrong length': p => { p.builtStructure.additionalPublicKeys = [] },
    'populated additional key non-canonical': p => {
      p.builtStructure.additionalPublicKeys = [
        pointHex(), pointHex(), 'ff'.repeat(32)
      ]
    },
    'populated output key non-canonical': p => {
      p.builtStructure.outputKeys = ['ff'.repeat(32), pointHex(), pointHex()]
    },
    'change amount without address': p => {
      p.builtStructure.changeAddress = null
      p.builtStructure.changeAmountPiconeros = '33'
    },
    'built structure extra key': p => { p.builtStructure.unknown = 1 },
    'built structure missing key': p => { delete p.builtStructure.changeAddress },
    'uppercase tx hash': p => { p.builtStructure.txHash = p.builtStructure.txHash.toUpperCase() },
    'short tx hash': p => { p.builtStructure.txHash = p.builtStructure.txHash.slice(1) },
    'numeric fee': p => { p.builtStructure.networkFeePiconeros = 7 },
    'non-canonical fee': p => { p.builtStructure.networkFeePiconeros = '07' },
    'negative fee': p => { p.builtStructure.networkFeePiconeros = '-1' },
    'destinations not array': p => { p.builtStructure.actualDestinations = {} },
    'destination extra key': p => { p.builtStructure.actualDestinations[0].memo = 'x' },
    'destination bad address': p => { p.builtStructure.actualDestinations[0].address = 'not-an-address' },
    'destination non-canonical amount': p => { p.builtStructure.actualDestinations[0].amountPiconeros = '01' },
    'numeric destination amount': p => { p.builtStructure.actualDestinations[0].amountPiconeros = 40 },
    'bad change address': p => { p.builtStructure.changeAddress = 'not-an-address' },
    'fractional change amount': p => { p.builtStructure.changeAmountPiconeros = '1.5' }
  })

  test('seal refuses malformed payloads with a fixed code', () => {
    for (const [name, mutate] of Object.entries(invalidCases())) {
      expectCode(() => seal(keys, { payload: mutated(mutate) }), 'TXPROOF_PAYLOAD_INVALID', name)
    }
  })

  test('explicit nulls for unpopulated built fields are accepted', () => {
    const withNulls = mutated(p => {
      p.builtStructure.additionalPublicKeys = null
      p.builtStructure.outputKeys = null
      p.builtStructure.changeAddress = null
      p.builtStructure.changeAmountPiconeros = null
    })
    const envelope = seal(keys, { payload: withNulls })
    expect(open(envelope, keys)).toEqual(withNulls)
  })

  test('an off-bundle populated main public key is accepted (no bundle↔public equality requirement)', () => {
    // Final-review C1: the bundle carries SECRET scalars and the optional
    // populated public facts are a different representation — the validator
    // must never require equality between them (the raw chain is the gate).
    const offBundle = mutated(p => { p.builtStructure.mainPublicKey = pointHex() })
    const envelope = seal(keys, { payload: offBundle })
    expect(open(envelope, keys)).toEqual(offBundle)
  })

  test('a change-less payment seals and opens end to end', () => {
    const changelessClaims = normalizePaymentClaims(paymentFixture({ change: null }))
    const changelessPayload = paymentTxFixture({ change: null }).proofPayload
    const envelope = sealPaymentProof({ claims: changelessClaims, payload: changelessPayload, keyProvider: keys })
    expect(openPaymentProof({ claims: changelessClaims, envelope, keyProvider: keys })).toEqual(changelessPayload)
  })

  test('open validates the decrypted payload before returning it', () => {
    // The payload validator is shared between seal and open; the open-side
    // gate is exercised through a round trip whose decrypted value must equal
    // a valid payload and be frozen.
    const envelope = seal(keys)
    const opened = open(envelope, keys)
    expect(opened).toEqual(payload())
    expect(Object.isFrozen(opened)).toBe(true)
    expect(Object.isFrozen(opened.builtStructure)).toBe(true)
  })
})

// --- secrecy and hygiene -----------------------------------------------------

describe('secrecy and hygiene', () => {
  test('errors never contain key material or sentinels', () => {
    const canaryBytes = Buffer.concat([Buffer.from('CANARY'), Buffer.alloc(28, 7)])
    const canaryB64 = canaryBytes.toString('base64')
    expect(canaryB64).toContain('Q0FOQVJZ')

    const canary = (fn, sentinels, label) => {
      let caught = null
      try {
        fn()
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      for (const sentinel of sentinels) {
        expect(caught.message).not.toContain(sentinel)
        if (caught.message.includes(sentinel)) throw new Error(`leaked sentinel in ${label}`)
      }
    }

    // Sentinel in the raw key bytes and in the registry text.
    const keys = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: canaryB64 }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
    })
    canary(() => keys.getMasterKey(2), ['CANARY', 'Q0FOQVJZ'], 'missing version')
    canary(() => keys.getMasterKey('x'), ['CANARY', 'Q0FOQVJZ'], 'invalid version')
    const malformed = createPaymentProofKeyProvider({
      TXPROOF_MASTER_KEYS: JSON.stringify({ 1: `!!${canaryB64}` }),
      TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
    })
    canary(() => malformed.getMasterKey(1), ['CANARY', 'Q0FOQVJZ'], 'malformed key value')

    // Envelope failures must not leak payload or claims content either.
    const provider = providerFor()
    const envelope = seal(provider)
    const walletAddress = claims().scope.walletAddress
    canary(
      () => open({ ...envelope, ciphertext: flipLastByte(envelope.ciphertext) }, provider),
      [walletAddress],
      'gcm failure'
    )
    canary(
      () => open(envelope, provider, { claims: normalizePaymentClaims(escrowInput()) }),
      [walletAddress],
      'claims swap'
    )
  })

  test('swapped-claims refusals are fixed and detail-free', () => {
    const keys = providerFor()
    const envelope = seal(keys)
    expectCode(
      () => open(envelope, keys, { claims: normalizePaymentClaims(escrowInput()) }),
      'TXPROOF_CLAIM_DIGEST_MISMATCH',
      'escrow swap'
    )
  })
})
