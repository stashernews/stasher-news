/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { saveSubscription } from '../../api/pushSubscriptions'

test('concurrent endpoint claims cannot bypass the existing-owner key check', async () => {
  const admin = new PrismaClient()
  const schema = `push_subscription_test_${process.pid}_${Date.now()}`
  const url = new URL(process.env.DATABASE_URL)
  url.searchParams.set('schema', schema)
  url.searchParams.set('connection_limit', '4')
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  let release
  let reads = 0
  const bothRead = new Promise(resolve => { release = resolve })
  const models = {
    $transaction: (fn, options) => client.$transaction(tx => fn({
      pushSubscription: {
        findUnique: async args => {
          const row = await tx.pushSubscription.findUnique(args)
          if (++reads <= 2) {
            if (reads === 2) release()
            await bothRead
          }
          return row
        },
        upsert: args => tx.pushSubscription.upsert(args),
        deleteMany: args => tx.pushSubscription.deleteMany(args)
      }
    }), options)
  }
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await client.$executeRawUnsafe(`CREATE TABLE "${schema}"."PushSubscription" (id serial PRIMARY KEY, "userId" integer NOT NULL, endpoint text NOT NULL UNIQUE, p256dh text NOT NULL, auth text NOT NULL, created_at timestamp NOT NULL DEFAULT now())`)
    const claims = await Promise.allSettled([7, 8].map(userId => saveSubscription({ models, userId, endpoint: 'https://fcm.googleapis.com/test', p256dh: `key${userId}`, auth: `auth${userId}` })))
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter(claim => claim.status === 'rejected')).toHaveLength(1)
    const winner = claims.find(claim => claim.status === 'fulfilled').value
    expect(await client.pushSubscription.findMany()).toEqual([winner])
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.$disconnect()
  }
}, 15000)
