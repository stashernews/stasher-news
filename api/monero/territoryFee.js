// Territory fee math (spec §6.2). Pure (no Prisma, no lexical) so it is
// unit-testable. The territory payIn types consume this to build the rewards-wallet
// fee URI; the penaltyIndexer observes the fee and flips Sub.billingStatus to PAID.
//
// §6.2: monthly 0.02 XMR (2e10 piconeros), yearly 0.2 XMR (2e11), once 1 XMR (1e12).

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
// comment fee (the posting-fee floor — comments beyond the 15/month freebie
// quota cost the same as a low-rep posting fee).
export async function territoryFeePrivatesFor (models, viewerId) {
  if (!viewerId) return { ...TERRITORY_FEE_PRIVATES_ZERO }
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) return { ...TERRITORY_FEE_PRIVATES_ZERO }
  return {
    territoryMonthlyPiconeros: config.territoryMonthlyPiconeros,
    territoryYearlyPiconeros: config.territoryYearlyPiconeros,
    territoryOncePiconeros: config.territoryOncePiconeros,
    commentFeePiconeros: config.postingFeeFloorPiconeros
  }
}
