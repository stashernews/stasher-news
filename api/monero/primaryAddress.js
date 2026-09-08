import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'

// Primary-address screening for wallet registration.
//
// monero-lws's admin REST add_account parses the address with
// cryptonote::get_account_address_from_str, then REJECTS subaddresses and
// integrated (payment-id) addresses with the same error::bad_address as a
// wrong network ("Invalid base58 public address - wrong --network ?",
// src/db/string.cpp). monero-ts isValidAddress accepts all three classes of
// the caller's network, so a same-network integrated/subaddress address
// sails through resolver validation and 500s in lws. This helper mirrors
// lws's exact rule: the decoded network byte must equal the network's
// STANDARD address prefix (cryptonote_config.h
// CRYPTONOTE_PUBLIC_ADDRESS_BASE58_PREFIX).
const STANDARD_PREFIX = { MAINNET: 18, STAGENET: 24, TESTNET: 53 }

// True when `address` decodes (checksum-verified) to a primary address for
// `network` ('MAINNET' | 'STAGENET' | 'TESTNET'). Any decode or checksum
// failure returns false — callers treat false as invalid input.
export function isPrimaryAddress (address, network) {
  const prefix = STANDARD_PREFIX[network]
  if (!prefix || typeof address !== 'string') return false
  let bytes
  try {
    bytes = base58xmr.decode(address)
  } catch {
    return false
  }
  // A primary address is exactly 69 decoded bytes: 1 network byte + 32-byte
  // public spend key + 32-byte public view key + 4-byte checksum.
  if (bytes.length !== 69) return false
  // @scure/base's base58xmr is only a block-width coder — it does NOT verify
  // the 4-byte keccak-256 tail Monero appends, so verify it here the same way
  // integratedAddress.js builds it when encoding (first 4 bytes of
  // keccak_256 over the 65 bytes that precede it).
  const checksum = keccak256(bytes.subarray(0, 65))
  const actual = Buffer.from(bytes.subarray(65)).toString('hex')
  return bytes[0] === prefix && checksum.slice(0, 8) === actual
}
