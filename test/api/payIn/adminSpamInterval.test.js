/* eslint-env jest */
import { escalatedFeePiconeros } from '@/api/payIn/types/itemCreate'
import itemResolvers from '@/api/resolvers/item'
import { __resetSiteSettingsForTests } from '@/lib/siteSettings'

jest.mock('../../../lib/lexical/server/mentions', () => ({ extractMentions: () => ({ userNames: [], itemIds: [] }) }))
jest.mock('../../../lib/lexical/server/html', () => ({ lexicalHTMLGenerator: jest.fn() }))

beforeEach(() => __resetSiteSettingsForTests())

test.each([17, 53, 1439])('both spam queries bind %i minutes instead of interpolating SQL', async minutes => {
  const calls = []
  const capture = (sql, ...values) => {
    calls.push({ sql: Array.isArray(sql) ? sql.join('?') : sql, values })
    return [{ item_spam: 2, n: 2 }]
  }
  const models = {
    siteSettings: { findUnique: async () => ({ itemSpamIntervalMinutes: minutes }) },
    $queryRaw: capture,
    $queryRawUnsafe: capture
  }
  expect(await itemResolvers.Query.itemRepetition(null, { parentId: '12' }, { me: { id: 7 }, models })).toBe(2)
  expect(await escalatedFeePiconeros(models, { parentId: '12', userId: 7, basePiconeros: 100n })).toBe(225n)
  for (const call of calls) {
    expect(call.sql).toContain('make_interval(mins =>')
    expect(call.sql).not.toContain(String(minutes))
    expect(call.values).toEqual([12, 7, minutes])
  }
})

test('anonymous escalation binds zero minutes and a zero fee avoids SQL', async () => {
  const calls = []
  const models = {
    siteSettings: { findUnique: async () => ({ itemSpamIntervalMinutes: 17 }) },
    $queryRaw: async (sql, ...values) => { calls.push(values); return [{ n: 0 }] }
  }
  expect(await escalatedFeePiconeros(models, { parentId: null, userId: 27, basePiconeros: 100n })).toBe(100n)
  expect(calls).toEqual([[null, 27, 0]])
  expect(await escalatedFeePiconeros(models, { parentId: null, userId: 27, basePiconeros: 0n })).toBe(0n)
  expect(calls).toHaveLength(1)
})
