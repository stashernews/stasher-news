/* eslint-env jest */

// Unit tests for lib/founderNyms.js — runtime nym -> id resolution for founder
// properties (trust seeds, curator handicap). Pure unit test: `models` is a
// stub, no DB. The integration behavior (trust job / curator shares consuming
// the resolver) is pinned by test/worker/trust.test.js and
// test/worker/curatorShares.test.js against the live dev DB.

import { TRUST_SEED_NYMS, HANDICAP_NYMS, nymsToIds, resolveTrustSeeds } from '@/lib/founderNyms'
import { USER_ID } from '@/lib/constants'

// Minimal Prisma stub: mirrors user.findMany({ where: { name: { in } }, select })
function modelsWithUsers (users) {
  return {
    user: {
      findMany: async ({ where, select }) => users
        .filter(u => where.name.in.includes(u.name))
        .map(u => ({ id: u.id, name: u.name }))
        .map(u => Object.fromEntries([['id', u.id], ['name', u.name]].filter(([k]) => select[k])))
    }
  }
}

test('founder nym lists carry the platform account, the personal founder account, and sn', () => {
  expect(TRUST_SEED_NYMS).toEqual(['stasher', 'untraceable'])
  expect(HANDICAP_NYMS).toEqual(['stasher', 'sn', 'untraceable'])
})

test('nymsToIds resolves names to ids in nym-list order, skipping missing nyms', async () => {
  // 'sn' has no row; 'untraceable' is listed last but stored first — output
  // order must follow the NYM list, not DB storage order.
  const models = modelsWithUsers([
    { id: 42, name: 'untraceable' },
    { id: USER_ID.stasher, name: 'stasher' }
  ])
  await expect(nymsToIds(models, ['stasher', 'sn', 'untraceable'])).resolves.toEqual([USER_ID.stasher, 42])
})

test('nymsToIds returns [] when no nym resolves', async () => {
  await expect(nymsToIds(modelsWithUsers([]), TRUST_SEED_NYMS)).resolves.toEqual([])
})

test('resolveTrustSeeds resolves every existing seed nym', async () => {
  const models = modelsWithUsers([
    { id: USER_ID.stasher, name: 'stasher' },
    { id: 7, name: 'untraceable' }
  ])
  await expect(resolveTrustSeeds(models)).resolves.toEqual([USER_ID.stasher, 7])
})

test('resolveTrustSeeds falls back to the migration-guaranteed platform account', async () => {
  // Fresh DB before the founder signs up: no seed nym exists except stasher —
  // and even if ALL were missing, seeds must never be empty.
  const models = modelsWithUsers([])
  await expect(resolveTrustSeeds(models)).resolves.toEqual([USER_ID.stasher])
})
