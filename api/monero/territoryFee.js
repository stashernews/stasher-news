// Territory fee math (spec §6.2). Pure (no Prisma, no lexical) so it is
// unit-testable. The territory payIn types consume this to build the rewards-wallet
// fee URI; the penaltyIndexer observes the fee and flips Sub.billingStatus to PAID.
//
// §6.2: monthly 0.2 XMR (2e11 piconeros), yearly 2 XMR (2e12), once 10 XMR (1e13).

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
