/* eslint-env jest */

// Regression test for the authed activeSubs path: it returns raw
// `SELECT "Sub".*` rows (NOT Prisma-mapped objects), so every Sub column the
// client SUB_FIELDS fragment requests must exist as a camelCase PHYSICAL
// column (or be aliased). The 2026-08-21 turf-owner-revenue migration
// initially created post_premium_piconeros/comment_premium_piconeros
// snake_case via @map — the raw rows lacked postPremiumPiconeros and the
// non-nullable Sub.postPremiumPiconeros field nulled the whole activeSubs
// query for every logged-in user (empty turf dropdown in the header).
// The fix renamed the physical columns to camelCase (sibling convention:
// postsPiconerosFilter). This test pins that contract.

import { PrismaClient } from '@prisma/client'
import subResolvers from '@/api/resolvers/sub'

// api/resolvers/sub.js transitively imports lexical/server deps (ESM-only).
// Mirror the mocks in test/api/resolvers/topSubs.test.js.
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

const prisma = new PrismaClient()

afterAll(async () => {
  await prisma.$disconnect()
})

describe('activeSubs authed path (raw SQL) camelCase column contract', () => {
  test('every row carries non-null BigInt premium fields', async () => {
    const userLoader = { load: async () => ({ nsfwMode: false }) }
    const subs = await subResolvers.Query.activeSubs(
      null, {}, { models: prisma, me: { id: 616 }, userLoader })

    expect(subs.length).toBeGreaterThan(0)
    for (const sub of subs) {
      expect(typeof sub.postPremiumPiconeros).toBe('bigint')
      expect(typeof sub.commentPremiumPiconeros).toBe('bigint')
      expect(sub.postPremiumPiconeros).toBeGreaterThanOrEqual(0n)
      expect(sub.commentPremiumPiconeros).toBeGreaterThanOrEqual(0n)
    }
  })

  test('postsPiconerosFilter sibling still camelCase (same contract)', async () => {
    const userLoader = { load: async () => ({ nsfwMode: false }) }
    const subs = await subResolvers.Query.activeSubs(
      null, {}, { models: prisma, me: { id: 616 }, userLoader })
    expect(typeof subs[0].postsPiconerosFilter).toBe('bigint')
  })
})
