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
