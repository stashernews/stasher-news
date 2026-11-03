// Shared by the settings fallback and the trust walk until it reads live settings.
export const TRUST_DEFAULTS = Object.freeze({
  trustSeedWeight: 0.83,
  trustMaxDepth: 40,
  trustPicoMin: 1001,
  trustAgainstPicoMin: 1000,
  trustIrrelevantCumulative: 0.001
})
