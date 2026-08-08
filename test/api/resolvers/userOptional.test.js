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

function mkUser (overrides = {}) {
  return {
    id: 1,
    hideFromTopUsers: false,
    hideStashAmount: true,
    stackedPiconeros: 5000000000n,
    ...overrides
  }
}

test('stacked returns the amount for the owner even when hideStashAmount is on', async () => {
  const user = mkUser()
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 1 }, models: {} })
  expect(stacked).toBe(5000000000n)
})

test('stacked returns null for other viewers when hideStashAmount is on', async () => {
  const user = mkUser()
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 2 }, models: {} })
  expect(stacked).toBeNull()
})

test('stacked returns the amount for other viewers when hideStashAmount is off', async () => {
  const user = mkUser({ hideStashAmount: false })
  const stacked = await UserOptional.stacked(user, {}, { me: { id: 2 }, models: {} })
  expect(stacked).toBe(5000000000n)
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

test('tippedRecently is true within 24h of a confirmed tip', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ n: 1 }])
  }
  const rec = await UserOptional.tippedRecently(mkUser(), {}, { models })
  expect(rec).toBe(true)
})

test('tippedRecently is false without a confirmed tip in the last 24h', async () => {
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([])
  }
  const rec = await UserOptional.tippedRecently(mkUser(), {}, { models })
  expect(rec).toBe(false)
})

test('hasWallet returns false when hideBadges is on (never queries the DB)', async () => {
  const models = {
    moneroAccount: { findFirst: jest.fn() }
  }
  const rec = await UserOptional.hasWallet(mkUser({ hideBadges: true }), {}, { models })
  expect(rec).toBe(false)
  expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
})

test('tippedRecently returns false when hideBadges is on (never queries the DB)', async () => {
  const models = {
    $queryRaw: jest.fn()
  }
  const rec = await UserOptional.tippedRecently(mkUser({ hideBadges: true }), {}, { models })
  expect(rec).toBe(false)
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

test('streak and maxStreak return null when hideBadges is on', async () => {
  const user = mkUser({ hideBadges: true, streak: 5 })
  expect(await UserOptional.streak(user, {}, { models: {} })).toBeNull()
  expect(await UserOptional.maxStreak(user, {}, { models: {} })).toBeNull()
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
