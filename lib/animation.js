// Pure helpers for the glitch animation (components/animation). Kept in lib/
// so the guards and localStorage migration are unit-testable without a DOM.

export const GLITCH_STORAGE_KEYS = {
  enabled: 'glitchAnimate',
  welcomed: 'glitchAnimated'
}

export const LEGACY_STORAGE_KEYS = {
  enabled: 'lnAnimate',
  welcomed: 'lnAnimated'
}

// Max |translateX| (px) per band keyframe, 0-indexed (s1..s6).
export const BAND_DISPLACEMENTS = [26, 30, 22, 24, 32, 22]

// Node-count degradation ladder: ghost (chromatic) copies per burst, then a
// hard cap above which the burst is skipped entirely (shouldPlayGlitch).
const GHOST_LADDER = [
  { maxNodes: 4000, ghostBands: 2 },
  { maxNodes: 8000, ghostBands: 1 }
]

const NODE_CAP = 15000

export function shouldPlayGlitch ({ domNodeCount, reducedMotion, visibilityState }) {
  if (reducedMotion) return false
  if (visibilityState !== 'visible') return false
  return domNodeCount <= NODE_CAP
}

export function glitchGhostCount (domNodeCount) {
  for (const rung of GHOST_LADDER) {
    if (domNodeCount <= rung.maxNodes) return rung.ghostBands
  }
  return 0
}

export function loudestBands (displacements = BAND_DISPLACEMENTS, count = 2) {
  return displacements
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d - a.d)
    .slice(0, count)
    .map(({ i }) => i)
}

export function readGlitchEnabled (storage) {
  return storage.getItem(GLITCH_STORAGE_KEYS.enabled) ??
    storage.getItem(LEGACY_STORAGE_KEYS.enabled) ??
    'yes'
}

export function writeGlitchEnabled (storage, enabled) {
  storage.setItem(GLITCH_STORAGE_KEYS.enabled, enabled ? 'yes' : 'no')
}

export function readGlitchAnimated (storage) {
  return storage.getItem(GLITCH_STORAGE_KEYS.welcomed) ??
    storage.getItem(LEGACY_STORAGE_KEYS.welcomed)
}

export function writeGlitchAnimated (storage, value) {
  storage.setItem(GLITCH_STORAGE_KEYS.welcomed, value)
}
