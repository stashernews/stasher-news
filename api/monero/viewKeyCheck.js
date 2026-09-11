import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'

// View-key ↔ address pairing check for wallet registration.
//
// monero-ts isValidPrivateViewKey is FORMAT-ONLY: it accepts any 64-hex
// string, so a pasted PUBLIC view key (or random garbage) registers
// successfully and the account silently never detects a single incoming
// transfer. This classifier pairs the candidate view key with the address:
//
//   'ok'        derives to the address's public view key (a real pair)
//   'public'    the pasted value IS the address's public view key
//   'mismatch'  a valid private view key, but from a different wallet
//   'invalid'   64-hex but not a valid private scalar (1 <= n < l) — most
//               likely the public view key of some OTHER wallet
//   'malformed' not 64-hex
//
// The caller (resolver) validates the address with monero-ts full wasm
// validation BEFORE calling this — base58xmr.decode here is byte extraction
// only (bytes[33:65], the embedded public view key); it does NOT verify the
// Monero checksum, and no checksum is checked in this module.
//
// Monero keys are edwards25519: public = scalarmultBase(private) with the
// 32-byte scalar read little-endian (verified against monero-ts-derived
// pairs). @noble enforces 1 <= n < l and throws otherwise — exactly
// Monero's sc_check for private keys.

// The address embeds the public view key at bytes 33..65 (base58-decoded).
// Publishing it is safe: it is already derivable from the address and cannot
// decode transaction amounts.
export function publicViewKeyFromAddress (address) {
  return Buffer.from(base58xmr.decode(address).slice(33, 65)).toString('hex')
}

export function classifyViewKey (address, viewKeyHex) {
  if (typeof viewKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(viewKeyHex)) return 'malformed'
  const vk = viewKeyHex.toLowerCase()
  let pubFromAddress = null
  try {
    pubFromAddress = publicViewKeyFromAddress(address)
  } catch {
    // The caller pre-validates the address, so a decode failure here is not
    // a crypto verdict — surface it as a pairing failure.
    return 'mismatch'
  }
  if (vk === pubFromAddress) return 'public'
  const bytes = vk.match(/.{2}/g).map(x => parseInt(x, 16))
  const n = BigInt('0x' + Buffer.from(bytes.reverse()).toString('hex'))
  try {
    const derived = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(n).toRawBytes()).toString('hex')
    return derived === pubFromAddress ? 'ok' : 'mismatch'
  } catch {
    return 'invalid'
  }
}
