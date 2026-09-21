/* eslint-env jest */
import { createMoneroWallRatingLoader } from '@/lib/monero-wall/rating-loader'

const enabledAt = new Date('2026-09-18T00:00:00Z')

const fakeModels = ({ items = [], aggs = [], mine = [] } = {}) => ({
  item: { findMany: jest.fn().mockResolvedValue(items) },
  moneroWallRating: {
    groupBy: jest.fn().mockResolvedValue(aggs),
    findMany: jest.fn().mockResolvedValue(mine)
  }
})

const fakeWallLoader = (contributions, rateable = {}) => ({
  load: jest.fn(async ({ id }) => ({
    progressPiconeros: 0n,
    myContributionPiconeros: contributions[id] ?? 0n,
    myRateablePiconeros: rateable[id] ?? contributions[id] ?? 0n,
    frozen: false
  }))
})

const walledItem = (over = {}) => ({
  id: 1,
  userId: 7,
  moneroWallPricePiconeros: 1_000_000_000n,
  moneroWallEnabledAt: enabledAt,
  ...over
})

const me = { id: 42 }

test('no ratings: zero aggregate, no myStars, not eligible', async () => {
  const models = fakeModels({ items: [walledItem()] })
  const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({}) })
  expect(await loader.load(1)).toEqual({ average: 0, count: 0, myStars: null, canRate: false, pendingRating: false })
  expect(models.moneroWallRating.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['itemId'] }))
})

test('aggregates and rounds the average to one decimal', async () => {
  const models = fakeModels({
    items: [walledItem()],
    aggs: [{ itemId: 1, _avg: { stars: 7 / 3 }, _count: { _all: 3 } }]
  })
  const loader = createMoneroWallRatingLoader({ models, me: null, moneroWallLoader: fakeWallLoader({}) })
  expect(await loader.load(1)).toEqual({ average: 2.3, count: 3, myStars: null, canRate: false, pendingRating: false })
})

test('returns the viewer own stars', async () => {
  const models = fakeModels({
    items: [walledItem()],
    aggs: [{ itemId: 1, _avg: { stars: 3 }, _count: { _all: 2 } }],
    mine: [{ itemId: 1, stars: 3 }]
  })
  const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 1_000_000_000n }) })
  expect((await loader.load(1)).myStars).toBe(3)
})

describe('canRate', () => {
  test('true when the viewer personally paid at least X', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 1_000_000_000n }) })
    expect((await loader.load(1)).canRate).toBe(true)
  })
  test('false when the contribution is below X (includes DETECTED-only tips)', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 999_999_999n }) })
    expect((await loader.load(1)).canRate).toBe(false)
  })
  test('false for T-only walls (no personal price)', async () => {
    const models = fakeModels({ items: [walledItem({ moneroWallPricePiconeros: null })] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 5_000_000_000n }) })
    expect((await loader.load(1)).canRate).toBe(false)
  })
  test('false for never-walled posts', async () => {
    const models = fakeModels({ items: [walledItem({ moneroWallEnabledAt: null })] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 5_000_000_000n }) })
    expect((await loader.load(1)).canRate).toBe(false)
  })
  test('false for the author', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me: { id: 7 }, moneroWallLoader: fakeWallLoader({ 1: 5_000_000_000n }) })
    expect((await loader.load(1)).canRate).toBe(false)
  })
  test('false for anonymous viewers', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me: null, moneroWallLoader: fakeWallLoader({}) })
    expect((await loader.load(1)).canRate).toBe(false)
  })
  test('true after wall removal (columns persist)', async () => {
    const models = fakeModels({ items: [walledItem({ moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') })] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 1_000_000_000n }) })
    expect((await loader.load(1)).canRate).toBe(true)
  })
})

describe('zero-conf rating tier', () => {
  test('canRate true at depth 3 (rateable >= X)', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 1_000_000_000n }, { 1: 1_000_000_000n }) })
    const r = await loader.load(1)
    expect(r.canRate).toBe(true)
    expect(r.pendingRating).toBe(false)
  })

  test('canRate false + pendingRating true when 0-conf paid but depth < 3', async () => {
    const models = fakeModels({ items: [walledItem()] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 1_000_000_000n }, { 1: 0n }) })
    const r = await loader.load(1)
    expect(r.canRate).toBe(false)
    expect(r.pendingRating).toBe(true)
  })

  test('pendingRating false below X entirely, and for T-only walls', async () => {
    const models = fakeModels({ items: [walledItem(), walledItem({ id: 2, moneroWallPricePiconeros: null })] })
    const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: fakeWallLoader({ 1: 999_999_999n, 2: 5_000_000_000n }) })
    expect((await loader.load(1)).pendingRating).toBe(false)
    expect((await loader.load(2)).pendingRating).toBe(false)
  })
})

test('batches: two ids, one query per concern', async () => {
  const models = fakeModels({ items: [walledItem(), walledItem({ id: 2 })] })
  const wall = fakeWallLoader({})
  const loader = createMoneroWallRatingLoader({ models, me, moneroWallLoader: wall })
  await Promise.all([loader.load(1), loader.load(2)])
  expect(models.item.findMany).toHaveBeenCalledTimes(1)
  expect(models.moneroWallRating.groupBy).toHaveBeenCalledTimes(1)
  expect(wall.load).toHaveBeenCalledTimes(2)
  expect(wall.load).toHaveBeenCalledWith({ id: 1, enabledAt })
  expect(wall.load).toHaveBeenCalledWith({ id: 2, enabledAt })
})
