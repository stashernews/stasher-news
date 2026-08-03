/* eslint-env jest */

// Integration test: verifies the item_path and item_subnames triggers
// (migration 20260802200000) fire correctly.
//
// These triggers were missing from the stealth-baseline migration, causing every
// app-created Item to have NULL path (crash in item-info.js `item.path.split`)
// and NULL subNames (invisible in territory feeds). The triggers derive path
// from the parent ltree and subNames from the ItemSub join table.
//
// Requires a live, migrated database. Run via:
//   ./sndev test test/prisma/itemPathSubnames.test.js

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

let testUserId
const testItemIds = []

afterAll(async () => {
  for (const id of testItemIds) {
    await prisma.$executeRaw`DELETE FROM "ItemSub" WHERE "itemId" = ${id}::int`
    await prisma.$executeRaw`DELETE FROM "Item" WHERE id = ${id}::int`
  }
  if (testUserId) {
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${testUserId}::int`
  }
  await prisma.$disconnect()
})

async function insertUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  return rows[0].id
}

test('item_path trigger sets path to the item id for a root post', async () => {
  testUserId = await insertUser()
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${testUserId}::int, 'path-trigger-root')
    RETURNING id::int AS id, path::text AS path`
  testItemIds.push(rows[0].id)

  expect(rows[0].path).toBe(String(rows[0].id))
})

test('item_path trigger sets path to parent.child for a reply', async () => {
  const parentId = testItemIds[0]
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", title) VALUES (${testUserId}::int, ${parentId}::int, 'path-trigger-reply')
    RETURNING id::int AS id, path::text AS path`
  testItemIds.push(rows[0].id)

  expect(rows[0].path).toBe(`${parentId}.${rows[0].id}`)
})

test('item_subnames trigger populates subNames when an ItemSub row is added', async () => {
  const itemId = testItemIds[0]
  await prisma.$executeRaw`INSERT INTO "ItemSub" ("itemId", "subName") VALUES (${itemId}::int, 'monero')`

  const rows = await prisma.$queryRaw`SELECT "subNames" FROM "Item" WHERE id = ${itemId}::int`
  expect(rows[0].subNames).toEqual(['monero'])
})

test('item_subnames trigger recomputes subNames when an ItemSub row is removed', async () => {
  const itemId = testItemIds[0]
  await prisma.$executeRaw`DELETE FROM "ItemSub" WHERE "itemId" = ${itemId}::int AND "subName" = 'monero'`

  const rows = await prisma.$queryRaw`SELECT "subNames" FROM "Item" WHERE id = ${itemId}::int`
  expect(rows[0].subNames).toBeNull()
})
