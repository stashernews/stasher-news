/* eslint-env jest */
// Regression: filterClause must accept BigInt user/territory filters and return a
// valid SQL clause without throwing (Math.min/max on bigint used to throw, 500/302).
// api/resolvers/item.js drags in heavy transitive deps (domino, lexical editor,
// url-unshort, page-metadata-parser); mirror test/components/fee-button.test.js and
// stub the pieces that are irrelevant to the pure filterClause path.
import { filterClause } from '@/api/resolvers/item'

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

function ctx (userOverrides = {}, subOverrides, userLoaderOverrides) {
  return {
    me: { id: 1 },
    userLoader: {
      load: async () => ({
        postsPiconerosFilter: 1000000000n,
        commentsPiconerosFilter: 0n,
        ...userOverrides
      }),
      ...userLoaderOverrides
    },
    subLoader: {
      load: async () => subOverrides || null
    }
  }
}

describe('filterClause with BigInt filters', () => {
  test('homepage lit feed returns a clause containing >= 1000000000 without throwing', async () => {
    const clause = await filterClause('links', undefined, 'lit', ctx())
    expect(typeof clause).toBe('string')
    expect(clause).toContain('>= 1000000000')
  })

  test('homepage lit respects an explicit "-∞ show all" (null) filter instead of the floor', async () => {
    // Regression: the homepage floor used to override a logged-in user's null
    // filter, hiding heavily downvoted posts even with the filter at -∞.
    const clause = await filterClause('links', undefined, 'lit', ctx({ postsPiconerosFilter: null, commentsPiconerosFilter: null }))
    expect(clause).toBe('')
  })

  test('homepage lit respects a negative filter instead of clamping to the homepage floor', async () => {
    const clause = await filterClause('links', undefined, 'lit', ctx({ postsPiconerosFilter: -2000000000n, commentsPiconerosFilter: -2000000000n }))
    expect(clause).toContain('>= -2000000000')
  })

  test('logged-out homepage lit applies the homepage floor default', async () => {
    const clause = await filterClause('links', undefined, 'lit', {
      me: null,
      userLoader: { load: async () => null },
      subLoader: { load: async () => null }
    })
    expect(clause).toContain('>= -25000000000')
  })

  test('territory lit stays territory-authoritative even when the user set -∞', async () => {
    const clause = await filterClause('links', 'tech', 'lit', ctx({ postsPiconerosFilter: null, commentsPiconerosFilter: null }, { postsPiconerosFilter: -100000000000n }))
    expect(clause).toContain('>= -100000000000')
  })

  test('non-curated territory feed (sort new) does not throw with BigInt territory filter', async () => {
    const clause = await filterClause('links', 'monero', 'new', ctx({}, { postsPiconerosFilter: 1000000000n }))
    expect(typeof clause).toBe('string')
  })

  test('does not throw when the session user row is missing (stale session)', async () => {
    // Regression: a session cookie referencing a deleted user id makes
    // userLoader.load return null. The old code dereferenced user.commentsPiconerosFilter
    // and crashed every feed query -> SSR 302 -> /404 (the logged-out homepage bug).
    const clause = await filterClause('links', undefined, 'lit', ctx({}, null, { load: async () => null }))
    expect(typeof clause).toBe('string')
  })
})
