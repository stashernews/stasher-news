/* eslint-env jest */
import {
  BAND_DISPLACEMENTS,
  shouldPlayGlitch,
  glitchGhostCount,
  loudestBands,
  readGlitchEnabled,
  writeGlitchEnabled,
  readGlitchAnimated,
  writeGlitchAnimated
} from '@/lib/animation'

function makeStorage () {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  }
}

describe('shouldPlayGlitch', () => {
  test('plays within limits in a visible tab without reduced motion', () => {
    expect(shouldPlayGlitch({ domNodeCount: 5000, reducedMotion: false, visibilityState: 'visible' })).toBe(true)
  })

  test('skips under prefers-reduced-motion', () => {
    expect(shouldPlayGlitch({ domNodeCount: 100, reducedMotion: true, visibilityState: 'visible' })).toBe(false)
  })

  test('skips when the tab is hidden', () => {
    expect(shouldPlayGlitch({ domNodeCount: 100, reducedMotion: false, visibilityState: 'hidden' })).toBe(false)
  })

  test('skips above the 15000-node cap', () => {
    expect(shouldPlayGlitch({ domNodeCount: 20000, reducedMotion: false, visibilityState: 'visible' })).toBe(false)
  })
})

describe('glitchGhostCount ladder', () => {
  test('2 ghost bands up to 4000 nodes', () => {
    expect(glitchGhostCount(4000)).toBe(2)
  })

  test('1 ghost band between 4001 and 8000 nodes', () => {
    expect(glitchGhostCount(4001)).toBe(1)
    expect(glitchGhostCount(8000)).toBe(1)
  })

  test('no ghosts beyond 8000 nodes', () => {
    expect(glitchGhostCount(8001)).toBe(0)
    expect(glitchGhostCount(20000)).toBe(0)
  })
})

describe('loudestBands', () => {
  test('selects the two largest-displacement keyframes (s5=32, s2=30)', () => {
    expect(loudestBands()).toEqual([4, 1])
  })

  test('count can be changed', () => {
    expect(loudestBands(BAND_DISPLACEMENTS, 1)).toEqual([4])
  })
})

describe('glitch enabled key', () => {
  test('reads the new key first', () => {
    const storage = makeStorage()
    storage.setItem('glitchAnimate', 'no')
    expect(readGlitchEnabled(storage)).toBe('no')
  })

  test('falls back to the legacy lnAnimate key', () => {
    const storage = makeStorage()
    storage.setItem('lnAnimate', 'no')
    expect(readGlitchEnabled(storage)).toBe('no')
  })

  test('defaults to yes when no key exists', () => {
    expect(readGlitchEnabled(makeStorage())).toBe('yes')
  })

  test('writes only the new key', () => {
    const storage = makeStorage()
    writeGlitchEnabled(storage, false)
    expect(storage.getItem('glitchAnimate')).toBe('no')
    expect(storage.getItem('lnAnimate')).toBeNull()
    writeGlitchEnabled(storage, true)
    expect(storage.getItem('glitchAnimate')).toBe('yes')
  })
})

describe('welcome marker key', () => {
  test('reads the new key, falling back to lnAnimated', () => {
    const storage = makeStorage()
    expect(readGlitchAnimated(storage)).toBeNull()
    storage.setItem('lnAnimated', 'yep')
    expect(readGlitchAnimated(storage)).toBe('yep')
    storage.setItem('glitchAnimated', 'yep')
    expect(readGlitchAnimated(storage)).toBe('yep')
  })

  test('writes only the new key', () => {
    const storage = makeStorage()
    writeGlitchAnimated(storage, 'yep')
    expect(storage.getItem('glitchAnimated')).toBe('yep')
    expect(storage.getItem('lnAnimated')).toBeNull()
  })
})
