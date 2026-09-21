/* eslint-env jest */
import { createMoneroWallLoader } from '@/lib/monero-wall/loader'

const enabledAt = new Date('2026-09-18T00:00:00Z')

function fakeModels ({ progress = [], contributions = [] } = {}) {
  const calls = []
  return {
    calls,
    $queryRawUnsafe: jest.fn(async (sql, ...params) => {
      calls.push({ sql, params })
      if (sql.includes('tipperId') || sql.includes('"tipperId"')) return contributions
      return progress
    })
  }
}

test('batches progress, freeze and contribution into one query per concern', async () => {
  const models = fakeModels({
    progress: [
      { postId: 1, progressPiconeros: 2_000_000_000n, detectedCount: 3 },
      { postId: 2, progressPiconeros: 0n, detectedCount: 0 }
    ]
  })
  const loader = createMoneroWallLoader({ models, me: { id: 99 } })
  const [a, b] = await Promise.all([
    loader.load({ id: 1, enabledAt }),
    loader.load({ id: 2, enabledAt })
  ])
  expect(a).toEqual({ progressPiconeros: 2_000_000_000n, myContributionPiconeros: 0n, myRateablePiconeros: 0n, frozen: true })
  expect(b).toEqual({ progressPiconeros: 0n, myContributionPiconeros: 0n, myRateablePiconeros: 0n, frozen: false })
  // one progress query + one contribution query for the whole batch
  expect(models.$queryRawUnsafe).toHaveBeenCalledTimes(2)
})

test('reports the viewer contribution when present', async () => {
  const models = fakeModels({
    progress: [{ postId: 1, progressPiconeros: 1_000_000_000n, detectedCount: 1 }],
    contributions: [{ postId: 1, contributionPiconeros: 1_000_000_000n, rateablePiconeros: 1_000_000_000n }]
  })
  const loader = createMoneroWallLoader({ models, me: { id: 99 } })
  const view = await loader.load({ id: 1, enabledAt })
  expect(view.myContributionPiconeros).toBe(1_000_000_000n)
})

test('anonymous viewers skip the contribution query', async () => {
  const models = fakeModels({ progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }] })
  const loader = createMoneroWallLoader({ models, me: null })
  await loader.load({ id: 1, enabledAt })
  expect(models.$queryRawUnsafe).toHaveBeenCalledTimes(1)
})

test('dedupes repeated keys', async () => {
  const models = fakeModels({ progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }] })
  const loader = createMoneroWallLoader({ models, me: null })
  await Promise.all([
    loader.load({ id: 1, enabledAt }),
    loader.load({ id: 1, enabledAt })
  ])
  expect(models.$queryRawUnsafe).toHaveBeenCalledTimes(1)
})

test('unknown keys resolve zeros and not frozen', async () => {
  const models = fakeModels({ progress: [] })
  const loader = createMoneroWallLoader({ models, me: null })
  expect(await loader.load({ id: 123, enabledAt })).toEqual({ progressPiconeros: 0n, myContributionPiconeros: 0n, myRateablePiconeros: 0n, frozen: false })
})

// --- zero-conf tiers (2026-09-22 spec) ---
test('entitlement contribution counts DETECTED tips (0-conf)', async () => {
  const models = fakeModels({
    progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 1 }],
    contributions: [{ postId: 1, contributionPiconeros: 1_000_000_000n, rateablePiconeros: 0n }]
  })
  const loader = createMoneroWallLoader({ models, me: { id: 99 } })
  const view = await loader.load({ id: 1, enabledAt })
  expect(view.myContributionPiconeros).toBe(1_000_000_000n)
  expect(view.myRateablePiconeros).toBe(0n)
})

test('rateable tier requires CONFIRMED when the chain tip is missing or stale', async () => {
  const fresh = fakeModels({
    progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }],
    contributions: [{ postId: 1, contributionPiconeros: 5n, rateablePiconeros: 1_000_000_000n }]
  })
  fresh.chainState = { findUnique: jest.fn().mockResolvedValue({ id: 1, chainHeight: 100, updatedAt: new Date(Date.now() - 60_000) }) }
  const loader = createMoneroWallLoader({ models: fresh, me: { id: 99 } })
  expect((await loader.load({ id: 1, enabledAt })).myRateablePiconeros).toBe(1_000_000_000n)

  const stale = fakeModels({
    progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }],
    contributions: [{ postId: 1, contributionPiconeros: 5n, rateablePiconeros: 2n }]
  })
  stale.chainState = { findUnique: jest.fn().mockResolvedValue({ id: 1, chainHeight: 100, updatedAt: new Date(Date.now() - 11 * 60 * 1000) }) }
  const loader2 = createMoneroWallLoader({ models: stale, me: { id: 99 } })
  expect((await loader2.load({ id: 1, enabledAt })).myRateablePiconeros).toBe(2n)

  // missing tip: findUnique resolves null — same CONFIRMED-only collapse
  const missing = fakeModels({
    progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }],
    contributions: [{ postId: 1, contributionPiconeros: 1_000_000_000n, rateablePiconeros: 1_000_000_000n }]
  })
  missing.chainState = { findUnique: jest.fn().mockResolvedValue(null) }
  const loader3 = createMoneroWallLoader({ models: missing, me: { id: 99 } })
  expect((await loader3.load({ id: 1, enabledAt })).myRateablePiconeros).toBe(1_000_000_000n)
})

test('anonymous viewers get zero rateable and still one contribution query is skipped', async () => {
  const models = fakeModels({ progress: [{ postId: 1, progressPiconeros: 0n, detectedCount: 0 }] })
  const loader = createMoneroWallLoader({ models, me: null })
  const view = await loader.load({ id: 1, enabledAt })
  expect(view.myRateablePiconeros).toBe(0n)
  expect(models.$queryRawUnsafe).toHaveBeenCalledTimes(1)
})
