/* eslint-env jest */
import { REBRAND_ENABLED, useRebrand } from '@/lib/rebrand'

describe('rebrand flag', () => {
  it('exposes a boolean REBRAND_ENABLED', () => {
    expect(typeof REBRAND_ENABLED).toBe('boolean')
  })

  it('useRebrand returns the same value as the constant', () => {
    expect(useRebrand()).toBe(REBRAND_ENABLED)
  })
})
