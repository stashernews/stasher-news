// CJS stand-in for the ESM-only @noble/hashes v2 (type:module) inside jest's
// sandbox, which cannot require ESM (same problem as the uuid shim: see
// test/helpers/uuid-shim.js). Only the specifiers first-party code imports
// are redirected (see jest.config.js); transitive users of @noble/hashes 1.x
// (@noble/curves, @scure/bip39) keep their real dual builds via nested deps.
// sha256 matches noble output byte-for-byte; the hex helpers replicate
// noble's strict validation (throw on malformed input) so error paths,
// including verifyChallengeSignature's catch-and-return-false, stay identical.
const { createHash } = require('node:crypto')

function sha256 (data) {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function bytesToHex (bytes) {
  return Buffer.from(bytes).toString('hex')
}

function hexToBytes (hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error('hex string is invalid')
  }
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

module.exports = { sha256, bytesToHex, hexToBytes }
