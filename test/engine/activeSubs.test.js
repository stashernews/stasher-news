/* eslint-env jest */

// Regression test for the blank territory dropdown when logged in.
//
// The authenticated `activeSubs` resolver (api/resolvers/sub.js) queries the
// Sub table with a raw Prisma query. Two things break the dropdown:
//   1. any row with postTypes = NULL violates GraphQL's non-null
//      `postTypes: [String!]!` field, which nulls the ENTIRE activeSubs array;
//   2. the platform-internal `_p4downvote_*` reward subs (created by the
//      stagenet downvote integration test) show up in every user's dropdown.
//
// This test seeds a platform-internal `_p4downvote_*` sub WITH NULL postTypes
// (exactly what the leaked dev-DB rows look like) and a normal sub, then runs
// the real resolver and asserts it neither throws nor returns the internal
// reward sub, and that every returned sub has a non-null postTypes array.
//
// Mirrors the real-DB integration style of test/worker/rewardsDistributor.test.js
// (live database, FK-safe teardown tracked in a `created` object). Run via:
//   docker exec -u apprunner app npx jest test/engine/activeSubs.test.js

import { PrismaClient } from '@prisma/client'
import subResolvers from '@/api/resolvers/sub'
import { createUserLoader } from '@/api/loaders'

// api/resolvers/sub imports `pay` from api/payIn, whose barrel pulls the
// ESM-only mdast-util-from-markdown chain (via itemCreate -> mentions). next/jest
// does not transform that node_modules ESM, so the payIn types barrel is mocked
// to expose only TERRITORY_CREATE (which has no ESM-only deps) — same trick as
// test/engine/payInTerritoryCreate.test.js. activeSubs never calls pay(), so the
// mock only needs to satisfy the import graph.
jest.mock('../../api/payIn/types', () => {
  const territoryCreate = jest.requireActual('../../api/payIn/types/territoryCreate')
  return { __esModule: true, default: { TERRITORY_CREATE: territoryCreate } }
})

// resolvers/sub also imports the lexical server HTML generator, whose node_modules
// deps (github-slugger) are ESM-only and untransformable by next/jest. activeSubs
// does not use it, so stub it away.
jest.mock('../../lib/lexical/server/html', () => ({
  lexicalHTMLGenerator: () => () => ''
}))

const prisma = new PrismaClient()

const created = {
  users: [],
  subs: []
}

beforeAll(async () => {
  const me = await prisma.user.create({ data: { name: 'activeSubsEngine' + Date.now() } })
  created.users.push(me.id)

  // Normal territory that must show up (billingStatus ONCE so the payIn gate
  // seeded by the other engine tests doesn't matter here).
  const normal = await prisma.sub.create({
    data: {
      name: 'activeSubsNormal' + Date.now(),
      userId: me.id,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 0,
      postTypes: ['LINK', 'DISCUSSION']
    }
  })
  created.subs.push(normal.name)

  // Platform-internal reward sub with NULL postTypes — replicates the leaked
  // `_p4downvote_*` rows the stagenet downvote test leaves behind.
  const internal = await prisma.sub.create({
    data: {
      name: `_p4downvote_${Date.now()}`,
      userId: me.id,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 0
    }
  })
  created.subs.push(internal.name)

  // nsfw territory owned by the viewer: must still show up in the viewer's own
  // dropdown even while their nsfw mode is off (founders can always see their
  // own turfs).
  const nsfwOwned = await prisma.sub.create({
    data: {
      name: `activeSubsNsfw${Date.now()}`,
      userId: me.id,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 0,
      postTypes: ['LINK', 'DISCUSSION'],
      nsfw: true
    }
  })
  created.subs.push(nsfwOwned.name)
})

afterAll(async () => {
  for (const name of created.subs) {
    await prisma.userSubTrust.deleteMany({ where: { subName: name } })
    await prisma.sub.deleteMany({ where: { name } })
  }
  for (const id of created.users) {
    await prisma.user.deleteMany({ where: { id } })
  }
  await prisma.$disconnect()
})

test('activeSubs for a logged-in user does not throw on internal subs with NULL postTypes', async () => {
  const me = { id: created.users[0] }
  const userLoader = createUserLoader(prisma)
  const result = await subResolvers.Query.activeSubs(null, null, { models: prisma, me, userLoader })

  expect(Array.isArray(result)).toBe(true)
})

test('activeSubs includes normal territories with a non-null postTypes array', async () => {
  const me = { id: created.users[0] }
  const userLoader = createUserLoader(prisma)
  const result = await subResolvers.Query.activeSubs(null, null, { models: prisma, me, userLoader })

  const names = result.map(s => s.name)
  for (const name of created.subs.filter(s => !s.startsWith('_p4downvote_'))) {
    expect(names).toContain(name)
  }

  for (const sub of result) {
    expect(Array.isArray(sub.postTypes)).toBe(true)
  }
})

test('activeSubs excludes the platform-internal _p4downvote_* reward subs', async () => {
  const me = { id: created.users[0] }
  const userLoader = createUserLoader(prisma)
  const result = await subResolvers.Query.activeSubs(null, null, { models: prisma, me, userLoader })

  for (const sub of result) {
    expect(sub.name.startsWith('_p4downvote_')).toBe(false)
  }
})

test('activeSubs shows the founder their own nsfw territory without nsfw mode', async () => {
  const me = { id: created.users[0] }
  const userLoader = createUserLoader(prisma)
  const result = await subResolvers.Query.activeSubs(null, null, { models: prisma, me, userLoader })

  const names = result.map(s => s.name)
  const nsfwOwned = created.subs.find(s => s.startsWith('activeSubsNsfw'))
  expect(nsfwOwned).toBeDefined()
  expect(names).toContain(nsfwOwned)
})
