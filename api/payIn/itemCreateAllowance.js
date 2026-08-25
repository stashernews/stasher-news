import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'
import { GqlInputError } from '@/lib/error'
import { USER_ID } from '@/lib/constants'

// Item-creation abuse gate (audit A-3, pre-open-beta blocker 1).
//
// Every fee-required createItem ATTEMPT permanently reserves one fee-pool
// subaddress (api/monero/feePool.js — ASSIGN-never-freed), so an unthrottled
// attempt loop exhausts the finite pools (~2000 posting / ~200 others) and
// takes down all fee-gated posting for everyone. With the auto top-up worker
// active the same loop instead forces unbounded SubaddressIndex growth and a
// widening lws scan range. The fee-pool top-up (FEE_POOL_TOPUP_THRESHOLD) is
// NOT a defense — attempts are throttled here.
//
// Three limits, mirroring the initiateTipCore/upload patterns:
//   - per-IP attempt throttle for everyone (covers anon + scripted signup);
//   - anonymous callers additionally get a low hourly bucket (they pay the
//     highest fees and can never clear the pending cap by paying);
//   - authenticated users additionally get a DB-backed cap on concurrent
//     PENDING_FEE items (mirrors the 20-pending-tips cap in initiateTipCore).
//
// All limits are env-overridable (audit follow-up #4): this site's audience
// concentrates on VPN/CGNAT egress where many users share an IP, so ops needs
// a no-deploy escape hatch for false positives — same idiom as the email
// limits in lib/auth-send-limiter.js.
export const ATTEMPTS_PER_IP = Number(process.env.ITEM_CREATE_ATTEMPTS_PER_IP) || 30
export const IP_WINDOW_MS = Number(process.env.ITEM_CREATE_IP_WINDOW_MS) || 10 * 60_000
export const ANON_ATTEMPTS_PER_HOUR = Number(process.env.ITEM_CREATE_ANON_ATTEMPTS_PER_HOUR) || 5
export const MAX_PENDING_FEE_ITEMS = Number(process.env.ITEM_CREATE_MAX_PENDING_FEE_ITEMS) || 5

export async function assertItemCreateAllowance ({ models, me, headers }) {
  const ip = clientIp(headers)
  const ipRl = rateLimit({ key: `itemcreate:${ip}`, limit: ATTEMPTS_PER_IP, windowMs: IP_WINDOW_MS })
  if (!ipRl.allowed) throw new GqlInputError('too many items created, try again shortly')

  const authenticated = me?.id != null && me.id !== USER_ID.anon
  if (authenticated) {
    const pending = await models.item.count({
      where: { userId: Number(me.id), feeStatus: 'PENDING_FEE', deletedAt: null }
    })
    if (pending >= MAX_PENDING_FEE_ITEMS) {
      throw new GqlInputError('too many unpaid items awaiting fees, complete or abandon them first')
    }
  } else {
    const anonRl = rateLimit({ key: `itemcreate-anon:${ip}`, limit: ANON_ATTEMPTS_PER_HOUR, windowMs: 60 * 60_000 })
    if (!anonRl.allowed) throw new GqlInputError('anonymous posting rate limit reached, try again later')
  }
}
