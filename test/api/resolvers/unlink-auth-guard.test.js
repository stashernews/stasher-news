/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'
import { E_UNAUTHENTICATED } from '@/lib/error'

// api/resolvers/user.js transitively imports api/resolvers/item.js, which drags
// in ESM-only lexical deps (mdast-util-from-markdown). Mirror the mocks in
// test/api/resolvers/phrase.test.js to break that chain.
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

const ME = { id: 42 }
const PUBKEY = 'a'.repeat(64)

// in-memory models; $transaction executes inline (same object) so unit tests
// exercise the guard logic — the Serializable isolation choice is documented
// in the resolver and validated by review, not by these tests
function makeModels ({ user = {}, accounts = [] } = {}) {
  const state = {
    user: {
      id: ME.id,
      pubkey: null,
      emailVerified: null,
      emailHash: null,
      nostrAuthPubkey: null,
      phrasePubkey: null,
      apiKeyEnabled: false,
      apiKeyHash: null,
      emailHint: null,
      ...user
    },
    accounts: [...accounts]
  }
  const models = {
    $transaction: async (fn) => fn(models),
    account: {
      findMany: async () => state.accounts,
      findFirst: async ({ where }) => state.accounts.find(
        a => a.userId === where.userId && a.provider === where.provider),
      delete: async ({ where }) => {
        state.accounts = state.accounts.filter(a => a.id !== where.id)
      }
    },
    user: {
      findUnique: async () => state.user,
      update: async ({ data }) => {
        state.user = { ...state.user, ...data }
        return state.user
      }
    }
  }
  return { models, state }
}

beforeAll(() => {
  process.env.PHRASE_AUTH = '1'
  process.env.GITHUB_ID = 'x'
  process.env.GITHUB_SECRET = 'x'
})

afterAll(() => {
  delete process.env.PHRASE_AUTH
  delete process.env.GITHUB_ID
  delete process.env.GITHUB_SECRET
})

describe('Mutation.unlinkAuth last-method guard', () => {
  test('requires lastAuthConfirm when unlinking the only enabled+linked method', async () => {
    const { models, state } = makeModels({ user: { phrasePubkey: PUBKEY } })
    await expect(userResolvers.Mutation.unlinkAuth(null, { authType: 'phrase' }, { models, me: ME }))
      .rejects.toThrow(/last auth method/)
    expect(state.user.phrasePubkey).toBe(PUBKEY)
  })

  test('unlinks the last method when lastAuthConfirm is passed', async () => {
    const { models, state } = makeModels({ user: { phrasePubkey: PUBKEY } })
    const result = await userResolvers.Mutation.unlinkAuth(
      null, { authType: 'phrase', lastAuthConfirm: true }, { models, me: ME })
    expect(state.user.phrasePubkey).toBeNull()
    expect(result.phrase).toBe(false)
  })

  test('no flag needed when another usable method remains', async () => {
    const { models, state } = makeModels({
      user: { phrasePubkey: PUBKEY },
      accounts: [{ id: 1, userId: ME.id, provider: 'github' }]
    })
    await userResolvers.Mutation.unlinkAuth(null, { authType: 'phrase' }, { models, me: ME })
    expect(state.user.phrasePubkey).toBeNull()
    expect(state.accounts).toHaveLength(1)
  })

  test('no flag needed when the linked method is platform-disabled, even if nothing else remains', async () => {
    delete process.env.PHRASE_AUTH
    try {
      const { models, state } = makeModels({ user: { phrasePubkey: PUBKEY } })
      await userResolvers.Mutation.unlinkAuth(null, { authType: 'phrase' }, { models, me: ME })
      expect(state.user.phrasePubkey).toBeNull()
    } finally {
      process.env.PHRASE_AUTH = '1'
    }
  })

  test('guards the oauth branch too: last github account requires the flag and is not deleted', async () => {
    const { models, state } = makeModels({
      accounts: [{ id: 7, userId: ME.id, provider: 'github' }]
    })
    await expect(userResolvers.Mutation.unlinkAuth(null, { authType: 'github' }, { models, me: ME }))
      .rejects.toThrow(/last auth method/)
    expect(state.accounts).toHaveLength(1)
  })

  test('unlinks the last github account when lastAuthConfirm is passed', async () => {
    const { models, state } = makeModels({
      accounts: [{ id: 7, userId: ME.id, provider: 'github' }]
    })
    const result = await userResolvers.Mutation.unlinkAuth(
      null, { authType: 'github', lastAuthConfirm: true }, { models, me: ME })
    expect(state.accounts).toHaveLength(0)
    expect(state.user.hideGithub).toBe(true)
    expect(result.github).toBe(false)
  })

  test('unknown authType still throws no such account', async () => {
    const { models } = makeModels({ user: { phrasePubkey: PUBKEY } })
    await expect(userResolvers.Mutation.unlinkAuth(null, { authType: 'bogus' }, { models, me: ME }))
      .rejects.toThrow(/no such account/)
  })

  test('rejects anonymous callers before touching models', async () => {
    const exploding = new Proxy({}, { get: () => { throw new Error('models touched before auth guard') } })
    await expect(userResolvers.Mutation.unlinkAuth(null, { authType: 'phrase' }, { models: exploding, me: null }))
      .rejects.toMatchObject({ extensions: { code: E_UNAUTHENTICATED } })
  })
})
