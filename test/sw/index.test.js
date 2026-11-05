/* eslint-env jest */
// Drives the service worker's real event handlers to prove storage operations
// are serialized: concurrent events (a background replay and an account
// switch, a page-side subscription store and an in-flight replay) must not
// interleave read-decide-write cycles and clobber each other's records.

jest.mock('workbox-precaching', () => ({ precacheAndRoute: jest.fn() }))
jest.mock('workbox-recipes', () => ({ offlineFallback: jest.fn() }))
jest.mock('workbox-routing', () => ({ setDefaultHandler: jest.fn() }))
jest.mock('workbox-strategies', () => ({ NetworkOnly: class {} }))
jest.mock('workbox-navigation-preload', () => ({ enable: jest.fn() }))

const mockStored = new Map()
jest.mock('serviceworker-storage', () => ({
  __esModule: true,
  default: class {
    async getItem (key) { return mockStored.get(key) }
    async setItem (key, value) { mockStored.set(key, value) }
    async removeItem (key) { mockStored.delete(key) }
  }
}))

const listeners = new Map()

beforeAll(() => {
  global.self = {
    __WB_MANIFEST: [],
    addEventListener: (type, handler) => listeners.set(type, handler),
    registration: { showNotification: jest.fn(), getNotifications: async () => [] },
    navigator: {}
  }
  jest.isolateModules(() => { require('../../sw/index') })
})

const drain = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const fire = (type, event) => {
  const waits = []
  listeners.get(type)({ ...event, waitUntil: p => waits.push(Promise.resolve(p)) })
  return waits
}

beforeEach(() => { mockStored.clear() })

test('a replay in flight cannot resurrect records an account switch cleared', async () => {
  mockStored.set('subscription', { endpoint: 'https://push.example/old', userId: 7 })
  mockStored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'p', auth: 'a' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'k',
    at: Date.now()
  })
  let release
  global.fetch = jest.fn(() => new Promise(resolve => { release = resolve }))
  const waits = [
    ...fire('pushsubscriptionchange', {}),
    ...fire('message', { data: { action: 'DELETE_SUBSCRIPTION' } })
  ]
  await drain()
  try {
    release({ ok: true, json: async () => ({ data: { savePushSubscription: { id: 1 } } }) })
  } finally {
    await Promise.all(waits.map(p => p.catch(() => {})))
  }
  // the replay and the account switch ran in order: the switch ran last, so
  // the replay's late response cannot resurrect the cleared records
  expect(mockStored.has('subscription')).toBe(false)
  expect(mockStored.has('pendingRenewal')).toBe(false)
})

test('a replay completing late cannot clobber a newer page-side subscription', async () => {
  mockStored.set('subscription', { endpoint: 'https://push.example/old', userId: 7 })
  mockStored.set('pendingRenewal', {
    endpoint: 'https://push.example/new',
    keys: { p256dh: 'p', auth: 'a' },
    oldEndpoint: 'https://push.example/old',
    expectedUserId: 7,
    applicationServerKey: 'k',
    at: Date.now()
  })
  let release
  global.fetch = jest.fn(() => new Promise(resolve => { release = resolve }))
  const waits = [
    ...fire('pushsubscriptionchange', {}),
    ...fire('message', {
      data: {
        action: 'STORE_SUBSCRIPTION',
        subscription: { endpoint: 'https://push.example/eight', keys: { p256dh: 'p8', auth: 'a8' }, userId: 8, applicationServerKey: 'k' }
      }
    })
  ]
  await drain()
  try {
    release({ ok: true, json: async () => ({ data: { savePushSubscription: { id: 1 } } }) })
  } finally {
    await Promise.all(waits.map(p => p.catch(() => {})))
  }
  // the newest state wins: the stale account-7 replay must not overwrite
  // account 8's page-side subscription
  expect(mockStored.get('subscription')).toMatchObject({ endpoint: 'https://push.example/eight', userId: 8 })
})
