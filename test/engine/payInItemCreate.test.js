/* eslint-env jest */

// ITEM_CREATE pgboss regression (Task 5 fix). pg-boss v9 dropped the DB-side
// default on pgboss.job.id (uuids are now minted by the JS client), so the raw
// INSERTs in itemCreate.onPaid (timestampItem + imgproxy) and in
// performBotBehavior (deleteItem + reminder) must supply gen_random_uuid().
// Before the fix these threw "null value in column \"id\" of relation \"job\""
// and rolled back the entire begin() tx. ITEM_CREATE is mcost:0n -> payInState
// PAID, so begin() runs onPaid synchronously — i.e. posting crashed on submit.
//
// This is a real-DB integration test: it drives the actual onPaid and
// performBotBehavior code paths against a live migrated database and asserts the
// pgboss rows are genuinely created (a mock-based test could not prove the INSERT
// is accepted by the v9 schema, which is the whole point).
//
// Mirrors the real-DB style of test/engine/payInTerritoryCreate.test.js and
// test/worker/rewardsDistributor.test.js. Run via:
//   docker exec -u apprunner app npx jest test/engine/payInItemCreate.test.js

import { PrismaClient } from '@prisma/client'
import { onPaid } from '@/api/payIn/types/itemCreate'
import { performBotBehavior } from '@/api/payIn/lib/item'

// itemCreate.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown, which next/jest does not transform from node_modules)
// and @/api/resolvers/item (getItem — pulls the heavy lexical/html +
// page-metadata-parser chain). Neither is exercised by onPaid, so both are
// stubbed. Relative paths are used because next/jest registers no `@/*`
// moduleNameMapper, so jest.mock — unlike import — cannot resolve the `@/`
// alias as its first argument; jest still resolves both the `@/` import inside
// itemCreate.js and this relative spec to the same absolute path, so the mock
// intercepts the real import. babel-jest hoists these jest.mock calls above the
// ES imports above, so the stubs register before itemCreate.js is evaluated.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))

const prisma = new PrismaClient()

// FK-safe teardown tracking. Item and PayIn cascade their ItemPayIn / Reminder
// children, so only the parents (items, payIns, users) plus the pgboss jobs we
// created need explicit cleanup.
const created = { users: [], items: [], payIns: [], reminderIds: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// Minimal root post (parentId null, freebie false) — enough for onPaid and
// performBotBehavior. path is set via a second statement (ltree is unsupported
// in Prisma create), exactly like test/worker/rewardsDistributor.test.js.
async function createRootPost (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${userId}::int, ${'pgboss regression post'}, now())
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// Delete pgboss jobs we inserted so the worker never executes them against test
// rows (imgproxy startafter is only +5s; this runs in milliseconds after commit).
async function deleteJobsForItem (itemId) {
  const id = String(itemId)
  await prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE data->>'id' = ${id} OR data->>'itemId' = ${id}`
}

afterAll(async () => {
  // pgboss.jobs (no FKs) first, then Reminder rows, then parents.
  for (const id of created.items) {
    await deleteJobsForItem(id)
  }
  await prisma.reminder.deleteMany({ where: { id: { in: created.reminderIds } } }).catch(() => {})
  for (const id of created.items) {
    await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  }
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } }).catch(() => {})
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

// --- Fix 1: itemCreate.onPaid (timestampItem + imgproxy) ---
test('onPaid creates timestampItem + imgproxy pgboss jobs without throwing', async () => {
  const userId = await createUser()
  const itemId = await createRootPost(userId)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', mcost: 0n }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId, payInId: payIn.id } })

  // This is the regression: before the fix, the first raw INSERT here threw
  // "null value in column id" and rolled back the whole transaction.
  await prisma.$transaction(async tx => {
    await onPaid(tx, payIn.id)
  })

  const jobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE data->>'id' = ${String(itemId)}`
  const names = jobs.map(r => r.name).sort()
  expect(names).toEqual(['imgproxy', 'timestampItem'])
})

// --- Fix 2: performBotBehavior (deleteItem + reminder) ---
test('performBotBehavior creates deleteItem + reminder pgboss jobs for marked text', async () => {
  const userId = await createUser()
  const itemId = await createRootPost(userId)
  // both directives in one text block -> both INSERTs run
  const text = 'hello world @delete in 1 hour @remindme in 1 day'

  await prisma.$transaction(async tx => {
    await performBotBehavior(tx, { text, id: itemId, userId })
  })

  const deleteJobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE name = 'deleteItem' AND data->>'id' = ${String(itemId)}`
  expect(deleteJobs).toHaveLength(1)

  const remindJobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE name = 'reminder' AND data->>'itemId' = ${String(itemId)}`
  expect(remindJobs).toHaveLength(1)

  // performBotBehavior also writes a Reminder row alongside the pgboss job
  const reminder = await prisma.reminder.findFirst({ where: { itemId } })
  expect(reminder).toBeTruthy()
  created.reminderIds.push(reminder.id)
})
