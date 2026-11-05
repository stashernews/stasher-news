/* eslint-env jest */
import { Kind } from 'graphql'
import resolvers from '@/api/resolvers/user'
import { useBoostCredit } from '@/api/resolvers/boost-credit'
import userTypeDefs from '@/api/typeDefs/user'
import itemTypeDefs from '@/api/typeDefs/item'

// api/resolvers/user.js drags in heavy ESM-only transitive deps; the mocks
// below break that chain — same pattern as
// test/api/resolvers/userPrivates.quests.test.js.
jest.mock('../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))
// unit-isolated redemption: the exact-credit ledger access is stubbed so the
// argument-compat path can be tested without a database
jest.mock('../../api/quests/boost-credit', () => ({
  lockRewardUser: async () => true,
  rewardNow: async () => new Date('2026-01-01T00:00:00Z'),
  availableBoostCredits: async () => credits
}))

let credits
beforeEach(() => { credits = [] })

function typeFields (typeDefs, typeName) {
  const fields = typeDefs.definitions
    .filter(d => (d.kind === Kind.OBJECT_TYPE_DEFINITION || d.kind === Kind.OBJECT_TYPE_EXTENSION) && d.name.value === typeName)
    .flatMap(d => d.fields ?? [])
  return Object.fromEntries(fields.map(f => [f.name.value, f]))
}

function fieldArgs (field) {
  return Object.fromEntries((field.arguments ?? []).map(a => [a.name.value, a]))
}

const isDeprecated = node => (node?.directives ?? []).some(d => d.name.value === 'deprecated')

test('the removed boost credit fields remain queryable as deprecated aliases', () => {
  const fields = typeFields(userTypeDefs, 'UserPrivates')
  expect(fields.boostCreditId).toBeDefined()
  expect(isDeprecated(fields.boostCreditId)).toBe(true)
  expect(fields.boostCreditExpiresAt).toBeDefined()
  expect(isDeprecated(fields.boostCreditExpiresAt)).toBe(true)
})

test('useBoostCredit keeps accepting the deprecated single-credit argument', () => {
  const args = fieldArgs(typeFields(itemTypeDefs, 'Mutation').useBoostCredit)
  expect(args.rewardIds).toBeDefined()
  // nullable list: a required rewardIds would fail the whole legacy operation
  // at validation, before the single-credit fallback can ever run
  expect(args.rewardIds.type.kind).toBe(Kind.LIST_TYPE)
  expect(args.rewardId).toBeDefined()
  expect(isDeprecated(args.rewardId)).toBe(true)
})

test('a useBoostCredit call with neither argument is rejected', async () => {
  const item = { id: 42, userId: 7, parentId: null, bio: false, deletedAt: null, status: 'ACTIVE', feeStatus: 'FEE_PAID' }
  const tx = {
    $queryRaw: async () => [item],
    streakReward: { updateMany: jest.fn(async () => ({ count: 1 })) },
    item: { update: jest.fn(async () => ({})) }
  }
  await expect(useBoostCredit(null, { itemId: 42 }, { me: { id: 7 }, models: { $transaction: async fn => fn(tx) }, headers: {}, readItem: async () => item })).rejects.toThrow('invalid rewardIds')
})

test('boostCreditId and boostCreditExpiresAt resolve the earliest held credit, owner only', async () => {
  const expiresAt = new Date('2026-03-01T00:00:00Z')
  const laterExpiry = new Date('2026-04-01T00:00:00Z')
  credits = [{ id: 11, expiresAt }, { id: 9, expiresAt: laterExpiry }]
  const owner = { me: { id: 7 }, models: { $queryRaw: async () => credits } }
  await expect(resolvers.UserPrivates.boostCreditId({ id: 7 }, {}, owner)).resolves.toBe(11)
  await expect(resolvers.UserPrivates.boostCreditExpiresAt({ id: 7 }, {}, owner)).resolves.toBe(expiresAt)
  const stranger = { me: { id: 8 }, models: { $queryRaw: async () => credits } }
  await expect(resolvers.UserPrivates.boostCreditId({ id: 7 }, {}, stranger)).resolves.toBeNull()
  await expect(resolvers.UserPrivates.boostCreditExpiresAt({ id: 7 }, {}, stranger)).resolves.toBeNull()
  credits = []
  await expect(resolvers.UserPrivates.boostCreditId({ id: 7 }, {}, { me: { id: 7 }, models: { $queryRaw: async () => [] } })).resolves.toBeNull()
})

test('the deprecated single-credit argument redeems exactly that credit', async () => {
  const queries = []
  const item = { id: 42, userId: 7, parentId: null, bio: false, deletedAt: null, status: 'ACTIVE', feeStatus: 'FEE_PAID' }
  const creditRow = { id: 5, userId: 7n, type: 'BOOST', consumedAt: null, itemId: null, expiresAt: new Date('2026-03-01T00:00:00Z') }
  const tx = {
    $queryRaw: async (strings, ...values) => {
      queries.push(values)
      return strings.join('').includes('FROM "Item"') ? [item] : [creditRow]
    },
    streakReward: { updateMany: jest.fn(async () => ({ count: 1 })) },
    item: { update: jest.fn(async () => ({})) }
  }
  const readItem = jest.fn(async () => 'item-result')
  const result = await useBoostCredit(null, { itemId: 42, rewardId: 5 }, { me: { id: 7 }, models: { $transaction: async fn => fn(tx) }, headers: {}, readItem })
  expect(result).toBe('item-result')
  expect(queries[1][0]).toEqual([5])
  expect(tx.streakReward.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ id: { in: [5] }, userId: 7, type: 'BOOST' })
  }))
})
