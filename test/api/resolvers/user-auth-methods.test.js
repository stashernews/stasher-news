/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

// api/resolvers/user.js transitively imports api/resolvers/item.js, which drags
// in ESM-only lexical deps (mdast-util-from-markdown). Mirror the mocks in
// test/api/resolvers/userOptional.test.js to break that chain.
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

// authMethods is a UserPrivates field resolver (api/typeDefs/user.js exposes
// `authMethods: AuthMethods!` inside `type UserPrivates`), not a Query root.
const { UserPrivates, Mutation } = userResolvers

function ctx (meId, accounts = []) {
  const models = {
    $transaction: async (fn) => fn(models),
    account: {
      findMany: async () => accounts,
      findFirst: async ({ where }) => accounts.find(
        a => a.userId === where.userId && a.provider === where.provider),
      delete: async ({ where }) => {}
    },
    user: {
      findUnique: async (id) => ({ id: meId, emailVerified: new Date(), emailHash: 'hash' }),
      update: async ({ data }) => ({ id: 1, email: 'stale@example.com', emailVerified: new Date('2020-01-01'), emailHash: 'stalehash', emailHint: 'stale***@example.com', ...data })
    }
  }
  return {
    me: meId == null ? null : { id: meId },
    models,
    userLoader: {
      load: async (id) => ({ id, pubkey: null, nostrAuthPubkey: null, emailVerified: new Date(), emailHash: 'hash', emailHint: 'j***@gmail.com', apiKeyEnabled: false, apiKeyHash: null })
    }
  }
}

describe('UserPrivates.authMethods', () => {
  test('returns emailHint to self alongside the email boolean', async () => {
    const methods = await UserPrivates.authMethods({ id: 1, emailVerified: new Date(), emailHash: 'hash', emailHint: 'j***@gmail.com' }, {}, ctx(1))
    expect(methods.email).toBe(true)
    expect(methods.emailHint).toBe('j***@gmail.com')
  })

  test('returns no emailHint for non-self viewers', async () => {
    const methods = await UserPrivates.authMethods({ id: 2, emailHint: 'j***@gmail.com' }, {}, ctx(1))
    expect(methods.emailHint).toBeUndefined()
    expect(methods.email).toBe(false)
  })
})

describe('Mutation.unlinkAuth(email)', () => {
  test('clears emailHint and emailCiphertext along with email, emailVerified and emailHash', async () => {
    let updateData
    const context = ctx(1)
    const update = context.models.user.update
    context.models.user.update = async ({ data }) => {
      updateData = data
      return update({ data })
    }

    const result = await Mutation.unlinkAuth(null, { authType: 'email', lastAuthConfirm: true }, context)

    expect(result.emailHint).toBeNull()
    expect(result.email).toBe(false)
    expect(updateData.email).toBeNull()
    expect(updateData.emailVerified).toBeNull()
    expect(updateData.emailHash).toBeNull()
    expect(updateData.emailCiphertext).toBeNull()
  })
})
