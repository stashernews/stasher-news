/* eslint-env jest */
// Every Mutation in api/resolvers/user.js must reject anonymous callers with
// E_UNAUTHENTICATED as its FIRST act — before any models/userLoader access.
// The context mocks prove the guard fires first: touching `models` throws.
import userResolvers from '@/api/resolvers/user'
import { E_UNAUTHENTICATED } from '@/lib/error'

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

const ARGS = {
  setName: { name: 'guardtest' },
  setSettings: { settings: {} },
  setWalkthrough: { upvotePopover: true, tipPopover: true },
  cropPhoto: { photoId: 1, cropData: {} },
  setPhoto: { photoId: 1 },
  upsertBio: { text: 'bio' },
  generateApiKey: { id: 1 },
  deleteApiKey: { id: 1 },
  unlinkAuth: { authType: 'github' },
  subscribeUserPosts: { id: 1 },
  subscribeUserComments: { id: 1 },
  toggleMute: { id: 1 }
}

const GUARDED_MUTATIONS = Object.keys(ARGS)

function explodingModels () {
  // property access itself throws — if the resolver reads models.x before the
  // auth guard, the test fails with "touched before auth guard", not a DB error
  return new Proxy({}, {
    get (target, prop) {
      throw new Error(`models.${String(prop)} touched before auth guard`)
    }
  })
}

describe.each(GUARDED_MUTATIONS)('Mutation.%s', (name) => {
  test('rejects anonymous callers with E_UNAUTHENTICATED before touching the database', async () => {
    const ctx = {
      me: null,
      models: explodingModels(),
      userLoader: {
        load: async () => { throw new Error('userLoader touched before auth guard') }
      }
    }
    await expect(userResolvers.Mutation[name](null, ARGS[name], ctx))
      .rejects.toMatchObject({ extensions: { code: E_UNAUTHENTICATED } })
  })
})
