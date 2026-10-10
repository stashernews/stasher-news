// Strict tx-extra parsing and Monero key-structure arithmetic for the
// payment-proof chain adapter (Finding #1, Task 4).
//
// Two responsibilities, both independent of any wallet/daemon/DB:
//
//  1. An ORDERED, strict tx-extra parser (tags 0x01 main tx pubkey, 0x02 nonce
//     varint, 0x04 additional pubkeys). Unlike the permissive per-tip parser in
//     `pidDecrypt.parseTxExtra` (which resyncs past unknown bytes and flattens
//     all pubkeys into one list), this parser refuses anything it does not
//     fully understand with a fixed error code — unknown tags, duplicate
//     fields, truncated data, non-canonical varints and impossible counts are
//     verification refusals, never best-effort parses.
//
//  2. The pinned Monero one-time-output-key arithmetic (monero-project
//     4693d293, src/cryptonote_core/cryptonote_tx_utils.cpp +
//     src/device/device_default.cpp generate_output_ephemeral_keys):
//
//       one-time key  = Hs(8 * s * R || varint(localIndex)) * G + publicSpend
//
//     with the cofactor-8 multiplication MANDATORY (crypto.cpp
//     generate_key_derivation applies ge_mul8 unconditionally; both the sender
//     construction and the wallet2 receiver scan hash that same derivation).
//     @noble/curves `multiply()` does NOT cofactor-clear, so the x8 is applied
//     explicitly via `.double().double().double()`.
//
//     Sender side (external outputs): s = r or r_i (tx secrets), R = the
//     recipients' PUBLIC view key (A for standard/change, C for subaddresses —
//     both encoded in the address text). Recipients' private keys are never an
//     input. Public part of the tx key used for an output:
//       standard/change → r_i*G ; subaddress → r_i*B ; a single-output tx
//     paying one subaddress may carry the main key as r*B instead.
//
//     Receiver side (sender's own outputs / change): s = the wallet's private
//     view key a, R = the tx pubkey slot (main or ordered additional key) — the
//     a*R orientation.
//
// Every refusal carries a fixed machine code (`error.code`); unknown or
// ambiguous key↔output correspondence is reported, never guessed into
// validity.

import { ed25519 } from '@noble/curves/ed25519'
import { keccak256 } from 'js-sha3'

const P = ed25519.ExtendedPoint
const CURVE_N = ed25519.CURVE.n
const HEX64 = /^[0-9a-f]{64}$/
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/

// tx-extra TLV tags (cryptonote_basic/tx_extra.h) this verifier understands.
const TAG_PUBKEY = 0x01
const TAG_NONCE = 0x02
const TAG_ADDITIONAL_PUBKEYS = 0x04

/**
 * Build a fixed-code verification error.
 * @param {string} code
 * @param {string} [detail]
 * @returns {Error} with `.name = 'PaymentKeyStructureError'` and `.code`
 */
export function keyStructureError (code, detail) {
  const error = new Error(detail === undefined ? code : `${code}: ${detail}`)
  error.name = 'PaymentKeyStructureError'
  error.code = code
  return error
}

function isHex64 (value) {
  return typeof value === 'string' && HEX64.test(value)
}

/** Decode a 64-hex Monero secret scalar as a little-endian bigint. */
export function scalarFromHexLE (hex) {
  if (!isHex64(hex)) {
    throw keyStructureError('SECRET_SCALAR_INVALID', 'expected 64 lowercase hex characters')
  }
  const bytes = Buffer.from(hex, 'hex')
  let value = 0n
  for (let i = 31; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  if (!(value > 0n && value < CURVE_N)) {
    throw keyStructureError('SECRET_SCALAR_INVALID', 'scalar is outside 0 < s < curve order')
  }
  return value
}

/** The public key `scalar * G` as 64-hex. */
export function publicKeyForScalar (scalar) {
  if (typeof scalar !== 'bigint' || !(scalar > 0n && scalar < CURVE_N)) {
    throw keyStructureError('SECRET_SCALAR_INVALID', 'scalar is outside 0 < s < curve order')
  }
  return P.BASE.multiply(scalar).toHex()
}

/** Validate a 64-hex canonical curve point, returning its hex form. */
function canonicalPointHex (hex, code) {
  if (!isHex64(hex)) throw keyStructureError(code, 'expected 64 lowercase hex characters')
  try {
    P.fromHex(hex).assertValidity()
  } catch {
    throw keyStructureError(code, 'not a canonical ed25519 point')
  }
  return hex
}

/** Little-endian varint encoding of a non-negative safe integer. */
function encodeVarint (value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw keyStructureError('KEY_STRUCTURE_INDEX_INVALID', `varint input ${value}`)
  }
  const bytes = []
  let v = value
  do {
    const part = v % 128
    v = Math.floor(v / 128)
    bytes.push(part | (v ? 128 : 0))
  } while (v)
  return Buffer.from(bytes)
}

function keyHexFromBytes (bytes) {
  return canonicalPointHex(Buffer.from(bytes).toString('hex'), 'EXTRA_KEY_NOT_CANONICAL')
}

/**
 * Strict ordered tx-extra parser. Accepts a lowercase hex string or raw bytes.
 * Returns `{ main, additional, nonce }` where `main`/`additional` are 64-hex
 * canonical points, `additional` preserves its on-chain order (never
 * flattened together with the main key), and `nonce` is the raw nonce payload
 * bytes or null. Every malformed shape refuses with a fixed `EXTRA_*` code.
 * @param {string|Uint8Array} extra
 * @returns {{ main: string, additional: string[], nonce: Uint8Array|null }}
 */
export function parseTxExtraStrict (extra) {
  let data
  if (typeof extra === 'string') {
    if (!HEX_BYTES.test(extra)) {
      throw keyStructureError('EXTRA_TYPE', 'expected lowercase even-length hex')
    }
    data = Buffer.from(extra, 'hex')
  } else if (extra instanceof Uint8Array) {
    data = Buffer.from(extra)
  } else {
    throw keyStructureError('EXTRA_TYPE', 'expected hex string or bytes')
  }

  let offset = 0
  let main = null
  let additional = null
  let nonce = null

  const take = count => {
    if (offset + count > data.length) {
      throw keyStructureError('EXTRA_TRUNCATED', `need ${count} bytes at offset ${offset}`)
    }
    const value = data.subarray(offset, offset + count)
    offset += count
    return value
  }
  const readCount = () => {
    let value = 0n
    let shift = 0n
    let last
    do {
      last = take(1)[0]
      value |= BigInt(last & 0x7f) << shift
      shift += 7n
      if (shift > 63n) throw keyStructureError('EXTRA_VARINT_OVERFLOW', 'varint exceeds 64 bits')
    } while (last & 0x80)
    if (!(shift === 7n || (last & 0x7f) !== 0)) {
      throw keyStructureError('EXTRA_VARINT_NONCANONICAL', 'zero encoded with a continuation byte')
    }
    if (value > 255n) throw keyStructureError('EXTRA_COUNT_UNSUPPORTED', `count ${value} > 255`)
    return Number(value)
  }

  while (offset < data.length) {
    const tag = take(1)[0]
    if (tag === TAG_PUBKEY) {
      if (main !== null) throw keyStructureError('EXTRA_MULTIPLE_MAIN_KEYS')
      main = keyHexFromBytes(take(32))
    } else if (tag === TAG_NONCE) {
      if (nonce !== null) throw keyStructureError('EXTRA_MULTIPLE_NONCES')
      nonce = new Uint8Array(take(readCount()))
    } else if (tag === TAG_ADDITIONAL_PUBKEYS) {
      if (additional !== null) throw keyStructureError('EXTRA_MULTIPLE_ADDITIONAL_FIELDS')
      const count = readCount()
      if (count < 1 || count > 64) {
        throw keyStructureError('EXTRA_KEY_COUNT_UNSUPPORTED', `additional key count ${count}`)
      }
      additional = []
      for (let i = 0; i < count; i++) additional.push(keyHexFromBytes(take(32)))
    } else {
      throw keyStructureError('EXTRA_TAG_UNSUPPORTED', `tag 0x${tag.toString(16).padStart(2, '0')}`)
    }
  }
  if (main === null) throw keyStructureError('EXTRA_MAIN_KEY_MISSING')
  return { main, additional: additional ?? [], nonce }
}

/**
 * The tx public key(s) that can be in effect for one output: the main key,
 * plus the output's ordered additional key when additional keys exist.
 * @param {{ main: string, additional: string[] }} parsedExtra parseTxExtraStrict output
 * @param {number} outputIndex
 * @returns {string[]}
 */
export function txPublicKeysForOutput (parsedExtra, outputIndex) {
  if (!parsedExtra || typeof parsedExtra !== 'object' ||
    !isHex64(parsedExtra.main) || !Array.isArray(parsedExtra.additional)) {
    throw keyStructureError('EXTRA_TYPE', 'expected parseTxExtraStrict output')
  }
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw keyStructureError('KEY_STRUCTURE_INDEX_INVALID', `outputIndex ${outputIndex}`)
  }
  const keys = [canonicalPointHex(parsedExtra.main, 'EXTRA_KEY_NOT_CANONICAL')]
  if (parsedExtra.additional.length > 0) {
    if (outputIndex >= parsedExtra.additional.length) {
      throw keyStructureError('KEY_STRUCTURE_INDEX_INVALID', `no additional key for output ${outputIndex}`)
    }
    keys.push(canonicalPointHex(parsedExtra.additional[outputIndex], 'EXTRA_KEY_NOT_CANONICAL'))
  }
  return keys
}

/**
 * Split a built key bundle (main secret + advertised additional secrets,
 * concatenated 64-hex little-endian) into validated scalars. Exactly
 * `1 + additionalKeyCount` keys must be present — truncated, appended and
 * count-mismatched bundles refuse.
 * @param {string} keyBundleHex
 * @param {number} additionalKeyCount
 * @returns {{ mainSecretHex: string, additionalSecretHexes: string[] }}
 */
export function parseKeyBundleHex (keyBundleHex, additionalKeyCount) {
  if (typeof keyBundleHex !== 'string' || !HEX_BYTES.test(keyBundleHex)) {
    throw keyStructureError('KEY_BUNDLE_INVALID', 'expected lowercase even-length hex')
  }
  if (!Number.isSafeInteger(additionalKeyCount) || additionalKeyCount < 0) {
    throw keyStructureError('KEY_BUNDLE_COUNT', `additionalKeyCount ${additionalKeyCount}`)
  }
  const keyCount = 1 + additionalKeyCount
  if (keyBundleHex.length !== keyCount * 64) {
    throw keyStructureError(
      'KEY_BUNDLE_LENGTH',
      `expected ${keyCount * 64} hex chars for ${keyCount} key(s), got ${keyBundleHex.length}`
    )
  }
  const sliceAt = index => keyBundleHex.slice(index * 64, index * 64 + 64)
  const validScalarHex = (hex, position) => {
    try {
      scalarFromHexLE(hex)
    } catch {
      throw keyStructureError('KEY_BUNDLE_SCALAR', `key ${position} is not a valid secret scalar`)
    }
    return hex
  }
  return {
    mainSecretHex: validScalarHex(sliceAt(0), 0),
    additionalSecretHexes: Array.from(
      { length: additionalKeyCount },
      (_, i) => validScalarHex(sliceAt(i + 1), i + 1)
    )
  }
}

function bundleOf (bundle) {
  if (!bundle || typeof bundle !== 'object' ||
    typeof bundle.mainSecretHex !== 'string' || !Array.isArray(bundle.additionalSecretHexes)) {
    throw keyStructureError('KEY_BUNDLE_INVALID', 'expected parseKeyBundleHex output')
  }
  return bundle
}

/**
 * Derive the public keys of a validated bundle: main = r*G, each additional
 * additional[i] = r_i*G. (Subaddress outputs carry r_i*B in the extra instead;
 * the kind-aware check lives in classifyOutputKeys.)
 * @param {{ mainSecretHex: string, additionalSecretHexes: string[] }} bundle
 * @returns {{ mainPublicKey: string, additionalPublicKeys: string[] }}
 */
export function bundlePublicKeys (bundle) {
  bundleOf(bundle)
  return {
    mainPublicKey: publicKeyForScalar(scalarFromHexLE(bundle.mainSecretHex)),
    additionalPublicKeys: bundle.additionalSecretHexes
      .map(hex => publicKeyForScalar(scalarFromHexLE(hex)))
  }
}

/**
 * Cofactored one-time output key Hs(8*s*R || varint(i))*G + publicSpend.
 * `secret` is a 64-hex little-endian scalar; `publicKey` is R (receiver path,
 * secret = private view key a) or the destination's public view key (sender
 * path, secret = r or r_i); `publicSpend` is the destination public spend key.
 * @param {{ publicKey: string, secret: string, publicSpend: string, outputIndex: number }} args
 * @returns {string} 64-hex one-time output key
 */
export function oneTimeOutputKey ({ publicKey, secret, publicSpend, outputIndex }) {
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw keyStructureError('KEY_STRUCTURE_INDEX_INVALID', `outputIndex ${outputIndex}`)
  }
  const secretScalar = scalarFromHexLE(secret)
  const rPoint = P.fromHex(canonicalPointHex(publicKey, 'KEY_STRUCTURE_POINT_INVALID'))
  const spendPoint = P.fromHex(canonicalPointHex(publicSpend, 'KEY_STRUCTURE_POINT_INVALID'))
  // Mandatory cofactor-8 (pinned crypto.cpp generate_key_derivation); @noble
  // multiply() does not cofactor-clear.
  const derivation = rPoint.multiply(secretScalar).double().double().double().toRawBytes()
  const digest = Buffer.from(keccak256(
    Buffer.concat([Buffer.from(derivation), encodeVarint(outputIndex)])
  ), 'hex')
  let h = 0n
  for (let i = 31; i >= 0; i--) h = (h << 8n) | BigInt(digest[i])
  h %= CURVE_N
  const base = h === 0n ? P.ZERO : P.BASE.multiply(h)
  return base.add(spendPoint).toHex()
}

/**
 * Public part of the tx key a sender publishes for one destination:
 * standard/change destinations use r*G, subaddress destinations use r*B
 * (recipient public spend key). Passing `null` selects the standard form.
 * @param {bigint} secretScalar r or r_i
 * @param {string|null} recipientSpendKeyHex
 * @returns {string} 64-hex public key
 */
export function senderPublicPart (secretScalar, recipientSpendKeyHex = null) {
  if (typeof secretScalar !== 'bigint' || !(secretScalar > 0n && secretScalar < CURVE_N)) {
    throw keyStructureError('SECRET_SCALAR_INVALID', 'scalar is outside 0 < s < curve order')
  }
  if (recipientSpendKeyHex === null) return publicKeyForScalar(secretScalar)
  return P.fromHex(canonicalPointHex(recipientSpendKeyHex, 'KEY_STRUCTURE_POINT_INVALID'))
    .multiply(secretScalar)
    .toHex()
}

function readRecipient (recipient, index) {
  if (!recipient || typeof recipient !== 'object' ||
    !isHex64(recipient.viewKey) || !isHex64(recipient.spendKey) ||
    typeof recipient.subaddress !== 'boolean') {
    throw keyStructureError('KEY_STRUCTURE_INPUT_INVALID', `recipients[${index}]`)
  }
  canonicalPointHex(recipient.viewKey, 'KEY_STRUCTURE_POINT_INVALID')
  canonicalPointHex(recipient.spendKey, 'KEY_STRUCTURE_POINT_INVALID')
  return recipient
}

function readOwnedTarget (target, index) {
  if (!target || typeof target !== 'object' ||
    !isHex64(target.publicSpendKey) || typeof target.privateViewKey !== 'string') {
    throw keyStructureError('KEY_STRUCTURE_INPUT_INVALID', `owned[${index}]`)
  }
  canonicalPointHex(target.publicSpendKey, 'KEY_STRUCTURE_POINT_INVALID')
  return target
}

/**
 * Classify every raw output of the audited transaction from the SENDER'S
 * secrets and PUBLIC key material only — never recipients' private keys.
 *
 * Per output i (with slot secret s_i = additional secret i when additional
 * keys exist, else the main secret; slot key = additional[i] when present,
 * else the main key):
 *   - OWNED first: the receiver a*R path over candidate tx pub keys
 *     (main, additional[i]) against each owned target (change/own address)
 *     — the independent key-structure confirmation of the scan-derived
 *     owned rows.
 *   - EXTERNAL otherwise: sender path. The slot key must equal the pinned
 *     public part (r_i*B for subaddress destinations, r_i*G for
 *     standard/change) AND the one-time key must equal
 *     Hs(8*r_i*A || i)*G + B for the recipient's PUBLIC (view, spend) pair.
 *
 * A single-output tx paying one subaddress may carry the main key as r*B
 * (handled by the same public-part rule with keySource 'main').
 *
 * Unrecognized outputs yield `association: null` — the caller refuses them
 * (amount-aware dummy-output policy is the verifier's decision, not guessed
 * validity here). Ambiguity (one output matching multiple associations)
 * throws KEY_PUBLIC_STRUCTURE_UNSUPPORTED.
 *
 * @param {{
 *   bundle: { mainSecretHex: string, additionalSecretHexes: string[] },
 *   txExtraKeys: { main: string, additional: string[] },
 *   outputKeys: string[],
 *   recipients: Array<{ viewKey: string, spendKey: string, subaddress: boolean }>,
 *   owned?: Array<{ publicSpendKey: string, privateViewKey: string }>
 * }} args
 * @returns {Array<{ outputIndex: number, association:
 *   { kind: 'external', recipientIndex: number, keySource: 'main'|'additional' } |
 *   { kind: 'owned', ownedIndex: number, keySource: 'main'|'additional' } |
 *   null }>} ordered by outputIndex
 */
export function classifyOutputKeys ({ bundle, txExtraKeys, outputKeys, recipients, owned = [] }) {
  bundleOf(bundle)
  if (!txExtraKeys || typeof txExtraKeys !== 'object' ||
    !isHex64(txExtraKeys.main) || !Array.isArray(txExtraKeys.additional)) {
    throw keyStructureError('EXTRA_TYPE', 'txExtraKeys must be parseTxExtraStrict output')
  }
  if (!Array.isArray(outputKeys) || outputKeys.length === 0 ||
    !outputKeys.every(key => isHex64(key))) {
    throw keyStructureError('KEY_STRUCTURE_OUTPUT_KEYS_INVALID', 'outputKeys must be non-empty 64-hex keys')
  }
  if (!Array.isArray(recipients)) {
    throw keyStructureError('KEY_STRUCTURE_INPUT_INVALID', 'recipients must be an array')
  }
  if (!Array.isArray(owned)) {
    throw keyStructureError('KEY_STRUCTURE_INPUT_INVALID', 'owned must be an array')
  }
  const { main, additional } = txExtraKeys
  if (additional.length !== 0 && additional.length !== outputKeys.length) {
    throw keyStructureError(
      'EXTRA_OUTPUT_COUNT_MISMATCH',
      `${additional.length} additional keys vs ${outputKeys.length} outputs`
    )
  }
  if (additional.length !== bundle.additionalSecretHexes.length) {
    throw keyStructureError(
      'KEY_BUNDLE_LENGTH',
      `bundle advertises ${bundle.additionalSecretHexes.length} additional secrets, extra carries ${additional.length}`
    )
  }
  recipients.forEach(readRecipient)
  owned.forEach(readOwnedTarget)

  const useAdditional = additional.length > 0
  // NOTE: there is deliberately no blanket equality check between the bundle
  // publics (r_i*G) and the extra's additional keys — subaddress destinations
  // publish r_i*B instead, so the correspondence is enforced per output by the
  // kind-aware public-part rule below (never guessed, only exact matches pass).

  const rows = []
  for (let outputIndex = 0; outputIndex < outputKeys.length; outputIndex++) {
    const outputKey = outputKeys[outputIndex]
    const keySource = useAdditional ? 'additional' : 'main'
    const slotSecret = useAdditional
      ? scalarFromHexLE(bundle.additionalSecretHexes[outputIndex])
      : scalarFromHexLE(bundle.mainSecretHex)
    const slotKey = useAdditional ? additional[outputIndex] : main
    const candidates = []

    // Owned/change first (receiver a*R path over the candidate tx pub keys).
    for (let ownedIndex = 0; ownedIndex < owned.length; ownedIndex++) {
      const target = owned[ownedIndex]
      for (const candidateKey of txPublicKeysForOutput(txExtraKeys, outputIndex)) {
        const expected = oneTimeOutputKey({
          publicKey: candidateKey,
          secret: target.privateViewKey,
          publicSpend: target.publicSpendKey,
          outputIndex
        })
        if (expected === outputKey) {
          candidates.push({
            kind: 'owned',
            ownedIndex,
            keySource: candidateKey === main ? 'main' : 'additional'
          })
          break
        }
      }
    }

    if (candidates.length === 0) {
      // External: sender secrets + recipient PUBLIC keys only. The slot key
      // must equal the pinned public part for the destination kind.
      for (let recipientIndex = 0; recipientIndex < recipients.length; recipientIndex++) {
        const recipient = recipients[recipientIndex]
        const expectedSlot = senderPublicPart(slotSecret, recipient.subaddress ? recipient.spendKey : null)
        if (expectedSlot !== slotKey) continue
        const expected = oneTimeOutputKey({
          publicKey: recipient.viewKey,
          secret: useAdditional ? bundle.additionalSecretHexes[outputIndex] : bundle.mainSecretHex,
          publicSpend: recipient.spendKey,
          outputIndex
        })
        if (expected === outputKey) {
          candidates.push({ kind: 'external', recipientIndex, keySource })
        }
      }
    }

    if (candidates.length > 1) {
      throw keyStructureError(
        'KEY_PUBLIC_STRUCTURE_UNSUPPORTED',
        `output ${outputIndex} matches ${candidates.length} conflicting associations`
      )
    }
    rows.push({ outputIndex, association: candidates.length === 1 ? candidates[0] : null })
  }
  return rows
}
