export const AUTH_PROVIDER_ENV = {
  email: ['LOGIN_EMAIL_SERVER', 'LOGIN_EMAIL_FROM'],
  github: ['GITHUB_ID', 'GITHUB_SECRET'],
  twitter: ['TWITTER_ID', 'TWITTER_SECRET'],
  nostr: ['NOSTR_AUTH'],
  phrase: ['PHRASE_AUTH']
}

export function isAuthProviderEnabled (kind, env = globalThis.process?.env ?? {}) {
  const keys = AUTH_PROVIDER_ENV[kind]
  if (!keys) return false
  return keys.every(key => typeof env[key] === 'string' && env[key].trim().length > 0)
}

export function enabledAuthMethods (env = globalThis.process?.env ?? {}) {
  return Object.keys(AUTH_PROVIDER_ENV).filter(kind => isAuthProviderEnabled(kind, env))
}
