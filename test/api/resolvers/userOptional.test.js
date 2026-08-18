/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

// api/resolvers/user.js transitively imports api/resolvers/item.js, which drags
// in ESM-only lexical deps (mdast-util-from-markdown). Mirror the mocks in
// test/api/resolvers/item-freebie.test.js to break that chain.
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

const { UserOptional } = userResolvers

const DAY = 86_400_000
const CONFIG = { id: 1, freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }

function mkUser (overrides = {}) {
  return {
    id: 1,
    hideFromTopUsers: false,
    hideStashAmount: true,
    // Default to an ESTABLISHED user so hasWallet's gate passes for positive cases.
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

test('hasWallet is true only when a MoneroAccount exists', async () => {
  const models = {
    platformFeeConfig: { findUnique: async () => CONFIG },
    moneroAccount: {
      findFirst: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 1 })
    }
  }
  const a = await UserOptional.hasWallet(mkUser({ id: 10 }), {}, { models })
  const b = await UserOptional.hasWallet(mkUser({ id: 11 }), {}, { models })
  expect(a).toBe(false)
  expect(b).toBe(true)
  expect(models.moneroAccount.findFirst).toHaveBeenCalledTimes(2)
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

test('hasWallet returns false for other viewers when hideBadges is on (never queries the DB)', async () => {
  const models = {
    platformFeeConfig: { findUnique: async () => CONFIG },
    moneroAccount: { findFirst: jest.fn() }
  }
  const rec = await UserOptional.hasWallet(mkUser({ hideBadges: true }), {}, { models, me: { id: 2 } })
  expect(rec).toBe(false)
  expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
})

test('hasWallet still resolves for the owner when hideBadges is on', async () => {
  const models = {
    platformFeeConfig: { findUnique: async () => CONFIG },
    moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) }
  }
  const rec = await UserOptional.hasWallet(mkUser({ hideBadges: true }), {}, { models, me: { id: 1 } })
  expect(rec).toBe(true)
  expect(models.moneroAccount.findFirst).toHaveBeenCalledTimes(1)
})

test('hasWallet is false when the wallet exists but the reputation gate is not met', async () => {
  const models = {
    platformFeeConfig: { findUnique: async () => CONFIG },
    moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) }
  }
  // lowRep override: below threshold
  const rec = await UserOptional.hasWallet(mkUser({ stackedPiconeros: 0n, createdAt: new Date() }), {}, { models })
  expect(rec).toBe(false)
})

test('hasWallet fetches missing createdAt/stackedPiconeros for feed authors and returns true when established', async () => {
  const models = {
    platformFeeConfig: { findUnique: async () => CONFIG },
    moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    user: { findUnique: jest.fn().mockResolvedValue({ stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * DAY) }) }
  }
  // Feed-author shape: has id but NO createdAt/stackedPiconeros on the object.
  const rec = await UserOptional.hasWallet({ id: 5 }, {}, { models })
  expect(rec).toBe(true)
  expect(models.user.findUnique).toHaveBeenCalledTimes(1)
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
