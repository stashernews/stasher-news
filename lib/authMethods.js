// Single source of truth for "what counts as a login method" on the
// AuthMethods GraphQL type (api/typeDefs/user.js). Consumers must count via
// this whitelist, never by key-blacklisting: blacklist filtering silently
// broke when the display-only emailHint field was added (it counted as a
// second method and disabled the lockout banner). If you add a new boolean
// auth method to the type, add it here.
export const AUTH_METHOD_KEYS = ['lightning', 'nostr', 'github', 'twitter', 'email']

export function activatedAuthMethods (authMethods) {
  return AUTH_METHOD_KEYS.filter(k => !!authMethods?.[k])
}

// true when the user has at most one linked login method — drives the
// lockout-warning banner on the settings pages
export function hasOnlyOneAuthMethod (authMethods) {
  return activatedAuthMethods(authMethods).length <= 1
}

// sorted enabled-method keys — drives the Link/Unlink buttons on /settings/logins
// (sort prevents hydration mismatch)
export function enabledAuthProviders (authMethods) {
  return AUTH_METHOD_KEYS.filter(k => (authMethods?.enabled || []).includes(k)).sort()
}
