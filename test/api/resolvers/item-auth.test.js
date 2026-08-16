/* eslint-env jest */
// anonymous bookmarkItem/subscribeItem must throw GqlAuthenticationError,
// not TypeError on me.id (fails closed today, but crashes are unactionable)
// NOTE: GqlAuthenticationError's message is 'you must be logged in' (lib/error.js:21)
import resolvers from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy transitive deps (domino, lexical editor,
// url-unshort, page-metadata-parser); mirror test/api/auth/authorization.test.js
// and stub the pieces that are irrelevant to the auth guard.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

describe('anonymous item mutations', () => {
  it('bookmarkItem rejects anonymous callers with an auth error', async () => {
    await expect(
      resolvers.Mutation.bookmarkItem(null, { id: 1 }, { models: {} })
    ).rejects.toThrow(/you must be logged in/i)
  })

  it('subscribeItem rejects anonymous callers with an auth error', async () => {
    await expect(
      resolvers.Mutation.subscribeItem(null, { id: 1 }, { models: {} })
    ).rejects.toThrow(/you must be logged in/i)
  })
})
