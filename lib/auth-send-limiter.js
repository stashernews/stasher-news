import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

// Magic-code email send throttling (audit B-3). /api/auth/* is deliberately
// NOT invite-gated, so this is the only brake on an unauthenticated attacker
// exhausting the SMTP provider quota (breaking all email login site-wide) or
// mail-bombing arbitrary inboxes from our domain.
//
// Two buckets, both via the shared in-memory limiter:
//   - per-IP burst: catches scripted send floods from one source.
//   - per-identifier cooldown: caps mail to one address; enforced SILENTLY by
//     the caller (resolve without sending — same anti-enumeration posture as
//     the existing signin-cookie/no-user silent drop) so it is not an oracle.
export const AUTH_EMAIL_IP_LIMIT = Number(process.env.AUTH_EMAIL_IP_LIMIT) || 3
export const AUTH_EMAIL_IP_WINDOW_MS = Number(process.env.AUTH_EMAIL_IP_WINDOW_MS) || 15 * 60_000
export const AUTH_EMAIL_IDENTIFIER_LIMIT = Number(process.env.AUTH_EMAIL_IDENTIFIER_LIMIT) || 5
export const AUTH_EMAIL_IDENTIFIER_WINDOW_MS = Number(process.env.AUTH_EMAIL_IDENTIFIER_WINDOW_MS) || 60 * 60_000

export function checkEmailSendAllowance ({ identifier, headers, socketAddress }) {
  const ipRl = rateLimit({
    key: `auth-email-ip:${clientIp(headers, socketAddress)}`,
    limit: AUTH_EMAIL_IP_LIMIT,
    windowMs: AUTH_EMAIL_IP_WINDOW_MS
  })
  if (!ipRl.allowed) return 'ip'

  const key = String(identifier ?? '').trim().toLowerCase()
  const idRl = rateLimit({
    key: `auth-email-id:${key}`,
    limit: AUTH_EMAIL_IDENTIFIER_LIMIT,
    windowMs: AUTH_EMAIL_IDENTIFIER_WINDOW_MS
  })
  if (!idRl.allowed) return 'identifier'

  return null
}
