import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { secureCookie } from '@/lib/auth'
import { logWarn } from '@/lib/logger'

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
  '/.well-known/',
  // document-level assets injected into every page <Head> by _document.js
  // (font preloads + @font-face, apple touch icon). The gate page itself is
  // rendered before the visitor holds a cookie, so these must load without
  // one — otherwise the browser 307s on them and the display font silently
  // falls back to the system stack.
  '/fonts/',
  '/icons/',
  '/apple-touch-icon'
]

// Database hashes cache independently of env codes, so env revocation keeps its
// existing immediate behavior. A failed DB read throws rather than opening a gate.
// NEXTAUTH_SECRET rotation changes code-to-token signing, not stored DB hashes:
// old DB cookies remain valid while old DB codes stop admitting new entrants.
// Operators must revoke and recreate DB codes when rotating that auth secret.
let hashCache = new WeakMap()
let warnedNoEnvCode = false

export function clearGateCache () {
  hashCache = new WeakMap()
}

export function gateTokenHash (token) {
  return createHash('sha256').update(token).digest('hex')
}

export async function getActiveGateHashes (models) {
  models ??= (await import('@/api/models')).default
  const now = Date.now()
  const cache = hashCache
  let entry = cache.get(models)
  if (!entry || now - entry.at >= 60000) {
    const rows = await models.inviteGateCode.findMany({ where: { revokedAt: null }, select: { tokenHash: true } })
    entry = { at: now, hashes: rows.map(row => row.tokenHash) }
    cache.set(models, entry)
  }
  return new Set([...entry.hashes, ...getGateCodes().map(code => gateTokenHash(hmacFor(code)))])
}

export async function isGateEnabled (models) {
  return (await getActiveGateHashes(models)).size > 0
}

export function getGateCodes () {
  return String(process.env.SITE_INVITE_CODES || '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean)
}

function hmacFor (code) {
  const secret = process.env.NEXTAUTH_SECRET
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('NEXTAUTH_SECRET must be set to gate invites (refusing to sign with an empty key)')
  }
  return createHmac('sha256', secret || '')
    .update(code)
    .digest('base64url')
}

// The cookie holds an HMAC of the code — never the code itself.
export function issueGateToken (code) {
  return hmacFor(code)
}

// server-to-server callers (worker jobs, operator scripts) run on the same
// host with the same env, so they can present a real gate cookie — no
// host-based trust decisions anywhere (the Host header is client-controlled)
export function buildGateCookieHeader () {
  const [code] = getGateCodes()
  if (!code) {
    if (!warnedNoEnvCode) {
      logWarn('No env invite code available for server-to-server gate cookie')
      warnedNoEnvCode = true
    }
    return null
  }
  return `${GATE_COOKIE}=${issueGateToken(code)}`
}

export async function verifyGateToken (token, models) {
  if (typeof token !== 'string' || !token) return false
  for (const code of getGateCodes()) {
    const expected = Buffer.from(hmacFor(code))
    const presented = Buffer.from(token)
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      return true
    }
  }
  return (await getActiveGateHashes(models)).has(gateTokenHash(token))
}

export async function gatePasses (req, models) {
  return verifyGateToken(req?.cookies?.[GATE_COOKIE], models)
}

/**
 * Gate decision for a single request.
 * 'redirect'      -> HTML document without a valid cookie (307 to /gate)
 * 'data-redirect' -> _next/data fetch without a valid cookie (client-router JSON redirect)
 * 'api-401'       -> /api/graphql without a valid cookie
 * 'pass'          -> everything else
 */
export async function shouldGateRequest ({ pathname, cookie, models }) {
  if (!await isGateEnabled(models)) return 'pass'
  if (await verifyGateToken(cookie, models)) return 'pass'
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
