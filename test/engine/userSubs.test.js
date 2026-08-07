/* eslint-env jest */

// Regression test for the 404 on the user profile "turfs" tab (/[name]/territories)
// and the other pages routed through topSubs (/top/territories/*, the subscribed
// territories settings page).
//
// topSubs (api/resolvers/sub.js) filters AggPayIn rows with
//   payInType <> 'DEFUNCT_TERRITORY_DAILY_PAYOUT'
// but that value was dropped from the PayInType enum when the fork rebranded to
// Monero (baseline migration 20260727054513_stealth_baseline). Postgres rejects
// the unknown enum literal with 22P02, the GraphQL query errors, and
// getGetServerSideProps (api/ssrApollo.js) turns that into a 302 to /404.
//
// This test seeds a user and a territory, runs the real userSubs resolver (which
// routes through topSubs), and asserts it neither throws nor drops the territory.
// Run via:
//   docker exec -u apprunner app npx jest test/engine/userSubs.test.js

import { PrismaClient } from '@prisma/client'
import subResolvers from '@/api/resolvers/sub'
import { LIMIT } from '@/lib/cursor'

// Same mocks as test/engine/activeSubs.test.js: the payIn types barrel and the
// lexical server HTML generator pull ESM-only node_modules chains that next/jest
// cannot transform. userSubs never calls pay() or lexical HTML, so the mocks
// only need to satisfy the import graph.
jest.mock('../../api/payIn/types', () => {
  const territoryCreate = jest.requireActual('../../api/payIn/types/territoryCreate')
  return { __esModule: true, default: { TERRITORY_CREATE: territoryCreate } }
})

jest.mock('../../lib/lexical/server/html', () => ({
  lexicalHTMLGenerator: () => () => ''
}))

const prisma = new PrismaClient()

const created = {
  userNames: [],
  users: [],
  subs: []
}

beforeAll(async () => {
  const me = await prisma.user.create({ data: { name: 'userSubsEngine' + Date.now() } })
  created.users.push(me.id)
  created.userNames.push(me.name)

  const sub = await prisma.sub.create({
    data: {
      name: 'userSubsNormal' + Date.now(),
      userId: me.id,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 0,
      postTypes: ['LINK', 'DISCUSSION']
    }
  })
  created.subs.push(sub.name)
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

test('userSubs resolves the founder territories without throwing', async () => {
  const result = await subResolvers.Query.userSubs(null, {
    name: created.userNames[0],
    when: 'forever',
    limit: LIMIT
  }, { models: prisma })

  expect(Array.isArray(result.subs)).toBe(true)
  const sub = result.subs.find(s => s.name === created.subs[0])
  expect(sub).toBeDefined()
  expect(Array.isArray(sub.postTypes)).toBe(true)
  expect(Number(sub.nitems)).toBe(0)
})
