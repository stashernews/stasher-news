import crypto from 'node:crypto'

// View-key envelope encryption (Task 2 / spec Q3).
//
// Authors' Monero private view keys are encrypted at rest so the indexer
// worker can decrypt them in-process to poll monero-lws; the web process
// only ever encrypts. View keys are never logged and never emailed.
//
// Scheme (AES-256-GCM envelope):
//   - a fresh random 32-byte DEK encrypts the view key (data layer);
//   - the DEK is wrapped by a KEK derived from the master key via
//     HKDF-SHA256, with `dekVersion` mixed into the salt so a bumped
//     version yields a fresh KEK even under the same master key (rotation);
//   - the wrapped DEK is itself AES-256-GCM authenticated, so DB tampering
//     of `wrappedDek` is detected on unwrap (not just on data decrypt).
//
// The master key is `process.env.VIEWKEY_MASTER_KEY`: base64-encoded 32
// bytes. In production this is backed by a KMS alias (Phase 5); the
// `getMasterKey` lazy-init below is the seam to swap in KMS fetch+cache.
//
// All return values are Buffers, matching the `MoneroViewKey` model fields
// (`ciphertext`, `iv`, `tag`, `wrappedDek` are `Bytes`; `dekVersion` is `Int`),
// so a caller can spread `encryptViewKey(...)` straight into a prisma create.

const DEK_LEN = 32 // AES-256 data-encryption key
const IV_LEN = 12 // GCM nonce
const TAG_LEN = 16 // GCM auth tag
const KEK_LEN = 32 // AES-256 key-encryption key
const HKDF_INFO = Buffer.from('stealthnews/monero/viewkey-kek/v1', 'utf8')

// `wrappedDek` packs {wrapIv(12) + wrapTag(16) + wrapped(32)} into one Bytes
// field so the MoneroViewKey schema needs no extra columns.
const WRAP_IV_OFFSET = 0
const WRAP_TAG_OFFSET = IV_LEN
const WRAP_BODY_OFFSET = IV_LEN + TAG_LEN

// In-process master-key cache. Lazily loaded from the env on first use; a
// Phase 5 KMS integration would populate this from the KMS instead.
let activeMasterKey = null

// Current dekVersion used by encryptViewKey. decryptViewKey uses the
// envelope's dekVersion, so it can read rows written under any version that
// shares the active master key.
let currentDekVersion = 1

function decodeBase64Key (b64, what) {
  if (!b64) {
    throw new Error(`${what} is not set; refusing to derive a weak key`)
  }
  let buf
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    throw new Error(`${what} is not valid base64`)
  }
  if (buf.length !== KEK_LEN) {
    throw new Error(`${what} must decode to ${KEK_LEN} bytes (got ${buf.length})`)
  }
  return buf
}

// Fail-closed: a missing/empty/malformed VIEWKEY_MASTER_KEY throws rather
// than silently deriving a zero/weak key for a security primitive.
function getMasterKey () {
  if (activeMasterKey) return activeMasterKey
  activeMasterKey = decodeBase64Key(process.env.VIEWKEY_MASTER_KEY, 'VIEWKEY_MASTER_KEY')
  return activeMasterKey
}

// HKDF-SHA256: dekVersion is the salt, so bumping the version derives a
// distinct KEK under the same master key (forward freshness during rotation).
function deriveKek (masterKey, dekVersion) {
  const salt = Buffer.allocUnsafe(4)
  salt.writeUInt32LE(dekVersion, 0)
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, HKDF_INFO, KEK_LEN))
}

// Wrap the per-row DEK under the KEK with AES-256-GCM (a fresh wrap IV per
// row). Returns the packed {wrapIv, wrapTag, wrapped} Buffer.
function wrapDek (dek, kek) {
  const wrapIv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, wrapIv, { authTagLength: TAG_LEN })
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()])
  const wrapTag = cipher.getAuthTag()
  return Buffer.concat([wrapIv, wrapTag, wrapped])
}

function unwrapDek (packed, kek) {
  const wrapIv = packed.subarray(WRAP_IV_OFFSET, WRAP_TAG_OFFSET)
  const wrapTag = packed.subarray(WRAP_TAG_OFFSET, WRAP_BODY_OFFSET)
  const wrapped = packed.subarray(WRAP_BODY_OFFSET)
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, wrapIv)
  decipher.setAuthTag(wrapTag)
  return Buffer.concat([decipher.update(wrapped), decipher.final()])
}

// Encrypt a Monero private view key (hex string) under the active master key.
// Returns { ciphertext, iv, tag, wrappedDek, dekVersion }, all Buffers except
// dekVersion (Int) — spread-safe into a prisma MoneroViewKey create.
export function encryptViewKey (plaintext) {
  const masterKey = getMasterKey()
  const kek = deriveKek(masterKey, currentDekVersion)
  const dek = crypto.randomBytes(DEK_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_LEN })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const wrappedDek = wrapDek(dek, kek)
  return { ciphertext, iv, tag, wrappedDek, dekVersion: currentDekVersion }
}

// Decrypt an envelope-shaped object ({ ciphertext, iv, tag, wrappedDek,
// dekVersion }) back to the plaintext view key. Pure crypto: no Prisma, no
// DB lookup — the caller (Task 3's lwsClient) fetches the MoneroViewKey row
// and passes it here. Throws on any tamper (GCM auth failure).
export function decryptViewKey (envelope) {
  const masterKey = getMasterKey()
  const kek = deriveKek(masterKey, envelope.dekVersion)
  const dek = unwrapDek(envelope.wrappedDek, kek)
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, envelope.iv)
  decipher.setAuthTag(envelope.tag)
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
}

// Rotate the active master key in-process and bump dekVersion. Subsequent
// encryptViewKey calls wrap under the new key + new version. Returns the new
// dekVersion.
//
// This does NOT re-wrap existing rows: envelopes written under a previous
// master key will fail to decrypt (their wrappedDek was sealed with a KEK
// derived from the old key). Phase 5's rotation job must, BEFORE calling this,
// read+decrypt every row under the old key, then re-encrypt+persist each under
// the new key (or load both keys into a keychain during a gradual migration).
export function rotateMasterKey (newKeyB64) {
  activeMasterKey = decodeBase64Key(newKeyB64, 'rotateMasterKey: newKey')
  currentDekVersion += 1
  return currentDekVersion
}
