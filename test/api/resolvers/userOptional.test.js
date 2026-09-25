/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

// api/resolvers/user.js transitively imports api/resolvers/item.js, which drags
// in ESM-only lexical deps (mdast-util-from-markdown). The mocks below break
// that chain.
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

// The verified badge is hard-off pending the award/pay redesign. The one
// surviving hasWallet test pins the disabled no-op path; it flips mockFlag to
// false locally. let, not const: reassigned per-test; jest.mock factories
// reference these lazily (mock*-prefixed per babel-plugin-jest-hoist), so TDZ
// never applies.
jest.mock('../../../lib/verified-badge-flag', () => ({
  __esModule: true,
  isVerifiedBadgeEnabled: () => mockFlag
}))

let mockFlag = true

beforeEach(() => {
  mockFlag = true
})

const { UserOptional } = userResolvers

const DAY = 86_400_000

function mkUser (overrides = {}) {
  return {
    id: 1,
    hideFromTopUsers: false,
    hideStashAmount: true,
    stackedPiconeros: 10_000_000_000n,
    createdAt: new Date(Date.now() - 8 * DAY),
    ...overrides
  }
}

test('stacked returns the amount for the owner even when hideStashAmount is on', async () => {
  const user = mkUser()
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 1 }, models: {} })
  expect(stacked).toBe(10_000_000_000n)
})

test('stacked returns null for other viewers when hideStashAmount is on', async () => {
  const user = mkUser()
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 2 }, models: {} })
  expect(stacked).toBeNull()
})

test('stacked returns the amount for other viewers when hideStashAmount is off', async () => {
  const user = mkUser({ hideStashAmount: false })
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 2 }, models: {} })
  expect(stacked).toBe(10_000_000_000n)
})

test('stacked stays null for other viewers when hideFromTopUsers is on (prior behavior preserved)', async () => {
  const user = mkUser({ hideFromTopUsers: true, hideStashAmount: false })
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 2 }, models: {} })
  expect(stacked).toBeNull()
})

test('stashAmountHidden is true only for non-owners with the setting on', async () => {
  const user = mkUser()
  expect(UserOptional.stashAmountHidden(user, {}, { me: { id: 2 } })).toBe(true)
  expect(UserOptional.stashAmountHidden(user, {}, { me: { id: 1 } })).toBe(false)
  expect(UserOptional.stashAmountHidden(mkUser({ hideStashAmount: false }), {}, { me: { id: 2 } })).toBe(false)
  expect(UserOptional.stashAmountHidden(mkUser({ hideStashAmount: false }), {}, { me: null })).toBe(false)
  expect(UserOptional.stashAmountHidden(user, {}, { me: null })).toBe(true)
})

test('hasWallet returns false when the badge is disabled (never queries the DB)', async () => {
  mockFlag = false
  const models = {
    platformFeeConfig: { findUnique: jest.fn() },
    moneroAccount: { findFirst: jest.fn() }
  }
  const rec = await UserOptional.hasWallet(mkUser(), {}, { models })
  expect(rec).toBe(false)
  expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
})

test('streak and maxStreak return null for other viewers when hideBadges is on', async () => {
  const user = mkUser({ hideBadges: true, streak: 5 })
  expect(await UserOptional.streak(user, {}, { models: {}, me: { id: 2 } })).toBeNull()
  expect(await UserOptional.maxStreak(user, {}, { models: {}, me: { id: 2 } })).toBeNull()
})

test('streak and maxStreak stay visible to the owner when hideBadges is on', async () => {
  const streakUser = mkUser({ hideBadges: true, streak: 5 })
  expect(await UserOptional.streak(streakUser, {}, { models: {}, me: { id: 1 } })).toBe(5)
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ max: 7 }])
  }
  expect(await UserOptional.maxStreak(mkUser({ hideBadges: true }), {}, { models, me: { id: 1 } })).toBe(7)
})

test('streak and maxStreak survive with the setting off (owner too)', async () => {
  const streakUser = mkUser({ hideBadges: false, streak: 5 })
  const maxUser = mkUser({ hideBadges: false })
  expect(await UserOptional.streak(streakUser, {}, { models: {} })).toBe(5)
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ max: 7 }])
  }
  expect(await UserOptional.maxStreak(maxUser, {}, { models })).toBe(7)
})

test('goldFlame reads the stored shield off the active FLAME streak', async () => {
  const models = {
    streak: {
      findFirst: async ({ where }) =>
        (where.type === 'FLAME' && where.endedAt === null ? { goldActive: true } : null)
    }
  }
  expect(await UserOptional.goldFlame(mkUser({ streak: 7 }), {}, { models })).toBe(true)
  const modelsOff = {
    streak: { findFirst: async () => ({ goldActive: false }) }
  }
  expect(await UserOptional.goldFlame(mkUser({ streak: 7 }), {}, { models: modelsOff })).toBe(false)
  // no active FLAME row at all -> not gold
  const modelsGone = {
    streak: { findFirst: async () => null }
  }
  expect(await UserOptional.goldFlame(mkUser({ streak: 7 }), {}, { models: modelsGone })).toBe(false)
})

test('goldFlame returns false for other viewers when hideBadges is on', async () => {
  const models = {
    streak: { findFirst: jest.fn() }
  }
  expect(await UserOptional.goldFlame(mkUser({ hideBadges: true, streak: 7 }), {}, { models, me: { id: 2 } })).toBe(false)
  expect(models.streak.findFirst).not.toHaveBeenCalled()
})

test('goldFlame stays visible to the owner when hideBadges is on', async () => {
  const models = {
    streak: { findFirst: async () => ({ goldActive: true }) }
  }
  expect(await UserOptional.goldFlame(mkUser({ hideBadges: true, streak: 7 }), {}, { models, me: { id: 1 } })).toBe(true)
})

test('goldFlame survives for other viewers when hideBadges is off', async () => {
  const models = {
    streak: { findFirst: async () => ({ goldActive: true }) }
  }
  expect(await UserOptional.goldFlame(mkUser({ hideBadges: false, streak: 7 }), {}, { models, me: { id: 2 } })).toBe(true)
})
