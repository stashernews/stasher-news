// Territory fee math (spec §6.2). Pure (no Prisma, no lexical) so it is
// unit-testable. The territory payIn types consume this to build the rewards-wallet
// fee URI; the rewardsWalletObserver observes the fee and flips Sub.billingStatus to PAID.
//
// §6.2: monthly 0.02 XMR (2e10 piconeros), yearly 0.2 XMR (2e11), once 1 XMR (1e12).

import { buildMoneroUri } from '@/api/monero/uri'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'
import { reentryQuote } from '@/lib/pay-in'

const TERRITORY_FEE = {
  MONTHLY: (c) => c.territoryMonthlyPiconeros,
  YEARLY: (c) => c.territoryYearlyPiconeros,
  ONCE: (c) => c.territoryOncePiconeros
}

/** The territory fee for a billing cycle, in piconeros. */
export function territoryFeePiconeros (billingType, config) {
  const fn = TERRITORY_FEE[billingType]
  if (!fn) throw new Error(`territoryFeePiconeros: unknown billingType ${billingType}`)
  return fn(config)
}

export const TERRITORY_FEE_PRIVATES_ZERO = {
  territoryMonthlyPiconeros: 0n,
  territoryYearlyPiconeros: 0n,
  territoryOncePiconeros: 0n,
  commentFeePiconeros: 0n
}

// UserPrivates bundle (self-view only): the live territory fees plus the flat
// comment fee (the commentFeePiconeros config knob — comments beyond the daily
// freebie quota (2/day low-rep, 5/day established) pay this instead of the
// posting floor).
export async function territoryFeePrivatesFor (models, viewerId) {
  if (!viewerId) return { ...TERRITORY_FEE_PRIVATES_ZERO }
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return { ...TERRITORY_FEE_PRIVATES_ZERO }
  return {
    territoryMonthlyPiconeros: config.territoryMonthlyPiconeros,
    territoryYearlyPiconeros: config.territoryYearlyPiconeros,
    territoryOncePiconeros: config.territoryOncePiconeros,
    commentFeePiconeros: config.commentFeePiconeros
  }
}

// Re-entry funding info for a PENDING_FEE turf: reuses the billing PayIn's
// reserved subaddress (recovered from its stored monero URI) and quotes only the
// REMAINDER, so a top-up completes the fee instead of stranding the prior partials
// on an orphaned subaddress (the fresh-mint path would reserve a NEW subaddress
// and re-point billingPayInId — exactly what strands them). Returns null when
// there is nothing to reuse; the caller falls through to the fresh mint. The
// stored URI is NEVER rewritten — the observer gate (attributeFeeBySubaddress)
// reads the FULL fee from it, so cumulative received keeps comparing against the
// full amount.
export async function territoryReentryFunding (models, sub) {
  if (sub.billingStatus !== 'PENDING_FEE' || !sub.billingPayInId) return null
  const payIn = await models.payIn.findUnique({ where: { id: sub.billingPayInId } })
  if (!payIn) return null
  const address = moneroUriAddress(payIn.moneroUri)
  if (!address) return null
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expected = moneroUriAmountPiconeros(payIn.moneroUri) ?? territoryFeePiconeros(sub.billingType, config)
  // Countable states only (review follow-up): REORGED/EXPIRED rows must not
  // read as payment progress — a stale inflated sum would keep fullyPaid true
  // (null URI, "detected" forever) while the flip gate correctly never opens,
  // stranding the turf fee until abandonment.
  const agg = await models.feeObservation.aggregate({
    _sum: { piconeros: true },
    where: { payInId: payIn.id, state: { in: ['DETECTED', 'CONFIRMED'] } }
  })
  const received = agg._sum.piconeros ?? 0n
  const { fullyPaid, amount } = reentryQuote(expected, received)
  // Fully observed but not yet flipped: nothing more to pay — a null URI
  // signals the caller/modal to show "payment detected — waiting for
  // confirmation" instead of re-quoting the full fee OR falling through to a
  // fresh mint (which would strand the paid partials; 2026-09-19 fix).
  const moneroUri = fullyPaid
    ? null
    : buildMoneroUri(
      [{ address, amount }],
      { description: `StasherNews territory ${sub.name} top-up (${sub.billingType})` }
    )
  return { payIn, moneroUri, fullyPaid, feePiconeros: expected, receivedPiconeros: received, expectedPiconeros: expected }
}
