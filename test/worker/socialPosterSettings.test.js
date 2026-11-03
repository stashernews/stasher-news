/* eslint-env jest */
const published = []
// This test targets dispatch, not the legacy formatter (which cannot accept
// the BigInt piconeros emitted by the real query).
jest.mock('../../lib/format', () => ({ numWithUnits: value => String(value) }))
jest.mock('../../lib/nostr', () => ({
  __esModule: true,
  default: { get: () => ({ getSigner: () => ({}), publish: async event => { published.push(event.content) } }) },
  getNostrProfile: () => null
}))

test.each([[null, '0', false], [null, '1', true], [true, '0', true], [false, '1', false]])(
  'Nostr publishes iff the effective db=%s/env=%s switch is enabled', async (stored, env, expected) => {
    const previous = { ...process.env }
    process.env.NODE_ENV = 'production'
    process.env.NOSTR_SOCIAL_POSTING = env
    process.env.NOSTR_PRIVATE_KEY = 'fake-key-never-leaves-the-mock'
    delete process.env.TWITTER_POSTER_API_KEY
    published.length = 0
    try {
      let postToSocial
      jest.isolateModules(() => { postToSocial = require('../../worker/socialPoster').postToSocial })
      await postToSocial({
        models: {
          siteSettings: { findUnique: async () => ({ nostrSocialPosting: stored }) },
          $queryRaw: async () => [{ id: 1, userId: 7, title: 'test post', userName: 'author', piconeros: 100n, ncomments: 2, subNames: ['monero'] }],
          AutoSocialPost: { create: async () => ({}) },
          user: { findUnique: async () => null }
        }
      })
      expect(published.length > 0).toBe(expected)
      if (expected) expect(published[0]).toContain('test post')
    } finally { process.env = previous }
  })
