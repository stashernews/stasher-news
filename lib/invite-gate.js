import { createHmac, timingSafeEqual } from 'node:crypto'
import { secureCookie } from '@/lib/auth'

export const GATE_COOKIE = secureCookie('sn_gate')
export const GATE_COOKIE_TTL_S = 60 * 60 * 24 * 30

// Paths that must stay reachable while the gate is on. '_next' is checked
// BEFORE this list (data fetches get a client-router redirect instead).
const GATE_EXEMPT_PATHS = [
  '/gate',
  '/sw.js',
  '/offline',
  '/404',
  '/500',
  '/_error',
  '/favicon.ico',
  '/.well-known/'
]

// Gate is ON iff SITE_INVITE_CODES holds at least one non-empty code.
export function isGateEnabled () {
  return getGateCodes().length > 0
}

export function getGateCodes () {
  return String(process.env.SITE_INVITE_CODES || '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean)
}

function hmacFor (code) {
  return createHmac('sha256', process.env.NEXTAUTH_SECRET || '')
    .update(code)
    .digest('base64url')
}

// The cookie holds an HMAC of the code — never the code itself.
export function issueGateToken (code) {
  return hmacFor(code)
}

export function verifyGateToken (token) {
  if (typeof token !== 'string' || !token) return false
  for (const code of getGateCodes()) {
    const expected = hmacFor(code)
    if (token.length === expected.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return true
    }
  }
  return false
}

export function gatePasses (req) {
  return verifyGateToken(req?.cookies?.[GATE_COOKIE])
}

/**
 * Gate decision for a single request.
 * 'redirect'      -> HTML document without a valid cookie (307 to /gate)
 * 'data-redirect' -> _next/data fetch without a valid cookie (client-router JSON redirect)
 * 'api-401'       -> /api/graphql without a valid cookie
 * 'pass'          -> everything else
 */
export function shouldGateRequest ({ pathname, cookie }) {
  if (!isGateEnabled()) return 'pass'
  if (verifyGateToken(cookie)) return 'pass'
  if (pathname === '/api/graphql') return 'api-401'
  if (pathname.startsWith('/_next/data/')) return 'data-redirect'
  if (GATE_EXEMPT_PATHS.some(p => pathname === p || pathname.startsWith(p))) return 'pass'
  return 'redirect'
}

// Only same-origin relative paths are allowed as a return target (open-redirect guard).
export function sanitizeNext (next) {
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')) return next
  return '/'
}
