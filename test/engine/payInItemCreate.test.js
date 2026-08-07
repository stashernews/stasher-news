/* eslint-env jest */

// ITEM_CREATE pgboss regression (Task 5 fix). pg-boss v9 dropped the DB-side
// default on pgboss.job.id (uuids are now minted by the JS client), so the raw
// INSERTs in itemCreate.onPaid (timestampItem + imgproxy) and in
// performBotBehavior (deleteItem + reminder) must supply gen_random_uuid().
// Before the fix these threw "null value in column \"id\" of relation \"job\""
// and rolled back the entire begin() tx. ITEM_CREATE is piconeros:0n -> payInState
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
import { onPaid, getInitial } from '@/api/payIn/types/itemCreate'
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
// Stub the fee-subaddress pool so getInitial never touches MoneroAccount /
// SubaddressIndex rows (deterministic; the address is the stagenet primary
// reused in downZap.test.js).
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(async () => ({
    id: 1,
    major: 1,
    minor: 1,
    address: '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  }))
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

// PlatformFeeConfig id=1 exists in the dev DB with @default values; create it
// only if absent so the tests stay self-contained on a fresh database.
let feeConfigCreated = false
async function ensureFeeConfig () {
  const existing = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (existing) return
  await prisma.platformFeeConfig.create({ data: { id: 1 } })
  feeConfigCreated = true
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
  if (feeConfigCreated) {
    await prisma.platformFeeConfig.delete({ where: { id: 1 } }).catch(() => {})
  }
  await prisma.$disconnect()
})

// --- Fix 1: itemCreate.onPaid (timestampItem + imgproxy) ---
test('onPaid creates timestampItem + imgproxy pgboss jobs without throwing', async () => {
  const userId = await createUser()
  const itemId = await createRootPost(userId)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
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

// --- Fix 3: comments are exempt from the posting-fee gate (spec §2.2, row 826) ---
test('getInitial returns a free prospect for comments — no fee subaddress draw', async () => {
  // No ensureFeeConfig() here: the comment early-return precedes any
  // PlatformFeeConfig read (and thus any feePool subaddress draw).
  const userId = await createUser()
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
  expect(result).not.toHaveProperty('moneroUri')
})

test('getInitial returns a posting-fee URI for low-rep post authors', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001')
  expect(result.moneroSubaddressMajor).toBe(1)
})

test('getInitial returns a free prospect for established users', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days'
    WHERE id = ${userId}::int`
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
  expect(result).not.toHaveProperty('moneroUri')
})

// --- Fix 4: comments beyond the 15/month freebie quota pay a flat comment fee ---
test('getInitial returns a comment-fee URI for authors past the freebie quota', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`
    UPDATE users SET "freeCommentCount" = 15
    WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001')
  expect(result.moneroSubaddressMajor).toBe(1)
})

test('getInitial returns a free prospect for anonymous comments', async () => {
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: 27 } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId: 27, piconeros: 0n })
  expect(result).not.toHaveProperty('moneroUri')
})

// --- A-05: 10x spam-fee escalation (item_spam) is applied server-side ---
test('getInitial escalates the posting fee x10 for a second root post within 10m', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await createRootPost(userId) // 1 prior root post by this user -> item_spam(NULL, userId, '10m') = 1
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.01') // 0.001 x 10^1
})

test('getInitial escalates the comment fee x10 for a repeat reply within 10m', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${userId}::int` // past quota
  // item_spam only counts replies whose tree root is NOT authored by the replier
  // (the fork never maintains Item.rootId, so the reply's rootId is set explicitly
  // here) -> root the thread under a second user.
  const otherUserId = await createUser()
  const parentId = await createRootPost(otherUserId)
  // 1 prior reply by this user to this parent -> item_spam(parentId, userId, '10m') = 1
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", text, "rootId", "created_at")
    VALUES (${userId}::int, ${parentId}::int, ${'prior reply'}, ${parentId}::int, now())
    RETURNING id::int AS id`
  const replyId = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(parentId) + '.' + String(replyId)}::ltree WHERE id = ${replyId}::int`
  created.items.push(replyId)
  const result = await getInitial(prisma, { parentId: String(parentId) }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.01') // 0.001 x 10^1
})
