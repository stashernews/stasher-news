/* eslint-env jest */
import { money, allocateInflow, opsCarry, sweepDebitLimit, standingReserve, walletScope } from '@/lib/rewardsAccounting'
import { rewardsFromInflow } from '@/lib/rewardsPool'

// Exact BigInt money accounting for the platform rewards hot wallet (rewards
// accounting repair §5). Pure helpers: no DB, no wallet, import inert.

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  boostRewardsPct: 30,
  walletlessTipRewardsPct: 70
}

describe('money', () => {
  test('converts exact decimal strings and BigInts', () => {
    expect(money('9007199254740993')).toBe(9007199254740993n)
    expect(money(3n)).toBe(3n)
    expect(money(0)).toBe(0n)
    expect(money(-5n)).toBe(-5n)
  })

  test('refuses rounded numbers and unknown values', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow(/unsafe/i)
    expect(() => money(1.5)).toThrow(/unsafe/i)
    expect(() => money(null)).toThrow(/unknown/i)
    expect(() => money(undefined)).toThrow(/unknown/i)
  })
})

describe('opsCarry', () => {
  test('expenses after the last checkpoint reduce carry once, without hiding debt', () => {
    const distribution = { opsAvailablePiconeros: 20n, opsSweptPiconeros: 10n, opsNetworkFeesAccountedPiconeros: 4n }
    expect(opsCarry({ distribution, totalNetworkFeesPiconeros: 7n, provenSweptPiconeros: 10n })).toBe(7n)
    expect(opsCarry({ distribution, totalNetworkFeesPiconeros: 17n, provenSweptPiconeros: 10n })).toBe(-3n)
    // No distribution yet: zero available/swept/expense checkpoint, but network
    // costs already incurred still debit this cycle's ops.
    expect(opsCarry({ distribution: null, totalNetworkFeesPiconeros: 3n, provenSweptPiconeros: 0n })).toBe(-3n)
  })

  test('journal-proven sweep principal substitutes for the recorded swept amount', () => {
    const distribution = { opsAvailablePiconeros: 20n, opsSweptPiconeros: 10n, opsNetworkFeesAccountedPiconeros: 4n }
    expect(opsCarry({ distribution, totalNetworkFeesPiconeros: 7n, provenSweptPiconeros: 15n })).toBe(2n)
  })
})

describe('sweepDebitLimit', () => {
  test('sweep debit protects outstanding rewards, next pool and reserve', () => {
    expect(sweepDebitLimit({
      opsPiconeros: 70n,
      unlockedPiconeros: 100n,
      commitmentsPiconeros: 20n,
      nextPoolPiconeros: 50n,
      reservePiconeros: 5n
    })).toBe(25n)
    expect(sweepDebitLimit({
      opsPiconeros: -1n,
      unlockedPiconeros: 100n,
      commitmentsPiconeros: 0n,
      nextPoolPiconeros: 0n,
      reservePiconeros: 5n
    })).toBe(0n)
  })

  test('never returns a negative limit and refuses negative commitments', () => {
    expect(sweepDebitLimit({
      opsPiconeros: 0n,
      unlockedPiconeros: 0n,
      commitmentsPiconeros: 0n,
      nextPoolPiconeros: 0n,
      reservePiconeros: 0n
    })).toBe(0n)
    expect(() => sweepDebitLimit({
      opsPiconeros: 1n,
      unlockedPiconeros: 1n,
      commitmentsPiconeros: -1n,
      nextPoolPiconeros: 0n,
      reservePiconeros: 0n
    })).toThrow(/negative/i)
  })
})

describe('standingReserve', () => {
  test('counts funded accounts and never sits below the dust floor', () => {
    expect(standingReserve({ 0: 0n, 1: 8n, 2: 9n }, { feeHeadroom: 2n, dustFloor: 1n })).toBe(4n)
    // No funded account still reserves one allowance.
    expect(standingReserve({ 0: 0n }, { feeHeadroom: 2n, dustFloor: 1n })).toBe(2n)
    // One allowance is below the dust floor: the floor wins.
    expect(standingReserve({ 0: 1n }, { feeHeadroom: 2n, dustFloor: 5n })).toBe(5n)
  })

  test('refuses negative headroom or dust floor', () => {
    expect(() => standingReserve({ 0: 1n }, { feeHeadroom: -1n, dustFloor: 1n })).toThrow(/negative/i)
    expect(() => standingReserve({ 0: 1n }, { feeHeadroom: 1n, dustFloor: -1n })).toThrow(/negative/i)
  })
})

describe('allocateInflow', () => {
  const raw = overrides => ({
    downvote: 0n,
    posting: 0n,
    territory: 0n,
    donate: 0n,
    donateRaw: 0n,
    boost: 0n,
    walletlesstip: 0n,
    bountyrollover: 0n,
    bountyrolloverRewards: null,
    bountyfee: 0n,
    ...overrides
  })

  test('a mixed net rollover keeps its exact rewards split and its fee rides in ops', () => {
    const result = allocateInflow(raw({ bountyrollover: 139n, bountyrolloverRewards: 100n, bountyfee: 9n }), CONFIG)
    expect(result.totalPiconeros).toBe(148n)
    expect(result.rewardsPiconeros).toBe(100n)
    expect(result.opsPiconeros).toBe(48n)
    expect(result.sources).toEqual([{ name: 'bounty rollovers', value: '100' }])
  })

  test('a NULL rewards component keeps the legacy full-rollover-to-rewards rule', () => {
    const result = allocateInflow(raw({ bountyrollover: 139n }), CONFIG)
    expect(result.totalPiconeros).toBe(139n)
    expect(result.rewardsPiconeros).toBe(139n)
    expect(result.opsPiconeros).toBe(0n)
  })

  test('an explicit zero rollover reward sends the whole receipt to ops', () => {
    const result = allocateInflow(raw({ bountyrollover: 139n, bountyrolloverRewards: 0n }), CONFIG)
    expect(result.totalPiconeros).toBe(139n)
    expect(result.rewardsPiconeros).toBe(0n)
    expect(result.opsPiconeros).toBe(139n)
    expect(result.sources).toEqual([])
  })

  test('floors each percentage source independently and preserves source order', () => {
    const result = allocateInflow(raw({
      downvote: 10n,
      posting: 101n,
      territory: 101n,
      donate: 33n,
      donateRaw: 50n,
      boost: 101n,
      walletlesstip: 101n,
      bountyrollover: 9n,
      bountyrolloverRewards: 4n,
      bountyfee: 7n
    }), CONFIG)
    expect(result.sources).toEqual([
      { name: 'downvote', value: '10' },
      { name: 'posting fee', value: '70' }, // floor(101 * 70 / 100)
      { name: 'turf fee', value: '30' }, // floor(101 * 30 / 100)
      { name: 'donations', value: '33' }, // already scaled per row by the reader
      { name: 'boosts', value: '30' },
      { name: 'wallet-less tips', value: '70' },
      { name: 'bounty rollovers', value: '4' }
    ])
    expect(result.rewardsPiconeros).toBe(10n + 70n + 30n + 33n + 30n + 70n + 4n)
    // DONATE's raw total (donateRaw) feeds the true inflow, its reward-scaled
    // total (donate) feeds the pool — the two stay distinct.
    expect(result.totalPiconeros).toBe(10n + 101n + 101n + 50n + 101n + 101n + 9n + 7n)
    expect(result.opsPiconeros).toBe(result.totalPiconeros - result.rewardsPiconeros)
    // bounty fees are 100% ops: no bounty-fees source even when nonzero
    expect(result.sources.some(s => s.name === 'bounty fees')).toBe(false)
  })

  test('percentage boundaries 0 and 100 are exact for every percentage source', () => {
    const zero = allocateInflow(raw({ downvote: 5n, posting: 5n, territory: 5n, boost: 5n, walletlesstip: 5n }), {
      downvoteRewardsPct: 0,
      postingFeeRewardsPct: 0,
      territoryFeeRewardsPct: 0,
      boostRewardsPct: 0,
      walletlessTipRewardsPct: 0
    })
    expect(zero.rewardsPiconeros).toBe(0n)
    expect(zero.opsPiconeros).toBe(25n)
    expect(zero.sources).toEqual([])

    const full = allocateInflow(raw({ downvote: 5n, posting: 5n, territory: 5n, boost: 5n, walletlesstip: 5n }), {
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 100,
      territoryFeeRewardsPct: 100,
      boostRewardsPct: 100,
      walletlessTipRewardsPct: 100
    })
    expect(full.rewardsPiconeros).toBe(25n)
    expect(full.opsPiconeros).toBe(0n)
    expect(full.sources).toEqual([
      { name: 'downvote', value: '5' },
      { name: 'posting fee', value: '5' },
      { name: 'turf fee', value: '5' },
      { name: 'boosts', value: '5' },
      { name: 'wallet-less tips', value: '5' }
    ])
  })

  test('negative inputs stay exact and signed instead of clamped', () => {
    const result = allocateInflow(raw({ posting: -3n, bountyfee: -2n }), CONFIG)
    expect(result.totalPiconeros).toBe(-5n)
    expect(result.rewardsPiconeros).toBe(-2n) // -3 * 70 / 100 truncates toward zero
    expect(result.opsPiconeros).toBe(-3n)
    expect(result.sources).toEqual([])
  })

  test('a legacy inflow without donateRaw or bountyrolloverRewards still allocates', () => {
    const legacy = { downvote: 100n, posting: 100n, territory: 100n, donate: 40n, boost: 0n, walletlesstip: 0n, bountyrollover: 10n, bountyfee: 0n }
    const result = allocateInflow(legacy, CONFIG)
    expect(result.totalPiconeros).toBe(350n)
    expect(result.rewardsPiconeros).toBe(100n + 70n + 30n + 40n + 10n)
  })
})

describe('rewardsFromInflow', () => {
  test('delegates to allocateInflow and keeps the { total, time, sources } API', () => {
    const time = new Date('2026-10-12T00:00:00.000Z')
    const inflow = { downvote: 10n, posting: 101n, territory: 0n, donate: 40n, boost: 0n, walletlesstip: 0n, bountyrollover: 5n, bountyfee: 3n }
    const allocated = allocateInflow(inflow, CONFIG)
    expect(rewardsFromInflow(inflow, time, CONFIG)).toEqual({
      total: allocated.rewardsPiconeros,
      time,
      sources: allocated.sources
    })
  })
})

describe('walletScope', () => {
  let savedAddress
  let savedNetwork

  beforeEach(() => {
    savedAddress = process.env.PLATFORM_REWARDS_ADDRESS
    savedNetwork = process.env.MONERO_NETWORK
    delete process.env.PLATFORM_REWARDS_ADDRESS
    delete process.env.MONERO_NETWORK
  })

  afterEach(() => {
    if (savedAddress === undefined) delete process.env.PLATFORM_REWARDS_ADDRESS
    else process.env.PLATFORM_REWARDS_ADDRESS = savedAddress
    if (savedNetwork === undefined) delete process.env.MONERO_NETWORK
    else process.env.MONERO_NETWORK = savedNetwork
  })

  test('reads the configured identity and defaults to STAGENET', () => {
    process.env.PLATFORM_REWARDS_ADDRESS = '5REWARDS'
    expect(walletScope()).toEqual({ network: 'STAGENET', walletAddress: '5REWARDS' })
  })

  test('accepts an explicit MAINNET identity', () => {
    process.env.PLATFORM_REWARDS_ADDRESS = '4REWARDS'
    process.env.MONERO_NETWORK = 'mainnet'
    expect(walletScope()).toEqual({ network: 'MAINNET', walletAddress: '4REWARDS' })
  })

  test('refuses a missing or empty identity', () => {
    expect(() => walletScope()).toThrow(/PLATFORM_REWARDS_ADDRESS/)
    process.env.PLATFORM_REWARDS_ADDRESS = '   '
    expect(() => walletScope()).toThrow(/PLATFORM_REWARDS_ADDRESS/)
  })

  test('refuses an unsupported network without echoing the identity', () => {
    process.env.PLATFORM_REWARDS_ADDRESS = '5TOPSECRETIDENTITY'
    process.env.MONERO_NETWORK = 'testnet'
    let message = null
    try { walletScope() } catch (err) { message = err.message }
    expect(message).toMatch(/network/i)
    expect(message).not.toContain('5TOPSECRETIDENTITY')
  })
})
