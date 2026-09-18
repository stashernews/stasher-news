/* eslint-env jest */
import { handleUnsubscribe } from '@/pages/api/email/unsubscribe'
import { createUnsubscribeToken } from '@/lib/emailCrypto'

process.env.EMAIL_MASTER_KEY = Buffer.alloc(32, 115).toString('base64')

function mockRes () {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k] = v },
    status (code) { this.statusCode = code; return this },
    send (body) { this.body = body; return this },
    end () { return this }
  }
}

function mockModels (fail = false) {
  const updates = []
  return {
    _updates: updates,
    user: {
      update: async (args) => {
        if (fail) throw new Error('db down')
        updates.push(args)
        return {}
      }
    }
  }
}

const USER_ID = 42
const TOKEN = createUnsubscribeToken(USER_ID)

test('POST with a valid token disables the digest', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleUnsubscribe({ method: 'POST', query: { u: String(USER_ID), t: TOKEN } }, res, models)
  expect(res.statusCode).toBe(200)
  expect(models._updates).toEqual([{ where: { id: USER_ID }, data: { emailNotifications: false } }])
  expect(res.body).toContain('unsubscribed')
  expect(res.body).toMatch(/no longer receive/)
})

test('GET with a valid token renders a confirm page and does not mutate', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleUnsubscribe({ method: 'GET', query: { u: String(USER_ID), t: TOKEN } }, res, models)
  expect(res.statusCode).toBe(200)
  expect(res.headers['Content-Type']).toBe('text/html')
  expect(res.body).toMatch(/form|post/i)
  expect(res.body).toMatch(/unsubscribe/i)
  expect(models._updates).toHaveLength(0)
})

test('rejects a token for another user', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleUnsubscribe({ method: 'POST', query: { u: '43', t: TOKEN } }, res, models)
  expect(res.statusCode).toBe(400)
  expect(models._updates).toHaveLength(0)
})

test('rejects garbage tokens', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleUnsubscribe({ method: 'POST', query: { u: String(USER_ID), t: 'nope' } }, res, models)
  expect(res.statusCode).toBe(400)
})

test('is idempotent — a second POST still succeeds', async () => {
  const models = mockModels()
  for (let i = 0; i < 2; i++) {
    const res = mockRes()
    await handleUnsubscribe({ method: 'POST', query: { u: String(USER_ID), t: TOKEN } }, res, models)
    expect(res.statusCode).toBe(200)
  }
})

test('returns 500 when the DB update fails', async () => {
  const models = mockModels(true)
  const res = mockRes()
  await handleUnsubscribe({ method: 'POST', query: { u: String(USER_ID), t: TOKEN } }, res, models)
  expect(res.statusCode).toBe(500)
})
