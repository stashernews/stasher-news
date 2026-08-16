/* eslint-env jest */
// newComments is polled every ~5s per thread viewer and must not run an
// unbounded path <@ subtree scan: the inner query is capped at LIMIT 50.
// Asserts SQL shape via a mocked $queryRawUnsafe (no DB), mirroring
// test/api/resolvers/item-auth.test.js's stubbing of heavy deps.
import resolvers from '@/api/resolvers/item'

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

function captureModels () {
  const captured = { query: null, args: null }
  const models = {
    $queryRawUnsafe: async (query, ...args) => {
      captured.query = query
      captured.args = args
      return []
    }
  }
  return { models, captured }
}

describe('newComments live-poll limit', () => {
  it('caps the subtree scan at LIMIT 50', async () => {
    const { models, captured } = captureModels()
    const after = new Date('2026-08-16T00:00:00Z')
    const result = await resolvers.Query.newComments(
      null, { itemId: 1, after }, { models }
    )
    expect(result).toEqual({ comments: [] })
    expect(captured.args).toEqual([1, after])
    expect(captured.query).toContain('ORDER BY "Item"."created_at" ASC')
    expect(captured.query).toMatch(/ORDER BY "Item"\."created_at" ASC\s+LIMIT 50/)
  })
})
