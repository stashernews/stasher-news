import { randomBytes } from 'node:crypto'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'

// Integrated-address encoder for Monero payment-ID-based tip attribution
// (spec §4.2). A tip is attributed by encoding a unique 8-byte payment ID into
// an integrated address derived from the author's primary address.
//
// Layout (77 bytes):
//   [0]     network byte (primary + 1: mainnet 0x12->0x13, stagenet 0x18->0x19)
//   [1:33]  public spend key
//   [33:65] public view key
//   [65:73] 8-byte payment ID
//   [73:77] keccak-256 checksum (first 4 bytes of keccak_256(bytes[0:73]))
//
// Pure function — no network calls. Mirrors the encoding XMRChat uses.

export function makeIntegratedAddress (primaryAddressBase58, paymentIdHex = '') {
  const primaryAddress = base58xmr.decode(primaryAddressBase58)
  const network = primaryAddress.slice(0, 1)
  const publicSpendKey = primaryAddress.slice(1, 33)
  const publicViewKey = primaryAddress.slice(33, 65)

  const paymentId = paymentIdHex
    ? hexToBytes(paymentIdHex)
    : randomBytes(8)

  const integrated = new Uint8Array(77)
  integrated[0] = network[0] + 1
  integrated.set(publicSpendKey, 1)
  integrated.set(publicViewKey, 33)
  integrated.set(paymentId, 65)

  const checksum = hexToBytes(keccak256(integrated.slice(0, 73)))
  integrated.set(checksum.slice(0, 4), 73)

  return {
    integratedAddress: base58xmr.encode(integrated),
    paymentId: Buffer.from(paymentId).toString('hex')
  }
}

function hexToBytes (hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}
