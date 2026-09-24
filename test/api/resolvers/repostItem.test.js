/* eslint-env jest */

// repostItem (2026-09-24): author-only, posts only, one turf per call, cap 5.
// Rejects must fire before pay() so no payment is ever created for an
// impossible repost.
import itemResolvers, { repostItem } from '@/api/resolvers/item'
import pay from '../../../api/payIn'

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ id: 99, moneroUri: 'monero:x' }))
}))

// api/resolvers/item.js drags in heavy transitive deps (the lexical server
// HTML generator pulls the ESM-only github-slugger, which jest's CJS sandbox
// cannot require); mirror test/api/resolvers/itemCreateSingleTurf.test.js and
// stub the pieces irrelevant to the resolver guards.
jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const basePost = (over = {}) => ({
  id: 10,
  userId: 7,
  parentId: null,
  bio: false,
  deletedAt: null,
  subNames: ['monero'],
  url: 'https://example.com',
  pollCost: null,
  bountyPiconeros: null,
  ...over
})

const models = (item, subs = [{ name: 'tech', status: 'ACTIVE', postTypes: ['LINK'] }]) => ({
  item: { findUnique: async () => item, update: jest.fn() },
  sub: { findMany: async () => subs }
})

const call = (item, subName, me = { id: 7 }) =>
  repostItem(null, { id: item?.id ?? 10, subName }, { me, models: models(item) })

beforeEach(() => jest.clearAllMocks())

describe('repostItem guards', () => {
  test('rejects a non-author', async () => {
    await expect(call(basePost(), 'tech', { id: 8 })).rejects.toThrow('does not belong')
    expect(pay).not.toHaveBeenCalled()
  })

  test('rejects comments and bios', async () => {
    await expect(call(basePost({ parentId: 3 }), 'tech')).rejects.toThrow('comments cannot be reposted')
    await expect(call(basePost({ bio: true }), 'tech')).rejects.toThrow('bios cannot be reposted')
  })

  test('rejects jobs', async () => {
    await expect(call(basePost({ subNames: ['jobs'], url: null }), 'tech')).rejects.toThrow('jobs cannot be reposted')
  })

  test('rejects a turf the item is already in (no double payment)', async () => {
    await expect(call(basePost(), 'monero')).rejects.toThrow('already in this territory')
    expect(pay).not.toHaveBeenCalled()
  })

  test('rejects a case-variant turf name (subNames is Citext)', async () => {
    await expect(call(basePost({ subNames: ['Monero'] }), 'monero')).rejects.toThrow('already in this territory')
    expect(pay).not.toHaveBeenCalled()
  })

  test('rejects at the cap', async () => {
    const atCap = basePost({ subNames: ['a', 'b', 'c', 'd', 'e'] })
    await expect(call(atCap, 'tech')).rejects.toThrow('at most 5')
    expect(pay).not.toHaveBeenCalled()
  })

  test('rejects a target turf that does not support the item type', async () => {
    const item = basePost()
    const pollOnly = [{ name: 'tech', status: 'ACTIVE', postTypes: ['POLL'] }]
    await expect(
      repostItem(null, { id: 10, subName: 'tech' }, { me: { id: 7 }, models: models(item, pollOnly) })
    ).rejects.toThrow('does not support LINK')
    expect(pay).not.toHaveBeenCalled()
  })
})

describe('repostItem happy path', () => {
  test('adds exactly one turf through the ITEM_UPDATE payIn', async () => {
    const result = await call(basePost(), 'tech')
    expect(pay).toHaveBeenCalledTimes(1)
    const [payInType, args] = pay.mock.calls[0]
    expect(payInType).toBe('ITEM_UPDATE')
    expect(args).toEqual({ id: 10, userId: 7, subNames: ['monero', 'tech'] })
    expect(result).toEqual({ id: 99, moneroUri: 'monero:x' })
  })

  test('never mutates the item itself — the engine defers until the fee is observed', async () => {
    const item = basePost()
    const m = models(item)
    await repostItem(null, { id: 10, subName: 'tech' }, { me: { id: 7 }, models: m })
    expect(m.item.update).not.toHaveBeenCalled()
  })
})

// GraphQL wiring regression (2026-09-24): repostItem is declared below the
// default export's Mutation map, so the map must reference it through a
// deferred call — a shorthand property would hit the const TDZ at module load,
// and a missing entry makes Apollo's default resolver return null for the
// non-nullable Mutation.repostItem field ("Cannot return null for non-nullable
// field Mutation.repostItem"). This test pins the entry and its delegation.
describe('repostItem resolver wiring', () => {
  test('is registered in the Mutation map and delegates to the real resolver', async () => {
    expect(typeof itemResolvers.Mutation.repostItem).toBe('function')
    await expect(
      itemResolvers.Mutation.repostItem(null, { id: 10, subName: 'tech' }, { me: { id: 8 }, models: models(basePost()) })
    ).rejects.toThrow('does not belong')
  })
})
