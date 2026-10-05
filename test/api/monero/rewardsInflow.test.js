/* eslint-env jest */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { rewardsFromInflow } from '@/lib/rewardsPool'

// One parameterized reader for CONFIRMED rewards-hot-wallet inflow (rewards
// accounting repair §5). Every fee-source subselect requires walletReceipt=true
// and the same [start, end) window; BOUNTY_ROLLOVER receipts mix an exact
// reward component (rewardsPiconeros) with the ops remainder. The mocked
// contracts run everywhere; the real-DB window/eligibility/flooring checks run
// only against the dedicated isolated database.

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  boostRewardsPct: 30,
  walletlessTipRewardsPct: 70
}

const TIME = new Date('2026-10-12T00:00:00.000Z')
const ZERO_ROW = {
  downvote: 0n,
  posting: 0n,
  territory: 0n,
  donate: 0n,
  donateRaw: 0n,
  boost: 0n,
  walletlesstip: 0n,
  bountyrollover: 0n,
  bountyrolloverRewards: 0n,
  bountyfee: 0n
}

function mockModels (row = {}) {
  return { $queryRaw: jest.fn().mockResolvedValue([{ ...ZERO_ROW, time: TIME, ...row }]) }
}

test('a mixed net rollover and a hot fee preserve exact rewards versus ops', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{
      downvote: 0n,
      posting: 0n,
      territory: 0n,
      donate: 0n,
      donateRaw: 0n,
      boost: 0n,
      walletlesstip: 0n,
      bountyrollover: 139n,
      bountyrolloverRewards: 100n,
      bountyfee: 9n,
      time: new Date('2026-10-12T00:00:00Z')
    }])
  }
  const inflow = await readRewardsInflow(models, { start: new Date('2026-10-05'), config: CONFIG })
  expect(inflow.totalPiconeros).toBe(148n)
  expect(inflow.rewardsPiconeros).toBe(100n)
  expect(inflow.opsPiconeros).toBe(48n)
  // The ops component absorbs the escrow-fee shortfall (139 - 100) plus the fee receipt.
  expect(inflow.sources).toEqual([{ name: 'bounty rollovers', value: '100' }])
})

test('returns the complete raw row plus the allocation', async () => {
  const models = mockModels({
    downvote: 7n,
    posting: 101n,
    territory: 101n,
    donate: 70n,
    donateRaw: 101n,
    boost: 101n,
    walletlesstip: 101n,
    bountyrollover: 139n,
    bountyrolloverRewards: 100n,
    bountyfee: 9n
  })
  const inflow = await readRewardsInflow(models, { start: new Date('2026-10-05'), config: CONFIG })

  expect(inflow.raw).toEqual({
    downvote: 7n,
    posting: 101n,
    territory: 101n,
    donate: 70n,
    donateRaw: 101n,
    boost: 101n,
    walletlesstip: 101n,
    bountyrollover: 139n,
    bountyrolloverRewards: 100n,
    bountyfee: 9n,
    time: TIME
  })
  expect(inflow.totalPiconeros).toBe(7n + 101n + 101n + 101n + 101n + 101n + 139n + 9n)
  expect(inflow.rewardsPiconeros).toBe(7n + 70n + 30n + 70n + 30n + 70n + 100n)
  expect(inflow.opsPiconeros).toBe(inflow.totalPiconeros - inflow.rewardsPiconeros)
  expect(inflow.sources).toEqual([
    { name: 'downvote', value: '7' },
    { name: 'posting fee', value: '70' },
    { name: 'turf fee', value: '30' },
    { name: 'donations', value: '70' },
    { name: 'boosts', value: '30' },
    { name: 'wallet-less tips', value: '70' },
    { name: 'bounty rollovers', value: '100' }
  ])
})

test('a legacy rollover row (SQL resolves its missing split to the full amount) is rewarded in full', async () => {
  const models = mockModels({ bountyrollover: 139n, bountyrolloverRewards: 139n })
  const inflow = await readRewardsInflow(models, { start: new Date('2026-10-05'), config: CONFIG })
  expect(inflow.rewardsPiconeros).toBe(139n)
  expect(inflow.opsPiconeros).toBe(0n)
})

test('an explicit zero rollover reward sends the whole receipt to ops', async () => {
  const models = mockModels({ bountyrollover: 139n, bountyrolloverRewards: 0n })
  const inflow = await readRewardsInflow(models, { start: new Date('2026-10-05'), config: CONFIG })
  expect(inflow.totalPiconeros).toBe(139n)
  expect(inflow.rewardsPiconeros).toBe(0n)
  expect(inflow.opsPiconeros).toBe(139n)
  expect(inflow.sources).toEqual([])
})

test('negative values flow through signed rather than being clamped', async () => {
  const inflow = await readRewardsInflow(mockModels({ posting: -3n, bountyfee: -2n }), { start: new Date('2026-10-05'), config: CONFIG })
  expect(inflow.totalPiconeros).toBe(-5n)
  expect(inflow.rewardsPiconeros).toBe(-2n)
  expect(inflow.opsPiconeros).toBe(-3n)
})

test('the raw row stays valid input for rewardsFromInflow, mixed split included', async () => {
  const models = mockModels({ bountyrollover: 139n, bountyrolloverRewards: 100n, bountyfee: 9n })
  const inflow = await readRewardsInflow(models, { start: new Date('2026-10-05'), config: CONFIG })
  const legacy = rewardsFromInflow(inflow.raw, inflow.raw.time, CONFIG)
  expect(legacy.time).toBe(TIME)
  expect(legacy.total).toBe(inflow.rewardsPiconeros)
  expect(legacy.sources).toEqual(inflow.sources)
})

test('binds the [start,end) window per fee source with receipt eligibility, never string SQL', async () => {
  const start = new Date('2026-10-05T00:00:00.000Z')
  const end = new Date('2026-10-12T00:00:00.000Z')
  const models = mockModels()
  await readRewardsInflow(models, { start, end, config: CONFIG })

  const [strings, ...values] = models.$queryRaw.mock.calls[0]
  const sql = strings.join('?')
  expect(sql).toContain('"walletReceipt" = true')
  expect(sql).toContain("state = 'CONFIRMED'")
  expect(sql).toContain('AS "donateRaw"')
  expect(sql).toContain('AS "bountyrolloverRewards"')
  expect(sql).toContain("date_trunc('week'")
  expect(sql).toContain("interval '1 week'")
  // 10 fee/observation subselects; each binds start once and end twice
  // (the NULL test and the `< end` comparison are separate parameters).
  expect(values).toHaveLength(30)
  expect(values.filter(v => v === start)).toHaveLength(10)
  expect(values.filter(v => v === end)).toHaveLength(20)
})

test('an absent end binds NULL for every subselect (all-time reader from the epoch)', async () => {
  const start = new Date(0)
  const models = mockModels()
  await readRewardsInflow(models, { start, config: CONFIG })

  const [, ...values] = models.$queryRaw.mock.calls[0]
  expect(values.filter(v => v === start)).toHaveLength(10)
  expect(values.filter(v => v === null)).toHaveLength(20)
})

// =============================================================================
// Real-DB checks (dedicated isolated database only): window boundaries,
// walletReceipt/state eligibility, per-row donation floors and the all-time
// epoch reader. Skipped (not thrown) anywhere else; the client is created in
// beforeAll, which does not run when skipped.
// =============================================================================

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const prisma = new PrismaClient()

;(ISOLATED_DB ? describe : describe.skip)('readRewardsInflow (isolated DB only)', () => {
  // A window no other suite uses: a crashed run's leftovers can be identified
  // and cleared without touching any other test's rows.
  const START = new Date('2035-01-01T00:00:00.000Z')
  const END = new Date('2035-01-08T00:00:00.000Z')
  const created = { feeHashes: [], downvoteHashes: [], items: [], users: [] }

  const hash = () => randomUUID().replaceAll('-', '')

  beforeAll(async () => {
    await prisma.feeObservation.deleteMany({ where: { confirmedAt: { gte: START, lt: END } } })
    await prisma.observedDownvote.deleteMany({ where: { confirmedAt: { gte: START, lt: END } } })
  })

  afterEach(async () => {
    await prisma.observedDownvote.deleteMany({ where: { txHash: { in: created.downvoteHashes } } })
    await prisma.feeObservation.deleteMany({ where: { txHash: { in: created.feeHashes } } })
    if (created.items.length) await prisma.item.deleteMany({ where: { id: { in: created.items } } })
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    created.feeHashes.length = 0
    created.downvoteHashes.length = 0
    created.items.length = 0
    created.users.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seedFee ({
    feeType,
    piconeros,
    confirmedAt = START,
    state = 'CONFIRMED',
    walletReceipt = true,
    rewardsPiconeros,
    donationRewardsPct
  }) {
    const txHash = hash()
    created.feeHashes.push(txHash)
    return prisma.feeObservation.create({
      data: {
        txHash,
        feeType,
        recipientMajor: 1,
        recipientMinor: 0,
        piconeros,
        state,
        confirmedAt: state === 'DETECTED' ? null : confirmedAt,
        walletReceipt,
        rewardsPiconeros,
        donationRewardsPct
      }
    })
  }

  async function seedDownvote ({ piconeros, confirmedAt = START, state = 'CONFIRMED' }) {
    const [user] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(user.id)
    const item = await prisma.item.create({
      data: { userId: user.id, title: 'rewards inflow window', status: 'ACTIVE' }
    })
    created.items.push(item.id)
    const txHash = hash()
    created.downvoteHashes.push(txHash)
    return prisma.observedDownvote.create({
      data: {
        txHash,
        postId: item.id,
        paymentId: hash(),
        piconeros,
        state,
        confirmedAt: state === 'DETECTED' ? null : confirmedAt
      }
    })
  }

  test('only confirmed wallet receipts inside [start,end) enter, with exact mixed splits and per-row floors', async () => {
    const allTimeBefore = await readRewardsInflow(prisma, { start: new Date(0), config: CONFIG })

    // Eligible posting at the window start and just before its end; the row AT
    // the end is excluded by the half-open boundary. Two more 101 rows make the
    // aggregate floor sharp: floor(646*70/100)=452, while per-row floors would
    // book 77+233+70+70=450.
    await seedFee({ feeType: 'POSTING', piconeros: 111n, confirmedAt: START })
    await seedFee({ feeType: 'POSTING', piconeros: 333n, confirmedAt: new Date(END.getTime() - 1) })
    await seedFee({ feeType: 'POSTING', piconeros: 101n, confirmedAt: START })
    await seedFee({ feeType: 'POSTING', piconeros: 101n, confirmedAt: START })
    await seedFee({ feeType: 'POSTING', piconeros: 222n, confirmedAt: END })
    // An ineligible funding-time row and a not-yet-confirmed row of the same
    // kind as real receipts: never inflow.
    await seedFee({ feeType: 'POSTING', piconeros: 888n, walletReceipt: false })
    await seedFee({ feeType: 'POSTING', piconeros: 555n, state: 'DETECTED' })
    // A real hot fee and the ineligible funding fee with the SAME nominal amount.
    await seedFee({ feeType: 'BOUNTY_FEE', piconeros: 444n })
    await seedFee({ feeType: 'BOUNTY_FEE', piconeros: 444n, walletReceipt: false })
    // Per-row donation percentage floors: floor(101*70/100) is 70 each, so
    // 140 total — an aggregate floor would book 141.
    await seedFee({ feeType: 'DONATE', piconeros: 101n, donationRewardsPct: 70 })
    await seedFee({ feeType: 'DONATE', piconeros: 101n, donationRewardsPct: 70 })
    // Mixed net rollover (exact reward component) + legacy NULL rollover (full).
    await seedFee({ feeType: 'BOUNTY_ROLLOVER', piconeros: 139n, rewardsPiconeros: 100n })
    await seedFee({ feeType: 'BOUNTY_ROLLOVER', piconeros: 50n, rewardsPiconeros: null })
    await seedFee({ feeType: 'TERRITORY_BILLING', piconeros: 100n })
    await seedFee({ feeType: 'BOOST', piconeros: 100n })
    await seedFee({ feeType: 'TIP_UNWALLETED', piconeros: 100n })
    await seedDownvote({ piconeros: 777n })
    await seedDownvote({ piconeros: 99999n, state: 'DETECTED' })
    await seedDownvote({ piconeros: 123n, confirmedAt: END })

    const windowed = await readRewardsInflow(prisma, { start: START, end: END, config: CONFIG })
    expect(windowed.raw.posting).toBe(646n) // 111 + 333 + 101 + 101, never the 888 ineligible or the 555 DETECTED
    expect(windowed.raw.bountyfee).toBe(444n) // the real receipt, not its walletReceipt=false twin
    expect(windowed.raw.donate).toBe(140n) // per-row floors, not 141
    expect(windowed.raw.donateRaw).toBe(202n)
    expect(windowed.raw.bountyrollover).toBe(189n)
    expect(windowed.raw.bountyrolloverRewards).toBe(150n) // 100 mixed + 50 legacy NULL
    expect(windowed.raw.downvote).toBe(777n)
    expect(windowed.raw.territory).toBe(100n)
    expect(windowed.raw.boost).toBe(100n)
    expect(windowed.raw.walletlesstip).toBe(100n)
    expect(windowed.raw.time).toBeInstanceOf(Date)
    expect(windowed.totalPiconeros).toBe(2558n)
    expect(windowed.rewardsPiconeros).toBe(1649n)
    expect(windowed.opsPiconeros).toBe(909n)
    expect(windowed.sources).toEqual([
      { name: 'downvote', value: '777' },
      { name: 'posting fee', value: '452' }, // aggregate floor over the eligible rows, not 450
      { name: 'turf fee', value: '30' },
      { name: 'donations', value: '140' },
      { name: 'boosts', value: '30' },
      { name: 'wallet-less tips', value: '70' },
      { name: 'bounty rollovers', value: '150' }
    ])

    // start = the Unix epoch with no end is the all-time reader: the deltas
    // equal every eligible seeded row exactly, including rows AT `END` (which
    // only the half-open windowed read excludes).
    const allTimeAfter = await readRewardsInflow(prisma, { start: new Date(0), config: CONFIG })
    expect(allTimeAfter.raw.downvote - allTimeBefore.raw.downvote).toBe(900n) // 777 + the 123 at END
    expect(allTimeAfter.raw.posting - allTimeBefore.raw.posting).toBe(868n) // 646 + the 222 at END
    expect(allTimeAfter.raw.territory - allTimeBefore.raw.territory).toBe(100n)
    expect(allTimeAfter.raw.donate - allTimeBefore.raw.donate).toBe(140n)
    expect(allTimeAfter.raw.donateRaw - allTimeBefore.raw.donateRaw).toBe(202n)
    expect(allTimeAfter.raw.boost - allTimeBefore.raw.boost).toBe(100n)
    expect(allTimeAfter.raw.walletlesstip - allTimeBefore.raw.walletlesstip).toBe(100n)
    expect(allTimeAfter.raw.bountyrollover - allTimeBefore.raw.bountyrollover).toBe(189n)
    expect(allTimeAfter.raw.bountyrolloverRewards - allTimeBefore.raw.bountyrolloverRewards).toBe(150n)
    expect(allTimeAfter.raw.bountyfee - allTimeBefore.raw.bountyfee).toBe(444n)
  })

  test('donation 0/100 percentages and a 100,000 XMR receipt stay exact', async () => {
    await seedFee({ feeType: 'DONATE', piconeros: 5000n, donationRewardsPct: 0 })
    await seedFee({ feeType: 'DONATE', piconeros: 7000n, donationRewardsPct: 100 })
    // 100,000 XMR = 1e17 piconeros: a bigint `piconeros * 100` intermediate
    // overflows int8 (1e19 > 9.22e18) although the 1e17 result is representable.
    await seedFee({ feeType: 'DONATE', piconeros: 100000000000000000n, donationRewardsPct: 100 })

    const windowed = await readRewardsInflow(prisma, { start: START, end: END, config: CONFIG })
    expect(windowed.raw.donateRaw).toBe(100000000000012000n)
    expect(windowed.raw.donate).toBe(100000000000007000n) // 0% stays ops-only
    expect(windowed.totalPiconeros).toBe(100000000000012000n)
    expect(windowed.rewardsPiconeros).toBe(100000000000007000n)
    expect(windowed.opsPiconeros).toBe(5000n)
    expect(windowed.sources).toEqual([{ name: 'donations', value: '100000000000007000' }])
  })
})
