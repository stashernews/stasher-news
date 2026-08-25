// Client-IP extraction for rate limiting. Takes the RIGHTMOST x-forwarded-for
// entry: with exactly one trusted proxy hop (Caddy), the rightmost entry is the
// one the proxy appended — a client-supplied spoof value sits at the FRONT and
// is ignored (audit B-2; the previous first-entry parsers let every request
// mint a fresh rate-limit bucket). Non-string XFF (multiple header lines arrive
// as an array) falls back to the socket address, as does a missing header.
export function clientIp (headers = {}, socketAddress) {
  const fwd = headers['x-forwarded-for']
  if (typeof fwd === 'string') {
    const entries = fwd.split(',').map(s => s.trim()).filter(Boolean)
    if (entries.length > 0) return entries[entries.length - 1]
  }
  return socketAddress || 'unknown'
}
