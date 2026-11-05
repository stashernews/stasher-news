// The flame levels: pure and dependency-free so the badge, the profile and the
// Daily Ops card agree on every look. A tier is the flame week that earned it.

const tip = (a, extra) => ({ look: 'tip', a, ...extra })
const surge = (a, b) => ({ look: 'surge', a, b })
const shift = (a, b, extra) => ({ look: 'shift', a, b, ...extra })

export const FLAME_TIERS = {
  4: tip('blue'),
  8: tip('green'),
  12: tip('red'),
  16: tip('indigo'),
  // a white core would vanish inside the white body
  20: tip('white', { core: '#b9c6da' }),
  24: surge('blue', 'green'),
  28: surge('green', 'white'),
  32: surge('red', 'indigo'),
  36: surge('indigo', 'blue'),
  40: surge('white', 'red'),
  44: shift('rose', 'mint'),
  // a black arc would vanish on the dark theme, so that changeover fires cream
  48: shift('eclipse', 'corona', { arc: '#fff3d6' }),
  52: { look: 'prism', a: 'white' }
}

const color = (kind, name) => `var(--fl-${kind}-${name})`

/** The CSS variables that paint a tier. Null for a tier with no look. */
export function flameTierVars (tier) {
  const t = FLAME_TIERS[tier]
  if (!t) return null
  if (t.look === 'prism') return {}
  const { a, b = a } = t
  const base = { '--flame': color('f', a), '--edge': color('e', a), '--glow': color('h', b) }
  if (t.look === 'tip') {
    const core = t.core ? { '--core': t.core, '--core-o': 1 } : { '--core': color('k', a) }
    return { ...base, '--arc': a === 'white' ? '#3f6bff' : color('k', a), ...core }
  }
  const twoTone = { ...base, '--core': color('h', b), '--core-o': 1, '--b': color('h', b) }
  if (t.look === 'surge') return { ...twoTone, '--spark': a === 'white' ? 'var(--fl-p-white)' : color('f', a) }
  return {
    ...twoTone,
    '--b': color('f', b),
    '--core2': color('h', a),
    '--edge2': color('e', b),
    '--c1': color('h', b),
    '--c2': t.arc ?? color('h', a),
    '--l1': color('f', b),
    '--l2': color('f', a)
  }
}

/** The Daily Ops card accent for a tier: its main colour, except that the
 * eclipse body is black and would vanish on the dark theme. */
export function flameTierAccent (tier) {
  const a = FLAME_TIERS[tier]?.a
  if (!a) return null
  const name = a === 'eclipse' ? 'corona' : a
  return { '--qm-tier': color('f', name), '--qm-tier2': color('k', name) }
}
