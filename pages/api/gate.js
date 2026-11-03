import * as cookie from 'cookie'
import { cookieOptions } from '@/lib/auth'
import defaultModels from '@/api/models'
import {
  GATE_COOKIE, GATE_COOKIE_TTL_S, gatePasses, isGateEnabled,
  issueGateToken, verifyGateToken, sanitizeNext
} from '@/lib/invite-gate'

export async function handleGate (req, res, models = defaultModels) {
  // gate off -> the endpoint does not exist
  if (!await isGateEnabled(models)) return res.status(404).json({ error: 'not found' })

  const { code, next } = req.body || {}
  const redirectTo = sanitizeNext(next)

  const token = typeof code === 'string' && code ? issueGateToken(code) : null
  if (!await verifyGateToken(token, models)) return res.status(401).json({ error: 'invalid invite code' })

  res.setHeader('Set-Cookie',
    cookie.serialize(GATE_COOKIE, token, cookieOptions({ req, maxAge: GATE_COOKIE_TTL_S })))
  return res.status(200).json({ next: redirectTo })
}

// Lets the gate page verify the cookie it just asked for actually took before
// navigating: if the browser rejected or lost it, the user would otherwise be
// silently bounced right back to /gate with no explanation.
export async function handleGateCheck (req, res, models = defaultModels) {
  if (!await isGateEnabled(models)) return res.status(404).json({ error: 'not found' })
  return res.status(200).json({ ok: await gatePasses(req, models) })
}

export default async function handler (req, res) {
  if (req.method === 'GET') return handleGateCheck(req, res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  return handleGate(req, res)
}
