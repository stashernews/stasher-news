// Lightning zap receipts (NIP-57) disabled - Monero payments not yet implemented
export async function nip57 ({ data: { hash }, boss, lnd, models }) {
  // Monero payments do not support NIP-57 zap receipts
  // Placeholder for Phase 5 when we might implement Nostr tips via Monero
  return
}