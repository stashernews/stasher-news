/* eslint-env jest */

// Resolver-level test for the turf-owner revenue accounting surface:
//   - Sub.earnedPiconeros — tenure-scoped CONFIRMED ObservedSubFee sums with an
//     owner-only gate
// Mocked models — no live DB (per plan testing latitude;
// live-DB coverage of the leaderboard itself lives in test/api/resolvers/topSubs.test.js).

import subResolvers from '@/api/resolvers/sub'

// api/resolvers/sub.js transitively imports
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
