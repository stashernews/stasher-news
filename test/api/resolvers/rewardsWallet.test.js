/* eslint-env jest */

// Unit tests for Query.rewardsWalletInfo — the public transparency surface
// for the platform rewards wallet (spec §4.4, §6.4).
//
// The lwsClient (`monero` context) and Prisma (`models` context) are stubbed
// so no network or DB is touched. The view-key decrypt path is exercised for
// real: the fixture envelope is produced by encryptViewKey under the same
// VIEWKEY_MASTER_KEY the resolver decrypts with.

import resolvers from '@/api/resolvers/rewardsWallet'
import { encryptViewKey } from '@/api/monero/viewkey'

process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')
process.env.MONERO_NETWORK = 'stagenet'

const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
const VIEW_KEY = '5580e0440c77c9b720950defd0bcfbd87b6a10f098ed345fac290c7f48b3c60e'

function makeAccount (overrides = {}) {
  return {
    id: 1,
    address: STAGENET_ADDR,
    label: 'platform_rewards',
    network: 'STAGENET',
    viewKey: encryptViewKey(VIEW_KEY),
    ...overrides
  }
}

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30
}

function makeModels ({ account = makeAccount(), burns = 0n, feeGroups = [], config = CONFIG } = {}) {
  return {
    moneroAccount: { findFirst: jest.fn(async () => account) },
    platformFeeConfig: { findUnique: jest.fn(async () => config) },
    observedBurn: { aggregate: jest.fn(async () => ({ _sum: { piconeros: burns } })) },
    feeObservation: { groupBy: jest.fn(async () => feeGroups) }
  }
}

function makeMonero (received = 0n, sent = 0n) {
  return {
    getAddressInfo: jest.fn(async () => ({ total_received: received, total_sent: sent }))
  }
}

describe('Query.rewardsWalletInfo', () => {
  test('returns a valid address, decrypted view key, and balance = received - sent', async () => {
    const models = makeModels({ burns: 0n, feeGroups: [] })
    const monero = makeMonero(1000n, 250n)

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models, monero })

    expect(result.address).toBe(STAGENET_ADDR)
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$/)
    expect(result.viewKey).toBe(VIEW_KEY)
    expect(result.viewKey).toMatch(/^[0-9a-f]{64}$/)
    expect(result.network).toBe('STAGENET')
    expect(result.totalReceivedPiconeros).toBe(1000n)
    expect(result.totalSentPiconeros).toBe(250n)
    expect(result.balancePiconeros).toBe(750n)
  })

  test('rewardsEarmark + opsEarmark === balance exactly (the split invariant)', async () => {
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 150n } },
      { feeType: 'TERRITORY_BILLING', _sum: { piconeros: 150n } }
    ]
    const models = makeModels({ burns: 100n, feeGroups })
    const monero = makeMonero(1000n, 100n)

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models, monero })

    expect(result.balancePiconeros).toBe(900n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
  })

  test('applies allocation percentages proportionally against the live balance', async () => {
    // inflow: downvote 100 (100%), posting 200 (70%), territory 300 (30%)
    // rewardsNumerator = 100*100 + 200*70 + 300*30 = 33000 -> rewardsInflow 330
    // totalInflow = 600, opsInflow = 270
    // balance = 900 -> rewardsEarmark = 900*330/600 = 495, opsEarmark = 405
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 300n } }
    ]
    const models = makeModels({ burns: 100n, feeGroups })
    const monero = makeMonero(1000n, 100n)

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models, monero })

    expect(result.rewardsEarmarkPiconeros).toBe(495n)
    expect(result.opsEarmarkPiconeros).toBe(405n)
    expect(result.inflowBreakdown.rewardsPiconeros).toBe(330n)
    expect(result.inflowBreakdown.opsPiconeros).toBe(270n)
    expect(result.inflowBreakdown.totalPiconeros).toBe(600n)
    expect(result.inflowBreakdown.downvotePiconeros).toBe(100n)
    expect(result.inflowBreakdown.postingFeePiconeros).toBe(200n)
    expect(result.inflowBreakdown.territoryFeePiconeros).toBe(300n)
    expect(result.inflowBreakdown.downvoteRewardsPct).toBe(100)
    expect(result.inflowBreakdown.postingFeeRewardsPct).toBe(70)
    expect(result.inflowBreakdown.territoryFeeRewardsPct).toBe(30)
  })

  test('zero confirmed inflow puts the whole balance in ops earmark', async () => {
    const models = makeModels({ burns: 0n, feeGroups: [] })
    const monero = makeMonero(500n, 100n)

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models, monero })

    expect(result.balancePiconeros).toBe(400n)
    expect(result.rewardsEarmarkPiconeros).toBe(0n)
    expect(result.opsEarmarkPiconeros).toBe(400n)
  })

  test('balanceXmr renders the live balance as a decimal XMR string', async () => {
    const models = makeModels()
    const monero = makeMonero(1500000000000n, 500000000000n)

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models, monero })

    expect(result.balanceXmr).toBe('1')
  })

  test('throws when the platform rewards wallet is not registered', async () => {
    const models = makeModels({ account: null })
    const monero = makeMonero()

    await expect(resolvers.Query.rewardsWalletInfo(null, null, { models, monero }))
      .rejects.toThrow(/rewards wallet/i)
  })
})
