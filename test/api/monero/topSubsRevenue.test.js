/* eslint-env jest */

// Resolver-level tests for the turf-owner revenue surfaces (Task 13):
//   - topSubs by:'revenue' — sub_revenue CTE present + revenue column when the
//     TURF_OWNER_FEES gate is on; CTE skipped + 0n exposure when off
//   - the REVENUE notification union branch (owner_user_id/confirmed_at physical
//     columns, noteEarning gated) + the lazy Revenue.subName field resolver
// Mocked $queryRaw/$queryRawUnsafe — no live DB (per plan testing latitude;
// live-DB coverage of the stat itself lives in test/api/resolvers/topSubs.test.js).

import subResolvers, { topSubs } from '@/api/resolvers/sub'
import notifications from '@/api/resolvers/notifications'
import { Prisma } from '@prisma/client'

// api/resolvers/sub.js and notifications.js transitively import
// lexical/server + payIn deps (ESM-only). Mirror the mocks in
// test/api/resolvers/topSubs.test.js.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const ALL_SUBS_QUERY = Prisma.sql`
  SELECT "Sub".name, "Sub".id
  FROM "Sub"
  GROUP BY "Sub".name
`

// The tagged template hands nested Prisma.sql fragments to the tag function
// as values (Prisma's own tags flatten them; our mock must do it) — splice
// fragment text back in ($? = scalar param)
const isSql = v => v && typeof v === 'object' && Array.isArray(v.strings) && Array.isArray(v.values)
function sqlText (strings, values) {
  let out = ''
  strings.forEach((s, i) => {
    out += s
    if (i < values.length) {
      const v = values[i]
      out += isSql(v) ? sqlText(v.strings, v.values) : '$?'
    }
  })
  return out
}

function captureRawModels (rows = []) {
  let captured = null
  const models = {
    $queryRaw: async (strings, ...values) => {
      captured = { sql: sqlText(strings, values), values }
      return rows
    }
  }
  models.captured = () => {
    if (!captured) throw new Error('$queryRaw was not called')
    return captured
  }
  return models
}

afterEach(() => { delete process.env.TURF_OWNER_FEES })

describe('topSubs revenue stat', () => {
  test('gate ON: by revenue builds the sub_revenue CTE and orders by revenue', async () => {
    process.env.TURF_OWNER_FEES = '1'
    const models = captureRawModels([{ name: 'rev-a', revenue: 5n }])

    const { subs } = await topSubs(
      null, { query: ALL_SUBS_QUERY, when: 'custom', from: '0', to: '1', by: 'revenue', limit: 21 },
      { models, me: null })

    const { sql } = models.captured()
    expect(sql).toContain('sub_revenue AS (')
    expect(sql).toContain('JOIN "ObservedSubFee" f ON f."subName" = user_subs.name')
    expect(sql).toContain("f.state = 'CONFIRMED'")
    expect(sql).toContain('sum(f.piconeros)::bigint AS revenue')
    expect(sql).toContain('COALESCE(sub_revenue.revenue, 0) AS revenue')
    expect(sql).toContain('LEFT JOIN sub_revenue ON sub_revenue.name = user_subs.name')
    expect(sql).toContain('ORDER BY revenue DESC NULLS LAST')
    // the mapped row carries the revenue column through
    expect(subs[0].revenue).toBe(5n)
  })

  test('gate OFF: no sub_revenue CTE, revenue exposed as 0n, sort still valid', async () => {
    delete process.env.TURF_OWNER_FEES
    const models = captureRawModels([{ name: 'rev-b', revenue: 0n }])

    const { subs } = await topSubs(
      null, { query: ALL_SUBS_QUERY, when: 'custom', from: '0', to: '1', by: 'revenue', limit: 21 },
      { models, me: null })

    const { sql } = models.captured()
    expect(sql).not.toContain('sub_revenue')
    expect(sql).not.toContain('ObservedSubFee')
    // dormant deployments still select a (zeroed) revenue column so the
    // GraphQL field resolves instead of erroring
    expect(sql).toContain('0::bigint AS revenue')
    expect(subs[0].revenue).toBe(0n)
  })

  test('gate OFF: by stacked keeps the legacy shape (no revenue CTE leak)', async () => {
    delete process.env.TURF_OWNER_FEES
    const models = captureRawModels([])

    await topSubs(
      null, { query: ALL_SUBS_QUERY, when: 'custom', from: '0', to: '1', by: 'stacked', limit: 21 },
      { models, me: null })

    const { sql } = models.captured()
    expect(sql).not.toContain('sub_revenue')
    expect(sql).toContain('0::bigint AS revenue')
    expect(sql).toContain('ORDER BY stacked DESC NULLS LAST')
  })
})

describe('Sub.earnedPiconeros (tenure-scoped owner revenue)', () => {
  function captureAggregateModels (sum = 5n) {
    let capturedWhere = null
    const models = {
      observedSubFee: {
        aggregate: jest.fn(async ({ where }) => {
          capturedWhere = where
          return { _sum: { piconeros: sum } }
        })
      }
    }
    models.capturedWhere = () => {
      if (!capturedWhere) throw new Error('observedSubFee.aggregate was not called')
      return capturedWhere
    }
    return models
  }

  test('counts only receipts attributed to the CURRENT owner (tenure-scoped)', async () => {
    const models = captureAggregateModels(42n)

    const out = await subResolvers.Sub.earnedPiconeros(
      { name: 'turf', userId: 7 }, {}, { me: { id: 7 }, models })

    expect(out).toBe(42n)
    expect(models.capturedWhere()).toMatchObject({
      subName: 'turf',
      state: 'CONFIRMED',
      ownerUserId: 7
    })
  })

  test('ownership gate: non-owner me gets null and no aggregate call', async () => {
    const models = captureAggregateModels()

    const out = await subResolvers.Sub.earnedPiconeros(
      { name: 'turf', userId: 7 }, {}, { me: { id: 999 }, models })

    expect(out).toBeNull()
    expect(models.observedSubFee.aggregate).not.toHaveBeenCalled()
  })

  test('ownership gate: anon me gets null and no aggregate call', async () => {
    const models = captureAggregateModels()

    const out = await subResolvers.Sub.earnedPiconeros(
      { name: 'turf', userId: 7 }, {}, { me: null, models })

    expect(out).toBeNull()
    expect(models.observedSubFee.aggregate).not.toHaveBeenCalled()
  })
})

describe('REVENUE notifications branch', () => {
  const meFull = {
    id: 616,
    noteEarning: true,
    noteMentions: false,
    noteItemMentions: false,
    noteItemPiconeros: false,
    noteInvites: false,
    noteBadges: false,
    noteAllDescendants: false,
    checkedNotesAt: null
  }

  function captureNotificationsModels (rows) {
    return {
      $queryRawUnsafe: jest.fn(async () => rows),
      user: { update: jest.fn(async () => ({})) }
    }
  }

  test('noteEarning users get a Revenue union branch over ObservedSubFee receipts', async () => {
    // receipts can only exist when the feature was on, so the branch is
    // intentionally NOT env-gated (historical receipts still notify)
    delete process.env.TURF_OWNER_FEES
    const models = captureNotificationsModels(
      [{ id: '99', sortTime: new Date(), earnedPiconeros: 1000000000n, type: 'Revenue', minSortTime: new Date() }])

    const res = await notifications.Query.notifications(
      null, {}, { me: { id: 616 }, models, userLoader: { load: async () => meFull } })

    const sql = models.$queryRawUnsafe.mock.calls[0][0]
    expect(sql).toContain('FROM "ObservedSubFee"')
    expect(sql).toContain('"ObservedSubFee"."owner_user_id" = $1')
    expect(sql).toContain('"ObservedSubFee".state = \'CONFIRMED\'')
    expect(sql).toContain('"ObservedSubFee"."confirmed_at" <= $2')
    expect(sql).toContain("'Revenue' AS type")
    expect(sql).toContain('"ObservedSubFee".piconeros AS "earnedPiconeros"')
    // the union stays 4 uniform columns — subName resolves lazily
    expect(sql).toContain('SELECT id, "sortTime", "earnedPiconeros", type,')
    expect(res.notifications[0].type).toBe('Revenue')
    expect(res.notifications[0].earnedPiconeros).toBe(1000000000n)
  })

  test('the branch is omitted when noteEarning is off', async () => {
    const models = captureNotificationsModels([])

    await notifications.Query.notifications(
      null, {}, { me: { id: 616 }, models, userLoader: { load: async () => ({ ...meFull, noteEarning: false }) } })

    const sql = models.$queryRawUnsafe.mock.calls[0][0]
    expect(sql).not.toContain('ObservedSubFee')
    expect(sql).not.toContain("'Revenue' AS type")
  })

  test('Revenue.subName resolves lazily from the receipt row', async () => {
    let captured = null
    const models = {
      $queryRaw: async (strings, ...values) => {
        captured = { sql: strings.join('$#'), values }
        return [{ subName: 'turfy' }]
      }
    }

    const subName = await notifications.Revenue.subName({ id: '99' }, {}, { models })

    expect(subName).toBe('turfy')
    expect(captured.sql).toContain('FROM "ObservedSubFee"')
    expect(captured.values).toEqual([99])
  })
})
