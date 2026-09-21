// Turf-owner fee routing (2026-08-21 turf-owner-revenue design).
//
// A posting/comment fee routes OWNER-DIRECT (one payment, 100% to the
// turf owner's registered wallet via a fee: payment-ID leg) iff:
//   - the TURF_OWNER_FEES=1 env gate is set,
//   - no upload fees are folded into the payment (media cost stays platform),
//   - the fee resolves to exactly ONE non-owned turf (posts: the target turf;
//     comments: the root post's turfs),
//   - that turf is NOT owned by the platform account (USER_ID.stasher — the
//     seeded default turfs are platform-owned and never billed, so their fees
//     belong to the rewards pool, not a personal wallet), and
//   - that turf's owner has a registered MoneroAccount.
// Everything else keeps today's rewards-wallet subaddress routing. BOOSTS are
// platform-only since R08 (2026-09-21): the boost owner-direct leg was removed
// after an item author round-tripped boost money to a colluding turf owner
// while buying rank — see api/payIn/types/boost.js.

import { postingFeePiconeros, commentFeePiconeros } from '@/api/monero/postingFee'
import { USER_ID } from '@/lib/constants'

export function turfOwnerFeesEnabled () {
  return process.env.TURF_OWNER_FEES === '1'
}

// Static ceiling — mirrors the yup bound in lib/validate.js. Used when the
// runtime config row is unavailable.
export const MAX_TURF_PREMIUM_PICONEROS = 10_000_000_000n

export function premiumPiconeros (config, sub, kind) {
  // Flag-gated on READ (the write path force-zeroes via zeroPremiumsIfDormant,
  // but a mid-flight kill-switch toggle must also stop charging premiums at
  // quote time — otherwise users pay "owner premiums" that route to the
  // platform wallet) and clamped to the operator's maxTurfPremiumPiconeros.
  if (!turfOwnerFeesEnabled()) return 0n
  const raw = sub?.[`${kind}PremiumPiconeros`]
  if (raw == null) return 0n
  const cap = BigInt(config?.maxTurfPremiumPiconeros ?? MAX_TURF_PREMIUM_PICONEROS)
  const value = BigInt(raw)
  return value > cap ? cap : value
}

/** Post fee = Σ over non-owned turfs of (floor + that turf's post premium). */
export function postFeePiconerosForSubs (config, nonOwnedSubs) {
  return nonOwnedSubs.reduce(
    (acc, s) => acc + postingFeePiconeros(config) + premiumPiconeros(config, s, 'post'), 0n)
}

/**
 * Comment fee = flat floor + the single non-owned turf's comment premium.
 * Multi-turf roots collect no premium (no single owner to pay).
 */
export function commentFeePiconerosForSubs (config, nonOwnedSubs) {
  const premium = nonOwnedSubs.length === 1 ? premiumPiconeros(config, nonOwnedSubs[0], 'comment') : 0n
  return commentFeePiconeros(config) + premium
}

/** Floor-only variants: what a platform-wallet FALLBACK charges. Owner
 * premiums are the owner's surcharge — they are never charged when the
 * payment would land in the platform rewards wallet (cross-posts,
 * wallet-less owners, feature off). */
export function postFloorPiconerosForSubs (config, nonOwnedSubs) {
  return nonOwnedSubs.reduce((acc, _s) => acc + postingFeePiconeros(config), 0n)
}

export function commentFloorPiconerosForSubs (config, nonOwnedSubs) {
  return commentFeePiconeros(config)
}

export async function resolveOwnerFeeRouteForSub (models, subName) {
  const sub = await models.sub.findUnique({ where: { name: subName } })
  if (!sub) return null
  // Platform-owned turfs (the seeded defaults: bounties, bitcoin, crypto, jobs,
  // memes, monero, stasher, tech — all USER_ID.stasher, billingType ONCE,
  // never billed) never route owner-direct: their fees fund the rewards pool
  // via the rewards-wallet fallback, not a personal wallet. Same for anything
  // later transferred to the platform account.
  if (Number(sub.userId) === USER_ID.stasher) return null
  const ownerAccount = await models.moneroAccount.findFirst({ where: { ownerUserId: sub.userId } })
  if (!ownerAccount) return null
  return { sub, ownerAccount }
}

/**
 * Resolve the fee route for a set of turfs the payer does NOT own.
 * `subs` is the full getSubs result; ownership is filtered here.
 */
export async function resolveOwnerFeeRoute (models, { subs, userId, uploadFeesPiconeros = 0n }) {
  if (!turfOwnerFeesEnabled()) return null
  if (uploadFeesPiconeros > 0n) return null
  const nonOwned = subs.filter(s => Number(s.userId) !== Number(userId))
  if (nonOwned.length !== 1) return null
  return await resolveOwnerFeeRouteForSub(models, nonOwned[0].name)
}
