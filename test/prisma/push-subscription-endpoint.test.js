/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import path from 'path'

test('endpoint migration keeps the latest owner and permits idempotent endpoint writes', async () => {
  const prisma = new PrismaClient()
  const migration = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261105120000_push_subscription_endpoint/migration.sql'), 'utf8')
  try {
    await prisma.$transaction(async tx => {
      // Temporary tables shadow public tables only on this transaction's connection.
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "PushSubscription" (id integer PRIMARY KEY, endpoint text NOT NULL, "userId" integer NOT NULL) ON COMMIT DROP')
      await tx.$executeRawUnsafe('INSERT INTO "PushSubscription" VALUES (1, \'https://push.example/1\', 7), (2, \'https://push.example/1\', 8)')
      for (const statement of migration.split(';').filter(sql => sql.trim())) await tx.$executeRawUnsafe(statement)
      expect(await tx.$queryRawUnsafe('SELECT * FROM "PushSubscription"')).toEqual([{ id: 2, endpoint: 'https://push.example/1', userId: 8 }])
      await tx.$executeRawUnsafe('INSERT INTO "PushSubscription" VALUES (3, \'https://push.example/1\', 9) ON CONFLICT (endpoint) DO UPDATE SET "userId" = EXCLUDED."userId"')
      expect(await tx.$queryRawUnsafe('SELECT * FROM "PushSubscription"')).toEqual([{ id: 2, endpoint: 'https://push.example/1', userId: 9 }])
    })
  } finally {
    await prisma.$disconnect()
  }
})
