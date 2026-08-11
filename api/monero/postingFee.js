// Posting-fee reputation gate + fee math (spec §6.2, Q5).
//
// A user posts for free only once they have BOTH stacked enough (default 1e10
// piconeros = 0.01 XMR) AND been around long enough (default 7 days). Below
// either threshold the user pays a posting fee to the platform rewards wallet
// (floor 1e9 piconeros = 0.001 XMR) before their post goes live.
//
// Pure (no Prisma, no lexical) so it is unit-testable in isolation. The payIn
// ITEM_CREATE flow consumes these helpers and wires the fee subaddress/URI.

import { FREE_COMMENTS_LOW_REP, FREE_COMMENTS_PER_MONTH, FREE_POSTS_PER_MONTH } from '@/lib/constants'

const DAY_MS = 86_400_000

/** True iff the user meets BOTH the stacked-Piconeros and age-day thresholds. */
export function canPostFree (user, config) {
  const ageDays = (Date.now() - user.createdAt.getTime()) / DAY_MS
  return user.stackedPiconeros >= config.freePostThresholdPiconeros &&
    ageDays >= config.freePostMinAgeDays
}

/** The posting fee for a low-rep user, in piconeros (the platform-wide floor). */
export function postingFeePiconeros (config) {
  return config.postingFeeFloorPiconeros
}

/** Monthly free-comment quota for the user's current tier (5 low-rep, 15 established). */
export function freeCommentsQuota (user, config) {
  if (!user) return 0
  return canPostFree(user, config) ? FREE_COMMENTS_PER_MONTH : FREE_COMMENTS_LOW_REP
}

/** Monthly free-post quota (5 established, 0 low-rep — low-rep users pay per post). */
export function freePostsQuota (user, config) {
  if (!user) return 0
  return canPostFree(user, config) ? FREE_POSTS_PER_MONTH : 0
}

/**
 * How many free comments the user has left this month (resets monthly).
 * `config` selects the tier via `canPostFree`; until all callers pass it
 * (Tasks 3/4 update itemCreate + the user resolver), the no-config call
 * preserves the pre-tier 15-flat behavior as a behavioral bridge.
 */
export function commentsFreeLeft (user, config) {
  if (!user) return 0
  const quota = config ? freeCommentsQuota(user, config) : FREE_COMMENTS_PER_MONTH
  if (user.freeCommentResetAt && new Date() >= new Date(user.freeCommentResetAt)) {
    return quota
  }
  return Math.max(0, quota - (user.freeCommentCount || 0))
}

/** How many free posts the user has left this month (0 for low-rep). */
export function postsFreeLeft (user, config) {
  if (!user) return 0
  if (user.freePostResetAt && new Date() >= new Date(user.freePostResetAt)) {
    return freePostsQuota(user, config)
  }
  return Math.max(0, freePostsQuota(user, config) - (user.freePostCount || 0))
}

// Resolver-facing bundle for UserPrivates.postingFeeRequired /
// postingFeePiconeros / freePostThresholdPiconeros / freePostMinAgeDays.
// Self-view only: other viewers and logged-out requests see no-fee values and
// zeroed thresholds. Fetches the fee config itself; never throws.
export const POSTING_FEE_NO_FEE = {
  postingFeeRequired: false,
  postingFeePiconeros: 0n,
  freePostThresholdPiconeros: 0n,
  freePostMinAgeDays: 0
}

export async function postingFeePrivatesFor (models, user, viewerId) {
  if (!viewerId || viewerId !== user.id) {
    return { ...POSTING_FEE_NO_FEE }
  }
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return { ...POSTING_FEE_NO_FEE }
  const frontend = {
    freePostThresholdPiconeros: config.freePostThresholdPiconeros,
    freePostMinAgeDays: config.freePostMinAgeDays
  }
  if (canPostFree(user, config)) {
    return { ...POSTING_FEE_NO_FEE, ...frontend }
  }
  return { ...POSTING_FEE_NO_FEE, postingFeeRequired: true, postingFeePiconeros: postingFeePiconeros(config), ...frontend }
}
