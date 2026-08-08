/* eslint-env jest */

// Unit tests for the master-key provider seam (Task C1).
//
// Covers the env version→key registry, the VIEWKEY_MASTER_KEY back-compat
// path (every existing MoneroViewKey row is dekVersion=1 and must keep
// decrypting), the KMS-provider seam (fails closed until implemented), and
// cross-version decrypt (encrypt under the current version, decrypt an
// envelope sealed under an older version whose key is still registered).
//
// Run via the app container:
//   docker exec -w /app -e NODE_OPTIONS=--experimental-vm-modules -u apprunner app \
//     npx jest test/api/monero/masterkey.test.js

const MASTERKEY_PATH = require.resolve('../../../api/monero/masterkey')
const VIEWKEY_PATH = require.resolve('../../../api/monero/viewkey')

const KEY_A_B64 = Buffer.from('a'.repeat(32)).toString('base64')
const KEY_B_B64 = Buffer.from('b'.repeat(32)).toString('base64')
const KEY_C_B64 = Buffer.from('c'.repeat(32)).toString('base64')
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60)

const SCALAR_VARS = [
  'VIEWKEY_MASTER_KEY',
  'VIEWKEY_MASTER_KEYS',
  'VIEWKEY_MASTER_KEY_CURRENT_VERSION',
  'VIEWKEY_MASTER_KEY_PROVIDER',
  'VIEWKEY_MASTER_KEY_KMS_KEY_ID'
]

function clearMasterKeyEnv () {
  for (const name of SCALAR_VARS) delete process.env[name]
  for (const name of Object.keys(process.env)) {
    if (/^VIEWKEY_MASTER_KEYS_V\d+$/.test(name)) delete process.env[name]
  }
}

beforeEach(() => {
  clearMasterKeyEnv()
  jest.resetModules()
})

afterEach(() => {
  clearMasterKeyEnv()
})

describe('back-compat: single VIEWKEY_MASTER_KEY', () => {
  test('treats the legacy var as version 1 and current', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const mk = require(MASTERKEY_PATH)
    expect(mk.getCurrentVersion()).toBe(1)
    const key = mk.getMasterKey(1)
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
    expect(key.equals(Buffer.from('a'.repeat(32)))).toBe(true)
  })

  test('encrypt/decrypt round-trips under version 1 via viewkey', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const vk = require(VIEWKEY_PATH)
    const enc = vk.encryptViewKey(VIEWKEY_HEX)
    expect(enc.dekVersion).toBe(1)
    expect(vk.decryptViewKey(enc)).toBe(VIEWKEY_HEX)
  })
})

describe('multi-version env registry', () => {
  test('VIEWKEY_MASTER_KEYS_V1 + _V2 + CURRENT_VERSION=2 exposes both versions', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    const mk = require(MASTERKEY_PATH)
    expect(mk.getCurrentVersion()).toBe(2)
    expect(mk.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
    expect(mk.getMasterKey(2).equals(Buffer.from('b'.repeat(32)))).toBe(true)
  })

  test('JSON VIEWKEY_MASTER_KEYS registry is accepted', () => {
    process.env.VIEWKEY_MASTER_KEYS = JSON.stringify({ 1: KEY_A_B64, 2: KEY_B_B64 })
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    const mk = require(MASTERKEY_PATH)
    expect(mk.getCurrentVersion()).toBe(2)
    expect(mk.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
    expect(mk.getMasterKey(2).equals(Buffer.from('b'.repeat(32)))).toBe(true)
  })

  test('defaults CURRENT_VERSION to the highest registered version when unset', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V3 = KEY_C_B64
    const mk = require(MASTERKEY_PATH)
    expect(mk.getCurrentVersion()).toBe(3)
  })

  test('rejects CURRENT_VERSION with no matching key (fail-closed)', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '5'
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getCurrentVersion()).toThrow(/VIEWKEY_MASTER_KEY_CURRENT_VERSION=5/)
  })

  test('versioned vars take precedence over the legacy single var', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    const mk = require(MASTERKEY_PATH)
    expect(mk.getCurrentVersion()).toBe(2)
    expect(() => mk.getMasterKey(1)).toThrow(/no master key registered for dekVersion 1/)
  })
})

describe('cross-version decrypt (encrypt-under-current, decrypt-under-old)', () => {
  test('an envelope sealed under v1 decrypts after v2 becomes current', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '1'
    jest.resetModules()
    const vkOld = require(VIEWKEY_PATH)
    const v1Envelope = vkOld.encryptViewKey(VIEWKEY_HEX)
    expect(v1Envelope.dekVersion).toBe(1)

    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    jest.resetModules()
    const vkNew = require(VIEWKEY_PATH)

    expect(vkNew.decryptViewKey(v1Envelope)).toBe(VIEWKEY_HEX)
    const v2Envelope = vkNew.encryptViewKey(VIEWKEY_HEX)
    expect(v2Envelope.dekVersion).toBe(2)
    expect(vkNew.decryptViewKey(v2Envelope)).toBe(VIEWKEY_HEX)
  })

  test('dropping an old version from the registry fails its decrypt (fail-closed)', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '1'
    jest.resetModules()
    const vkOld = require(VIEWKEY_PATH)
    const v1Envelope = vkOld.encryptViewKey(VIEWKEY_HEX)

    delete process.env.VIEWKEY_MASTER_KEYS_V1
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    jest.resetModules()
    const vkNew = require(VIEWKEY_PATH)
    expect(() => vkNew.decryptViewKey(v1Envelope)).toThrow(/no master key registered for dekVersion 1/)
  })
})

describe('setActiveKey (destructive in-process hot-swap)', () => {
  test('bumps to the next version and drops prior versions', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '2'
    const mk = require(MASTERKEY_PATH)
    expect(mk.setActiveKey(KEY_C_B64)).toBe(3)
    expect(mk.getCurrentVersion()).toBe(3)
    expect(mk.getMasterKey(3).equals(Buffer.from('c'.repeat(32)))).toBe(true)
    expect(() => mk.getMasterKey(1)).toThrow(/no master key registered for dekVersion 1/)
    expect(() => mk.getMasterKey(2)).toThrow(/no master key registered for dekVersion 2/)
  })

  test('rejects a wrong-length key without changing state', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.setActiveKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
    expect(mk.getCurrentVersion()).toBe(1)
    expect(mk.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
  })
})

describe('addMasterKeyVersion (non-destructive, idempotent rotation)', () => {
  test('mints the next version, elects it current, and RETAINS prior versions', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const mk = require(MASTERKEY_PATH)
    expect(mk.addMasterKeyVersion(KEY_B_B64)).toBe(2)
    expect(mk.getCurrentVersion()).toBe(2)
    expect(mk.getMasterKey(2).equals(Buffer.from('b'.repeat(32)))).toBe(true)
    expect(mk.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
  })

  test('is idempotent: the same key bytes re-elect the existing version (no bump)', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = KEY_A_B64
    process.env.VIEWKEY_MASTER_KEYS_V2 = KEY_B_B64
    process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION = '1'
    const mk = require(MASTERKEY_PATH)
    expect(mk.addMasterKeyVersion(KEY_B_B64)).toBe(2)
    expect(mk.addMasterKeyVersion(KEY_B_B64)).toBe(2)
    expect(mk.getCurrentVersion()).toBe(2)
    expect(() => mk.getMasterKey(3)).toThrow(/no master key registered for dekVersion 3/)
  })

  test('can stack several versions without losing any', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const mk = require(MASTERKEY_PATH)
    expect(mk.addMasterKeyVersion(KEY_B_B64)).toBe(2)
    expect(mk.addMasterKeyVersion(KEY_C_B64)).toBe(3)
    expect(mk.getCurrentVersion()).toBe(3)
    expect(mk.getMasterKey(1).equals(Buffer.from('a'.repeat(32)))).toBe(true)
    expect(mk.getMasterKey(2).equals(Buffer.from('b'.repeat(32)))).toBe(true)
    expect(mk.getMasterKey(3).equals(Buffer.from('c'.repeat(32)))).toBe(true)
  })

  test('rejects a wrong-length key without changing state', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.addMasterKeyVersion(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
    expect(mk.getCurrentVersion()).toBe(1)
  })

  test('old-version envelopes keep decrypting after a new version is added', () => {
    process.env.VIEWKEY_MASTER_KEY = KEY_A_B64
    const vk = require(VIEWKEY_PATH)
    const v1 = vk.encryptViewKey(VIEWKEY_HEX)
    require(MASTERKEY_PATH).addMasterKeyVersion(KEY_B_B64)
    const v2 = vk.encryptViewKey(VIEWKEY_HEX)
    expect(v1.dekVersion).toBe(1)
    expect(v2.dekVersion).toBe(2)
    expect(vk.decryptViewKey(v1)).toBe(VIEWKEY_HEX)
    expect(vk.decryptViewKey(v2)).toBe(VIEWKEY_HEX)
  })
})

describe('fail-closed loading', () => {
  test('no master-key env at all throws', () => {
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getMasterKey(1)).toThrow(/VIEWKEY_MASTER_KEY is not set/)
  })

  test('empty legacy var throws', () => {
    process.env.VIEWKEY_MASTER_KEY = ''
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getCurrentVersion()).toThrow(/VIEWKEY_MASTER_KEY is not set/)
  })

  test('wrong-length legacy var throws on /32 bytes/', () => {
    process.env.VIEWKEY_MASTER_KEY = Buffer.from('short').toString('base64')
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getMasterKey(1)).toThrow(/32 bytes/)
  })

  test('wrong-length versioned var names that var in the error', () => {
    process.env.VIEWKEY_MASTER_KEYS_V1 = Buffer.from('short').toString('base64')
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getMasterKey(1)).toThrow(/VIEWKEY_MASTER_KEYS_V1.*32 bytes/)
  })

  test('kms provider is a seam that throws until implemented', () => {
    process.env.VIEWKEY_MASTER_KEY_PROVIDER = 'kms'
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getMasterKey(1)).toThrow(/kms is not implemented/)
  })

  test('unknown provider throws', () => {
    process.env.VIEWKEY_MASTER_KEY_PROVIDER = 'vault'
    const mk = require(MASTERKEY_PATH)
    expect(() => mk.getMasterKey(1)).toThrow(/unknown VIEWKEY_MASTER_KEY_PROVIDER/)
  })
})
