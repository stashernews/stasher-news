// Posting-fee reputation gate + fee math (spec §6.2, Q5).
//
// A user posts for free only once they have BOTH stacked enough (default 1e10
// piconeros = 0.01 XMR) AND been around long enough (default 7 days). Below
// either threshold the user pays a posting fee to the platform rewards wallet
// (floor 1e9 piconeros = 0.001 XMR) before their post goes live.
//
// Pure (no Prisma, no lexical) so it is unit-testable in isolation. The payIn
// ITEM_CREATE flow consumes these helpers and wires the fee subaddress/URI.

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
