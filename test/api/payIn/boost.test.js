/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn'

// `pay` imports the full payIn type barrel, which pulls in itemCreate →
// @/lib/lexical/server/mentions (ESM-only mdast-util-from-markdown, not
// transformed by next/jest) and @/api/resolvers/item (heavy lexical/html
// chain). Neither is exercised by the BOOST flow, so both are stubbed — same
// technique as test/engine/pollVote.test.js. (babel-jest hoists these
// jest.mock calls above the imports at runtime. Paths are relative because
// jest.mock cannot resolve the @/ alias.)
jest.mock('../../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))

const prisma = new PrismaClient()
let user
let post
const created = { accounts: [], subaddrs: [] }

// The BOOST payIn reserves a major-5 subaddress from the platform_rewards
// wallet's SubaddressIndex pool — the test seeds both (the dev stack usually
// has them, but tests must not depend on that).
async function seedRewardsWallet () {
  const [account] = await prisma.$queryRaw`
    INSERT INTO "MoneroAccount" ("address", label, network, status)
    VALUES ('5' || repeat('A', 94), 'platform_rewards', 'STAGENET'::"Network", 'ACTIVE'::"LwsAccountStatus")
    ON CONFLICT ("address", network) DO NOTHING
    RETURNING id::int AS id`
  const id = account?.id
  if (!id) throw new Error('platform_rewards account insert failed')
  created.accounts.push(id)
  await prisma.$queryRaw`
    INSERT INTO "SubaddressIndex" ("accountId", "majorIndex", "minorIndex", address, state)
    VALUES (${id}::int, 5, 1, '5' || repeat('B', 94), 'AVAILABLE'::"SubaddressState")`
}

beforeAll(async () => {
  await seedRewardsWallet()
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  user = rows[0].id
  const items = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${user}::int, 'boost test', now()) RETURNING id::int AS id`
  post = items[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(post)}::ltree WHERE id = ${post}::int`
})

afterAll(async () => {
  await prisma.item.deleteMany({ where: { id: post } })
  await prisma.user.deleteMany({ where: { id: user } })
  await prisma.subaddressIndex.deleteMany({ where: { accountId: { in: created.accounts } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.$disconnect()
})

test('BOOST payIn returns a monero URI to a major-5 subaddress', async () => {
  const payIn = await pay('BOOST', { id: post, piconeros: 1_000_000_000n }, { me: { id: user } })
  expect(payIn.moneroUri).toMatch(/^monero:/)
  expect(payIn.payInType).toBe('BOOST')
  expect(payIn.piconeros).toBe(0n)
  expect(payIn.moneroSubaddressMajor).toBe(5)
})
