// Cake Wallet / Monerujo send URI scheme, verified against
// docs.cakewallet.com/faq/glossary/uri-scheme.md :
//   monero:<address>?tx_amount=<decimal-XMR>&tx_description=<...>
// tx_amount is parsed by wallets as DECIMAL XMR (not atomic units), so we convert
// the project's internal BigInt piconeros to an XMR decimal string here.
//
// Piconeros = 1e-12 XMR. All internal monetary columns are BigInt piconeros; the
// URI boundary is the one place we render them as a human/wallet decimal string.

const PICONEROS_PER_XMR = 10n ** 12n

/** BigInt piconeros -> decimal XMR string (trimmed of trailing zeros). */
export function piconerosToXmrDecimal (piconeros) {
  if (typeof piconeros !== 'bigint') throw new Error('piconerosToXmrDecimal: amount must be a BigInt')
  const neg = piconeros < 0n
  const n = neg ? -piconeros : piconeros
  const whole = n / PICONEROS_PER_XMR
  const frac = n % PICONEROS_PER_XMR
  let s
  if (frac === 0n) {
    s = whole.toString()
  } else {
    const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '')
    s = `${whole.toString()}.${fracStr}`
  }
  return (neg ? '-' : '') + s
}

// base58 Monero address charset. The Monero base58 alphabet is the standard
// Bitcoin-style set: 1-9 (no 0), A-Z (no I/O), a-z (no l). Primary addresses are
// 95 chars; integrated addresses (with an embedded payment ID) are 106 chars.
// The network byte determines the leading char (mainnet '4'/'8', stagenet '5'),
// but the body may contain any base58 char — so we validate the full charset,
// not just the prefix.
export const MONERO_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/

/**
 * Build a monero: payment URI.
 *
 * destinations: [{ address, amount: BigInt(piconeros) }].
 * options: { description?, recipientName?, paymentId? }.
 *
 * Monero wallets deep-link a SINGLE destination only; >1 destination throws
 * (emit one URI per destination instead). This keeps the signature multi-ready
 * for future 2-output tips without producing URIs wallets can't open.
 */
export function buildMoneroUri (destinations, options = {}) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error('buildMoneroUri: destinations must be a non-empty array')
  }
  if (destinations.length > 1) {
    throw new Error('buildMoneroUri: multi-destination monero URIs are not supported by Monero wallets — emit one URI per destination')
  }
  const { address, amount } = destinations[0]
  if (typeof address !== 'string' || !MONERO_ADDR_RE.test(address)) {
    throw new Error('buildMoneroUri: invalid Monero address')
  }
  if (typeof amount !== 'bigint') {
    throw new Error('buildMoneroUri: amount must be a BigInt piconeros')
  }
  const params = new URLSearchParams()
  params.set('tx_amount', piconerosToXmrDecimal(amount))
  if (options.description) params.set('tx_description', options.description)
  if (options.recipientName) params.set('recipient_name', options.recipientName)
  if (options.paymentId) params.set('tx_payment_id', options.paymentId)
  return `monero:${address}?${params.toString()}`
}
