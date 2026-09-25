/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

const { UserPrivates } = userResolvers
const CONFIG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7, commentFeePiconeros: 600_000_000n }

function mkModels ({ turfs = [{ id: 1, name: 'bitcoin' }], tips = [{ n: 1 }], replyCredits = 0, streakGoldActive = false } = {}) {
  return {
    sub: { findMany: async () => turfs },
    platformFeeConfig: { findUnique: async () => CONFIG },
    user: { findUnique: async () => null },
    payIn: { findFirst: async () => null },
    item: { findFirst: async () => null },
    streakReward: { findFirst: async () => ({ id: 9 }) },
    // goldFlame reads the stored shield off the user's active FLAME streak row
    streak: {
      findFirst: jest.fn(async ({ where }) =>
        (where.type === 'FLAME' && where.endedAt === null ? { goldActive: !!streakGoldActive } : null))
    },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('ObservedTip')) return tips
      // bankedReplyCredits hits StreakReward with type 'REPLY'; match it before the generic branch
      if (sql.includes("'REPLY'")) return [{ credits: replyCredits, nextExpiresAt: null }]
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
  // streak 4 with today's quests still open: the card shows the day being worked (5)
  expect(await UserPrivates.flameCycleDay(user, {}, { models })).toBe(5)
  expect(await UserPrivates.flameWeek(user, {}, { models })).toBe(1)
  expect(await UserPrivates.goldFlame(user, {}, { models })).toBe(false)
  expect(await UserPrivates.turfDiscountHeld(user, {}, { models })).toBe(true)
  expect(await UserPrivates.questResetsAt(user, {}, { models })).toBeInstanceOf(Date)
})

test('goldFlame reflects the stored shield, not the streak length', async () => {
  const models = mkModels({ streakGoldActive: true })
  expect(await UserPrivates.goldFlame({ id: 1, streak: 7 }, {}, { models })).toBe(true)
  const modelsOff = mkModels({ streakGoldActive: false })
  expect(await UserPrivates.goldFlame({ id: 1, streak: 7 }, {}, { models: modelsOff })).toBe(false)
  // the flag is read from the user's active FLAME streak row
  expect(models.streak.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: 1, type: 'FLAME', endedAt: null } }))
})

test('freeReplyCredits counts unconsumed banked REPLY rewards', async () => {
  expect(await UserPrivates.freeReplyCredits({ id: 1 }, {}, { models: mkModels({ replyCredits: 2 }) })).toBe(2)
  expect(await UserPrivates.freeReplyCredits({ id: 1 }, {}, { models: mkModels() })).toBe(0)
})

test('the golden flame persists across cycles and the card shows the current cycle', async () => {
  // the stored shield flag, not the streak length, keeps the flame gold across cycle resets
  expect(await UserPrivates.goldFlame({ id: 1, streak: 4 }, {}, { models: mkModels({ streakGoldActive: true }) })).toBe(true)
  expect(await UserPrivates.goldFlame({ id: 1, streak: 8 }, {}, { models: mkModels({ streakGoldActive: true }) })).toBe(true)
  // no flame -> 0 (the card shows "not started")
  expect(await UserPrivates.flameCycleDay({ id: 1, streak: null }, {}, { models: mkModels() })).toBe(0)
  // streak 8 = week 2 day 1 earned; with today's quests still open the card is on day 2
  expect(await UserPrivates.flameCycleDay({ id: 1, streak: 8 }, {}, { models: mkModels() })).toBe(2)
  expect(await UserPrivates.flameWeek({ id: 1, streak: 8 }, {}, { models: mkModels() })).toBe(2)
})
