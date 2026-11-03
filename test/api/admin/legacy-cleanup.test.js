/* eslint-env jest */
import { graphql } from 'graphql'
import { makeExecutableSchema } from '@graphql-tools/schema'
import publicTypeDefs from '@/api/typeDefs'
import { updateItem } from '@/api/resolvers/item'
import publicAdmin from '@/api/resolvers/admin'
import { ADMIN_ITEMS, USER_ID, DOMAIN_BETA_IDS } from '@/lib/constants'

jest.mock('../../../components/editor', () => ({ SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: jest.fn(async () => ({ id: 42, payIn: { id: 1 } })) }))
jest.mock('../../../lib/lexical/server/html', () => ({ lexicalHTMLGenerator: async () => '' }))

test('the public on-air mutation is removed while the banner query remains readable', async () => {
  const schema = makeExecutableSchema({ typeDefs: publicTypeDefs })
  const result = await graphql({ schema, source: 'mutation { onAirToggle }' })
  expect(result.errors?.[0].message).toContain('Cannot query field "onAirToggle"')
  expect(await publicAdmin.Query.snl(null, {}, { models: { snl: { findFirst: async () => ({ live: true }) } } })).toBe(true)
})

test('only @stasher keeps the special-item admin edit privilege; domain beta access is separate', async () => {
  const id = ADMIN_ITEMS[0]
  const models = {
    item: { findUnique: async () => ({ id, userId: 99999, subNames: ['monero'], deletedAt: null, itemPayIns: [] }) },
    user: { findUnique: async () => ({ bioId: null }) }
  }
  await expect(updateItem(null, { id, text: 'updated', subNames: ['monero'] }, { me: { id: USER_ID.stasher }, models })).resolves.toBeTruthy()
  await expect(updateItem(null, { id, text: 'updated', subNames: ['monero'] }, { me: { id: USER_ID.sn }, models })).rejects.toThrow('item does not belong to you')
  expect(DOMAIN_BETA_IDS).toContain(USER_ID.sn)
})
