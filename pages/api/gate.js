import * as cookie from 'cookie'
import { cookieOptions } from '@/lib/auth'
import { safeEqual } from '@/lib/domains/auth'
import {
  GATE_COOKIE, GATE_COOKIE_TTL_S, getGateCodes, isGateEnabled,
  issueGateToken, sanitizeNext
} from '@/lib/invite-gate'

export async function handleGate (req, res) {
  // gate off -> the endpoint does not exist
  if (!isGateEnabled()) return res.status(404).json({ error: 'not found' })

  const { code, next } = req.body || {}
  const redirectTo = sanitizeNext(next)

  // timing-safe, case-sensitive match against the current code list
  const match = getGateCodes().find(gateCode => safeEqual(code, gateCode))
  if (!match) return res.status(401).json({ error: 'invalid invite code' })

  res.setHeader('Set-Cookie',
    cookie.serialize(GATE_COOKIE, issueGateToken(match), cookieOptions({ req, maxAge: GATE_COOKIE_TTL_S })))
  return res.status(200).json({ next: redirectTo })
}

export default async function handler (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  return handleGate(req, res)
}
