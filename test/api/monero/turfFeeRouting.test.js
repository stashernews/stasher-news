/* eslint-env jest */
import {
  turfOwnerFeesEnabled, premiumPiconeros, postFeePiconerosForSubs,
  commentFeePiconerosForSubs, postFloorPiconerosForSubs, commentFloorPiconerosForSubs,
  resolveOwnerFeeRoute, resolveOwnerFeeRouteForSub,
  MAX_TURF_PREMIUM_PICONEROS
} from '@/api/monero/turfFeeRouting'
import { territorySchema } from '@/lib/validate'

const config = { postingFeeFloorPiconeros: 1_000_000_000n, maxTurfPremiumPiconeros: 10_000_000_000n }
const sub = (name, userId, post = 0n, comment = 0n) => ({
  name, userId, postPremiumPiconeros: post, commentPremiumPiconeros: comment
})

describe('turfOwnerFeesEnabled', () => {
  afterEach(() => { delete process.env.TURF_OWNER_FEES })
  it('is off by default', () => {
    delete process.env.TURF_OWNER_FEES
    expect(turfOwnerFeesEnabled()).toBe(false)
  })
  it('is on only for exactly "1"', () => {
    process.env.TURF_OWNER_FEES = '1'
    expect(turfOwnerFeesEnabled()).toBe(true)
    process.env.TURF_OWNER_FEES = 'true'
    expect(turfOwnerFeesEnabled()).toBe(false)
  })
})

describe('premium math', () => {
  beforeEach(() => { process.env.TURF_OWNER_FEES = '1' })
  afterEach(() => { delete process.env.TURF_OWNER_FEES })

  it('sums floor + premium per non-owned sub for posts', () => {
    expect(postFeePiconerosForSubs(config, [sub('a', 1, 500_000_000n)])).toBe(1_500_000_000n)
    expect(postFeePiconerosForSubs(config, [sub('a', 1, 100n), sub('b', 2, 200n)])).toBe(2_000_000_300n)
  })
  it('adds single-sub comment premium only (multi-turf roots collect none)', () => {
    expect(commentFeePiconerosForSubs(config, [sub('a', 1, 0n, 700_000_000n)])).toBe(1_700_000_000n)
    expect(commentFeePiconerosForSubs(config, [sub('a', 1, 0n, 700_000_000n), sub('b', 2)])).toBe(1_000_000_000n)
  })
  it('floor-only helpers quote the platform FALLBACK charge even with stored premiums', () => {
    expect(postFloorPiconerosForSubs(config, [sub('a', 1, 500_000_000n), sub('b', 2, 200n)])).toBe(2_000_000_000n)
    expect(commentFloorPiconerosForSubs(config, [sub('a', 1, 0n, 700_000_000n)])).toBe(1_000_000_000n)
  })
  it('tolerates missing premium fields (legacy rows)', () => {
    expect(premiumPiconeros(config, {}, 'post')).toBe(0n)
    expect(commentFeePiconerosForSubs(config, [{}])).toBe(1_000_000_000n)
  })
})

describe('premiumPiconeros flag gate + config clamp', () => {
  afterEach(() => { delete process.env.TURF_OWNER_FEES })

  test('TURF_OWNER_FEES off: stored premiums are zeroed on read (kill-switch)', () => {
    delete process.env.TURF_OWNER_FEES
    const s = sub('turf', 2, 5_000_000_000n, 3_000_000_000n)
    expect(premiumPiconeros(config, s, 'post')).toBe(0n)
    expect(premiumPiconeros(config, s, 'comment')).toBe(0n)
  })

  test('flag on: stored premium above maxTurfPremiumPiconeros is clamped', () => {
    process.env.TURF_OWNER_FEES = '1'
    const tightConfig = { postingFeeFloorPiconeros: 1_000_000_000n, maxTurfPremiumPiconeros: 1_000_000_000n }
    const s = sub('turf', 2, 5_000_000_000n, 500_000_000n)
    expect(premiumPiconeros(tightConfig, s, 'post')).toBe(1_000_000_000n)
    expect(premiumPiconeros(tightConfig, s, 'comment')).toBe(500_000_000n)
  })

  test('flag on, missing config max: falls back to the static 0.01 XMR ceiling', () => {
    process.env.TURF_OWNER_FEES = '1'
    const s = sub('turf', 2, 99_000_000_000n, 0n)
    expect(premiumPiconeros(undefined, s, 'post')).toBe(MAX_TURF_PREMIUM_PICONEROS)
  })

  test('flag off: fee helpers quote floor-only even with stored premiums', () => {
    delete process.env.TURF_OWNER_FEES
    const s = sub('turf', 2, 5_000_000_000n, 3_000_000_000n)
    expect(postFeePiconerosForSubs(config, [s])).toBe(1_000_000_000n)
    expect(commentFeePiconerosForSubs(config, [s])).toBe(1_000_000_000n)
  })
})

describe('resolveOwnerFeeRoute', () => {
  const ownerAccount = { id: 9, ownerUserId: 42, address: 'addr' }
  const models = {
    sub: { findUnique: async ({ where }) => where.name === 'mine' ? sub('mine', 42) : null },
    moneroAccount: { findFirst: async ({ where }) => where.ownerUserId === 42 ? ownerAccount : null }
  }

  afterEach(() => { delete process.env.TURF_OWNER_FEES })

  it('routes when exactly one non-owned sub and its owner has a wallet', async () => {
    process.env.TURF_OWNER_FEES = '1'
    const route = await resolveOwnerFeeRoute(models, { subs: [sub('mine', 42)], userId: 7 })
    expect(route).toEqual({ sub: sub('mine', 42), ownerAccount })
  })

  it('routes for one owned + one non-owned sub (unambiguous single owner)', async () => {
    process.env.TURF_OWNER_FEES = '1'
    const route = await resolveOwnerFeeRoute(models, { subs: [sub('mine', 42), sub('yours', 7)], userId: 7 })
    expect(route?.sub.name).toBe('mine')
  })

  it('never routes cross-posts (2+ non-owned)', async () => {
    process.env.TURF_OWNER_FEES = '1'
    expect(await resolveOwnerFeeRoute(models, { subs: [sub('a', 1), sub('b', 2)], userId: 7 })).toBeNull()
  })

  it('never routes when upload fees are present', async () => {
    process.env.TURF_OWNER_FEES = '1'
    expect(await resolveOwnerFeeRoute(models, { subs: [sub('mine', 42)], userId: 7, uploadFeesPiconeros: 1n })).toBeNull()
  })

  it('never routes without the env gate', async () => {
    delete process.env.TURF_OWNER_FEES
    expect(await resolveOwnerFeeRoute(models, { subs: [sub('mine', 42)], userId: 7 })).toBeNull()
  })

  it('never routes when the owner has no registered wallet (fallback = platform)', async () => {
    process.env.TURF_OWNER_FEES = '1'
    const noWallet = {
      sub: { findUnique: async () => sub('x', 99) },
      moneroAccount: { findFirst: async () => null }
    }
    expect(await resolveOwnerFeeRoute(noWallet, { subs: [sub('x', 99)], userId: 7 })).toBeNull()
  })

  it('resolveOwnerFeeRouteForSub returns null for unknown turf', async () => {
    expect(await resolveOwnerFeeRouteForSub(models, 'nope')).toBeNull()
  })
})

describe('territorySchema premium bounds', () => {
  const base = { name: 'freenamex', desc: 'd', postTypes: ['LINK'], billingType: 'MONTHLY', nsfw: false }
  const args = { models: { sub: { findMany: async () => [] } } }

  it('accepts premiums within bounds', async () => {
    await expect(territorySchema(args).validate({ ...base, postPremiumPiconeros: 5_000_000_000n, commentPremiumPiconeros: 0n }))
      .resolves.toBeTruthy()
  })
  it('rejects negative premiums', async () => {
    await expect(territorySchema(args).validate({ ...base, postPremiumPiconeros: -1n }))
      .rejects.toThrow()
  })
  it('rejects premiums above the static ceiling', async () => {
    await expect(territorySchema(args).validate({ ...base, postPremiumPiconeros: 10_000_000_001n }))
      .rejects.toThrow()
  })
})
