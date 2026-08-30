/* eslint-env jest */
import phraseResolvers, { consumeChallenge, AUTH_CHALLENGE_EXPIRY_MS } from '@/api/resolvers/phrase'
import { E_UNAUTHENTICATED } from '@/lib/error'

// api/resolvers/phrase.js imports authMethods from api/resolvers/user.js,
// which transitively imports api/resolvers/item.js, which drags in ESM-only
// lexical deps (mdast-util-from-markdown). Mirror the mocks in
// test/api/resolvers/user-mutation-guards.test.js to break that chain.
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

function makeModels () {
  const rows = new Map()
  let nextId = 1
  return {
    rows,
    authChallenge: {
      create: async ({ data }) => {
        const row = { id: nextId++, createdAt: new Date(), ...data }
        rows.set(row.k1, row)
        return row
      },
      deleteMany: async ({ where }) => {
        let count = 0
        for (const [k1, row] of rows) {
          const k1Ok = where.k1 === undefined || where.k1 === k1
          const ageOk = where.createdAt?.gte === undefined || row.createdAt >= where.createdAt.gte
          const ltOk = where.createdAt?.lt === undefined || row.createdAt < where.createdAt.lt
          if (k1Ok && ageOk && ltOk) { rows.delete(k1); count++ }
        }
        return { count }
      }
    },
    account: { findMany: async () => [] },
    user: {
      update: async ({ where, data }) => ({ id: where.id, phrasePubkey: data.phrasePubkey ?? null, pubkey: null })
    }
  }
}

const KP = {
  k1: 'ab'.repeat(32),
  pubkey: 'bfb8cfa9a9e3a6336cb5cf6a51dc1953fbd34aefe826383b4916cd37c4cc4629',
  sig: '80168edb3d714ae0357ac51f176f85527bb801d3acbd0d9dada20399813bd85bba09aed9d6d6d75d24637dfcf105f5a5336a9a7b5f2972b060481e667d705f0b'
}

const ME = { id: 42 }

describe('Mutation.createAuth', () => {
  it('creates a 64-hex k1 challenge row', async () => {
    const models = makeModels()
    const row = await phraseResolvers.Mutation.createAuth(null, {}, { models, me: null, headers: {} })
    expect(row.k1).toMatch(/^[0-9a-f]{64}$/)
    expect(models.rows.has(row.k1)).toBe(true)
  })

  it('rejects API-key sessions', async () => {
    const models = makeModels()
    await expect(phraseResolvers.Mutation.createAuth(null, {}, { models, me: { apiKey: true }, headers: {} }))
      .rejects.toThrow()
  })
})

describe('consumeChallenge', () => {
  it('consumes a fresh challenge exactly once', async () => {
    const models = makeModels()
    const row = await phraseResolvers.Mutation.createAuth(null, {}, { models, me: null, headers: {} })
    expect(await consumeChallenge(models, row.k1)).toBe(true)
    expect(await consumeChallenge(models, row.k1)).toBe(false)
  })

  it('rejects expired challenges', async () => {
    const models = makeModels()
    const stale = new Date(Date.now() - AUTH_CHALLENGE_EXPIRY_MS - 1000)
    models.rows.set(KP.k1, { id: 1, createdAt: stale, k1: KP.k1 })
    expect(await consumeChallenge(models, KP.k1)).toBe(false)
  })
})

describe('Mutation.linkPhrase', () => {
  // the fixture sig is over KP.k1, so seed the store with that exact challenge
  async function seedValidChallenge (models) {
    await phraseResolvers.Mutation.createAuth(null, {}, { models, me: null, headers: {} })
    const [row] = [...models.rows.values()]
    models.rows.delete(row.k1)
    models.rows.set(KP.k1, { ...row, k1: KP.k1 })
    return KP.k1
  }

  it('rejects anonymous callers with E_UNAUTHENTICATED before touching models', async () => {
    const exploding = new Proxy({}, { get: () => { throw new Error('models touched before auth guard') } })
    await expect(phraseResolvers.Mutation.linkPhrase(null, KP, { models: exploding, me: null }))
      .rejects.toMatchObject({ extensions: { code: E_UNAUTHENTICATED } })
  })

  it('rejects API-key sessions', async () => {
    const models = makeModels()
    const k1 = await seedValidChallenge(models)
    await expect(phraseResolvers.Mutation.linkPhrase(null, { ...KP, k1 }, { models, me: { ...ME, apiKey: true } }))
      .rejects.toThrow()
  })

  it('rejects an invalid signature without consuming the challenge', async () => {
    const models = makeModels()
    const k1 = await seedValidChallenge(models)
    await expect(phraseResolvers.Mutation.linkPhrase(null, { k1, pubkey: KP.pubkey, sig: 'ff'.repeat(64) }, { models, me: ME }))
      .rejects.toThrow(/signature/)
    expect(models.rows.has(k1)).toBe(true)
  })

  it('links on a valid proof and reports phrase in authMethods', async () => {
    const models = makeModels()
    const k1 = await seedValidChallenge(models)
    const result = await phraseResolvers.Mutation.linkPhrase(null, { ...KP, k1 }, { models, me: ME })
    expect(result.phrase).toBe(true)
    expect(result.phraseFingerprint).toBe('bfb8cfa9')
    // challenge single-use
    await expect(phraseResolvers.Mutation.linkPhrase(null, { ...KP, k1 }, { models, me: ME }))
      .rejects.toThrow(/expired|already used/)
  })

  it('rejects a phrase already linked to another account (P2002)', async () => {
    const models = makeModels()
    const k1 = await seedValidChallenge(models)
    models.user.update = async () => { const e = new Error('unique'); e.code = 'P2002'; throw e }
    await expect(phraseResolvers.Mutation.linkPhrase(null, { ...KP, k1 }, { models, me: ME }))
      .rejects.toThrow(/already linked/)
  })
})
