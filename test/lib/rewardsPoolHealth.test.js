/* eslint-env jest */

import { poolHealth, POOL_RUNWAY, POOL_STATUS } from '@/lib/rewardsPoolHealth'
import { formatShare } from '@/lib/format'

// Newest-first COMPLETE runs where every week pays `spend` and the rollover
// moves by `net`: income = spend + net.
function weeks ({ count = 5, spend = 400n, net = 0n, latestRollover = 4000n }) {
  return Array.from({ length: count }, (_, i) => {
    const rolledOverPiconeros = latestRollover - net * BigInt(i)
    return {
      distributedPiconeros: spend,
      rolledOverPiconeros,
      poolPiconeros: rolledOverPiconeros + spend
    }
  })
}

describe('poolHealth', () => {
  test('no status before two completed runs', () => {
    expect(poolHealth({ rows: [], poolPiconeros: 0n })).toEqual({ status: null, runway: null, curatorShareBps: null })
    expect(poolHealth({ rows: weeks({ count: 1 }), poolPiconeros: 0n }).status).toBeNull()
  })

  test('within ±10% of weekly spending is STABLE', () => {
    expect(poolHealth({ rows: weeks({ net: 40n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.STABLE)
    expect(poolHealth({ rows: weeks({ net: -40n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.STABLE)
    expect(poolHealth({ rows: weeks({ net: 41n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.GROWING)
    expect(poolHealth({ rows: weeks({ net: -41n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.DRAINING)
  })

  test('averages over the last four runs only', () => {
    // an old big drop five runs back must not count
    const rows = weeks({ count: 6, net: 0n })
    rows[5].rolledOverPiconeros = 100_000n
    expect(poolHealth({ rows, poolPiconeros: 4000n }).status).toBe(POOL_STATUS.STABLE)
  })

  test('uses the runs available when fewer than four exist', () => {
    expect(poolHealth({ rows: weeks({ count: 2, net: -100n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.DRAINING)
  })

  test('nothing paid out: any growth is GROWING, no change is STABLE', () => {
    expect(poolHealth({ rows: weeks({ spend: 0n, net: 1n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.GROWING)
    expect(poolHealth({ rows: weeks({ spend: 0n, net: 0n }), poolPiconeros: 4000n }).status).toBe(POOL_STATUS.STABLE)
  })

  test('runway buckets the reserve over the weekly drain', () => {
    const runway = pool => poolHealth({ rows: weeks({ net: -100n }), poolPiconeros: pool }).runway
    expect(runway(399n)).toBe(POOL_RUNWAY.LT_1_MONTH) // 3.99 weeks
    expect(runway(400n)).toBe(POOL_RUNWAY.MONTHS_1_3)
    expect(runway(1299n)).toBe(POOL_RUNWAY.MONTHS_1_3)
    expect(runway(1300n)).toBe(POOL_RUNWAY.MONTHS_3_6)
    expect(runway(2600n)).toBe(POOL_RUNWAY.MONTHS_6_12)
    expect(runway(5200n)).toBe(POOL_RUNWAY.YEAR_PLUS)
    expect(runway(0n)).toBe(POOL_RUNWAY.LT_1_MONTH)
  })

  test('a STABLE pool that still loses a little gets a runway; a flat or growing one is not draining', () => {
    expect(poolHealth({ rows: weeks({ net: -10n }), poolPiconeros: 400n }).runway).toBe(POOL_RUNWAY.MONTHS_6_12) // 40 weeks
    expect(poolHealth({ rows: weeks({ net: 0n }), poolPiconeros: 4000n }).runway).toBe(POOL_RUNWAY.NOT_DRAINING)
    expect(poolHealth({ rows: weeks({ net: 100n }), poolPiconeros: 4000n }).runway).toBe(POOL_RUNWAY.NOT_DRAINING)
  })

  test('curator share is payouts over rewards income', () => {
    // income 500 = spend 400 + net 100
    expect(poolHealth({ rows: weeks({ net: 100n }), poolPiconeros: 4000n }).curatorShareBps).toBe(8000)
    expect(poolHealth({ rows: weeks({ spend: 0n, net: 0n }), poolPiconeros: 4000n }).curatorShareBps).toBeNull()
  })
})

describe('formatShare', () => {
  test('whole percents, with tiny slices shown as <1%', () => {
    expect(formatShare(4800)).toBe('48%')
    expect(formatShare(50)).toBe('<1%')
    expect(formatShare(0)).toBe('0%')
  })
})
