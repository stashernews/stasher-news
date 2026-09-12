import { createHmac } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { UPLOAD_OUTSTANDING_CAP_USER, UPLOAD_OUTSTANDING_CAP_ANON } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'

export const UPLOAD_QUOTA_WINDOW_USER_MS = 7 * 24 * 60 * 60 * 1000
export const UPLOAD_QUOTA_WINDOW_ANON_MS = 24 * 60 * 60 * 1000

// Salted, stable hash of the uploader IP. The salt must NOT rotate freely or
// existing anonymous quotas reset; UPLOAD_IP_SALT is an optional override and
// NEXTAUTH_SECRET is always present in production (validateEnv).
export function hashUploadClientIp (ip) {
  const salt = process.env.UPLOAD_IP_SALT || process.env.NEXTAUTH_SECRET || 'dev-upload-ip-salt'
  return createHmac('sha256', salt).update(String(ip || 'unknown')).digest('hex')
}

// Sums unpaid upload bytes in the window, keyed by userId (logged-in) or
// ipHash (anonymous) — callers pass exactly one key.
export async function outstandingUploadBytes (models, { userId = null, ipHash = null, windowMs }) {
  const key = userId != null
    ? Prisma.sql`"userId" = ${Number(userId)}::INTEGER`
    : Prisma.sql`"ipHash" = ${ipHash}`
  const [row] = await models.$queryRaw`
    SELECT COALESCE(SUM(size), 0)::BIGINT AS bytes
    FROM "Upload"
    WHERE paid = false
      AND ${key}
      AND created_at > NOW() - (${Number(windowMs)}::INTEGER * INTERVAL '1 millisecond')`
  return row?.bytes ?? 0n
}

function toMb (bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(1)
}

// Throws when `size` more outstanding bytes would push the caller over the cap.
// Returns the ipHash for anonymous uploads so the caller can persist it.
export async function assertUploadQuota ({ models, me, ip, size }) {
  const isAnon = !me
  const cap = isAnon ? UPLOAD_OUTSTANDING_CAP_ANON : UPLOAD_OUTSTANDING_CAP_USER
  const windowMs = isAnon ? UPLOAD_QUOTA_WINDOW_ANON_MS : UPLOAD_QUOTA_WINDOW_USER_MS
  const ipHash = isAnon ? hashUploadClientIp(ip) : null
  const used = isAnon
    ? await outstandingUploadBytes(models, { ipHash, windowMs })
    : await outstandingUploadBytes(models, { userId: me.id, windowMs })

  if (used + BigInt(size) > cap) {
    throw new GqlInputError(
      `you have ${toMb(used)} MB of unpaid uploads (limit ${toMb(cap)} MB) — ` +
      'publish or pay for them, or wait for them to expire, before uploading more'
    )
  }
  return { ipHash }
}
