/* eslint-env jest */
import { REBRAND_ENABLED, useRebrand, DISPLAY_FONT } from '@/lib/rebrand'

describe('rebrand flag', () => {
  it('exposes a boolean REBRAND_ENABLED', () => {
    expect(typeof REBRAND_ENABLED).toBe('boolean')
  })

  it('useRebrand returns the same value as the constant', () => {
    expect(useRebrand()).toBe(REBRAND_ENABLED)
  })
})

describe('display font', () => {
  it('picks chakra-petch or lightning', () => {
    expect(['chakra-petch', 'lightning']).toContain(DISPLAY_FONT)
    expect(DISPLAY_FONT).toBe(REBRAND_ENABLED ? 'chakra-petch' : 'lightning')
  })
})
