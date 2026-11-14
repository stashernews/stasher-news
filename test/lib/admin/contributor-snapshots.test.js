/* eslint-env jest */
import { readContributorRuns, readContributorSnapshot } from '@/lib/admin/contributor-snapshots'

const run = params => ({ id: 7, periodEnd: new Date('2026-11-09T00:00:00Z'), status: 'COMPLETE', contributorPoolMode: 'SHADOW', contributorBudgetPiconeros: 0n, contributorDistributedPiconeros: 0n, contributorParams: params })
const modelsFor = row => ({ rewardDistribution: { findUnique: async () => row }, item: { findMany: jest.fn(async () => []) } })

test('preserves shadow allocations, exact money and missing post rows without leaking arbitrary JSON', async () => {
  const models = modelsFor(run({ configuredMode: 'SHADOW', allocation: { paid: '9007199254740993', rolledOver: '0' }, scored: [{ itemId: 9, authorId: 2, rank: 1, S: 27.6, n: 4, share: '9007199254740993', recipientAddress: 'private-canary', note: 'private-canary' }] }))
  const result = await readContributorSnapshot(models, 7)
  expect(result.appliedBudget).toBe('0')
  expect(result.allocation.paid).toBe('9007199254740993')
  expect(result.posts[0]).toMatchObject({ itemId: 9, rank: 1, available: false, score: 27.6, trustedTippers: 4 })
  expect(JSON.stringify(result)).not.toContain('private-canary')
})

test.each([null, {}, { errors: ['selection_failed'] }])('handles incomplete snapshot %p without inventing amounts', async params => {
  const result = await readContributorSnapshot(modelsFor(run(params)), 7)
  expect(result.posts).toEqual([])
  expect(result.allocation).toBeNull()
  expect(result.candidates).toBeNull()
})

test('uses recorded unscored window and nulls invalid numeric values', async () => {
  const result = await readContributorSnapshot(modelsFor(run({ windowNotScored: ['2026-10-26T00:00:00Z', '2026-11-02T00:00:00Z'], allocation: { paid: '1e9' }, scored: [{ itemId: 9, authorId: 2, S: Infinity, share: '-1' }] })), 7)
  expect(result.windowScored).toBe(false)
  expect(result.windowStart).toBe('2026-10-26T00:00:00.000Z')
  expect(result.allocation.paid).toBeNull()
  expect(result.posts[0].score).toBeNull()
  expect(result.posts[0].share).toBeNull()
  expect(result.warnings.length).toBeGreaterThan(0)
})

test('paginates by stable distribution id with a bounded query', async () => {
  const models = { rewardDistribution: { findMany: jest.fn(async () => Array.from({ length: 21 }, (_, i) => ({ ...run(null), id: 30 - i }))) } }
  const page = await readContributorRuns(models, { beforeId: 40 })
  expect(page.rows).toHaveLength(20)
  expect(page.nextBeforeId).toBe(11)
  expect(models.rewardDistribution.findMany.mock.calls[0][0]).toMatchObject({ take: 21, orderBy: { id: 'desc' }, where: { id: { lt: 40 } } })
})

test('resolves recorded trusted IDs with current names in one minimal user lookup', async () => {
  const models = modelsFor(run({
    scored: [
      { itemId: 9, authorId: 2, n: 2, trustedTipperIds: [10, 20] },
      { itemId: 11, authorId: 3, n: 1, trustedTipperIds: [10] },
      { itemId: 12, authorId: 4, n: 0, trustedTipperIds: [] }
    ]
  }))
  models.user = { findMany: jest.fn(async () => [{ id: 10, name: 'renamed-account', privateKey: 'secret-canary' }]) }
  const result = await readContributorSnapshot(models, 7)
  expect(result.posts[0].trustedTipperAccounts).toEqual([{ id: 10, name: 'renamed-account' }, { id: 20, name: null }])
  expect(result.posts[1].trustedTipperAccounts).toEqual([{ id: 10, name: 'renamed-account' }])
  expect(result.posts[2].trustedTipperAccounts).toEqual([])
  expect(models.user.findMany).toHaveBeenCalledTimes(1)
  expect(models.user.findMany).toHaveBeenCalledWith({ where: { id: { in: [10, 20] } }, select: { id: true, name: true } })
  expect(JSON.stringify(result)).not.toContain('secret-canary')
})

test.each([undefined, null, [0], ['10'], [10, 10], [10], [0, 20], ['10', 20], [2147483648, 20], [-10, 20]])('does not reconstruct absent or inconsistent trusted IDs: %p', async ids => {
  const models = modelsFor(run({ scored: [{ itemId: 9, authorId: 2, n: 2, trustedTipperIds: ids }] }))
  expect((await readContributorSnapshot(models, 7)).posts[0].trustedTipperAccounts).toBeNull()
})
