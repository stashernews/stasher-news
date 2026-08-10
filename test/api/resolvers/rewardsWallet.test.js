/* eslint-env jest */

// Unit tests for Query.rewardsWalletInfo — the public transparency surface
// for the platform rewards wallet (spec §4.4, §6.4).
//
// The Prisma (`models` context) is stubbed so no DB is touched; received/sent/
// balance are ledger-derived (CONFIRMED observations vs recorded payouts + ops
// sweeps), NOT lws get_address_info (which misattributes other wallets' spends).
// The view-key decrypt path is exercised for real: the fixture envelope is
// produced by encryptViewKey under the same VIEWKEY_MASTER_KEY the resolver
// decrypts with.

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
  territoryFeeRewardsPct: 30,
  walletlessTipRewardsPct: 50,
  boostRewardsPct: 50
}

function makeModels ({ account = makeAccount(), downvotes = 0n, feeGroups = [], config = CONFIG, payoutsSent = 0n, opsSwept = 0n } = {}) {
  return {
    moneroAccount: { findFirst: jest.fn(async () => account) },
    platformFeeConfig: { findUnique: jest.fn(async () => config) },
    observedDownvote: { aggregate: jest.fn(async () => ({ _sum: { piconeros: downvotes } })) },
    feeObservation: { groupBy: jest.fn(async () => feeGroups) },
    rewardPayout: { aggregate: jest.fn(async () => ({ _sum: { piconeros: payoutsSent } })) },
    rewardDistribution: { aggregate: jest.fn(async () => ({ _sum: { opsSweptPiconeros: opsSwept } })) }
  }
}

function makeDistribution (overrides = {}) {
  return {
    id: 1,
    periodStart: new Date('2026-01-01'),
    periodEnd: new Date('2026-01-08'),
    poolPiconeros: 5_000_000_000_000n,
    distributedPiconeros: 4_000_000_000_000n,
    rolledOverPiconeros: 1_000_000_000_000n,
    payoutCount: 2,
    status: 'COMPLETE',
    startedAt: new Date('2026-01-08'),
    completedAt: new Date('2026-01-08'),
    opsInflowPiconeros: 1_500_000_000_000n,
    opsRolledOverPiconeros: 500_000_000_000n,
    opsAvailablePiconeros: 2_000_000_000_000n,
    opsSweptPiconeros: 2_000_000_000_000n,
    opsSweepTxHash: 'ab'.repeat(32),
    opsSweepState: 'SWEPT',
    payouts: [],
    ...overrides
  }
}

describe('Query.rewardsWalletInfo', () => {
  test('returns a valid address, decrypted view key, and balance = ledger received - ledger sent', async () => {
    const models = makeModels({
      downvotes: 600n,
      feeGroups: [{ feeType: 'POSTING', _sum: { piconeros: 400n } }],
      payoutsSent: 250n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.address).toBe(STAGENET_ADDR)
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$/)
    expect(result.viewKey).toBe(VIEW_KEY)
    expect(result.viewKey).toMatch(/^[0-9a-f]{64}$/)
    expect(result.network).toBe('STAGENET')
    expect(result.totalReceivedPiconeros).toBe(1000n)
    expect(result.totalSentPiconeros).toBe(250n)
    expect(result.balancePiconeros).toBe(750n)
  })

  test('counts ops sweeps toward ledger sent (they leave the wallet on-chain)', async () => {
    const models = makeModels({
      downvotes: 600n,
      feeGroups: [{ feeType: 'POSTING', _sum: { piconeros: 400n } }],
      payoutsSent: 200n,
      opsSwept: 50n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.totalSentPiconeros).toBe(250n)
    expect(result.balancePiconeros).toBe(750n)
  })

  test('rewardsEarmark + opsEarmark === balance exactly (the split invariant)', async () => {
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 150n } },
      { feeType: 'TERRITORY_BILLING', _sum: { piconeros: 150n } }
    ]
    const models = makeModels({ downvotes: 100n, feeGroups, payoutsSent: 100n })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balancePiconeros).toBe(500n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
  })

  test('applies allocation percentages proportionally against the live balance', async () => {
    // inflow: downvote 100 (100%), posting 200 (70%), territory 300 (30%)
    // rewardsNumerator = 100*100 + 200*70 + 300*30 = 33000 -> rewardsInflow 330
    // totalInflow = 600, opsInflow = 270
    // balance = 600 (no sent) -> rewardsEarmark = 600*330/600 = 330, opsEarmark = 270
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 300n } }
    ]
    const models = makeModels({ downvotes: 100n, feeGroups })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(330n)
    expect(result.opsEarmarkPiconeros).toBe(270n)
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

  test('TIP_UNWALLETED is bucketed as wallet-less tips (NOT territory) and earmarked at walletlessTipRewardsPct', async () => {
    const feeGroups = [{ feeType: 'TIP_UNWALLETED', _sum: { piconeros: 4_000_000_000n } }]
    const models = makeModels({ downvotes: 0n, feeGroups }) // no sent -> balance === inflow, so earmark === rewardsInflow

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.inflowBreakdown.walletlessTipPiconeros).toBe(4_000_000_000n)
    expect(result.inflowBreakdown.territoryFeePiconeros).toBe(0n) // NOT mislabeled as turf
    expect(result.inflowBreakdown.walletlessTipRewardsPct).toBe(50)
    // rewardsInflow = 4e9 * 50 / 100 = 2e9; opsInflow = 2e9
    expect(result.inflowBreakdown.rewardsPiconeros).toBe(2_000_000_000n)
    expect(result.inflowBreakdown.opsPiconeros).toBe(2_000_000_000n)
  })

  test('DONATE and BOOST are aggregated separately: DONATE 100% rewards, BOOST 50% rewards / 50% ops (A-14)', async () => {
    // DONATE goes 100% to the pool: full inflow earmarked to rewards.
    const donateModels = makeModels({
      downvotes: 0n,
      feeGroups: [{ feeType: 'DONATE', _sum: { piconeros: 4_000_000_000n } }]
    })
    const donateResult = await resolvers.Query.rewardsWalletInfo(null, null, { models: donateModels })

    expect(donateResult.inflowBreakdown.totalPiconeros).toBe(4_000_000_000n)
    expect(donateResult.inflowBreakdown.rewardsPiconeros).toBe(4_000_000_000n)
    expect(donateResult.inflowBreakdown.opsPiconeros).toBe(0n)
    expect(donateResult.rewardsEarmarkPiconeros).toBe(4_000_000_000n)
    expect(donateResult.opsEarmarkPiconeros).toBe(0n)

    // BOOST goes boostRewardsPct (50): half to rewards, half to ops — NOT 100%
    // rewards like DONATE.
    const boostModels = makeModels({
      downvotes: 0n,
      feeGroups: [{ feeType: 'BOOST', _sum: { piconeros: 4_000_000_000n } }]
    })
    const boostResult = await resolvers.Query.rewardsWalletInfo(null, null, { models: boostModels })

    expect(boostResult.inflowBreakdown.totalPiconeros).toBe(4_000_000_000n)
    expect(boostResult.inflowBreakdown.rewardsPiconeros).toBe(2_000_000_000n)
    expect(boostResult.inflowBreakdown.opsPiconeros).toBe(2_000_000_000n)
    expect(boostResult.rewardsEarmarkPiconeros).toBe(2_000_000_000n)
    expect(boostResult.opsEarmarkPiconeros).toBe(2_000_000_000n)
  })

  test('zero confirmed inflow and zero sent puts the whole (zero) balance in ops earmark', async () => {
    const models = makeModels({ downvotes: 0n, feeGroups: [] })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balancePiconeros).toBe(0n)
    expect(result.rewardsEarmarkPiconeros).toBe(0n)
    expect(result.opsEarmarkPiconeros).toBe(0n)
  })

  test('balanceXmr renders the live balance as a decimal XMR string', async () => {
    const models = makeModels({
      downvotes: 1_000_000_000_000n,
      feeGroups: [{ feeType: 'POSTING', _sum: { piconeros: 1_000_000_000_000n } }],
      payoutsSent: 500_000_000_000n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balanceXmr).toBe('1.5')
  })

  test('flags balanceNeedsReconciliation on a genuinely negative LEDGER balance', async () => {
    // Ledger sent (payouts) exceeding ledger received is a real accounting bug
    // (money recorded as leaving the wallet that never arrived) — unlike the
    // old lws artifact (lws claiming sent > received), this must be surfaced,
    // not clamped away.
    const models = makeModels({
      downvotes: 100n,
      feeGroups: [],
      payoutsSent: 2500n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balancePiconeros).toBe(-2400n)
    expect(result.balanceXmr).toBe('-0.0000000024')
    expect(result.balanceNeedsReconciliation).toBe(true)
  })

  test('does not flag reconciliation when ledger received >= ledger sent', async () => {
    const models = makeModels({
      downvotes: 600n,
      feeGroups: [{ feeType: 'POSTING', _sum: { piconeros: 400n } }],
      payoutsSent: 250n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balanceNeedsReconciliation).toBe(false)
    expect(result.balancePiconeros).toBe(750n)
  })

  test('throws when the platform rewards wallet is not registered', async () => {
    const models = makeModels({ account: null })

    await expect(resolvers.Query.rewardsWalletInfo(null, null, { models }))
      .rejects.toThrow(/rewards wallet/i)
  })
})

describe('Query.rewardDistributions', () => {
  function makeDistModels (distributions = []) {
    return {
      rewardDistribution: {
        findMany: jest.fn(async () => distributions)
      }
    }
  }

  test('surfaces the ops-sweep fields on each distribution', async () => {
    const dist = makeDistribution()
    const models = makeDistModels([dist])

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result).toHaveLength(1)
    expect(result[0].opsInflowPiconeros).toBe(1_500_000_000_000n)
    expect(result[0].opsAvailablePiconeros).toBe(2_000_000_000_000n)
    expect(result[0].opsSweptPiconeros).toBe(2_000_000_000_000n)
    expect(result[0].opsSweepTxHash).toBe('ab'.repeat(32))
    expect(result[0].opsSweepState).toBe('SWEPT')
  })

  test('passes a SKIPPED_LOCKED sweep through unchanged (deferred, non-swept)', async () => {
    const dist = makeDistribution({
      opsSweptPiconeros: 0n,
      opsSweepTxHash: null,
      opsSweepState: 'SKIPPED_LOCKED'
    })
    const models = makeDistModels([dist])

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result[0].opsSweepState).toBe('SKIPPED_LOCKED')
    expect(result[0].opsSweptPiconeros).toBe(0n)
    expect(result[0].opsSweepTxHash).toBeNull()
    // pending (rolled over) = opsAvailable - opsSwept = full amount deferred
    expect(result[0].opsAvailablePiconeros - result[0].opsSweptPiconeros)
      .toBe(result[0].opsAvailablePiconeros)
  })

  test('resolves curator nym and renders payout XMR amount alongside raw piconeros', async () => {
    const dist = makeDistribution({
      payouts: [{
        id: 7,
        curatorId: 42,
        curator: { name: 'satoshi' },
        piconeros: 1_000_000_000_000n,
        txHash: 'cd'.repeat(32),
        state: 'SENT'
      }]
    })
    const models = makeDistModels([dist])

    const result = await resolvers.Query.rewardDistributions(null, {}, { models })

    expect(result[0].payouts[0].curatorNym).toBe('satoshi')
    expect(result[0].payouts[0].amountXmr).toBe('1')
  })
})
