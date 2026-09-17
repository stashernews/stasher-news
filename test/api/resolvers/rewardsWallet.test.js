/* eslint-env jest */

// Unit tests for Query.rewardsWalletInfo — the public transparency surface
// for the platform rewards wallet (spec §4.4, §6.4).
//
// The Prisma (`models` context) is stubbed so no DB is touched; received/sent/
// balance are ledger-derived (CONFIRMED observations vs recorded payouts + ops
// sweeps), NOT lws get_address_info (which misattributes other wallets' spends).
// The published view key must be the address-embedded PUBLIC key, never the
// stored private one: the fixture row still carries an encrypted private view
// key (encryptViewKey under VIEWKEY_MASTER_KEY) so the assertions can prove it
// is not leaked.
//
// The rewards/ops figures are the LITERAL current allocations, not a pro-rata
// slice of the balance: rewards = the next distribution's pool (this cycle's
// rewards-earmarked inflow + the latest rollover, via lib/rewardsPool.js — the
// same computation /rewards uses), ops = the latest distribution's unswept
// carry (opsAvailablePiconeros - opsSweptPiconeros) + this cycle's ops-earmarked
// inflow (the monero_ops_pending_piconeros definition). The cycle inflow comes
// from the shared function's $queryRaw; the all-time aggregates only drive the
// ledger balance + inflowBreakdown (a cumulative display, never an allocation).

import resolvers from '@/api/resolvers/rewardsWallet'
import { encryptViewKey } from '@/api/monero/viewkey'
import { publicViewKeyFromAddress } from '@/api/monero/viewKeyCheck'
import { piconerosToXmr } from '@/lib/format'
import { collectDBBackedMetrics, register, __resetMetricsForTests } from '@/lib/metrics'

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
  walletlessTipRewardsPct: 70,
  boostRewardsPct: 30
}

// `downvotes` / `feeGroups` / `payoutsSent` / `opsSweptTotal` are the ALL-TIME
// ledger aggregates (they drive totalReceived/totalSent/balance and the
// inflowBreakdown display). `lastDistribution` and `inflow` drive the LITERAL
// allocations: the latest RewardDistribution row and this cycle's CONFIRMED
// inflow returned by the shared pool query.
function makeModels ({
  account = makeAccount(),
  downvotes = 0n,
  feeGroups = [],
  config = CONFIG,
  payoutsSent = 0n,
  opsSweptTotal = 0n,
  lastDistribution = null,
  inflow = {}
} = {}) {
  const inflowRow = {
    downvote: 0n,
    posting: 0n,
    territory: 0n,
    donate: 0n,
    donateRaw: 0n,
    boost: 0n,
    walletlesstip: 0n,
    bountyrollover: 0n,
    bountyfee: 0n,
    time: new Date('2026-09-21T00:00:00.000Z'),
    ...inflow
  }
  return {
    moneroAccount: { findFirst: jest.fn(async () => account) },
    platformFeeConfig: {
      findUnique: jest.fn(async () => config),
      upsert: jest.fn(async () => config)
    },
    observedDownvote: { aggregate: jest.fn(async () => ({ _sum: { piconeros: downvotes } })) },
    feeObservation: { groupBy: jest.fn(async () => feeGroups) },
    rewardPayout: { aggregate: jest.fn(async () => ({ _sum: { piconeros: payoutsSent } })) },
    rewardDistribution: {
      aggregate: jest.fn(async () => ({ _sum: { opsSweptPiconeros: opsSweptTotal } })),
      findFirst: jest.fn(async () => lastDistribution)
    },
    observedTip: { count: jest.fn(async () => 0) },
    $queryRaw: jest.fn(async () => [inflowRow])
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
  test('returns a valid address, the embedded public view key, and balance = ledger received - ledger sent', async () => {
    const models = makeModels({
      downvotes: 600n,
      feeGroups: [{ feeType: 'POSTING', _sum: { piconeros: 400n } }],
      payoutsSent: 250n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.address).toBe(STAGENET_ADDR)
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{95}$/)
    expect(result.viewKey).toBe(publicViewKeyFromAddress(STAGENET_ADDR))
    expect(result.viewKey).not.toBe(VIEW_KEY)
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
      opsSweptTotal: 50n
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.totalSentPiconeros).toBe(250n)
    expect(result.balancePiconeros).toBe(750n)
  })

  test('post-FAILED-sweep: rewards is the pool (rollover only) and ops is the full unswept amount; both literal, sum == balance', async () => {
    // Worked production state (2026-09-14): dist #2 payouts all SENT, the ops
    // sweep FAILED (opsSwept 0), no new confirmed inflow this cycle. The page
    // must show the literal 7_516_894_999 / 252_159_000_000, not the old
    // pro-rata slice (104_595_455_411 / 155_080_439_588).
    //
    // The all-time ledger mix is chosen so the OLD pro-rata code returns
    // exactly production's misleading 104_595_455_411 / 155_080_439_588 for
    // this stub (downvote 100% rewards, BOUNTY_FEE 100% ops, balance ==
    // all-time inflow), making the regression pointed rather than incidental.
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 7_516_894_999n,
      opsAvailablePiconeros: 252_159_000_000n,
      opsSweptPiconeros: 0n,
      opsSweepState: 'FAILED'
    })
    const models = makeModels({
      downvotes: 104_595_455_411n,
      feeGroups: [{ feeType: 'BOUNTY_FEE', _sum: { piconeros: 155_080_439_588n } }],
      lastDistribution
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(7_516_894_999n)
    expect(result.opsEarmarkPiconeros).toBe(252_159_000_000n)
    expect(result.nextPoolPiconeros).toBe(7_516_894_999n)
    expect(result.pendingSweepPiconeros).toBe(252_159_000_000n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(259_675_894_999n)

    // acceptance #1: the exact strings the transparency page renders
    expect(piconerosToXmr(result.nextPoolPiconeros)).toBe('0.007516894999 XMR')
    expect(piconerosToXmr(result.pendingSweepPiconeros)).toBe('0.252159 XMR')
  })

  test('fresh DB (no distributions): rewards = this cycle rewards earmark, ops = this cycle ops earmark', async () => {
    // Before the first distribution the pool is just this cycle's earmark and
    // nothing has ever been swept, so ops is the cycle's ops share.
    const models = makeModels({
      downvotes: 8_000_000_000n,
      inflow: {
        downvote: 1_000_000_000n,
        posting: 1_000_000_000n,
        territory: 2_000_000_000n,
        donate: 4_000_000_000n,
        donateRaw: 4_000_000_000n
      }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    // downvote 100% + posting 70% + territory 30% + donation 100%
    expect(result.rewardsEarmarkPiconeros).toBe(6_300_000_000n)
    // raw cycle inflow 8e9 - rewards earmark 6.3e9
    expect(result.opsEarmarkPiconeros).toBe(1_700_000_000n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(8_000_000_000n)
  })

  test('fresh DB: a DONATE routed 50% to the pool contributes its raw amount to the ops fallback, not the scaled one', async () => {
    const models = makeModels({
      downvotes: 4_000_000_000n,
      inflow: { donate: 2_000_000_000n, donateRaw: 4_000_000_000n }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(2_000_000_000n)
    expect(result.opsEarmarkPiconeros).toBe(2_000_000_000n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(4_000_000_000n)
  })

  test('normal completed week: ops is 0 once the latest sweep landed; rewards is the new cycle inflow', async () => {
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 10_000_000_000n,
      opsSweptPiconeros: 10_000_000_000n,
      opsSweepState: 'SWEPT'
    })
    const models = makeModels({
      // ledger: received 17e9 - (5e9 payouts + 10e9 swept) = 2e9 balance
      downvotes: 17_000_000_000n,
      payoutsSent: 5_000_000_000n,
      opsSweptTotal: 10_000_000_000n,
      lastDistribution,
      inflow: { downvote: 2_000_000_000n }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(2_000_000_000n)
    expect(result.opsEarmarkPiconeros).toBe(0n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(2_000_000_000n)
  })

  test('rollover week: the pool includes the prior distribution rolledOverPiconeros', async () => {
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 7_516_894_999n,
      opsAvailablePiconeros: 3_000_000_000n,
      opsSweptPiconeros: 1_000_000_000n
    })
    const models = makeModels({
      downvotes: 11_516_894_999n,
      opsSweptTotal: 1_000_000_000n,
      lastDistribution,
      inflow: { downvote: 1_000_000_000n }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(8_516_894_999n)
    expect(result.opsEarmarkPiconeros).toBe(2_000_000_000n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(10_516_894_999n)
  })

  test('open-cycle POSTING + BOOST inflow counts toward ops even when the prior sweep landed (carry 0)', async () => {
    // Regression for the truncated ops definition: the prior distribution is
    // fully settled and swept (carry 0), but the OPEN week takes 1_000 posting
    // (70/30) + 1_000 boost (30/70) — rewards earmark 700 + 300 = 1_000, ops
    // earmark 300 + 700 = 1_000. The old definition reported ops = 0 until the
    // next distribution ran, while the ledger balance already held that 1_000
    // (the transparency page's two figures failed to sum to the balance).
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 42n,
      opsAvailablePiconeros: 100n,
      opsSweptPiconeros: 100n,
      opsSweepState: 'SWEPT'
    })
    const models = makeModels({
      // ledger: received 3000 - (858 payouts + 100 swept) = 2042 balance
      downvotes: 3_000n,
      payoutsSent: 858n,
      opsSweptTotal: 100n,
      lastDistribution,
      inflow: { posting: 1_000n, boost: 1_000n }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(1_042n) // 42 rollover + 1_000 open rewards
    expect(result.opsEarmarkPiconeros).toBe(1_000n) // carry 0 + 1_000 open ops
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(2_042n)
  })

  test('a prior partial sweep: ops = unswept carry + the open-cycle ops earmark', async () => {
    // The latest distribution swept only part of its ops (2_000 of 5_000, e.g.
    // SKIPPED_LOCKED mid-sweep), so 3_000 carries; the open week adds 1_000
    // posting (70/30) -> 700 rewards / 300 ops. Ops must be the full 3_300, not
    // just the 3_000 carry.
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 1_000n,
      opsAvailablePiconeros: 5_000n,
      opsSweptPiconeros: 2_000n,
      opsSweepState: 'SKIPPED_LOCKED'
    })
    const models = makeModels({
      // ledger: received 8000 - (1000 payouts + 2000 swept) = 5000 balance
      downvotes: 8_000n,
      payoutsSent: 1_000n,
      opsSweptTotal: 2_000n,
      lastDistribution,
      inflow: { posting: 1_000n }
    })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.rewardsEarmarkPiconeros).toBe(1_700n) // 1_000 rollover + 700 open rewards
    expect(result.opsEarmarkPiconeros).toBe(3_300n) // 3_000 carry + 300 open ops
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
    expect(result.balancePiconeros).toBe(5_000n)
  })

  test('pendingSweepPiconeros agrees with the monero_ops_pending_piconeros metric for the same distribution', async () => {
    __resetMetricsForTests()
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 252_159_000_000n,
      opsSweptPiconeros: 12_159_000_000n
    })
    const models = makeModels({ downvotes: 240_000_000_000n, lastDistribution })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })
    await collectDBBackedMetrics(models)

    expect(result.pendingSweepPiconeros).toBe(240_000_000_000n)
    expect(await metricValue('monero_ops_pending_piconeros')).toBe(Number(result.pendingSweepPiconeros))
  })

  test('does not scale allocations pro-rata against the balance (literal-allocation regression)', async () => {
    // All-time ledger: 600 received, 558 already paid => balance 42.
    // The latest distribution rolled over 42 and swept everything, so the
    // literal allocations are 42/0 — the old pro-rata math would have split
    // 42 by the all-time 330/270 mix (23/19).
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 300n } }
    ]
    const lastDistribution = makeDistribution({
      rolledOverPiconeros: 42n,
      opsAvailablePiconeros: 1n,
      opsSweptPiconeros: 1n
    })
    const models = makeModels({ downvotes: 100n, feeGroups, payoutsSent: 558n, lastDistribution })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.balancePiconeros).toBe(42n)
    expect(result.rewardsEarmarkPiconeros).toBe(42n)
    expect(result.opsEarmarkPiconeros).toBe(0n)
    expect(result.rewardsEarmarkPiconeros + result.opsEarmarkPiconeros).toBe(result.balancePiconeros)
  })

  test('splits all-time inflow by the allocation percentages for the inflowBreakdown display (unchanged)', async () => {
    // inflow: downvote 100 (100%), posting 200 (70%), territory 300 (30%)
    // rewardsNumerator = 100*100 + 200*70 + 300*30 = 33000 -> rewardsInflow 330
    // totalInflow = 600, opsInflow = 270
    const feeGroups = [
      { feeType: 'POSTING', _sum: { piconeros: 200n } },
      { feeType: 'TERRITORY_CREATE', _sum: { piconeros: 300n } }
    ]
    const models = makeModels({ downvotes: 100n, feeGroups })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

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

  test('TIP_UNWALLETED is bucketed as wallet-less tips (NOT territory) and split at walletlessTipRewardsPct', async () => {
    const feeGroups = [{ feeType: 'TIP_UNWALLETED', _sum: { piconeros: 4_000_000_000n } }]
    const models = makeModels({ downvotes: 0n, feeGroups })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.inflowBreakdown.walletlessTipPiconeros).toBe(4_000_000_000n)
    expect(result.inflowBreakdown.territoryFeePiconeros).toBe(0n) // NOT mislabeled as turf
    expect(result.inflowBreakdown.walletlessTipRewardsPct).toBe(70)
    // rewardsInflow = 4e9 * 70 / 100 = 2.8e9; opsInflow = 1.2e9
    expect(result.inflowBreakdown.rewardsPiconeros).toBe(2_800_000_000n)
    expect(result.inflowBreakdown.opsPiconeros).toBe(1_200_000_000n)
  })

  test('DONATE and BOOST are aggregated separately in the all-time breakdown: DONATE 100% rewards, BOOST 30% rewards / 70% ops (A-14)', async () => {
    // DONATE goes 100% to the pool: full inflow counted to rewards.
    const donateModels = makeModels({
      downvotes: 0n,
      feeGroups: [{ feeType: 'DONATE', _sum: { piconeros: 4_000_000_000n } }]
    })
    const donateResult = await resolvers.Query.rewardsWalletInfo(null, null, { models: donateModels })

    expect(donateResult.inflowBreakdown.totalPiconeros).toBe(4_000_000_000n)
    expect(donateResult.inflowBreakdown.rewardsPiconeros).toBe(4_000_000_000n)
    expect(donateResult.inflowBreakdown.opsPiconeros).toBe(0n)

    // BOOST goes boostRewardsPct (30): 30% to rewards, 70% to ops — NOT 100%
    // rewards like DONATE.
    const boostModels = makeModels({
      downvotes: 0n,
      feeGroups: [{ feeType: 'BOOST', _sum: { piconeros: 4_000_000_000n } }]
    })
    const boostResult = await resolvers.Query.rewardsWalletInfo(null, null, { models: boostModels })

    expect(boostResult.inflowBreakdown.totalPiconeros).toBe(4_000_000_000n)
    expect(boostResult.inflowBreakdown.rewardsPiconeros).toBe(1_200_000_000n)
    expect(boostResult.inflowBreakdown.opsPiconeros).toBe(2_800_000_000n)
  })

  test('a donation with donationRewardsPct=50 splits 50/50 in the all-time breakdown', async () => {
    const models = makeModels({
      downvotes: 0n,
      feeGroups: [{ feeType: 'DONATE', donationRewardsPct: 50, _sum: { piconeros: 4_000_000_000n } }]
    })
    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    expect(result.inflowBreakdown.totalPiconeros).toBe(4_000_000_000n)
    expect(result.inflowBreakdown.rewardsPiconeros).toBe(2_000_000_000n)
    expect(result.inflowBreakdown.opsPiconeros).toBe(2_000_000_000n)
  })

  test('BOUNTY_ROLLOVER flows 100% to rewards; BOUNTY_FEE flows 0% to rewards but counts to the ledger (A-13 final)', async () => {
    // Rollover: the escrow's bounty portion physically arrives at the rewards
    // wallet — 100% rewards, same treatment as DONATE. Bounty fee: booked at
    // funding confirmation, rides the rollover tx into the wallet — it counts
    // to totalReceived/totalInflow but 0% toward the rewards numerator (ops).
    const feeGroups = [
      { feeType: 'BOUNTY_ROLLOVER', _sum: { piconeros: 4_000_000_000n } },
      { feeType: 'BOUNTY_FEE', _sum: { piconeros: 1_000_000_000n } }
    ]
    const models = makeModels({ downvotes: 0n, feeGroups })

    const result = await resolvers.Query.rewardsWalletInfo(null, null, { models })

    // Both physically arrived at the wallet, so both are ledger received.
    expect(result.totalReceivedPiconeros).toBe(5_000_000_000n)
    // Rollover counts 100% to rewards; the fee 0% (ops).
    expect(result.inflowBreakdown.rewardsPiconeros).toBe(4_000_000_000n)
    expect(result.inflowBreakdown.opsPiconeros).toBe(1_000_000_000n)
    expect(result.inflowBreakdown.totalPiconeros).toBe(5_000_000_000n)
  })

  test('all-zero fresh DB: both literal allocations are zero', async () => {
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

// Reads a gauge value out of the shared Prometheus registry exposition
// (mirrors test/lib/metrics.test.js) so the ops allocation is pinned to the
// monero_ops_pending_piconeros metric definition.
async function metricValue (name) {
  const exposition = await register.metrics()
  const line = exposition.split('\n').find(l => {
    if (!l.startsWith(name)) return false
    const rest = l.slice(name.length)
    return rest.startsWith(' ') || rest.startsWith('{')
  })
  if (!line) throw new Error(`metric ${name} not found in exposition`)
  return Number(line.trim().split(/\s+/).pop())
}
