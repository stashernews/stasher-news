/* eslint-env jest */
import { saveSubscription, deleteSubscription } from '../../api/pushSubscriptions'

function database (initial = []) {
  let rows = initial.map(row => ({ ...row }))
  let nextId = 10
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const pushSubscription = {
    findUnique: async ({ where }) => rows.find(row => matches(row, where)),
    findFirst: async ({ where }) => rows.find(row => matches(row, where)),
    upsert: async ({ where, create, update }) => {
      let row = rows.find(row => matches(row, where))
      if (row) Object.assign(row, update)
      else { row = { id: nextId++, ...create }; rows.push(row) }
      return { ...row }
    },
    deleteMany: async ({ where }) => {
      const before = rows.length
      rows = rows.filter(row => !matches(row, where))
      return { count: before - rows.length }
    }
  }
  const models = { pushSubscription, $transaction: async fn => fn({ pushSubscription }) }
  return { models, rows: () => rows }
}

const input = { endpoint: 'https://push.example/new', p256dh: 'public', auth: 'secret' }

test('repeated saves produce one subscription and transfer it to the active account', async () => {
  const db = database()
  await saveSubscription({ models: db.models, userId: 7, ...input })
  await saveSubscription({ models: db.models, userId: 8, ...input })
  expect(db.rows()).toEqual([{ id: 10, userId: 8, ...input }])
})

test('knowing an endpoint without its keys cannot transfer another account subscription', async () => {
  const db = database([{ id: 1, userId: 7, ...input }])
  await expect(saveSubscription({ models: db.models, userId: 8, ...input, auth: 'wrong' })).rejects.toThrow()
  expect(db.rows()[0].userId).toBe(7)
})

test('renewal cannot remove a different user subscription', async () => {
  const db = database([{ id: 1, userId: 9, ...input, endpoint: 'https://push.example/old' }])
  await saveSubscription({ models: db.models, userId: 7, ...input, oldEndpoint: 'https://push.example/old' })
  expect(db.rows()).toHaveLength(2)
  expect(db.rows()[0].userId).toBe(9)
})

test('deletion is idempotent and scoped to the authenticated account', async () => {
  const db = database([{ id: 1, userId: 9, ...input }])
  expect(await deleteSubscription({ models: db.models, userId: 7, endpoint: input.endpoint })).toBeNull()
  expect(db.rows()).toHaveLength(1)
  expect(await deleteSubscription({ models: db.models, userId: 9, endpoint: input.endpoint })).toMatchObject({ id: 1 })
  expect(await deleteSubscription({ models: db.models, userId: 9, endpoint: input.endpoint })).toBeNull()
})

test('a serialization conflict retries the ownership check against the committed row', async () => {
  const db = database([{ id: 1, userId: 7, ...input }])
  const transaction = db.models.$transaction
  db.models.$transaction = jest.fn().mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' })).mockImplementation(transaction)
  await expect(saveSubscription({ models: db.models, userId: 8, ...input, auth: 'wrong' })).rejects.toThrow('belongs to another account')
})
