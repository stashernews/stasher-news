/* eslint-env jest */
// Single source of truth for "what counts as a login method" on the
// AuthMethods GraphQL type. Blacklist-based key filtering broke once already
// (emailHint silently counted as a second method and disabled the lockout
// banner — see pages/settings history); these tests pin the whitelist.
import { AUTH_METHOD_KEYS, activatedAuthMethods, hasOnlyOneAuthMethod, enabledAuthProviders } from '../authMethods'

describe('AUTH_METHOD_KEYS', () => {
  test('is exactly the boolean method fields on the AuthMethods type', () => {
    expect(AUTH_METHOD_KEYS).toEqual(['lightning', 'nostr', 'github', 'twitter', 'email'])
  })
})

describe('activatedAuthMethods', () => {
  test('returns only the truthy method keys, in whitelist order', () => {
    const methods = { email: true, github: true, nostr: false, lightning: null, twitter: undefined }
    expect(activatedAuthMethods(methods)).toEqual(['github', 'email'])
  })

  test('ignores non-method fields regardless of truthiness', () => {
    const methods = { email: true, emailHint: 'j***@gmail.com', apiKey: true, enabled: ['email'] }
    expect(activatedAuthMethods(methods)).toEqual(['email'])
  })

  test('returns an empty array for missing authMethods', () => {
    expect(activatedAuthMethods(undefined)).toEqual([])
  })
})

describe('hasOnlyOneAuthMethod', () => {
  test('true for a single linked method', () => {
    expect(hasOnlyOneAuthMethod({ email: true })).toBe(true)
  })

  test('true when nothing is linked', () => {
    expect(hasOnlyOneAuthMethod({})).toBe(true)
    expect(hasOnlyOneAuthMethod(undefined)).toBe(true)
  })

  test('false for two linked methods', () => {
    expect(hasOnlyOneAuthMethod({ email: true, github: true })).toBe(false)
  })

  test('the display hint never counts as a method (regression: banner must stay for email-only users)', () => {
    expect(hasOnlyOneAuthMethod({ email: true, emailHint: 'j***@gmail.com' })).toBe(true)
  })

  test('apiKey never counts as a method', () => {
    expect(hasOnlyOneAuthMethod({ email: true, apiKey: true })).toBe(true)
  })
})

describe('enabledAuthProviders', () => {
  test('returns the sorted intersection of method keys and enabled', () => {
    const methods = { twitter: true, email: true, github: false, enabled: ['email', 'twitter', 'github', 'nostr'] }
    expect(enabledAuthProviders(methods)).toEqual(['email', 'github', 'nostr', 'twitter'])
  })

  test('includes enabled-but-unlinked methods (drives the Link button)', () => {
    const methods = { email: true, enabled: ['email', 'github'] }
    expect(enabledAuthProviders(methods)).toEqual(['email', 'github'])
  })

  test('ignores non-method fields', () => {
    const methods = { email: true, emailHint: 'j***@gmail.com', enabled: ['email', 'emailHint'] }
    expect(enabledAuthProviders(methods)).toEqual(['email'])
  })

  test('returns an empty array when enabled is missing or empty', () => {
    expect(enabledAuthProviders({ email: true })).toEqual([])
    expect(enabledAuthProviders({ email: true, enabled: [] })).toEqual([])
    expect(enabledAuthProviders(undefined)).toEqual([])
  })
})
