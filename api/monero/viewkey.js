import crypto from 'node:crypto'
import { getMasterKey, getCurrentVersion, addMasterKeyVersion } from './masterkey'

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
// The master key is provisioned by the pluggable provider seam in
// ./masterkey.js (env registry by default; KMS-ready). It is versioned so
// rotation (Task C2) can keep old keys around to decrypt prior envelopes.
// `dekVersion` is mixed into the HKDF salt below, so each version derives a
// distinct KEK under the same master key.
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
  const dekVersion = getCurrentVersion()
  const masterKey = getMasterKey(dekVersion)
  const kek = deriveKek(masterKey, dekVersion)
  const dek = crypto.randomBytes(DEK_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_LEN })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const wrappedDek = wrapDek(dek, kek)
  return { ciphertext, iv, tag, wrappedDek, dekVersion }
}

// Decrypt an envelope-shaped object ({ ciphertext, iv, tag, wrappedDek,
// dekVersion }) back to the plaintext view key. Pure crypto: no Prisma, no
// DB lookup — the caller (Task 3's lwsClient) fetches the MoneroViewKey row
// and passes it here. Throws on any tamper (GCM auth failure).
export function decryptViewKey (envelope) {
  const masterKey = getMasterKey(envelope.dekVersion)
  const kek = deriveKek(masterKey, envelope.dekVersion)
  const dek = unwrapDek(envelope.wrappedDek, kek)
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, envelope.iv)
  decipher.setAuthTag(envelope.tag)
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
}

// Production-safe master-key rotation (Task C2). Registers `newKeyB64` as the
// next version via the non-destructive, idempotent registry (old versions are
// RETAINED so prior envelopes and backups keep decrypting), then re-wraps every
// MoneroViewKey row whose dekVersion is below the new target: decrypt under the
// row's old master key, re-encrypt under the new version with a fresh DEK + IV,
// and stamp dekVersion + rotatedAt. On completion every row decrypts under the
// new current key; old keys stay registered. Returns { version, rotated }.
//
// Resumable/idempotent: only rows with dekVersion < targetVersion are touched,
// so a crash mid-rotation leaves a consistent mix (each row decrypts under its
// own retained key) and a re-run with the same key finishes the stragglers
// without bumping the version again (addMasterKeyVersion is byte-idempotent).
//
// The function needs DB access to re-wrap rows, hence the `{ models }` arg
// (same shape as the worker jobs: models.moneroViewKey.{findMany,update}).
// The operator script persists the new key to env + restarts app/worker BEFORE
// running this, so the version it mints is durable, not in-process only.
export async function rotateMasterKey ({ newKeyB64, models }) {
  if (!newKeyB64) {
    throw new Error('rotateMasterKey requires { newKeyB64 }')
  }
  if (!models || typeof models.moneroViewKey?.findMany !== 'function' || typeof models.moneroViewKey?.update !== 'function') {
    throw new Error('rotateMasterKey requires { models } with moneroViewKey.{findMany,update} to re-wrap rows')
  }
  const targetVersion = addMasterKeyVersion(newKeyB64)
  const rows = await models.moneroViewKey.findMany({
    where: { dekVersion: { lt: targetVersion } }
  })
  let rotated = 0
  for (const row of rows) {
    const plaintext = decryptViewKey(row)
    const fresh = encryptViewKey(plaintext)
    await models.moneroViewKey.update({
      where: { id: row.id },
      data: {
        ciphertext: fresh.ciphertext,
        iv: fresh.iv,
        tag: fresh.tag,
        wrappedDek: fresh.wrappedDek,
        dekVersion: fresh.dekVersion,
        rotatedAt: new Date()
      }
    })
    rotated += 1
  }
  return { version: targetVersion, rotated }
}
