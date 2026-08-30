// Recovery-phrase auth: 12-word BIP39 phrase, client-side key derivation,
// Ed25519 challenge-response. The phrase and its private key never leave the
// browser; only the public key and one-time signatures are transmitted.
// Deliberately wallet-incompatible: seed = sha256(bip39 entropy) is OUR
// derivation (no BIP32/SLIP-32 steps), so this phrase is meaningless to
// wallet tooling and wallet seeds derive keys that match no account here.
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { sha256 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export const WORD_COUNT = 12

// lowercase, trim, collapse whitespace — before any validation or derivation
export function normalizePhrase (input) {
  return String(input ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean).join(' ')
}

// null when valid; otherwise { index?, message } with a 1-based word position
// when a specific word is bad, or a checksum-level { message }
export function phraseError (input) {
  const mnemonic = normalizePhrase(input)
  const words = mnemonic.split(' ').filter(Boolean)
  if (words.length === 0) return { message: 'enter your 12-word recovery phrase' }
  if (words.length !== WORD_COUNT) {
    return { message: `expected ${WORD_COUNT} words, got ${words.length}` }
  }
  for (let i = 0; i < words.length; i++) {
    if (!wordlist.includes(words[i])) {
      return { index: i + 1, message: `word ${i + 1} is not in the wordlist` }
    }
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    return { message: 'invalid phrase checksum. a word may be mistyped or out of order' }
  }
  return null
}

export function generatePhrase () {
  return generateMnemonic(wordlist, 128)
}

// deterministic: same phrase => same keypair. seed = sha256(bip39 entropy)
export function phraseKeypair (input) {
  const mnemonic = normalizePhrase(input)
  const seed = sha256(mnemonicToEntropy(mnemonic, wordlist))
  return {
    pubkey: bytesToHex(ed25519.getPublicKey(seed)),
    signChallenge: (k1Hex) => bytesToHex(ed25519.sign(hexToBytes(k1Hex), seed))
  }
}

// stateless proof check, safe on server and client
export function verifyChallengeSignature ({ k1, pubkey, sig }) {
  try {
    return ed25519.verify(hexToBytes(sig), hexToBytes(k1), hexToBytes(pubkey))
  } catch {
    return false
  }
}

export function phraseFingerprint (pubkey) {
  return String(pubkey ?? '').slice(0, 8)
}
