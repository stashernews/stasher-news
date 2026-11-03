/* eslint-env jest */
import { freeCommentsQuota, freePostsQuota, commentsFreeLeft, postsFreeLeft, commentQuotaFor, postQuotaFor, __resetFeeConfigCacheForTests } from '@/api/monero/postingFee'
import { SITE_SETTINGS_DEFAULTS, __resetSiteSettingsForTests } from '@/lib/siteSettings'
import { getItemEditMode } from '@/lib/item-addendum'
import itemResolvers, { filterClause, repostItem } from '@/api/resolvers/item'
import { escalatedFeePiconeros } from '@/api/payIn/types/itemCreate'
import { resolveItemComments } from '@/api/resolvers/comment-tree'
import { incrementFreeCommentCount, incrementFreePostCount } from '@/api/payIn/lib/freebie'

jest.mock('../../lib/lexical/server/mentions', () => ({ extractMentions: () => ({ userNames: [], itemIds: [] }) }))
jest.mock('../../lib/lexical/server/html', () => ({ lexicalHTMLGenerator: jest.fn() }))

beforeEach(() => { __resetSiteSettingsForTests(); __resetFeeConfigCacheForTests() })
const user = { id: 7, freeCommentCount: 1, freePostCount: 1, createdAt: new Date(), stackedPiconeros: 0n }
const modelsFor = overrides => ({ siteSettings: { findUnique: async () => ({ ...SITE_SETTINGS_DEFAULTS, ...overrides }) } })

test('pure quota math honors supplied live quotas', () => {
  const config = { freeCommentsPerWeek: 4, freePostsPerMonth: 3 }
  expect(freeCommentsQuota(user, config)).toBe(4)
  expect(freePostsQuota(user, config)).toBe(3)
  expect(commentsFreeLeft(user, config)).toBe(3)
  expect(postsFreeLeft(user, config)).toBe(2)
})

test('credit-aware quota readers load promoted settings', async () => {
  const models = {
    ...modelsFor({ freeCommentsPerWeek: 4, freePostsPerMonth: 3 }),
    platformFeeConfig: { findUnique: async () => ({}) },
    $queryRaw: async () => [{ credits: 0, comments: 0, posts: 0 }]
  }
  expect(await commentQuotaFor(models, user)).toMatchObject({ base: 4, quota: 4, left: 3 })
  expect(await postQuotaFor(models, user)).toMatchObject({ baseQuota: 3, left: 2 })
})

test('spam factor remains exact BigInt math at a changed numerator/denominator', async () => {
  const models = { ...modelsFor({ spamEscalationNumerator: 5, spamEscalationDenominator: 2 }), $queryRaw: async () => [{ n: 2 }] }
  expect(await escalatedFeePiconeros(models, { userId: 7, basePiconeros: 100n })).toBe(625n)
})

test('feed defaults come from settings and can be bound without SQL interpolation', async () => {
  const values = []
  const clause = await filterClause('posts', null, 'lit', {
    models: modelsFor({ homepagePostsFilterPiconeros: -123456789n, defaultCommentsFilterPiconeros: -987654321n }),
    me: null,
    subLoader: { load: async () => null },
    bind: value => { values.push(value); return `$${values.length}::BIGINT` }
  })
  expect(clause).toContain('>= $1::BIGINT')
  expect(clause).not.toContain('123456789')
  expect(values).toEqual([-123456789n, -987654321n])
})

test('reposts enforce the live turf cap', async () => {
  const models = { ...modelsFor({ maxItemTurfs: 1 }), item: { findUnique: async () => ({ id: 1, userId: 7, subNames: ['monero'] }) } }
  await expect(repostItem(null, { id: 1, subName: 'tech' }, { models, me: { id: 7 } })).rejects.toThrow('at most 1 territories')
})

test('edit mode honors a changed deadline without relaxing ownership', () => {
  const item = { userId: 7, createdAt: new Date(0), payIn: { payInState: 'PAID' } }
  expect(getItemEditMode(item, { meId: 7, now: 700000, itemEditSeconds: 1200 })).toBe('FULL')
  expect(getItemEditMode(item, { meId: 7, now: 700000, itemEditSeconds: 60 })).toBe('ADDENDUM')
  expect(getItemEditMode(item, { meId: 8, now: 700000, itemEditSeconds: 1200 })).toBe('NONE')
})

test.each(['new', 'top', 'lit'])('%s feed binds live thresholds after its existing positional parameters', async sort => {
  const calls = []
  const models = {
    ...modelsFor({ homepagePostsFilterPiconeros: -123456789n, defaultPostsFilterPiconeros: -123456789n, defaultCommentsFilterPiconeros: -987654321n }),
    $queryRawUnsafe: async (sql, ...values) => { calls.push({ sql, values }); return [] }
  }
  await itemResolvers.Query.items(null, { sort, type: 'posts', limit: 5 }, { models, me: null, subLoader: { load: async () => null } })
  const query = calls.find(call => call.sql.includes('"netInvestment"'))
  expect(query.sql).not.toContain('123456789')
  expect(query.sql).not.toContain('987654321')
  expect(query.values.slice(-2)).toEqual([-123456789n, -987654321n])
  const first = sort === 'new' ? 4 : sort === 'top' ? 5 : 3
  expect(query.sql).toContain(`>= $${first}::BIGINT`)
})

test.each([5, 1001])('comment tree binds threshold for %i comments', async ncomments => {
  let captured
  await resolveItemComments({ id: 1, ncomments, nDirectComments: 2 }, 'top', null, {
    me: null,
    models: modelsFor({ defaultCommentsFilterPiconeros: -123456789n }),
    itemQueryWithMeta: async (options, ...values) => { captured = { ...options, values }; return [] },
    payInJoinFilter: () => '',
    activeOrMine: () => 'TRUE',
    select: 'SELECT "Item".*'
  })
  expect(captured.values.at(-1)).toBe(-123456789n)
  expect(captured.orderBy).not.toContain('123456789')
  expect(captured.orderBy).toContain(ncomments > 1000 ? '$7::BIGINT' : '$4::BIGINT')
})

test.each(['comment', 'post'])('zero %s quota spends a banked credit rather than granting a reset unit', async type => {
  let increments = 0
  const tx = {
    ...modelsFor({ freeCommentsPerWeek: 0, freePostsPerMonth: 0 }),
    user: { findUnique: async () => user, update: async () => { increments++ } },
    platformFeeConfig: { findUnique: async () => ({}) },
    $queryRaw: async () => []
  }
  const item = type === 'comment' ? { id: 1, freebie: true, parentId: 2 } : { id: 1, feeStatus: 'FEE_NOT_REQUIRED' }
  const increment = type === 'comment' ? incrementFreeCommentCount : incrementFreePostCount
  await expect(increment(tx, { item, userId: 7 })).rejects.toThrow(`no free ${type}s left`)
  expect(increments).toBe(0)
})
