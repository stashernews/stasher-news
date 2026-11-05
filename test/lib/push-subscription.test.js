/* eslint-env jest */
import { renewPushSubscription, detachPushSubscription, flushPendingRenewal, RENEWAL_RETRY_TAG } from '../../lib/push-subscription'

const subscription = (endpoint) => ({ endpoint, keys: { p256dh: 'public', auth: 'secret' } })

function renewalContext (saved = subscription('https://push.example/old')) {
  const stored = new Map([['subscription', { ...saved, userId: 7 }]])
  return {
    stored,
    storage: {
      getItem: async key => stored.get(key),
      setItem: async (key, value) => stored.set(key, value),
      removeItem: async key => stored.delete(key)
    },
    registration: { pushManager: { getSubscription: async () => null }, sync: { register: jest.fn(async () => {}) } },
    fetch: jest.fn(async () => ({ ok: true, json: async () => ({ data: { savePushSubscription: { id: 1 } } }) }))
  }
}

test('renewal with no replacement leaves the stored subscription intact', async () => {
  const ctx = renewalContext()
  await expect(renewPushSubscription({}, ctx)).resolves.toBeUndefined()
  expect(ctx.stored.get('subscription').endpoint).toBe('https://push.example/old')
  expect(ctx.fetch).not.toHaveBeenCalled()
})

test('renewal persists replacement only after an authenticated server acknowledgement', async () => {
  const ctx = renewalContext()
  await renewPushSubscription({ newSubscription: subscription('https://push.example/new') }, ctx)
  expect(ctx.stored.get('subscription')).toMatchObject({ endpoint: 'https://push.example/new', userId: 7 })
  const request = JSON.parse(ctx.fetch.mock.calls[0][1].body)
  expect(request.variables).toMatchObject({ oldEndpoint: 'https://push.example/old', expectedUserId: 7, sendConfirmation: false })
})

test('a GraphQL renewal failure preserves the last known server subscription', async () => {
  const ctx = renewalContext()
  ctx.fetch.mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'not authenticated' }] }) })
  await expect(renewPushSubscription({ newSubscription: subscription('https://push.example/new') }, ctx)).rejects.toThrow()
  expect(ctx.stored.get('subscription').endpoint).toBe('https://push.example/old')
})

test('account detachment revokes browser delivery before removing the server record', async () => {
  const order = []
  const current = { endpoint: 'https://push.example/old', unsubscribe: async () => { order.push('browser'); return true } }
  const registration = { pushManager: { getSubscription: async () => current } }
  await detachPushSubscription({ registration, deleteSubscription: async endpoint => order.push(endpoint) })
  expect(order).toEqual(['browser', 'https://push.example/old'])
})

test('failed browser revocation blocks the account transition', async () => {
  const registration = { pushManager: { getSubscription: async () => ({ unsubscribe: async () => { throw new Error('offline') } }) } }
  await expect(detachPushSubscription({ registration, deleteSubscription: async () => {} })).rejects.toThrow('offline')
})

test('renewal recreates an expired subscription using its original application key', async () => {
  const ctx = renewalContext()
  ctx.stored.get('subscription').applicationServerKey = 'vapid-public'
  ctx.registration.pushManager.permissionState = async () => 'granted'
  ctx.registration.pushManager.subscribe = jest.fn(async () => subscription('https://push.example/recreated'))
  await renewPushSubscription({}, ctx)
  expect(ctx.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: 'vapid-public' })
  expect(ctx.stored.get('subscription').endpoint).toBe('https://push.example/recreated')
})

test('a failed renewal persists an ownership-bound retry record and asks for background replay', async () => {
  const ctx = renewalContext()
  ctx.fetch.mockRejectedValue(new Error('network unreachable'))
  await expect(renewPushSubscription({ newSubscription: subscription('https://push.example/new') }, ctx)).rejects.toThrow('network unreachable')
  expect(ctx.stored.get('pendingRenewal')).toMatchObject({
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'public', auth: 'secret' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7
  })
  expect(ctx.registration.sync.register).toHaveBeenCalledWith(RENEWAL_RETRY_TAG)
})

test('flushing the retry record saves the browser-held replacement and clears it', async () => {
  const ctx = renewalContext()
  ctx.stored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'public', auth: 'secret' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'vapid-public',
    at: Date.now()
  })
  await flushPendingRenewal(ctx)
  const request = JSON.parse(ctx.fetch.mock.calls[0][1].body)
  expect(request.variables).toMatchObject({ endpoint: 'https://push.example/new', oldEndpoint: 'https://push.example/old', expectedUserId: 7, sendConfirmation: false })
  expect(ctx.stored.get('subscription')).toMatchObject({ endpoint: 'https://push.example/new', userId: 7 })
  expect(ctx.stored.has('pendingRenewal')).toBe(false)
})

test('an expired retry record is dropped without contacting the server', async () => {
  const ctx = renewalContext()
  ctx.stored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'public', auth: 'secret' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'vapid-public',
    at: Date.now() - 49 * 60 * 60 * 1000
  })
  await flushPendingRenewal(ctx)
  expect(ctx.fetch).not.toHaveBeenCalled()
  expect(ctx.stored.has('pendingRenewal')).toBe(false)
})

test('a failed flush keeps the retry record for the next replay opportunity', async () => {
  const ctx = renewalContext()
  ctx.stored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'public', auth: 'secret' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'vapid-public',
    at: Date.now()
  })
  ctx.fetch.mockRejectedValue(new Error('still unreachable'))
  await expect(flushPendingRenewal(ctx)).rejects.toThrow('still unreachable')
  expect(ctx.stored.has('pendingRenewal')).toBe(true)
})

const drain = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }

test('a failed renewal registers background replay before surfacing the failure', async () => {
  const ctx = renewalContext()
  let release
  ctx.registration.sync.register = jest.fn(() => new Promise(resolve => { release = resolve }))
  ctx.fetch.mockRejectedValue(new Error('network unreachable'))
  let rejected = false
  const renewal = renewPushSubscription({ newSubscription: subscription('https://push.example/new') }, ctx).catch(() => { rejected = true })
  await drain()
  // the retry must be scheduled within the service worker event lifetime,
  // which only lasts until waitUntil's promise settles
  expect(rejected).toBe(false)
  release()
  await renewal
  expect(rejected).toBe(true)
  expect(ctx.registration.sync.register).toHaveBeenCalledWith(RENEWAL_RETRY_TAG)
})

test('a retry record without a valid timestamp is dropped without contacting the server', async () => {
  const ctx = renewalContext()
  ctx.stored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'public', auth: 'secret' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'vapid-public'
  })
  await flushPendingRenewal(ctx)
  expect(ctx.fetch).not.toHaveBeenCalled()
  expect(ctx.stored.has('pendingRenewal')).toBe(false)
})
