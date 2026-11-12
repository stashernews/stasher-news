// Curator rewards v2 configuration. Pure, with no Prisma or logger imports,
// so the admin panel can validate edits with the same rules the distributor
// applies.
//
// PlatformFeeConfig.curatorShareFormula selects the formula: LEGACY pays the
// ported earn.js shares, SHADOW pays LEGACY and records V2, V2 pays V2. Any
// invalid V2 parameter fails closed to LEGACY (the caller logs the errors), so
// malformed config can never change payouts.
export const CURATOR_SHARE_FORMULAS = ['LEGACY', 'SHADOW', 'V2']

const isUnitInterval = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

export function resolveCuratorShareConfig (config) {
  const row = config ?? {}
  const formula = row.curatorShareFormula ?? 'LEGACY'
  const params = {
    accuracyExponent: row.curatorAccuracyExponent ?? 0.25,
    amountExponent: row.curatorAmountExponent ?? 0.25,
    minTipPiconeros: row.curatorMinTipPiconeros ?? 200_000_000n,
    capShareBps: row.curatorShareCapBps ?? 2500,
    shadowTrustWeightFloor: row.curatorShadowTrustWeightFloor ?? null,
    minAccountAgeDays: row.curatorMinAccountAgeDays ?? 7
  }

  const errors = []
  if (!CURATOR_SHARE_FORMULAS.includes(formula)) errors.push('formula_invalid')
  if (!isUnitInterval(params.accuracyExponent)) errors.push('accuracyExponent_invalid')
  if (!isUnitInterval(params.amountExponent)) errors.push('amountExponent_invalid')
  if (typeof params.minTipPiconeros !== 'bigint' || params.minTipPiconeros <= 0n) errors.push('minTipPiconeros_invalid')
  if (!Number.isSafeInteger(params.capShareBps) || params.capShareBps <= 0 || params.capShareBps > 10000) {
    errors.push('capShareBps_invalid')
  }
  if (params.shadowTrustWeightFloor != null && !isUnitInterval(params.shadowTrustWeightFloor)) {
    errors.push('shadowTrustWeightFloor_invalid')
  }
  // Applies to LEGACY too. Invalid fails closed to LEGACY with no age limit,
  // the payout rule from before the setting existed, and is reported.
  if (!Number.isSafeInteger(params.minAccountAgeDays) || params.minAccountAgeDays < 0) {
    errors.push('minAccountAgeDays_invalid')
  }

  return {
    ok: errors.length === 0,
    formula: errors.length === 0 ? formula : 'LEGACY',
    params,
    errors
  }
}

// The per-payment minimum also leaves the budget's tip volume T, but only when
// V2 is the configured (and valid) formula: in LEGACY and SHADOW the budget
// must stay exactly as it is today. The budget is planned before the shares
// are computed, so a week whose V2 computation fails and pays LEGACY shares
// keeps the V2-filtered budget; the run records the filter it applied.
export function budgetMinTipPiconeros (shareConfig) {
  return shareConfig?.formula === 'V2' ? shareConfig.params.minTipPiconeros : null
}
