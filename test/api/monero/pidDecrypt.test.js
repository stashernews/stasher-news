/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import {
  parseTxExtra,
  maskFromDerivation,
  maskFromTxPubKey,
  xorWithMask,
  paymentIdCandidates
} from '@/api/monero/pidDecrypt'

// Monero scalar/point encodings are little-endian byte strings; noble takes
// BigInts. These helpers convert for test-vector construction.
function randomScalar () {
  // a wallet-grade scalar: 1 <= s < l (Monero sc_check rejects >= l)
  const b = randomBytes(31) // < 2^248 < l
  return BigInt('0x' + b.toString('hex')) + 1n
}
function scalarToLEHex (s) {
  const bytes = []
  let v = s
  for (let i = 0; i < 32; i++) {
    bytes.push(Number(v & 0xffn))
    v >>= 8n
  }
  return Buffer.from(bytes).toString('hex')
}

// Build a tx-extra blob in Monero wire format.
//   [0x01][32B tx pubkey][optional 0x04 additional pubkeys][0x02][len][0x01][8B encrypted pid]
function buildExtra ({ txPubKey, additionalPubKeys = [], encryptedPid, plainPid }) {
  const out = []
  out.push(0x01, ...txPubKey)
  if (additionalPubKeys.length) {
    out.push(0x04, additionalPubKeys.length)
    for (const k of additionalPubKeys) out.push(...k)
  }
  if (encryptedPid) out.push(0x02, 1 + encryptedPid.length, 0x01, ...encryptedPid)
  if (plainPid) out.push(0x02, 1 + plainPid.length, 0x00, ...plainPid)
  return Buffer.from(out)
}

describe('parseTxExtra', () => {
  const pub = Buffer.from(randomBytes(32))

  test('extracts the tx public key and the encrypted payment id', () => {
    const pid = Buffer.from('661bf254912cb9f7', 'hex')
    const extra = buildExtra({ txPubKey: pub, encryptedPid: pid })
    const parsed = parseTxExtra(extra)
    expect(parsed.pubKeys).toHaveLength(1)
    expect(Buffer.from(parsed.pubKeys[0]).equals(pub)).toBe(true)
    expect(parsed.encryptedPid).not.toBeNull()
    expect(Buffer.from(parsed.encryptedPid).equals(pid)).toBe(true)
    expect(parsed.plainPid).toBeNull()
  })

  test('extracts additional tx public keys after the primary', () => {
    const addl = [Buffer.from(randomBytes(32)), Buffer.from(randomBytes(32))]
    const extra = buildExtra({ txPubKey: pub, additionalPubKeys: addl, encryptedPid: Buffer.alloc(8, 7) })
    const parsed = parseTxExtra(extra)
    expect(parsed.pubKeys).toHaveLength(3)
    expect(Buffer.from(parsed.pubKeys[1]).equals(addl[0])).toBe(true)
    expect(Buffer.from(parsed.pubKeys[2]).equals(addl[1])).toBe(true)
  })

  test('extracts an unencrypted (32-byte) payment id as plainPid', () => {
    const plain = Buffer.from(randomBytes(32))
    const extra = buildExtra({ txPubKey: pub, plainPid: plain })
    const parsed = parseTxExtra(extra)
    expect(parsed.encryptedPid).toBeNull()
    expect(Buffer.from(parsed.plainPid).equals(plain)).toBe(true)
  })

  test('skips unknown tags and tolerates trailing padding', () => {
    const pid = Buffer.alloc(8, 0xab)
    const extra = Buffer.concat([
      Buffer.from([0x01, ...pub]),
      Buffer.from([0x02, 1 + pid.length, 0x01, ...pid]),
      Buffer.from([0x00, 0x00, 0x00]) // Monero pads some fields with zeroes
    ])
    const parsed = parseTxExtra(extra)
    expect(parsed.pubKeys).toHaveLength(1)
    expect(Buffer.from(parsed.encryptedPid).equals(pid)).toBe(true)
  })

  test('returns empty structures on a blob with no pub key', () => {
    const parsed = parseTxExtra(Buffer.from([0x02, 3, 0x01, 1, 2, 3]))
    expect(parsed.pubKeys).toHaveLength(0)
    expect(parsed.encryptedPid).toBeNull()
    expect(parsed.plainPid).toBeNull()
  })
})

describe('encrypted payment-id derivation (lws decrypt_payment_id parity)', () => {
  test('recipient-side mask 8*a*R equals sender-side mask 8*r*A (ECDH commutation)', () => {
    const r = randomScalar()
    const a = randomScalar()
    const G = ed25519.ExtendedPoint.BASE
    const R = G.multiply(r) // tx public key
    const A = G.multiply(a) // recipient public view key
    // Monero generate_key_derivation: scalarmult then ge_mul8, then tobytes
    const dRecv = R.multiply(a).double().double().double().toRawBytes()
    const dSend = A.multiply(r).double().double().double().toRawBytes()
    expect(Buffer.from(dRecv).equals(Buffer.from(dSend))).toBe(true)
    expect(maskFromTxPubKey(Buffer.from(R.toRawBytes()), scalarToLEHex(a)))
      .toEqual(maskFromDerivation(Buffer.from(dSend)))
  })

  test('xorWithMask under the recipient mask undoes encryption under the sender mask', () => {
    const r = randomScalar()
    const a = randomScalar()
    const G = ed25519.ExtendedPoint.BASE
    const R = G.multiply(r)
    const A = G.multiply(a)
    const pid = Buffer.from('a0211a0a2c1217c6', 'hex')
    const senderMask = maskFromDerivation(A.multiply(r).double().double().double().toRawBytes())
    const stored = xorWithMask(pid, senderMask)
    expect(stored.equals(pid)).toBe(false)
    const recipientMask = maskFromTxPubKey(Buffer.from(R.toRawBytes()), scalarToLEHex(a))
    const recovered = xorWithMask(stored, recipientMask)
    expect(recovered.equals(pid)).toBe(true)
  })

  test('masks are 8 bytes and differ per derivation', () => {
    const m1 = maskFromDerivation(Buffer.from(randomBytes(32)))
    const m2 = maskFromDerivation(Buffer.from(randomBytes(32)))
    expect(m1).toHaveLength(8)
    expect(m2).toHaveLength(8)
    expect(m1.equals(m2)).toBe(false)
  })
})

describe('paymentIdCandidates (wrong-pid fallback core)', () => {
  test('returns the recipient-side decrypted pid for every tx pubkey in the extra', () => {
    const a = randomScalar()
    const G = ed25519.ExtendedPoint.BASE
    const R1 = G.multiply(randomScalar())
    const R2 = G.multiply(randomScalar())
    const pid1 = Buffer.from('0102030405060708', 'hex')
    // encrypt pid1 under R1's derivation (sender side: 8*r1*A with r1 known to sender)
    const r1 = 0n // placeholder, replaced below by re-deriving from stored point is impossible;
    // instead encrypt under the recipient-commuting form directly: mask(8*a*R1)
    const mask1 = maskFromTxPubKey(Buffer.from(R1.toRawBytes()), scalarToLEHex(a))
    const stored = xorWithMask(pid1, mask1)
    const extra = buildExtra({ txPubKey: Buffer.from(R1.toRawBytes()), additionalPubKeys: [Buffer.from(R2.toRawBytes())], encryptedPid: stored })
    const candidates = paymentIdCandidates(extra, scalarToLEHex(a))
    expect(candidates).toContain(pid1.toString('hex'))
    // R2 also yields a candidate (garbage for this tx, but a valid 8-byte decryption)
    expect(candidates).toHaveLength(2)
    expect(r1).toBe(0n)
  })

  test('returns [] when the extra carries no encrypted pid', () => {
    const a = randomScalar()
    const extra = buildExtra({ txPubKey: Buffer.from(randomBytes(32)) })
    expect(paymentIdCandidates(extra, scalarToLEHex(a))).toEqual([])
  })

  test('propagates a plain (unencrypted) pid untouched as a candidate', () => {
    const plain = Buffer.from(randomBytes(32))
    const extra = buildExtra({ txPubKey: Buffer.from(randomBytes(32)), plainPid: plain })
    const candidates = paymentIdCandidates(extra, scalarToLEHex(randomScalar()))
    expect(candidates).toEqual([plain.toString('hex')])
  })
})
