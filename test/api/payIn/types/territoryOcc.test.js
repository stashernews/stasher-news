/* eslint-env jest */
import { subOccWhere } from '@/api/payIn/lib/territory'

test('omits a null billingPayInId from the where clause (Prisma rejects null for unique fields)', () => {
  const where = subOccWhere({ name: 'x', userId: 1, postTypes: ['LINK'], billingPayInId: null })
  expect('billingPayInId' in where).toBe(false)
  expect(where).toEqual({ name: 'x', userId: 1, postTypes: { equals: ['LINK'] } })
})

test('keeps a set billingPayInId and the postTypes guard', () => {
  const where = subOccWhere({ name: 'x', userId: 1, postTypes: ['LINK'], billingPayInId: 42 })
  expect(where).toEqual({ name: 'x', userId: 1, billingPayInId: 42, postTypes: { equals: ['LINK'] } })
})

test('keeps the full fetched row (incl. updatedAt) so concurrent writes are still caught', () => {
  const updatedAt = new Date()
  const where = subOccWhere({ name: 'x', userId: 1, updatedAt, postTypes: ['LINK'], billingPayInId: null })
  expect(where.updatedAt).toBe(updatedAt)
})
