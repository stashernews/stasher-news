/* eslint-env jest */
import getColor, { EmberRainbow, Rainbow } from '@/lib/rainbow'

describe('getColor', () => {
  it('returns grey for zero', () => {
    expect(getColor(0)).toBe('#a5a5a5')
    expect(getColor(0, true)).toBe('#a5a5a5')
  })

  it('flag-off default matches legacy behavior', () => {
    expect(getColor(1000, false)).toBe(getColor(1000))
    expect(getColor(1000, false)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('high tips are violet-dominant under the ember ramp', () => {
    const high = getColor(1e12, true).toLowerCase()
    const r = parseInt(high.slice(1, 3), 16)
    const b = parseInt(high.slice(5, 7), 16)
    expect(b).toBeGreaterThan(r)
  })
})

describe('ember ramp table', () => {
  it('starts at monero orange', () => {
    expect(EmberRainbow[0].toLowerCase()).toBe('#ff6600')
  })

  it('ends at violet', () => {
    expect(EmberRainbow[EmberRainbow.length - 1].toLowerCase()).toBe('#7c3aed')
  })

  it('same length as the legacy table', () => {
    expect(EmberRainbow.length).toBe(Rainbow.length)
    expect(EmberRainbow.length).toBe(734)
  })
})
