/* eslint-env jest */
import { DISPLAY_FONT } from '@/lib/rebrand'

describe('rebrand constants', () => {
  it('uses the self-hosted Chakra Petch display font', () => {
    expect(DISPLAY_FONT).toBe('Chakra Petch')
  })
})
