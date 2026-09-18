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

test('tippedRecently is true within 24h of a detected tip', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ n: 1 }])
  }
  const rec = await UserOptional.tippedRecently(mkUser(), {}, { models })
  expect(rec).toBe(true)
})

test('tippedRecently is false without a tip in the last 24h', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([])
  }
  const rec = await UserOptional.tippedRecently(mkUser(), {}, { models })
  expect(rec).toBe(false)
})

test('tippedRecently counts DETECTED and CONFIRMED tips by detectedAt (mirrors the flame streak)', async () => {
  let captured = ''
  const models = {
    $queryRaw: async (...args) => {
      const [strings] = args
      captured = strings.join('?')
      return [{ n: 1 }]
    }
  }
  await UserOptional.tippedRecently(mkUser(), {}, { models })
  expect(captured).toContain('state IN (\'DETECTED\', \'CONFIRMED\')')
  expect(captured).toContain('detectedAt')
  expect(captured).not.toContain('confirmedAt')
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

test('tippedRecently returns false for other viewers when hideBadges is on (never queries the DB)', async () => {
  const models = {
    $queryRaw: jest.fn()
  }
  const rec = await UserOptional.tippedRecently(mkUser({ hideBadges: true }), {}, { models, me: { id: 2 } })
  expect(rec).toBe(false)
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

test('tippedRecently still resolves for the owner when hideBadges is on', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ n: 1 }])
  }
  const rec = await UserOptional.tippedRecently(mkUser({ hideBadges: true }), {}, { models, me: { id: 1 } })
  expect(rec).toBe(true)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1)
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
