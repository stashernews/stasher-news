/* eslint-env jest */
// The thread comment queries (fetchFullCommentRows / fetchLimitedCommentRows)
// power Item.comments on every thread page. They MUST apply the same PENDING_FEE /
// bounty visibility gate as the feeds (activeOrMine): a fee-gated reply is
// invisible to everyone but its author until rewardsWalletObserver observes its
// comment fee (regression: unpaid replies rendered live in threads, e.g. items
// 10658/10659 under 10653). Asserts SQL shape via a stubbed itemQueryWithMeta
// (no DB), mirroring test/api/resolvers/item-comments.test.js.
import { resolveItemComments } from '@/api/resolvers/comment-tree'

function makeCtx (me) {
  const captured = { query: null }
  const ctx = {
    me,
    models: {},
    userLoader: { load: async () => ({ commentsPiconerosFilter: null }) },
    itemQueryWithMeta: async ({ query }) => {
      captured.query = query
      return []
    },
    payInJoinFilter: () => '-- payInJoinFilter --',
    activeOrMine: viewer => `-- activeOrMine(${viewer ? viewer.id : 'anon'}) --`,
    select: '-- select --'
  }
  return { ctx, captured }
}

const item = ({ ncomments = 5, nDirectComments = 1 }) => ({
  id: 1, ncomments, nDirectComments, pinId: null, bioId: null, createdAt: new Date()
})

describe('comment-tree visibility gate', () => {
  test('the full-thread query applies activeOrMine for anonymous viewers', async () => {
    const { ctx, captured } = makeCtx(undefined)
    await resolveItemComments(item({}), 'top', null, ctx)
    expect(captured.query).toContain('-- activeOrMine(anon) --')
  })

  test('the full-thread query applies activeOrMine for logged-in viewers', async () => {
    const { ctx, captured } = makeCtx({ id: 860 })
    await resolveItemComments(item({}), 'top', null, ctx)
    expect(captured.query).toContain('-- activeOrMine(860) --')
  })

  test('the limited-thread query applies activeOrMine in BOTH the base and recursive CTE steps', async () => {
    const { ctx, captured } = makeCtx({ id: 860 })
    await resolveItemComments(item({ ncomments: 1001, nDirectComments: 2 }), 'top', null, ctx)
    const [base, recursive] = captured.query.split('UNION ALL')
    expect(base).toContain('-- activeOrMine(860) --')
    expect(recursive).toContain('-- activeOrMine(860) --')
  })

  test('the limited-thread query applies activeOrMine for anonymous viewers too', async () => {
    const { ctx, captured } = makeCtx(undefined)
    await resolveItemComments(item({ ncomments: 1001, nDirectComments: 2 }), 'top', null, ctx)
    const [base, recursive] = captured.query.split('UNION ALL')
    expect(base).toContain('-- activeOrMine(anon) --')
    expect(recursive).toContain('-- activeOrMine(anon) --')
  })
})
