/* eslint-env jest */
import { isAuthProviderEnabled, enabledAuthMethods } from '@/lib/authProviderEnv'

describe('isAuthProviderEnabled', () => {
  it('enables email only when both server and from are set', () => {
    expect(isAuthProviderEnabled('email', {})).toBe(false)
    expect(isAuthProviderEnabled('email', { LOGIN_EMAIL_SERVER: 'smtp://x' })).toBe(false)
    expect(isAuthProviderEnabled('email', { LOGIN_EMAIL_SERVER: 'smtp://x', LOGIN_EMAIL_FROM: 'a@b.c' })).toBe(true)
  })

  it('enables github and twitter only when id and secret are both set', () => {
    expect(isAuthProviderEnabled('github', { GITHUB_ID: 'x' })).toBe(false)
    expect(isAuthProviderEnabled('github', { GITHUB_ID: 'x', GITHUB_SECRET: 'y' })).toBe(true)
    expect(isAuthProviderEnabled('twitter', { TWITTER_ID: 'x', TWITTER_SECRET: 'y' })).toBe(true)
    expect(isAuthProviderEnabled('twitter', { TWITTER_ID: 'x' })).toBe(false)
  })

  it('treats whitespace-only values as unset', () => {
    expect(isAuthProviderEnabled('github', { GITHUB_ID: '  ', GITHUB_SECRET: 'y' })).toBe(false)
  })

  it('enables nostr only when the flag is present and non-empty', () => {
    expect(isAuthProviderEnabled('nostr', {})).toBe(false)
    expect(isAuthProviderEnabled('nostr', { NOSTR_AUTH: '' })).toBe(false)
    expect(isAuthProviderEnabled('nostr', { NOSTR_AUTH: '1' })).toBe(true)
  })

  it('returns false for unknown kinds', () => {
    expect(isAuthProviderEnabled('lightning', {})).toBe(false)
  })
})

describe('enabledAuthMethods', () => {
  it('returns enabled kinds in stable order', () => {
    expect(enabledAuthMethods({ LOGIN_EMAIL_SERVER: 'smtp://x', LOGIN_EMAIL_FROM: 'a@b.c', GITHUB_ID: 'x', GITHUB_SECRET: 'y' }))
      .toEqual(['email', 'github'])
  })

  it('returns only nostr when only the flag is set', () => {
    expect(enabledAuthMethods({ NOSTR_AUTH: '1' })).toEqual(['nostr'])
  })

  it('returns an empty array when nothing is configured', () => {
    expect(enabledAuthMethods({})).toEqual([])
  })
})
