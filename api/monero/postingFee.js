// Posting-fee reputation gate + fee math (spec §6.2, Q5).
//
// A user posts for free only once they have BOTH stacked enough (default 1e10
// piconeros = 0.01 XMR) AND been around long enough (default 7 days). Below
// either threshold the user pays a posting fee to the platform rewards wallet
// (floor 1e9 piconeros = 0.001 XMR) before their post goes live.
//
// Pure (no Prisma, no lexical) so it is unit-testable in isolation. The payIn
// ITEM_CREATE flow consumes these helpers and wires the fee subaddress/URI.

import { buildMoneroUri } from '@/api/monero/uri'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'
import { reentryQuote } from '@/lib/pay-in'
import { FREE_COMMENTS_PER_DAY, FREE_COMMENTS_PER_DAY_LOW_REP, FREE_POSTS_PER_MONTH, FREE_POSTS_LOW_REP } from '@/lib/constants'

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

/** The flat comment/reply fee, in piconeros (operator-tunable, decoupled from
 * the posting floor so comments can be priced below posts). */
export function commentFeePiconeros (config) {
  return config.commentFeePiconeros
}

/** Daily free-comment quota for the user's current tier (1 low-rep, 3 established). */
export function freeCommentsQuota (user, config) {
  if (!user) return 0
  return canPostFree(user, config) ? FREE_COMMENTS_PER_DAY : FREE_COMMENTS_PER_DAY_LOW_REP
}

/** Monthly free-post quota (5 established, 1 low-rep; past it users pay per post). */
export function freePostsQuota (user, config) {
  if (!user) return 0
  return canPostFree(user, config) ? FREE_POSTS_PER_MONTH : FREE_POSTS_LOW_REP
}

/**
 * How many free comments the user has left today (window resets 00:00 UTC).
 */
export function commentsFreeLeft (user, config) {
  if (!user) return 0
  const quota = freeCommentsQuota(user, config)
  if (user.freeCommentResetAt && new Date() >= new Date(user.freeCommentResetAt)) {
    return quota
  }
  return Math.max(0, quota - (user.freeCommentCount || 0))
}

/** How many free posts the user has left this month (1 of the low-rep quota until used). */
export function postsFreeLeft (user, config) {
  if (!user) return 0
  if (user.freePostResetAt && new Date() >= new Date(user.freePostResetAt)) {
    return freePostsQuota(user, config)
  }
  return Math.max(0, freePostsQuota(user, config) - (user.freePostCount || 0))
}

// In-process cache for the PlatformFeeConfig singleton. It changes almost never
// (operator-tunable thresholds/floor), so a 60s TTL is safe and avoids an N+1 on
// hot resolvers (hasWallet renders per user in feeds). After a migration that
// changes it, the cache self-heals within the TTL, and operators restart
// containers anyway.
const FEE_CONFIG_TTL_MS = 60_000
let cachedFeeConfig = null
let cachedFeeConfigAt = 0

export async function getCachedPlatformFeeConfig (models) {
  const now = Date.now()
  if (cachedFeeConfig && now - cachedFeeConfigAt < FEE_CONFIG_TTL_MS) return cachedFeeConfig
  cachedFeeConfig = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  cachedFeeConfigAt = now
  return cachedFeeConfig
}

// Test-only: clears the cache so unit tests with different model mocks don't leak.
export function __resetFeeConfigCacheForTests () {
  cachedFeeConfig = null
  cachedFeeConfigAt = 0
}

// Resolver-facing bundle for UserPrivates.postingFeeRequired /
// postingFeePiconeros / freePostThresholdPiconeros / freePostMinAgeDays.
// Self-view only: other viewers and logged-out requests see no-fee values and
// zeroed thresholds. Fetches the fee config itself; never throws.
export const POSTING_FEE_NO_FEE = {
  postingFeeRequired: false,
  postingFeePiconeros: 0n,
  freePostThresholdPiconeros: 0n,
  freePostMinAgeDays: 0,
  freePostsLeft: 0,
  freePostCount: 0,
  freePostsQuota: 0,
  freeCommentsQuota: 0
}

export async function postingFeePrivatesFor (models, user, viewerId) {
  if (!viewerId || viewerId !== user.id) {
    return { ...POSTING_FEE_NO_FEE }
  }
  const config = await getCachedPlatformFeeConfig(models)
  if (!config) return { ...POSTING_FEE_NO_FEE }
  const postsLeft = postsFreeLeft(user, config)
  const frontend = {
    freePostThresholdPiconeros: config.freePostThresholdPiconeros,
    freePostMinAgeDays: config.freePostMinAgeDays,
    freePostsLeft: postsLeft,
    freePostCount: user.freePostCount || 0,
    freePostsQuota: freePostsQuota(user, config),
    freeCommentsQuota: freeCommentsQuota(user, config)
  }
  // A post requires a fee once the user's free-post quota is exhausted
  // (established 5/month, low-rep 1/month — postsFreeLeft tiers via quota).
  const postingFeeRequired = postsLeft <= 0
  if (!postingFeeRequired) {
    return { ...POSTING_FEE_NO_FEE, ...frontend }
  }
  return {
    ...POSTING_FEE_NO_FEE,
    ...frontend,
    postingFeeRequired: true,
    postingFeePiconeros: postingFeePiconeros(config)
  }
}

// Cumulative fee received on-chain for a fee PayIn, across BOTH observation
// tables: platform-routed legs record FeeObservation rows (rewards-wallet
// subaddresses, observed by rewardsWalletObserver) while owner-routed legs
// record ObservedSubFee rows (fee: payment-ID legs, observed by the lws webhook).
// A PayIn is exactly one or the other, so the sum is the payee's cumulative
// received. Countable states only (DETECTED/CONFIRMED) — REORGED, EXPIRED, and
// refused (EXCLUDED) receipts must not read as payment progress. Drives
// Item.feeReceivedPiconeros (underpayment hint) and itemFeeReentryFunding
// (top-up remainder).
export async function feeReceivedPiconerosForPayIn (models, payInId) {
  const [feeAgg, subFeeAgg] = await Promise.all([
    models.feeObservation.aggregate({
      _sum: { piconeros: true },
      where: { payInId, state: { in: ['DETECTED', 'CONFIRMED'] } }
    }),
    models.observedSubFee.aggregate({
      _sum: { piconeros: true },
      where: { payInId, state: { in: ['DETECTED', 'CONFIRMED'] } }
    })
  ])
  return (feeAgg._sum.piconeros ?? 0n) + (subFeeAgg._sum.piconeros ?? 0n)
}

// Re-entry funding info for a PENDING_FEE item (post OR comment): reuses the fee
// PayIn's reserved subaddress (recovered from its stored monero URI) and quotes
// only the REMAINDER, so a top-up completes the fee instead of re-quoting the
// full original amount after a partial payment. Returns null when there is
// nothing to reuse; the caller falls back to the item's stored URI (a fresh
// submit has nothing received, so the remainder equals the full fee). The
// stored URI is NEVER rewritten — the observer gate (rewardsWalletObserver)
// reads the FULL fee from it, so cumulative received keeps comparing against the
// full amount.
export async function itemFeeReentryFunding (models, item) {
  if (item.feeStatus !== 'PENDING_FEE' || !item.feePayInId) return null
  const payIn = await models.payIn.findUnique({ where: { id: item.feePayInId } })
  if (!payIn) return null
  const address = moneroUriAddress(payIn.moneroUri)
  if (!address) return null
  const expected = moneroUriAmountPiconeros(payIn.moneroUri)
  if (expected == null) return null
  const received = await feeReceivedPiconerosForPayIn(models, payIn.id)
  const { fullyPaid, amount } = reentryQuote(expected, received)
  // Fully observed (received >= expected) but not yet chain-verified enough to
  // flip: there is nothing more to pay. Return the funding info with a null URI
  // so the caller renders the "payment detected — waiting for confirmation"
  // state instead of re-quoting the full fee (2026-09-19 fix: the old
  // `remaining > 0 ? remaining : expected` fallback re-quoted the FULL amount,
  // which the modal showed as "pay 0.0006 again" after a complete payment).
  const moneroUri = fullyPaid
    ? null
    : buildMoneroUri(
      [{ address, amount }],
      { description: `StasherNews ${item.parentId ? 'comment' : 'posting'} fee top-up` }
    )
  return { payIn, moneroUri, fullyPaid, feePiconeros: expected, receivedPiconeros: received, expectedPiconeros: expected }
}
