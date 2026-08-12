/* eslint-env jest */
import { GqlAuthenticationError } from '@/lib/error'
import payInResolvers, { getPayIn } from '@/api/resolvers/payIn'

// payIn.js transitively imports ESM-only node_modules (components/editor,
// api/payIn -> itemCreate -> lib/lexical/server/mentions; lib/lexical/server/html)
// that next/jest does not transform. Mirror the mocks in
// test/api/resolvers/payIn.test.js:18-31 to break the chain.
jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

// statistics lives inline on the default export's Query object (payIn.js:56).
const statistics = payInResolvers.Query.statistics

// Strict models proxy: any DB access fires the throw below, so a test that
// expected auth-deny but reached the DB fails loudly instead of silently passing.
function mockModels () {
  return new Proxy({}, {
    get: () => jest.fn(() => { throw new Error('models must not be touched before the auth check') })
  })
}

test('statistics rejects an anonymous caller (no me)', async () => {
  const ctx = { models: mockModels(), me: null }
  await expect(statistics({}, { cursor: null, walletId: null }, ctx))
    .rejects.toBeInstanceOf(GqlAuthenticationError)
})

test('statistics does not reach the database before the auth check', async () => {
  const ctx = { models: mockModels(), me: null }
  await expect(statistics({}, { cursor: null, walletId: null }, ctx))
    .rejects.not.toThrow(/models must not be touched/)
})

test('getPayIn rejects a logged-in user who does not own the PayIn', async () => {
  // getPayIn is a named export (payIn.js:35) and is registered on Query under
  // the key `payIn` (payIn.js:55), not `getPayIn`. Imported directly at the top.
  const otherUsersPayIn = { id: 5, userId: 999, payOutCustodialTokens: [] }
  const models = { $queryRaw: jest.fn().mockResolvedValue([otherUsersPayIn]) }
  const ctx = { models, me: { id: 1 } }
  await expect(getPayIn({}, { id: 5 }, ctx)).rejects.toBeInstanceOf(GqlAuthenticationError)
})
