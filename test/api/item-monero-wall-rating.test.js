/* eslint-env jest */
import resolvers from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy ESM-only transitive deps; the mocks
// below break that chain — same pattern as test/api/item-monero-wall.test.js.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const enabledAt = new Date('2026-09-18T00:00:00Z')
const walledItem = {
  id: 1,
  userId: 7,
  text: 'intro\n[monerowall]\nsecret',
  moneroWallPricePiconeros: 1_000_000_000n,
  moneroWallThresholdPiconeros: null,
  moneroWallEnabledAt: enabledAt,
  moneroWallRemovedAt: null
}

const ctx = (contributions = {}, rateable = {}) => ({
  me: { id: 42 },
  moneroWallLoader: {
    load: jest.fn(async () => ({
      progressPiconeros: 0n,
      myContributionPiconeros: contributions[42] ?? 0n,
      myRateablePiconeros: rateable[42] ?? contributions[42] ?? 0n,
      frozen: false
    }))
  },
  moneroWallRatingLoader: { load: jest.fn(async () => ({ average: 0, count: 0, myStars: null, canRate: false, pendingRating: false })) }
})

const modelsWith = (item, { createError } = {}) => ({
  item: { findUnique: jest.fn().mockResolvedValue(item) },
  moneroWallRating: { create: createError ? jest.fn().mockRejectedValue(createError) : jest.fn().mockResolvedValue({ id: 1 }) }
})

describe('rateMoneroWallPost', () => {
  test('creates the rating for an eligible unlocker and returns the item', async () => {
    const models = modelsWith(walledItem)
    const result = await resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 3 }, { ...ctx({ 42: 1_000_000_000n }), models })
    expect(models.moneroWallRating.create).toHaveBeenCalledWith({ data: { itemId: 1, userId: 42, stars: 3 } })
    expect(result.id).toBe(1)
  })

  test('rejects anonymous callers', async () => {
    const models = modelsWith(walledItem)
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 3 }, { ...ctx(), me: null, models }))
      .rejects.toThrow(/logged in/)
  })

  test.each([0, 4, 2.5])('rejects stars=%p', async (stars) => {
    const models = modelsWith(walledItem)
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars }, { ...ctx({ 42: 1_000_000_000n }), models }))
      .rejects.toThrow(/1, 2 or 3/)
  })

  test('rejects the author rating their own post', async () => {
    const models = modelsWith(walledItem)
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx({ 7: 1_000_000_000n }), me: { id: 7 }, models }))
      .rejects.toThrow(/own post/)
  })

  test('rejects posts that never had a wall', async () => {
    const models = modelsWith({ ...walledItem, moneroWallEnabledAt: null })
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx(), models }))
      .rejects.toThrow(/no monerowall/)
  })

  test('rejects T-only walls (no individual unlock threshold)', async () => {
    const models = modelsWith({ ...walledItem, moneroWallPricePiconeros: null, moneroWallThresholdPiconeros: 5_000_000_000n })
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx(), models }))
      .rejects.toThrow(/individual unlock threshold/)
  })

  test('rejects viewers whose rateable contribution is below X', async () => {
    const models = modelsWith(walledItem)
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx({ 42: 999_999_999n }), models }))
      .rejects.toThrow(/unlock this post before rating/)
  })

  test('rates at depth 3 (rateable >= X) even while unconfirmed remainder exists', async () => {
    const models = modelsWith(walledItem)
    await resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 3 }, { ...ctx({ 42: 1_500_000_000n }, { 42: 1_000_000_000n }), models })
    expect(models.moneroWallRating.create).toHaveBeenCalled()
  })

  test('rejects when paid at 0-conf but depth < 3', async () => {
    const models = modelsWith(walledItem)
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx({ 42: 1_000_000_000n }, { 42: 999_999_999n }), models }))
      .rejects.toThrow(/unlock this post before rating/)
  })

  test('still rates after wall removal (columns persist)', async () => {
    const removed = { ...walledItem, moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }
    const models = modelsWith(removed)
    await resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 1 }, { ...ctx({ 42: 1_000_000_000n }), models })
    expect(models.moneroWallRating.create).toHaveBeenCalled()
  })

  test('maps a unique violation to the permanent-rating error', async () => {
    const models = modelsWith(walledItem, { createError: Object.assign(new Error('unique'), { code: 'P2002' }) })
    await expect(resolvers.Mutation.rateMoneroWallPost({}, { itemId: 1, stars: 2 }, { ...ctx({ 42: 1_000_000_000n }), models }))
      .rejects.toThrow(/already rated/)
  })
})

describe('Item.moneroWallRating', () => {
  test('delegates to the rating loader by item id', async () => {
    const c = ctx()
    await resolvers.Item.moneroWallRating(walledItem, {}, c)
    expect(c.moneroWallRatingLoader.load).toHaveBeenCalledWith(1)
  })
})
