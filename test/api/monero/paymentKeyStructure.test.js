/* eslint-env jest */

// Strict tx-extra / key-structure module (Finding #1, Task 4).
//
// These tests pin the ordered parser and the sender/receiver one-time-key
// arithmetic against the deterministic synthetic fixture facts: every point
// here is a small scalar times the ed25519 base point, so nothing is a real
// key, address, or chain fact. The cofactor-8 regression control recomputes a
// derivation WITHOUT the mandatory x8 multiplication to prove the product code
// never quietly skips it.

import { ed25519 } from '@noble/curves/ed25519'
import { keccak256 } from 'js-sha3'

import {
  bundlePublicKeys,
  classifyOutputKeys,
  keyStructureError,
  oneTimeOutputKey,
  parseKeyBundleHex,
  parseTxExtraStrict,
  publicKeyForScalar,
  scalarFromHexLE,
  senderPublicPart,
  txPublicKeysForOutput
} from '@/api/monero/paymentKeyStructure'
import { paymentTxFixture } from '../../fixtures/payment-proof'

const P = ed25519.ExtendedPoint
const CURVE_N = ed25519.CURVE.n

// Small deterministic points/scalars (mirrors the fixture's scalar allocation
// so assertions read against known synthetic facts).
const pt = s => Buffer.from(P.BASE.multiply(BigInt(s)).toRawBytes()).toString('hex')
const mul = (s, pointHex) => Buffer.from(P.fromHex(pointHex).multiply(BigInt(s)).toRawBytes()).toString('hex')
// 64-hex little-endian encoding of a bigint (Monero secret scalar wire form).
const leHex = n => {
  let out = ''
  let v = n
  for (let i = 0; i < 32; i++) {
    out += (v & 255n).toString(16).padStart(2, '0')
    v >>= 8n
  }
  return out
}
const varintBytes = n => {
  const bytes = []
  let v = n
  do {
    const part = v % 128
    v = Math.floor(v / 128)
    bytes.push(part | (v ? 128 : 0))
  } while (v)
  return Buffer.from(bytes)
}

// Test-local negative control: the receiver/sender derivation WITHOUT the
// mandatory cofactor-8 (what a naive implementation would compute).
function keyWithoutCofactor ({ publicKey, secret, publicSpend, outputIndex }) {
  const derivation = P.fromHex(publicKey).multiply(scalarFromHexLE(secret)).toRawBytes()
  const digest = Buffer.from(keccak256(
    Buffer.concat([Buffer.from(derivation), varintBytes(outputIndex)])
  ), 'hex')
  let h = 0n
  for (let i = 31; i >= 0; i--) h = (h << 8n) | BigInt(digest[i])
  h %= CURVE_N
  const base = h === 0n ? P.ZERO : P.BASE.multiply(h)
  return base.add(P.fromHex(publicSpend)).toHex()
}

const expectCode = (fn, code) => {
  let caught = null
  try { fn() } catch (e) { caught = e }
  expect(caught).not.toBeNull()
  expect(caught.code).toBe(code)
}

// Fixture-keyed classification scenario (all points synthetic):
//   output 0 — external SUBADDRESS (recipientB keys): additional secret 5,
//              extra additional pubkey = 5 * B_B; one-time = Hs(8*5*C||0)*G+B
//   output 1 — OWNED change (wallet keys 5/6): additional secret 7 → slot 7*G,
//              one-time = Hs(8*6*(7G)||1)*G + walletSpend
//   output 2 — external STANDARD (recipientA keys): additional secret 9 →
//              slot 9*G, one-time = Hs(8*9*A||2)*G + recipientASpend
const SUB_SPEND = pt(3)
const SUB_VIEW = pt(4)
const A_SPEND = pt(1)
const A_VIEW = pt(2)
const WALLET_SPEND = pt(5)
const WALLET_VIEW_SECRET = leHex(6n)

function scenario () {
  const bundle = {
    mainSecretHex: leHex(16n),
    additionalSecretHexes: [leHex(5n), leHex(7n), leHex(9n)]
  }
  const txExtraKeys = {
    main: pt(16),
    additional: [mul(5n, SUB_SPEND), pt(7), pt(9)],
    nonce: null
  }
  const outputKeys = [
    oneTimeOutputKey({ publicKey: SUB_VIEW, secret: leHex(5n), publicSpend: SUB_SPEND, outputIndex: 0 }),
    oneTimeOutputKey({ publicKey: pt(7), secret: WALLET_VIEW_SECRET, publicSpend: WALLET_SPEND, outputIndex: 1 }),
    oneTimeOutputKey({ publicKey: A_VIEW, secret: leHex(9n), publicSpend: A_SPEND, outputIndex: 2 })
  ]
  const recipients = [
    { viewKey: SUB_VIEW, spendKey: SUB_SPEND, subaddress: true },
    { viewKey: A_VIEW, spendKey: A_SPEND, subaddress: false }
  ]
  const owned = [{ publicSpendKey: WALLET_SPEND, privateViewKey: WALLET_VIEW_SECRET }]
  return { bundle, txExtraKeys, outputKeys, recipients, owned }
}

// ---- error surface ----------------------------------------------------------

describe('keyStructureError', () => {
  test('produces errors carrying the fixed code', () => {
    const err = keyStructureError('EXTRA_TRUNCATED', 'offender')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EXTRA_TRUNCATED')
    expect(err.message).toContain('EXTRA_TRUNCATED')
    expect(err.message).toContain('offender')
  })
})

// ---- strict ordered tx-extra parser ----------------------------------------

describe('parseTxExtraStrict', () => {
  function extraBlob ({ main = pt(16), additional = [pt(7), pt(8), pt(9)], nonce = 'a1b2c3d4e5f60718', order = ['main', 'additional', 'nonce'] } = {}) {
    const parts = {}
    if (main !== null) parts.main = Buffer.concat([Buffer.from([0x01]), Buffer.from(main, 'hex')])
    if (additional !== null) {
      const count = varintBytes(additional.length)
      parts.additional = Buffer.concat([
        Buffer.from([0x04]), count, Buffer.from(additional.join(''), 'hex')
      ])
    }
    if (nonce !== null) {
      const nonceBytes = Buffer.from(nonce, 'hex')
      parts.nonce = Buffer.concat([Buffer.from([0x02]), varintBytes(nonceBytes.length), nonceBytes])
    }
    return Buffer.concat(order.filter(name => parts[name] !== undefined).map(name => parts[name]))
  }

  test('parses main, ordered additional keys and nonce from a well-formed blob', () => {
    const parsed = parseTxExtraStrict(extraBlob())
    expect(parsed.main).toBe(pt(16))
    expect(parsed.additional).toEqual([pt(7), pt(8), pt(9)])
    expect(Buffer.from(parsed.nonce).toString('hex')).toBe('a1b2c3d4e5f60718')
  })

  test('accepts hex string and byte-array encodings of the same blob', () => {
    const blob = extraBlob()
    expect(parseTxExtraStrict(blob.toString('hex'))).toEqual(parseTxExtraStrict(blob))
    expect(parseTxExtraStrict(new Uint8Array(blob))).toEqual(parseTxExtraStrict(blob))
  })

  test('parses a main-key-only blob (no additional, no nonce)', () => {
    const parsed = parseTxExtraStrict(extraBlob({ additional: null, nonce: null }))
    expect(parsed.main).toBe(pt(16))
    expect(parsed.additional).toEqual([])
    expect(parsed.nonce).toBeNull()
  })

  test('preserves discovered order without flattening (nonce before additional)', () => {
    const parsed = parseTxExtraStrict(extraBlob({ order: ['main', 'nonce', 'additional'] }))
    expect(parsed.main).toBe(pt(16))
    expect(parsed.additional).toEqual([pt(7), pt(8), pt(9)])
    expect(parsed.nonce).not.toBeNull()
  })

  test('refuses unknown tags (padding, merge-mining, arbitrary)', () => {
    expectCode(() => parseTxExtraStrict(Buffer.concat([Buffer.from([0x00, 0x00]), extraBlob()])), 'EXTRA_TAG_UNSUPPORTED')
    expectCode(() => parseTxExtraStrict(Buffer.concat([extraBlob(), Buffer.from([0x03, 1, 2, 3])])), 'EXTRA_TAG_UNSUPPORTED')
    expectCode(() => parseTxExtraStrict(Buffer.from([0x05, 0x01])), 'EXTRA_TAG_UNSUPPORTED')
  })

  test('refuses duplicate main key, nonce, and additional fields', () => {
    const blob = extraBlob()
    expectCode(() => parseTxExtraStrict(Buffer.concat([blob, Buffer.from([0x01]), Buffer.from(pt(16), 'hex')])), 'EXTRA_MULTIPLE_MAIN_KEYS')
    expectCode(() => parseTxExtraStrict(Buffer.concat([blob, Buffer.from([0x02, 0x01, 0x00])])), 'EXTRA_MULTIPLE_NONCES')
    expectCode(() => parseTxExtraStrict(Buffer.concat([blob, Buffer.from([0x04, 0x01]), Buffer.from(pt(9), 'hex')])), 'EXTRA_MULTIPLE_ADDITIONAL_FIELDS')
  })

  test('refuses truncated main key, additional key, and nonce payload', () => {
    expectCode(() => parseTxExtraStrict(Buffer.from([0x01, ...Buffer.from(pt(16), 'hex').subarray(0, 31)])), 'EXTRA_TRUNCATED')
    expectCode(() => parseTxExtraStrict(Buffer.from([0x04, 0x02, ...Buffer.from(pt(7), 'hex'), 0x11, 0x22])), 'EXTRA_TRUNCATED')
    expectCode(() => parseTxExtraStrict(Buffer.from([0x02, 0x08, 0x01, 0x02, 0x03])), 'EXTRA_TRUNCATED')
  })

  test('refuses non-canonical and overflowing varints', () => {
    // 0x80 0x00 encodes zero in two bytes — non-canonical.
    expectCode(() => parseTxExtraStrict(Buffer.from([0x04, 0x80, 0x00])), 'EXTRA_VARINT_NONCANONICAL')
    // 10 continuation bytes overflow the 64-bit varint window.
    expectCode(() => parseTxExtraStrict(Buffer.from([0x04, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])), 'EXTRA_VARINT_OVERFLOW')
  })

  test('refuses impossible additional-key counts', () => {
    expectCode(() => parseTxExtraStrict(Buffer.from([0x04, 0x00])), 'EXTRA_KEY_COUNT_UNSUPPORTED')
    expectCode(() => parseTxExtraStrict(Buffer.concat([Buffer.from([0x04, 65]), Buffer.alloc(65 * 32)])), 'EXTRA_KEY_COUNT_UNSUPPORTED')
    expectCode(() => parseTxExtraStrict(Buffer.concat([Buffer.from([0x04, 0xff, 0x01]), Buffer.alloc(255 * 32)])), 'EXTRA_KEY_COUNT_UNSUPPORTED')
    expectCode(() => parseTxExtraStrict(Buffer.from([0x04, 0x80, 0x02])), 'EXTRA_COUNT_UNSUPPORTED')
  })

  test('refuses a blob without a main tx public key', () => {
    expectCode(() => parseTxExtraStrict(Buffer.from([0x02, 0x01, 0x00])), 'EXTRA_MAIN_KEY_MISSING')
  })

  test('refuses non-canonical curve points in key fields', () => {
    const bad = '02'.repeat(32)
    expectCode(() => parseTxExtraStrict(extraBlob({ main: bad })), 'EXTRA_KEY_NOT_CANONICAL')
    expectCode(() => parseTxExtraStrict(extraBlob({ additional: [pt(7), bad] })), 'EXTRA_KEY_NOT_CANONICAL')
  })

  test('refuses non-hex/non-buffer extra input', () => {
    expectCode(() => parseTxExtraStrict(null), 'EXTRA_TYPE')
    expectCode(() => parseTxExtraStrict(42), 'EXTRA_TYPE')
    expectCode(() => parseTxExtraStrict('zz'), 'EXTRA_TYPE')
    expectCode(() => parseTxExtraStrict('abc'), 'EXTRA_TYPE')
  })
})

// ---- scalars and public keys -------------------------------------------------

describe('scalarFromHexLE', () => {
  test('decodes little-endian secret scalars', () => {
    expect(scalarFromHexLE(leHex(16n))).toBe(16n)
    expect(scalarFromHexLE(leHex(1n))).toBe(1n)
    expect(scalarFromHexLE(leHex(CURVE_N - 1n))).toBe(CURVE_N - 1n)
  })

  test('refuses zero, curve order, beyond-order and malformed scalars', () => {
    expectCode(() => scalarFromHexLE(leHex(0n)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE(leHex(CURVE_N)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE(leHex(CURVE_N + 1n)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE('10' + '00'.repeat(30)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE('ZZ' + '00'.repeat(31)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE('10'.repeat(31)), 'SECRET_SCALAR_INVALID')
    expectCode(() => scalarFromHexLE(null), 'SECRET_SCALAR_INVALID')
  })

  test('publicKeyForScalar reproduces the fixture points (s*G)', () => {
    expect(publicKeyForScalar(16n)).toBe(pt(16))
    expect(publicKeyForScalar(1n)).toBe(pt(1))
    expectCode(() => publicKeyForScalar(0n), 'SECRET_SCALAR_INVALID')
  })
})

// ---- key bundle --------------------------------------------------------------

describe('parseKeyBundleHex / bundlePublicKeys', () => {
  test('parses a bundle of valid little-endian secret scalars and re-derives its publics', () => {
    const bundle = parseKeyBundleHex(leHex(16n) + leHex(17n) + leHex(18n) + leHex(19n), 3)
    expect(bundle.mainSecretHex).toBe(leHex(16n))
    expect(bundle.additionalSecretHexes).toEqual([leHex(17n), leHex(18n), leHex(19n)])
    expect(bundlePublicKeys(bundle)).toEqual({
      mainPublicKey: pt(16),
      additionalPublicKeys: [pt(17), pt(18), pt(19)]
    })
  })

  test('the fixture keyBundleHex is a valid SECRET bundle whose slots correspond to the raw tx keys', () => {
    // Final-review C1: the captured bundle is the SDK's little-endian SECRET
    // scalars (main + one per output). The fixture derives the tx public key
    // slots from those very secrets — main r*G, standard slots r_i*G, the
    // subaddress slot r_i*B — so the kind-aware correspondence holds exactly.
    const recipientBSpend = pt(3)
    const tx = paymentTxFixture()
    const bundle = parseKeyBundleHex(tx.keyBundleHex, tx.additionalKeyCount)
    expect(bundle.mainSecretHex).toBe(leHex(101n))
    expect(bundle.additionalSecretHexes).toEqual([leHex(102n), leHex(103n), leHex(104n)])
    // Default layout: externalA (PRIMARY → r_0*G), change (standard → r_1*G),
    // externalB (SUBADDRESS → r_2*B_B).
    expect(tx.additionalPublicKeys[0]).toBe(senderPublicPart(102n, null))
    expect(tx.additionalPublicKeys[1]).toBe(senderPublicPart(103n, null))
    expect(tx.additionalPublicKeys[2]).toBe(senderPublicPart(104n, recipientBSpend))
    expect(tx.mainPublicKey).toBe(senderPublicPart(101n, null))
  })

  test('parses a main-only bundle', () => {
    const bundle = parseKeyBundleHex(leHex(16n), 0)
    expect(bundle.additionalSecretHexes).toEqual([])
    expect(bundlePublicKeys(bundle).mainPublicKey).toBe(pt(16))
  })

  test('refuses truncated, appended and mismatched bundles', () => {
    const tx = paymentTxFixture()
    expectCode(() => parseKeyBundleHex(tx.keyBundleHex.slice(0, 128), 3), 'KEY_BUNDLE_LENGTH')
    expectCode(() => parseKeyBundleHex(tx.keyBundleHex + leHex(20n), 3), 'KEY_BUNDLE_LENGTH')
    expectCode(() => parseKeyBundleHex(tx.keyBundleHex, 4), 'KEY_BUNDLE_LENGTH')
    expectCode(() => parseKeyBundleHex('zz'.repeat(128), 3), 'KEY_BUNDLE_INVALID')
    expectCode(() => parseKeyBundleHex(tx.keyBundleHex, -1), 'KEY_BUNDLE_COUNT')
    expectCode(() => parseKeyBundleHex(tx.keyBundleHex, 1.5), 'KEY_BUNDLE_COUNT')
    expectCode(() => parseKeyBundleHex(leHex(0n), 0), 'KEY_BUNDLE_SCALAR')
    expectCode(() => parseKeyBundleHex(leHex(CURVE_N) + leHex(17n), 1), 'KEY_BUNDLE_SCALAR')
  })
})

// ---- one-time key arithmetic --------------------------------------------------

describe('oneTimeOutputKey', () => {
  test('sender (r*A) and receiver (a*R) orientations agree — pinned cofactored arithmetic', () => {
    // 8*r*(a*G) === 8*a*(r*G): same derivation from either side.
    const r = 17n
    const a = 2n
    const A = pt(2)
    const R = pt(17)
    const B = pt(1)
    for (const outputIndex of [0, 1, 5]) {
      const sender = oneTimeOutputKey({ publicKey: A, secret: leHex(r), publicSpend: B, outputIndex })
      const receiver = oneTimeOutputKey({ publicKey: R, secret: leHex(a), publicSpend: B, outputIndex })
      expect(sender).toBe(receiver)
      expect(typeof sender).toBe('string')
      expect(sender).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('applies the mandatory cofactor-8 (non-cofactored control differs)', () => {
    const args = { publicKey: pt(17), secret: leHex(2n), publicSpend: pt(1), outputIndex: 0 }
    expect(oneTimeOutputKey(args)).not.toBe(keyWithoutCofactor(args))
  })

  test('binds the output index (different index → different key)', () => {
    const a = { publicKey: pt(17), secret: leHex(2n), publicSpend: pt(1), outputIndex: 0 }
    const b = { ...a, outputIndex: 1 }
    expect(oneTimeOutputKey(a)).not.toBe(oneTimeOutputKey(b))
  })

  test('refuses invalid scalars, points and indexes', () => {
    expectCode(() => oneTimeOutputKey({ publicKey: pt(17), secret: leHex(0n), publicSpend: pt(1), outputIndex: 0 }), 'SECRET_SCALAR_INVALID')
    expectCode(() => oneTimeOutputKey({ publicKey: '02'.repeat(32), secret: leHex(2n), publicSpend: pt(1), outputIndex: 0 }), 'KEY_STRUCTURE_POINT_INVALID')
    expectCode(() => oneTimeOutputKey({ publicKey: pt(17), secret: leHex(2n), publicSpend: 'ff'.repeat(32), outputIndex: 0 }), 'KEY_STRUCTURE_POINT_INVALID')
    expectCode(() => oneTimeOutputKey({ publicKey: pt(17), secret: leHex(2n), publicSpend: pt(1), outputIndex: -1 }), 'KEY_STRUCTURE_INDEX_INVALID')
    expectCode(() => oneTimeOutputKey({ publicKey: pt(17), secret: leHex(2n), publicSpend: pt(1), outputIndex: 1.5 }), 'KEY_STRUCTURE_INDEX_INVALID')
  })
})

// ---- sender public-part rules -------------------------------------------------

describe('senderPublicPart', () => {
  test('standard/change destinations use r*G', () => {
    expect(senderPublicPart(17n, null)).toBe(pt(17))
  })

  test('subaddress destinations use r*B (recipient public spend key only)', () => {
    expect(senderPublicPart(5n, SUB_SPEND)).toBe(mul(5n, SUB_SPEND))
    expect(senderPublicPart(5n, SUB_SPEND)).not.toBe(pt(5))
  })

  test('refuses invalid scalars/spend keys', () => {
    expectCode(() => senderPublicPart(0n, null), 'SECRET_SCALAR_INVALID')
    expectCode(() => senderPublicPart(5n, 'zz'), 'KEY_STRUCTURE_POINT_INVALID')
  })
})

describe('txPublicKeysForOutput', () => {
  test('single-key tx exposes the main key for every output', () => {
    expect(txPublicKeysForOutput({ main: pt(16), additional: [] }, 0)).toEqual([pt(16)])
    expect(txPublicKeysForOutput({ main: pt(16), additional: [] }, 2)).toEqual([pt(16)])
  })

  test('additional-key tx pairs the ordered additional key with its output', () => {
    const parsed = { main: pt(16), additional: [pt(7), pt(8), pt(9)] }
    expect(txPublicKeysForOutput(parsed, 0)).toEqual([pt(16), pt(7)])
    expect(txPublicKeysForOutput(parsed, 2)).toEqual([pt(16), pt(9)])
    expectCode(() => txPublicKeysForOutput(parsed, 3), 'KEY_STRUCTURE_INDEX_INVALID')
  })
})

// ---- output classification -----------------------------------------------------

describe('classifyOutputKeys', () => {
  test('classifies subaddress additional, owned change and standard external outputs', () => {
    const s = scenario()
    expect(classifyOutputKeys(s)).toEqual([
      { outputIndex: 0, association: { kind: 'external', recipientIndex: 0, keySource: 'additional' } },
      { outputIndex: 1, association: { kind: 'owned', ownedIndex: 0, keySource: 'additional' } },
      { outputIndex: 2, association: { kind: 'external', recipientIndex: 1, keySource: 'additional' } }
    ])
  })

  test('single-subaddress main pubkey is accepted (main key = r*B, no additional)', () => {
    const { bundle, outputKeys, recipients } = scenario()
    const single = {
      bundle: { mainSecretHex: bundle.additionalSecretHexes[0], additionalSecretHexes: [] },
      txExtraKeys: { main: mul(5n, SUB_SPEND), additional: [] },
      outputKeys: [outputKeys[0]],
      recipients: [recipients[0]],
      owned: []
    }
    expect(classifyOutputKeys(single)).toEqual([
      { outputIndex: 0, association: { kind: 'external', recipientIndex: 0, keySource: 'main' } }
    ])
  })

  test('omitted owned/change target leaves its output unassociated (never guessed)', () => {
    const s = scenario()
    const rows = classifyOutputKeys({ ...s, owned: [] })
    expect(rows[1].association).toBeNull()
    expect(rows[0].association).toEqual({ kind: 'external', recipientIndex: 0, keySource: 'additional' })
  })

  test('unknown external output stays unassociated (never guessed)', () => {
    const s = scenario()
    const rows = classifyOutputKeys({ ...s, recipients: [] })
    expect(rows[0].association).toBeNull()
    expect(rows[2].association).toBeNull()
    expect(rows[1].association).toEqual({ kind: 'owned', ownedIndex: 0, keySource: 'additional' })
  })

  test('ambiguous correspondence (two identical recipients) refuses with KEY_PUBLIC_STRUCTURE_UNSUPPORTED', () => {
    const s = scenario()
    const ambiguous = { ...s, recipients: [s.recipients[0], s.recipients[0]] }
    expectCode(() => classifyOutputKeys(ambiguous), 'KEY_PUBLIC_STRUCTURE_UNSUPPORTED')
  })

  test('additional key count that is neither zero nor the vout count refuses', () => {
    const s = scenario()
    const broken = {
      ...s,
      txExtraKeys: { ...s.txExtraKeys, additional: s.txExtraKeys.additional.slice(0, 2) },
      bundle: { ...s.bundle, additionalSecretHexes: s.bundle.additionalSecretHexes.slice(0, 2) }
    }
    expectCode(() => classifyOutputKeys(broken), 'EXTRA_OUTPUT_COUNT_MISMATCH')
  })

  test('swap/tamper of an extra additional key refuses (correspondence broken)', () => {
    const s = scenario()
    const swapped = {
      ...s,
      txExtraKeys: {
        ...s.txExtraKeys,
        additional: [s.txExtraKeys.additional[1], s.txExtraKeys.additional[0], s.txExtraKeys.additional[2]]
      }
    }
    const rows = classifyOutputKeys(swapped)
    // The extra key no longer equals r_0*B, so the subaddress association is gone.
    expect(rows[0].association).toBeNull()
  })
})
