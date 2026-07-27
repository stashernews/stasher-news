/* eslint-env jest */

// Unit tests for the view-key envelope encryption helper (Task 2).
//
// AES-256-GCM envelope: a fresh random per-row DEK encrypts the view key;
// the DEK is wrapped by a master-key-derived KEK (HKDF-SHA256, dekVersion
// mixed into the derivation). Pure crypto — no DB, no network.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/api/monero/viewkey.test.js

const MODULE_PATH = require.resolve('../../../api/monero/viewkey')

// A 32-byte master key, base64-encoded, used for the "valid key" tests.
const VALID_MASTER_B64 = Buffer.from('a'.repeat(32)).toString('base64')

// 64-hex-char Monero private view key (per controller resolution #6 — a clean
// literal, not the brief's escaped template artifact).
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60)

// Fields of the MoneroViewKey prisma model that the envelope must match so a
// caller can spread encryptViewKey(...) straight into a prisma create.
const ENVELOPE_KEYS = ['ciphertext', 'iv', 'tag', 'wrappedDek', 'dekVersion']

let viewkey

beforeEach(() => {
  process.env.VIEWKEY_MASTER_KEY = VALID_MASTER_B64
  jest.resetModules()
  viewkey = require(MODULE_PATH)
})

describe('encryptViewKey / decryptViewKey round-trip', () => {
  test('decrypt(encrypt(plaintext)) returns the original view key', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(viewkey.decryptViewKey(enc)).toBe(VIEWKEY_HEX)
  })

  test('returns Buffers matching the MoneroViewKey model fields', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true)
    expect(Buffer.isBuffer(enc.iv)).toBe(true)
    expect(Buffer.isBuffer(enc.tag)).toBe(true)
    expect(Buffer.isBuffer(enc.wrappedDek)).toBe(true)
    expect(typeof enc.dekVersion).toBe('number')
  })

  test('envelope keys are exactly the MoneroViewKey field names (spread-safe)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Object.keys(enc).sort()).toEqual(ENVELOPE_KEYS.slice().sort())
  })

  test('GCM iv is 12 bytes and tag is 16 bytes', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(enc.iv.length).toBe(12)
    expect(enc.tag.length).toBe(16)
  })

  test('fresh DEK and IV per call (ciphertext/wrappedDek/iv are non-deterministic)', () => {
    const a = viewkey.encryptViewKey(VIEWKEY_HEX)
    const b = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false)
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false)
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false)
  })
})

describe('GCM tamper detection', () => {
  test('flipping a ciphertext byte makes decrypt throw (auth failure)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedCt = Buffer.from(enc.ciphertext)
    tamperedCt[0] = tamperedCt[0] ^ 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, ciphertext: tamperedCt })).toThrow()
  })

  test('flipping the GCM tag makes decrypt throw', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedTag = Buffer.from(enc.tag)
    tamperedTag[0] = tamperedTag[0] ^ 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, tag: tamperedTag })).toThrow()
  })

  test('tampering the wrappedDek makes decrypt throw (wrap is also authenticated)', () => {
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    const tamperedWrap = Buffer.from(enc.wrappedDek)
    tamperedWrap[tamperedWrap.length - 1] ^= 0x01
    expect(() => viewkey.decryptViewKey({ ...enc, wrappedDek: tamperedWrap })).toThrow()
  })
})

describe('rotateMasterKey', () => {
  test('bumps dekVersion and changes the wrapping of subsequent encrypts', () => {
    const before = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(before.dekVersion).toBe(1)

    const newKeyB64 = Buffer.from('b'.repeat(32)).toString('base64')
    const nextVersion = viewkey.rotateMasterKey(newKeyB64)
    expect(nextVersion).toBe(2)

    const after = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(after.dekVersion).toBe(2)
    expect(Buffer.from(after.wrappedDek).equals(Buffer.from(before.wrappedDek))).toBe(false)
  })

  test('envelopes encrypted after rotation still round-trip', () => {
    viewkey.rotateMasterKey(Buffer.from('b'.repeat(32)).toString('base64'))
    const enc = viewkey.encryptViewKey(VIEWKEY_HEX)
    expect(viewkey.decryptViewKey(enc)).toBe(VIEWKEY_HEX)
  })

  test('envelopes encrypted under the OLD master key fail to decrypt after rotation (Phase 5 must re-wrap)', () => {
    const oldEnc = viewkey.encryptViewKey(VIEWKEY_HEX)
    viewkey.rotateMasterKey(Buffer.from('c'.repeat(32)).toString('base64'))
    expect(() => viewkey.decryptViewKey(oldEnc)).toThrow()
  })

  test('rejects a new key that does not decode to 32 bytes', () => {
    expect(() => viewkey.rotateMasterKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
  })
})

describe('VIEWKEY_MASTER_KEY env handling (fail-closed)', () => {
  test('missing VIEWKEY_MASTER_KEY throws on encrypt (never silently weak)', () => {
    delete process.env.VIEWKEY_MASTER_KEY
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/VIEWKEY_MASTER_KEY/)
  })

  test('empty VIEWKEY_MASTER_KEY throws on encrypt', () => {
    process.env.VIEWKEY_MASTER_KEY = ''
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/VIEWKEY_MASTER_KEY/)
  })

  test('wrong-length VIEWKEY_MASTER_KEY throws on encrypt', () => {
    process.env.VIEWKEY_MASTER_KEY = Buffer.from('short').toString('base64')
    jest.resetModules()
    const fresh = require(MODULE_PATH)
    expect(() => fresh.encryptViewKey(VIEWKEY_HEX)).toThrow(/32 bytes/)
  })
})
