/* eslint-env jest */
import { adminServer } from '@/pages/api/admin/graphql'
afterAll(() => adminServer.stop())

test('private API serializes snapshot money exactly and hides raw candidate secrets', async () => {
  const models = {
    rewardDistribution: { findUnique: async () => ({ id: 7, periodEnd: new Date(), status: 'COMPLETE', contributorPoolMode: 'SHADOW', contributorBudgetPiconeros: 0n, contributorParams: { scored: [{ itemId: 9, authorId: 2, share: '9007199254740993', recipientAddress: 'secret' }] } }) },
    item: { findMany: async () => [] }
  }
  const result = await adminServer.executeOperation({ query: '{ adminContributorSnapshot(id: 7) { id mode appliedBudget posts { itemId available share score } } }' }, { contextValue: { models } })
  expect(result.body.singleResult.errors).toBeUndefined()
  expect(result.body.singleResult.data.adminContributorSnapshot).toMatchObject({ mode: 'SHADOW', appliedBudget: '0', posts: [{ itemId: 9, available: false, share: '9007199254740993', score: null }] })
})

test('eligibility mutation requires the private client marker', async () => {
  const result = await adminServer.executeOperation({ query: 'mutation { adminSetContributorEligibility(id: 7, expectedVersion: "x", disqualified: false, reason: "reviewed") { applied } }' })
  expect(result.http.status).toBe(403)
})

test('private schema returns recorded tipper accounts without exposing extra user fields', async () => {
  const models = {
    rewardDistribution: { findUnique: async () => ({ id: 7, periodEnd: new Date(), status: 'COMPLETE', contributorPoolMode: 'SHADOW', contributorParams: { scored: [{ itemId: 9, authorId: 2, n: 1, trustedTipperIds: [10] }] } }) },
    item: { findMany: async () => [] },
    user: { findMany: async () => [{ id: 10, name: 'alice', privateKey: 'canary' }] }
  }
  const result = await adminServer.executeOperation({ query: '{ adminContributorSnapshot(id: 7) { posts { trustedTipperAccounts { id name } } } }' }, { contextValue: { models } })
  expect(result.body.singleResult.errors).toBeUndefined()
  expect(result.body.singleResult.data.adminContributorSnapshot.posts[0].trustedTipperAccounts).toEqual([{ id: 10, name: 'alice' }])
})
