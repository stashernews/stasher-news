import crypto from 'node:crypto'

// Address confidentiality for the weekly email digest. Plaintext emails are
// never stored (signup keeps only emailHash + emailHint); a linked address is
// kept as an AES-256-GCM envelope under EMAIL_MASTER_KEY so the digest worker
// can decrypt it in memory at send time. Decryption never happens in the web
// process for sending purposes, and neither plaintext nor envelopes are logged.
//
// Envelope format: v1:<iv_b64>:<tag_b64>:<ct_b64> — the version prefix leaves
// room for key rotation without a schema change.

const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const ENVELOPE_PREFIX = 'v1'
const AAD = Buffer.from('stasher:email:v1', 'utf8')
const UNSUB_PURPOSE = 'email-unsubscribe:'

function getMasterKey () {
  const raw = process.env.EMAIL_MASTER_KEY
  if (!raw) {
    throw new Error('EMAIL_MASTER_KEY is not set')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LEN) {
    throw new Error(`EMAIL_MASTER_KEY must decode to ${KEY_LEN} bytes, got ${key.length}`)
  }
  return key
}

export function encryptEmail (plaintext) {
  const key = getMasterKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [ENVELOPE_PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptEmail (envelope) {
  const key = getMasterKey()
  const parts = String(envelope).split(':')
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new Error('email envelope is malformed')
  }
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const ciphertext = Buffer.from(parts[3], 'base64')
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('email envelope is malformed')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// Signed one-click unsubscribe: the digest's List-Unsubscribe URLs carry the
// user id plus an HMAC of it, so no session or DB lookup is needed to prove the
// link was minted by us. Any change to EMAIL_MASTER_KEY invalidates old links.
export function createUnsubscribeToken (userId) {
  const key = getMasterKey()
  return crypto.createHmac('sha256', key).update(`${UNSUB_PURPOSE}${userId}`).digest('base64url')
}

export function verifyUnsubscribeToken (userId, token) {
  if (typeof token !== 'string' || token.length === 0) return false
  const expected = createUnsubscribeToken(userId)
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
