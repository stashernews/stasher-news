/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

const { UserPrivates } = userResolvers
const CONFIG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7, commentFeePiconeros: 600_000_000n }

function mkModels ({ turfs = [{ id: 1, name: 'bitcoin' }], tips = [{ n: 1 }] } = {}) {
  return {
    sub: { findMany: async () => turfs },
    platformFeeConfig: { findUnique: async () => CONFIG },
    user: { findUnique: async () => null },
    payIn: { findFirst: async () => null },
    item: { findFirst: async () => null },
    streakReward: { findFirst: async () => ({ id: 9 }) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('ObservedTip')) return tips
      if (sql.includes('StreakReward')) return [{ credits: 0, nextExpiresAt: null }]
      return []
    })
  }
}

const user = { id: 1, streak: 4, freeCommentCount: 1, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() }

test('quest privates expose the draw, completions, flame cycle, and held rewards', async () => {
  const models = mkModels()
  expect(await UserPrivates.questUpvoteComplete(user, {}, { models })).toBe(true)
  expect(typeof await UserPrivates.questDrawnType(user, {}, { models })).toBe('string')
  expect(await UserPrivates.questsCompletedToday(user, {}, { models })).toBeGreaterThanOrEqual(1)
  expect(await UserPrivates.flameCycleDay(user, {}, { models })).toBe(4)
  expect(await UserPrivates.goldFlame(user, {}, { models })).toBe(false)
  expect(await UserPrivates.freezeHeld(user, {}, { models })).toBe(true)
  expect(await UserPrivates.turfDiscountHeld(user, {}, { models })).toBe(true)
  expect(await UserPrivates.questResetsAt(user, {}, { models })).toBeInstanceOf(Date)
})

test('gold flame is true on cycle days 5-7 and the cycle wraps', async () => {
  const models = mkModels()
  expect(await UserPrivates.goldFlame({ id: 1, streak: 5 }, {}, { models })).toBe(true)
  expect(await UserPrivates.goldFlame({ id: 1, streak: 8 }, {}, { models })).toBe(false)
  expect(await UserPrivates.flameCycleDay({ id: 1, streak: 8 }, {}, { models })).toBe(1)
})
