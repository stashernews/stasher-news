/* eslint-env jest */
import { isNostrEnabled, isNostrSocialPostingEnabled } from '@/lib/nostrFeatures'

describe('isNostrEnabled', () => {
  it('is true only when the enabled list includes nostr', () => {
    expect(isNostrEnabled({ enabled: ['email', 'github'] })).toBe(false)
    expect(isNostrEnabled({ enabled: ['email', 'nostr'] })).toBe(true)
    expect(isNostrEnabled({ enabled: ['nostr'] })).toBe(true)
  })

  it('handles missing or empty authMethods', () => {
    expect(isNostrEnabled(undefined)).toBe(false)
    expect(isNostrEnabled(null)).toBe(false)
    expect(isNostrEnabled({})).toBe(false)
    expect(isNostrEnabled({ enabled: undefined })).toBe(false)
  })
})

describe('isNostrSocialPostingEnabled', () => {
  it('is true only when the flag is exactly 1', () => {
    expect(isNostrSocialPostingEnabled({})).toBe(false)
    expect(isNostrSocialPostingEnabled({ NOSTR_SOCIAL_POSTING: '' })).toBe(false)
    expect(isNostrSocialPostingEnabled({ NOSTR_SOCIAL_POSTING: '0' })).toBe(false)
    expect(isNostrSocialPostingEnabled({ NOSTR_SOCIAL_POSTING: '1' })).toBe(true)
  })

  it('defaults to process.env when no env is passed', () => {
    expect(typeof isNostrSocialPostingEnabled()).toBe('boolean')
  })
})
