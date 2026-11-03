// Public pool-health summary for /rewards, /transparency and the footer.
//
// The reserve itself is never published: a large advertised balance is a
// target. Instead the public surfaces get a trend label and a coarse runway
// range, both derived so that neither can be multiplied back into the reserve:
//   - the trend band is relative to weekly SPENDING, never to the reserve,
//   - the runway is bucketed, coarsest at the long end where an exact figure
//     would reveal a large balance.
// BigInt only.

export const POOL_HEALTH_WEEKS = 4
// |average weekly net change| within this share of average weekly spending is STABLE.
export const STABLE_BAND_BPS = 1000n

export const POOL_STATUS = {
  GROWING: 'GROWING',
  STABLE: 'STABLE',
  DRAINING: 'DRAINING'
}

export const POOL_RUNWAY = {
  LT_1_MONTH: 'LT_1_MONTH',
  MONTHS_1_3: 'MONTHS_1_3',
  MONTHS_3_6: 'MONTHS_3_6',
  MONTHS_6_12: 'MONTHS_6_12',
  YEAR_PLUS: 'YEAR_PLUS',
  NOT_DRAINING: 'NOT_DRAINING'
}

// Upper bounds in weeks, ascending; anything at or past the last is YEAR_PLUS.
const RUNWAY_BUCKETS = [
  [4n, POOL_RUNWAY.LT_1_MONTH],
  [13n, POOL_RUNWAY.MONTHS_1_3],
  [26n, POOL_RUNWAY.MONTHS_3_6],
  [52n, POOL_RUNWAY.MONTHS_6_12]
]

export const POOL_RUNWAY_LABELS = {
  LT_1_MONTH: '<1 month',
  MONTHS_1_3: '1–3 months',
  MONTHS_3_6: '3–6 months',
  MONTHS_6_12: '6–12 months',
  YEAR_PLUS: 'a year or more',
  NOT_DRAINING: 'not draining'
}

const toBigInt = v => (v == null ? 0n : BigInt(v))

// rows: COMPLETE distributions, newest first, at least POOL_HEALTH_WEEKS + 1
// when available. poolPiconeros: the current full pool (the reserve the
// runway is measured against). Returns nulls until two runs exist.
export function poolHealth ({ rows, poolPiconeros }) {
  const k = Math.min(POOL_HEALTH_WEEKS, rows.length - 1)
  if (k < 1) return { status: null, runway: null, curatorShareBps: null }

  // rolledOver(n) = rolledOver(n-1) + rewards inflow(n) - distributed(n), so
  // the rollover delta across k runs is exactly k weeks of net change.
  const netTotal = toBigInt(rows[0].rolledOverPiconeros) - toBigInt(rows[k].rolledOverPiconeros)
  let spendTotal = 0n
  let incomeTotal = 0n
  for (let i = 0; i < k; i++) {
    spendTotal += toBigInt(rows[i].distributedPiconeros)
    incomeTotal += toBigInt(rows[i].poolPiconeros) - toBigInt(rows[i + 1].rolledOverPiconeros)
  }

  let status = POOL_STATUS.STABLE
  if (netTotal * 10000n > spendTotal * STABLE_BAND_BPS) status = POOL_STATUS.GROWING
  else if (netTotal * 10000n < -spendTotal * STABLE_BAND_BPS) status = POOL_STATUS.DRAINING

  return {
    status,
    runway: runwayBucket({ netTotal, weeks: BigInt(k), poolPiconeros: toBigInt(poolPiconeros) }),
    curatorShareBps: incomeTotal > 0n ? Number(spendTotal * 10000n / incomeTotal) : null
  }
}

function runwayBucket ({ netTotal, weeks, poolPiconeros }) {
  if (netTotal >= 0n) return POOL_RUNWAY.NOT_DRAINING
  const pool = poolPiconeros > 0n ? poolPiconeros : 0n
  // runway weeks = pool / (-netTotal / weeks), compared without division
  const drain = -netTotal
  for (const [limit, bucket] of RUNWAY_BUCKETS) {
    if (pool * weeks < limit * drain) return bucket
  }
  return POOL_RUNWAY.YEAR_PLUS
}
