// Turf-owner fee routing (2026-08-21 turf-owner-revenue design).
//
// A posting/comment fee or boost routes OWNER-DIRECT (one payment, 100% to the
// turf owner's registered wallet via a fee: payment-ID leg) iff:
//   - the TURF_OWNER_FEES=1 env gate is set,
//   - no upload fees are folded into the payment (media cost stays platform),
//   - the fee resolves to exactly ONE non-owned turf (posts: the target turf;
//     comments: the root post's turfs; boosts: the item's single turf), and
//   - that turf's owner has a registered MoneroAccount.
// Everything else keeps today's rewards-wallet subaddress routing.

import { postingFeePiconeros } from '@/api/monero/postingFee'

export function turfOwnerFeesEnabled () {
  return process.env.TURF_OWNER_FEES === '1'
}

export function premiumPiconeros (sub, kind) {
  const raw = sub?.[`${kind}PremiumPiconeros`]
  return raw == null ? 0n : BigInt(raw)
}

/** Post fee = Σ over non-owned turfs of (floor + that turf's post premium). */
export function postFeePiconerosForSubs (config, nonOwnedSubs) {
  return nonOwnedSubs.reduce(
    (acc, s) => acc + postingFeePiconeros(config) + premiumPiconeros(s, 'post'), 0n)
}

/**
 * Comment fee = flat floor + the single non-owned turf's comment premium.
 * Multi-turf roots collect no premium (no single owner to pay).
 */
export function commentFeePiconerosForSubs (config, nonOwnedSubs) {
  const premium = nonOwnedSubs.length === 1 ? premiumPiconeros(nonOwnedSubs[0], 'comment') : 0n
  return postingFeePiconeros(config) + premium
}

export async function resolveOwnerFeeRouteForSub (models, subName) {
  const sub = await models.sub.findUnique({ where: { name: subName } })
  if (!sub) return null
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
