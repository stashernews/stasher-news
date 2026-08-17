// Client-side guard for the Web Push VAPID public key. The browser throws an
// opaque InvalidAccessError ("The provided applicationServerKey is not valid")
// when pushManager.subscribe receives an empty or malformed key, so this
// module validates the configured key BEFORE subscribe is ever called and
// returns a human-readable failure reason (or null when all is well).
// NEXT_PUBLIC_VAPID_PUBKEY is statically inlined by Next at build time; it is
// read at call time so the guard is trivially unit-testable.

export function getPushConfigError () {
  const pubkey = process.env.NEXT_PUBLIC_VAPID_PUBKEY
  if (!pubkey) return 'push notifications are not configured on this server'
  try {
    // base64url -> binary: - and _ are the url-safe alphabet, atob wants + and /
    const b64 = pubkey.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    // uncompressed P-256 public key: 65 bytes, first byte 0x04
    if (decoded.length !== 65 || decoded[0] !== 4) {
      return 'the push public key configured on this server is invalid'
    }
  } catch {
    return 'the push public key configured on this server is invalid'
  }
  return null
}
