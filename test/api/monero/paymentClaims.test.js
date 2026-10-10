/* eslint-env jest */

// Canonical payment-claims codec (Finding #1, Task 1): a closed PaymentClaimsV1
// union with exact canonical serialization, receiving-identity aggregation and
// binding digests. The claims commit to the payment's immutable structure —
// never to mutable state (dates, attempts, dispatch bookkeeping).
//
// Addresses are real syntactically valid deterministic points/checksums on the
// MAINNET (18/19/42) and STAGENET (24/25/36) prefixes; nothing here is a real
// wallet, key, or historical claim.

import { base58xmr } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519'
import { keccak256 } from 'js-sha3'

import {
  canonicalPaymentJson,
  decodeReceivingIdentity,
  normalizePaymentClaims,
  paymentBinding,
  paymentClaimDigest
} from '@/api/monero/paymentClaims'
import {
  paymentChainFixture,
  paymentFixture,
  paymentTxFixture
} from '../../fixtures/payment-proof'

// Independent stagenet/mainnet address encoder for adversarial cases (the
// product codec must not be trusted to build its own negative fixtures).
function encodeAddress (prefix, spendKeyHex, viewKeyHex, paymentIdHex = null) {
  const size = 1 + 32 + 32 + (paymentIdHex ? 8 : 0)
  const body = new Uint8Array(size)
  body[0] = prefix
  body.set(Buffer.from(spendKeyHex, 'hex'), 1)
  body.set(Buffer.from(viewKeyHex, 'hex'), 33)
  if (paymentIdHex) body.set(Buffer.from(paymentIdHex, 'hex'), 65)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}

const VALID_POINT = '00'.repeat(32)
const INVALID_POINT = '02'.repeat(32)
const STAGENET_PRIMARY_PREFIX = 24
const MAINNET_PRIMARY_PREFIX = 18
const TESTNET_PRIMARY_PREFIX = 53

const clone = value => structuredClone(value)

function mutate (fn) {
  const input = clone(paymentFixture())
  fn(input)
  return input
}

// A valid STAGENET/ESCROW/AWARD variant of the default fixture, used to pin
// role-specific validation without a second fixture family.
function escrowFixture () {
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

describe('normalizePaymentClaims: receiving aggregation', () => {
  test('keeps two obligations but aggregates one receiving identity', () => {
    const input = paymentFixture({ repeatedRecipient: true })
    const claims = normalizePaymentClaims(input)
    expect(claims.members).toHaveLength(2)
    expect(claims.receivingAggregates).toHaveLength(1)
    expect(claims.receivingAggregates[0].amountPiconeros).toBe('60')
    expect(paymentClaimDigest(claims)).toBe(paymentClaimDigest(normalizePaymentClaims({
      ...input, members: [...input.members].reverse()
    })))
  })

  test.each(['01', '-0', '1e3', 1.5, Number.MAX_SAFE_INTEGER + 1, null])(
    'refuses noncanonical principal %p', value => {
      expect(() => normalizePaymentClaims(paymentFixture({ principalPiconeros: value }))).toThrow()
    }
  )

  test('disagrees over two distinct receiving identities', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    expect(claims.receivingAggregates).toHaveLength(2)
    const total = claims.receivingAggregates.reduce((sum, a) => sum + BigInt(a.amountPiconeros), 0n)
    expect(total).toBe(60n)
  })

  test('preserves the integrated alias payment-ID claim while sharing its identity', () => {
    const claims = normalizePaymentClaims(paymentFixture({ repeatedRecipient: true }))
    const integrated = claims.members.filter(m => m.type === 'INTEGRATED')
    expect(integrated).toHaveLength(1)
    expect(integrated[0].paymentId).toMatch(/^[0-9a-f]{16}$/)
    const primary = claims.members.filter(m => m.type === 'PRIMARY')
    expect(primary).toHaveLength(1)
    expect(primary[0].paymentId).toBeNull()
    expect(integrated[0].receivingIdentity).toBe(primary[0].receivingIdentity)
    expect(claims.receivingAggregates).toHaveLength(1)
  })

  test('aggregates exact actual amounts under fee subtraction', () => {
    const claims = normalizePaymentClaims(paymentFixture({ feeSubtractedFromLast: true }))
    expect(claims.feePolicy.mode).toBe('SUBTRACT_LAST')
    expect(claims.feePolicy.legs.at(-1).actualPiconeros).toBe('13')
    expect(claims.receivingAggregates).toHaveLength(2)
    const total = claims.receivingAggregates.reduce((sum, a) => sum + BigInt(a.amountPiconeros), 0n)
    expect(total).toBe(53n)
  })

  test('normalization is idempotent and frozen', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    expect(normalizePaymentClaims(claims)).toEqual(claims)
    expect(Object.isFrozen(claims)).toBe(true)
    expect(Object.isFrozen(claims.members[0])).toBe(true)
    expect(Object.isFrozen(claims.feePolicy.legs)).toBe(true)
  })
})

describe('normalizePaymentClaims: canonical digest binding', () => {
  const baseDigest = () => paymentClaimDigest(normalizePaymentClaims(paymentFixture()))

  test('pins the canonical default-fixture claim digest', () => {
    // Byte-exact regression guard for the canonical serialization contract
    // that later tasks (envelope binding, store, verifier) depend on. A
    // legitimate claims-shape change must deliberately update this value.
    expect(baseDigest()).toBe('8a44bf24264d3856e59db1a18c3289524f68ddba650c914ccf11211eaf545fe6')
    expect(paymentClaimDigest(normalizePaymentClaims(paymentFixture({ repeatedRecipient: true }))))
      .toBe('f246fd1d310dc9dd52ea0616954ed61405d3534714772e3e69bf0262b98cab82')
  })

  test.each([
    ['member id', i => {
      i.members[0].id = '99'
      i.feePolicy.legs[0].memberId = '99'
    }],
    ['network fee', i => { i.networkFeePiconeros = '8' }],
    ['source account', i => { i.sourceAccounts = ['1'] }],
    ['kind', i => { i.kind = 'OPS_SWEEP' }],
    ['dispatch id', i => { i.dispatchId = '00000000-0000-4000-8000-000000000002' }],
    ['transaction hash', i => { i.txHash = 'f2'.repeat(32) }],
    ['member gross and actual', i => {
      i.members[0].grossPiconeros = '41'
      i.members[0].actualPiconeros = '41'
      i.principalPiconeros = '61'
      i.feePolicy.legs[0].grossPiconeros = '41'
      i.feePolicy.legs[0].actualPiconeros = '41'
      i.receivingAggregates = i.receivingAggregates.map(a =>
        a.receivingIdentity === i.members[0].receivingIdentity ? { ...a, amountPiconeros: '41' } : a)
    }],
    ['scope wallet address', i => { i.scope.walletAddress = i.members[0].address }],
    ['change address', i => { i.change.address = i.members[0].address }],
    ['fee policy mode and actuals', i => {
      i.networkFeePiconeros = '7'
      i.members[1].actualPiconeros = '13'
      i.feePolicy.mode = 'SUBTRACT_LAST'
      i.feePolicy.legs[1].actualPiconeros = '13'
      i.receivingAggregates = i.receivingAggregates.map(a =>
        a.receivingIdentity === i.members[1].receivingIdentity ? { ...a, amountPiconeros: '13' } : a)
    }]
  ])('altered %s changes the digest', (_label, change) => {
    const input = mutate(change)
    expect(paymentClaimDigest(normalizePaymentClaims(input))).not.toBe(baseDigest())
  })

  test('object-key order and duplicate normalization never change the digest', () => {
    const fixture = paymentFixture()
    const reordered = {
      ...clone(fixture),
      scope: { walletAddress: fixture.scope.walletAddress, network: fixture.scope.network },
      members: fixture.members.map(m => ({ actualPiconeros: m.actualPiconeros, id: m.id, address: m.address, leg: m.leg, type: m.type, paymentId: m.paymentId, receivingIdentity: m.receivingIdentity, grossPiconeros: m.grossPiconeros }))
    }
    expect(paymentClaimDigest(normalizePaymentClaims(reordered))).toBe(baseDigest())
  })

  test('member leg participates in the digest (escrow role)', () => {
    const input = escrowFixture()
    const before = paymentClaimDigest(normalizePaymentClaims(input))
    input.members[1].leg = 'FEE'
    input.feePolicy.legs[1].leg = 'FEE'
    expect(normalizePaymentClaims(input).members.find(m => m.id === '12').leg).toBe('FEE')
    expect(paymentClaimDigest(normalizePaymentClaims(input))).not.toBe(before)
  })
})

describe('normalizePaymentClaims: closed-union negatives', () => {
  test.each([
    ['unknown top-level field state', i => { i.state = 'PREPARED' }],
    ['unknown top-level field attempts', i => { i.attempts = 1 }],
    ['date field', i => { i.observedAt = '2026-10-06T12:00:00.000Z' }],
    ['unknown member field', i => { i.members[0].owned = true }],
    ['unknown fee-policy field', i => { i.feePolicy.subtractFrom = 'LAST' }],
    ['unknown aggregate field', i => { i.receivingAggregates[0].address = i.members[0].address }],
    ['unknown owned-target field', i => {
      i.ownedTargets = [{ accountIndex: '0', subaddressIndex: '0', address: i.members[0].address, amountPiconeros: '1', label: 'x' }]
    }],
    ['unknown change field', i => { i.change.amountPiconeros = '33' }]
  ])('rejects %s', (_label, change) => {
    expect(() => normalizePaymentClaims(mutate(change))).toThrow()
  })

  test('rejects duplicate member IDs with the same leg', () => {
    expect(() => normalizePaymentClaims(mutate(i => { i.members[1].id = i.members[0].id }))).toThrow()
  })

  test('allows one ID on distinct legs but rejects the duplicate pair', () => {
    const distinctLegs = escrowFixture()
    distinctLegs.members[1].id = distinctLegs.members[0].id
    distinctLegs.members[1].leg = 'FEE'
    distinctLegs.feePolicy.legs[1].memberId = distinctLegs.members[0].id
    distinctLegs.feePolicy.legs[1].leg = 'FEE'
    const claims = normalizePaymentClaims(distinctLegs)
    expect(claims.members.map(m => `${m.id}/${m.leg}`)).toEqual(['11/FEE', '11/PRINCIPAL'])
    const duplicatePair = clone(distinctLegs)
    duplicatePair.members[1].leg = 'PRINCIPAL'
    duplicatePair.feePolicy.legs[1].leg = 'PRINCIPAL'
    expect(() => normalizePaymentClaims(duplicatePair)).toThrow()
  })

  test('member actual amount may not exceed its contracted gross', () => {
    expect(() => normalizePaymentClaims(mutate(i => {
      i.members[0].actualPiconeros = '41'
      i.feePolicy.legs[0].actualPiconeros = '41'
    }))).toThrow()
  })

  test.each([
    ['negative principal', i => { i.principalPiconeros = '-1' }],
    ['negative member fee', i => { i.networkFeePiconeros = '-7' }],
    ['fractional member amount', i => { i.members[0].grossPiconeros = 40.5 }],
    ['unsafe member amount', i => { i.members[0].grossPiconeros = Number.MAX_SAFE_INTEGER + 1 }],
    ['whitespace amount', i => { i.networkFeePiconeros = ' 7' }],
    ['bigint amount at the claims boundary', i => { i.principalPiconeros = 60n }]
  ])('rejects %s', (_label, change) => {
    expect(() => normalizePaymentClaims(mutate(change))).toThrow()
  })

  test('rejects a wrong principal sum, wrong aggregates and wrong fee legs', () => {
    expect(() => normalizePaymentClaims(mutate(i => { i.principalPiconeros = '61' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.receivingAggregates[0].amountPiconeros = '41' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.receivingAggregates.push({ receivingIdentity: i.members[0].receivingIdentity, amountPiconeros: '0' }) }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.feePolicy.legs[0].grossPiconeros = '41' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.feePolicy.mode = 'SUBTRACT_LAST' }))).toThrow()
  })

  test('refuses wrong format constants and uppercase hashes, retaining address case', () => {
    expect(() => normalizePaymentClaims(mutate(i => { i.application = 'other/app' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.bindingVersion = '2' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.captureContractVersion = '2' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.txHash = i.txHash.toUpperCase() }))).toThrow()
    const input = paymentFixture()
    expect(normalizePaymentClaims(input).members[0].address).toBe(input.members[0].address)
  })

  test('role identity fields stay closed: unused fields are explicit nulls', () => {
    expect(() => normalizePaymentClaims(mutate(i => { i.bountyPaymentId = '21' }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.frozenTerms = { recipientAddress: i.members[0].address, prizePiconeros: '40', feePiconeros: '20', feeRecipientAddress: i.members[1].address } }))).toThrow()
    const escrow = escrowFixture()
    escrow.distributionId = '1'
    expect(() => normalizePaymentClaims(escrow)).toThrow()
    const missingTerms = escrowFixture()
    missingTerms.frozenTerms = null
    expect(() => normalizePaymentClaims(missingTerms)).toThrow()
    const unknownKind = mutate(i => { i.kind = 'DONATION' })
    expect(() => normalizePaymentClaims(unknownKind)).toThrow()
  })

  test('consolidation binds an owned target with zero external principal', () => {
    const input = paymentFixture()
    const owned = {
      accountIndex: '0',
      subaddressIndex: '0',
      address: input.scope.walletAddress,
      amountPiconeros: '33'
    }
    input.kind = 'CONSOLIDATION'
    input.principalPiconeros = '0'
    input.members = []
    input.feePolicy = { mode: 'NONE', legs: [] }
    input.receivingAggregates = []
    input.ownedTargets = [owned]
    const claims = normalizePaymentClaims(input)
    expect(claims.members).toEqual([])
    expect(claims.ownedTargets).toEqual([owned])
    expect(claims.principalPiconeros).toBe('0')
    expect(() => normalizePaymentClaims({ ...clone(input), ownedTargets: [] })).toThrow()
  })

  test('SUBTRACT_LAST must actually subtract the fee from the last leg', () => {
    const input = paymentFixture({ feeSubtractedFromLast: true })
    const claims = normalizePaymentClaims(input)
    expect(claims.feePolicy.legs.map(l => l.actualPiconeros)).toEqual(['40', '13'])
    const wrong = clone(input)
    wrong.feePolicy.legs[1].actualPiconeros = '20'
    expect(() => normalizePaymentClaims(wrong)).toThrow()
  })
})

describe('address decoding', () => {
  test('decodes primary, subaddress and integrated addresses on both networks', () => {
    for (const network of ['MAINNET', 'STAGENET']) {
      const claims = normalizePaymentClaims(paymentFixture({ network }))
      const identity = decodeReceivingIdentity(claims.scope.walletAddress, network)
      expect(identity.type).toBe('PRIMARY')
      expect(identity.paymentId).toBeNull()
      expect(identity.identity).toBe(`${network}/${identity.spendKey}/${identity.viewKey}`)
      expect(identity.spendKey).toMatch(/^[0-9a-f]{64}$/)
      const sub = claims.members.find(m => m.type === 'SUBADDRESS')
      expect(decodeReceivingIdentity(sub.address, network).type).toBe('SUBADDRESS')
    }
  })

  test('an integrated alias shares its primary identity and keeps its payment ID', () => {
    const claims = normalizePaymentClaims(paymentFixture({ repeatedRecipient: true }))
    const integrated = claims.members.find(m => m.type === 'INTEGRATED')
    const primary = claims.members.find(m => m.type === 'PRIMARY')
    const decodedIntegrated = decodeReceivingIdentity(integrated.address, 'STAGENET')
    expect(decodedIntegrated.paymentId).toBe(integrated.paymentId)
    expect(decodedIntegrated.identity).toBe(decodeReceivingIdentity(primary.address, 'STAGENET').identity)
  })

  test('rejects wrong-network, unknown-prefix, checksum-tampered and malformed addresses', () => {
    const stagenet = paymentFixture()
    const mainnet = paymentFixture({ network: 'MAINNET' })
    expect(() => decodeReceivingIdentity(mainnet.scope.walletAddress, 'STAGENET')).toThrow()
    expect(() => decodeReceivingIdentity(stagenet.scope.walletAddress, 'MAINNET')).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.scope.walletAddress = mainnet.scope.walletAddress }))).toThrow()
    const testnet = encodeAddress(TESTNET_PRIMARY_PREFIX, VALID_POINT, VALID_POINT)
    expect(() => decodeReceivingIdentity(testnet, 'STAGENET')).toThrow()
    const mainnetEncoded = encodeAddress(MAINNET_PRIMARY_PREFIX, VALID_POINT, VALID_POINT)
    expect(() => decodeReceivingIdentity(mainnetEncoded, 'STAGENET')).toThrow()
    const tampered = stagenet.scope.walletAddress.slice(0, -1) + (stagenet.scope.walletAddress.endsWith('1') ? '2' : '1')
    expect(() => decodeReceivingIdentity(tampered, 'STAGENET')).toThrow()
    expect(() => decodeReceivingIdentity('not-a-monero-address', 'STAGENET')).toThrow()
    expect(() => decodeReceivingIdentity(stagenet.scope.walletAddress, 'FAKECHAIN')).toThrow()
    expect(() => decodeReceivingIdentity(undefined, 'STAGENET')).toThrow()
    expect(() => decodeReceivingIdentity(` ${stagenet.scope.walletAddress}`, 'STAGENET')).toThrow()
  })

  test('rejects an address whose public key is not a valid curve point', () => {
    const invalid = encodeAddress(STAGENET_PRIMARY_PREFIX, INVALID_POINT, VALID_POINT)
    expect(() => decodeReceivingIdentity(invalid, 'STAGENET')).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.scope.walletAddress = invalid }))).toThrow()
  })

  test('integrated addresses are not valid owned targets or change destinations', () => {
    const claims = normalizePaymentClaims(paymentFixture({ repeatedRecipient: true }))
    const integrated = claims.members.find(m => m.type === 'INTEGRATED').address
    expect(() => normalizePaymentClaims(mutate(i => {
      i.ownedTargets = [{ accountIndex: '0', subaddressIndex: '0', address: integrated, amountPiconeros: '1' }]
    }))).toThrow()
    expect(() => normalizePaymentClaims(mutate(i => { i.change.address = integrated }))).toThrow()
  })
})

describe('canonicalPaymentJson', () => {
  test('recursively ASCII-sorts object keys and keeps array order', () => {
    const json = canonicalPaymentJson({ b: 1, a: { d: 'x', c: [3, 2, 1] }, 0: 'zero' })
    expect(json).toBe('{"0":"zero","a":{"c":[3,2,1],"d":"x"},"b":1}')
    expect(canonicalPaymentJson({ a: 'x', b: 'y' })).toBe(canonicalPaymentJson({ b: 'y', a: 'x' }))
  })

  test('rejects unsupported JS values instead of stringifying them', () => {
    class PrismaLike { constructor () { this.value = 'x' } }
    expect(() => canonicalPaymentJson({ value: 1n })).toThrow()
    expect(() => canonicalPaymentJson({ value: undefined })).toThrow()
    expect(() => canonicalPaymentJson([undefined])).toThrow()
    expect(() => canonicalPaymentJson({ value: () => {} })).toThrow()
    expect(() => canonicalPaymentJson({ value: Symbol('x') })).toThrow()
    expect(() => canonicalPaymentJson({ value: NaN })).toThrow()
    expect(() => canonicalPaymentJson({ value: Infinity })).toThrow()
    expect(() => canonicalPaymentJson({ value: -0 })).toThrow()
    expect(() => canonicalPaymentJson({ value: new Date() })).toThrow()
    expect(() => canonicalPaymentJson({ value: new PrismaLike() })).toThrow()
    expect(() => canonicalPaymentJson(new Map([['a', 1]]))).toThrow()
  })

  test('handles escaped strings and nested nulls deterministically', () => {
    expect(canonicalPaymentJson({ 'a"b': 'x\\y\n', z: null })).toBe('{"a\\"b":"x\\\\y\\n","z":null}')
  })
})

describe('paymentBinding', () => {
  test('binds the claim digest and exact format versions', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    const binding = paymentBinding(claims, { masterKeyVersion: 2, envelopeVersion: '1', payloadVersion: '1' })
    expect(binding.application).toBe('stashernews/monero/payment')
    expect(binding.bindingVersion).toBe('1')
    expect(binding.masterKeyVersion).toBe('2')
    expect(binding.envelopeVersion).toBe('1')
    expect(binding.payloadVersion).toBe('1')
    expect(binding.claimDigest).toBe(paymentClaimDigest(claims))
    expect(canonicalPaymentJson(binding)).toContain('"masterKeyVersion":"2"')
  })

  test('accepts canonical decimal-string master versions and normalizes them', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    const numeric = paymentBinding(claims, { masterKeyVersion: 2, envelopeVersion: '1', payloadVersion: '1' })
    const stringly = paymentBinding(claims, { masterKeyVersion: '2', envelopeVersion: '1', payloadVersion: '1' })
    expect(stringly).toEqual(numeric)
  })

  test('different master versions never produce the same binding digest', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    const one = canonicalPaymentJson(paymentBinding(claims, { masterKeyVersion: 1, envelopeVersion: '1', payloadVersion: '1' }))
    const two = canonicalPaymentJson(paymentBinding(claims, { masterKeyVersion: 2, envelopeVersion: '1', payloadVersion: '1' }))
    expect(one).not.toBe(two)
  })

  test.each([
    ['zero version', { masterKeyVersion: 0, envelopeVersion: '1', payloadVersion: '1' }],
    ['negative version', { masterKeyVersion: -1, envelopeVersion: '1', payloadVersion: '1' }],
    ['fractional version', { masterKeyVersion: 1.5, envelopeVersion: '1', payloadVersion: '1' }],
    ['noncanonical string version', { masterKeyVersion: '01', envelopeVersion: '1', payloadVersion: '1' }],
    ['unknown envelope version', { masterKeyVersion: 1, envelopeVersion: '2', payloadVersion: '1' }],
    ['unknown payload version', { masterKeyVersion: 1, envelopeVersion: '1', payloadVersion: '2' }],
    ['extra binding field', { masterKeyVersion: 1, envelopeVersion: '1', payloadVersion: '1', scope: 'REWARDS' }]
  ])('rejects %s', (_label, versions) => {
    expect(() => paymentBinding(normalizePaymentClaims(paymentFixture()), versions)).toThrow()
  })
})

describe('fixtures: paymentTxFixture', () => {
  test('returns a fake built transaction whose facts match the default claims', async () => {
    const claims = normalizePaymentClaims(paymentFixture())
    const tx = paymentTxFixture()
    expect(tx.txHash).toBe(claims.txHash)
    expect(tx.getHash()).toBe(claims.txHash)
    expect(tx.getFee()).toBe(BigInt(claims.networkFeePiconeros))
    const destinations = tx.getOutgoingTransfer().getDestinations()
    const byId = new Map(claims.members.map(m => [m.id, m]))
    expect(destinations).toHaveLength(2)
    expect(destinations.map(d => d.getAddress())).toEqual([
      byId.get('11').address,
      byId.get('12').address
    ])
    expect(destinations.map(d => d.getAmount())).toEqual([40n, 20n])
    expect(tx.getChangeAddress()).toBe(claims.change.address)
    expect(tx.getChangeAmount()).toBe(33n)
    // The SDK's getKey() is the SECRET-bundle STRING (final-review C1):
    // main secret + one additional secret per output, little-endian hex.
    expect(typeof tx.getKey()).toBe('string')
    expect(tx.getKey()).toBe(tx.keyBundleHex)
    expect(tx.getKey().length).toBe(64 * (1 + tx.additionalKeyCount))
    for (let offset = 0; offset < tx.getKey().length; offset += 64) {
      const scalar = BigInt(`0x${tx.getKey().slice(offset, offset + 64).match(/../g).reverse().join('')}`)
      expect(scalar).toBeGreaterThan(0n)
      expect(scalar).toBeLessThan(ed25519.CURVE.n)
    }
  })

  test('carries a deterministic ProofPayloadV1 internally consistent with the claims', () => {
    const claims = normalizePaymentClaims(paymentFixture())
    const { proofPayload } = paymentTxFixture()
    expect(proofPayload.payloadVersion).toBe('1')
    expect(proofPayload.additionalKeyCount).toBe(3)
    expect(proofPayload.keyBundleHex).toMatch(/^[0-9a-f]+$/)
    expect(proofPayload.builtStructure.txHash).toBe(claims.txHash)
    expect(proofPayload.builtStructure.networkFeePiconeros).toBe(claims.networkFeePiconeros)
    expect(proofPayload.builtStructure.actualDestinations).toEqual([
      { address: claims.members[0].address, amountPiconeros: '40' },
      { address: claims.members[1].address, amountPiconeros: '20' }
    ])
    expect(proofPayload.builtStructure.changeAddress).toBe(claims.change.address)
    expect(proofPayload.builtStructure.changeAmountPiconeros).toBe('33')
    // Public built fields the SDK does not expose stay explicit null; the
    // populated variant carries the corresponding public points (C1).
    expect(proofPayload.builtStructure.mainPublicKey).toBeNull()
    expect(proofPayload.builtStructure.additionalPublicKeys).toBeNull()
    expect(proofPayload.builtStructure.outputKeys).toBeNull()
    const populated = paymentTxFixture({ populatedPublicKeys: true }).proofPayload
    expect(populated.builtStructure.mainPublicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(populated.builtStructure.additionalPublicKeys).toHaveLength(3)
    expect(populated.builtStructure.outputKeys).toHaveLength(3)
    expect(canonicalPaymentJson(proofPayload).length).toBeGreaterThan(0)
  })

  test('tracks fee-subtraction and repeated-recipient fixtures', () => {
    const subtracted = normalizePaymentClaims(paymentFixture({ feeSubtractedFromLast: true }))
    const tx = paymentTxFixture({ feeSubtractedFromLast: true })
    expect(tx.proofPayload.builtStructure.actualDestinations).toEqual([
      { address: subtracted.members[0].address, amountPiconeros: '40' },
      { address: subtracted.members[1].address, amountPiconeros: '13' }
    ])
    expect(tx.proofPayload.builtStructure.changeAmountPiconeros).toBe('40')
    const repeated = paymentTxFixture({ repeatedRecipient: true })
    expect(repeated.proofPayload.builtStructure.actualDestinations[1].address).toBe(
      normalizePaymentClaims(paymentFixture({ repeatedRecipient: true })).members.find(m => m.type === 'INTEGRATED').address
    )
  })

  test('rejects unrecognized overrides instead of silently ignoring them', () => {
    expect(() => paymentTxFixture({ networkFeePiconero: '8' })).toThrow()
  })
})

describe('fixtures: paymentChainFixture', () => {
  test('exposes the base independent facts D=100n O=33n F=7n E=60n', async () => {
    const f = paymentChainFixture()
    expect(f.txHash).toBe(paymentFixture().txHash)
    expect(f.observedAt).toBe('2026-10-06T12:00:00.000Z')
    expect(jest.isMockFunction(f.wallet.getOutputs)).toBe(true)
    const rows = await f.wallet.getOutputs()
    expect(f.wallet.getOutputs).toHaveBeenCalledWith()
    const change = rows.find(r => r.getTx().getHash() === f.txHash)
    const source = rows.find(r => r.getTx().getHash() === f.chain.source.txHash)
    expect(change.getAmount()).toBe(33n)
    expect(change.getIsSpent()).toBe(false)
    expect(source.getAmount()).toBe(100n)
    expect(source.getIsSpent()).toBe(true)
    // SDK getIndex() is deliberately the chain-global index, never the local
    // vout position (the join must use raw vout keys).
    expect(change.getIndex()).toBe(f.chain.audited.outputIndices[1])
    expect(f.chain.audited.inputKeyImages).toEqual([f.chain.source.keyImage])
    expect(f.chain.audited.feePiconeros).toBe(7n)
    expect(f.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
  })

  test('per-address checkTxKey receipts sum to the external aggregate 60n', async () => {
    const f = paymentChainFixture()
    const claims = normalizePaymentClaims(paymentFixture())
    const received = []
    for (const member of claims.members) {
      const check = await f.wallet.checkTxKey(f.txHash, '00'.repeat(32), member.address)
      expect(check.getIsGood()).toBe(true)
      expect(check.getInTxPool()).toBe(false)
      received.push(check.getReceivedAmount())
    }
    expect(received).toEqual([40n, 20n])
    expect(received.reduce((a, b) => a + b, 0n)).toBe(60n)
    expect(f.checkTxKeyResult).toBe(60n)
    const unknown = await f.wallet.checkTxKey(f.txHash, '00'.repeat(32), f.chain.hiddenExtra?.address ?? claims.change.address)
    expect(unknown.getIsGood()).toBe(false)
  })

  test('ownedAmount 22n leaves the exactly-11n hidden extra residual', async () => {
    const f = paymentChainFixture({ ownedAmount: 22n })
    const rows = await f.wallet.getOutputs()
    const change = rows.find(r => r.getTx().getHash() === f.txHash)
    expect(change.getAmount()).toBe(22n)
    expect(f.chain.hiddenExtra).toMatchObject({ amountPiconeros: 11n })
    expect(f.totals).toEqual({ D: '100', O: '22', F: '7', E: '60', residual: '11' })
    expect(f.chain.audited.voutKeys).toContain(f.chain.hiddenExtra.stealthPublicKey)
  })

  test('globalIndex, localIndex and spentOwnedOutput move the owned join facts', async () => {
    const f = paymentChainFixture({ globalIndex: 918, localIndex: 1, spentOwnedOutput: true })
    expect(f.chain.audited.outputIndices[1]).toBe(918)
    expect(f.chain.audited.voutKeys[1]).toBe(f.chain.ownedScan[0].stealthPublicKey)
    const rows = await f.wallet.getOutputs()
    const change = rows.find(r => r.getTx().getHash() === f.txHash)
    expect(change.getIsSpent()).toBe(true)
    expect(f.chain.spend).toMatchObject({ inputKeyImages: [f.chain.ownedScan[0].keyImage] })
  })

  test('exposes collectOptions/verifyOptions/session for later tasks without importing them', async () => {
    const f = paymentChainFixture()
    expect(Object.keys(f.collectOptions).sort()).toEqual(['boundary', 'daemon', 'derivation', 'scope', 'viewWallet', 'wallet'])
    expect(f.verifyOptions.journalRole).toBe('REWARDS')
    expect(f.verifyOptions.session.rawByHash[f.txHash]).toBe(f.chain.audited)
    const facts = f.verifyOptions.session.ownershipFor(f.txHash)
    expect(facts.owned[0]).toMatchObject({ outputIndex: 1, amountPiconeros: 33n })
    expect(jest.isMockFunction(f.collectOptions.daemon.getPaymentTransactions)).toBe(true)
    const fetched = await f.collectOptions.daemon.getPaymentTransactions([f.txHash])
    expect(fetched).toHaveLength(1)
    expect(fetched[0].txHash).toBe(f.txHash)
  })

  test('rejects unrecognized overrides instead of silently ignoring them', () => {
    expect(() => paymentChainFixture({ ownedAmout: 22n })).toThrow()
  })
})

describe('fixtures: determinism', () => {
  test('repeated fixture construction is deterministic', () => {
    expect(paymentFixture()).toEqual(paymentFixture())
    expect(paymentTxFixture().proofPayload).toEqual(paymentTxFixture().proofPayload)
    expect(paymentChainFixture().chain).toEqual(paymentChainFixture().chain)
  })
})
