export const isNostrEnabled = (authMethods) => !!authMethods?.enabled?.includes('nostr')

export const isNostrSocialPostingEnabled = (env = globalThis.process?.env ?? {}) =>
  env.NOSTR_SOCIAL_POSTING === '1'
