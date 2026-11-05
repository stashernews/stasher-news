/* eslint-env jest */
// Focused gating test: walled items must only ever push their indexable
// (teaser) text, never the locked body or the cosmetic [monerowall] marker.
jest.mock('web-push', () => ({ sendNotification: jest.fn() }))
jest.mock('../../api/models', () => ({
  user: { findUnique: jest.fn() },
  pushSubscription: { findMany: jest.fn() },
  $queryRawUnsafe: jest.fn()
}))
jest.mock('../../lib/user', () => ({ isMuted: jest.fn() }))

const WALL_ENABLED_AT = new Date('2026-09-18T00:00:00Z')

function item (over = {}) {
  return {
    id: 42,
    userId: 7,
    text: 'public intro\n[monerowall]\nsecret body',
    moneroWallEnabledAt: WALL_ENABLED_AT,
    moneroWallRemovedAt: null,
    netInvestment: 0,
    user: { name: 'alice' },
    ...over
  }
}

let webPush
let models
let isMuted
let webPushLib

beforeEach(() => {
  jest.clearAllMocks()
  process.env.VAPID_MAILTO = 'mailto:test@example.com'
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = 'test-public-key'
  process.env.VAPID_PRIVKEY = 'test-private-key'
  process.env.NEXT_PUBLIC_URL = 'https://stasher.news'

  webPush = require('web-push')
  models = require('../../api/models')
  isMuted = require('../../lib/user').isMuted
  webPushLib = require('../../lib/webPush')

  isMuted.mockResolvedValue(false)
  models.user.findUnique.mockResolvedValue({ id: 99, name: 'alice', postsPiconerosFilter: null, commentsPiconerosFilter: null })
  models.$queryRawUnsafe.mockResolvedValue([{ id: 1 }])
  models.pushSubscription.findMany.mockResolvedValue([{ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' }])
  webPush.sendNotification.mockResolvedValue({})
})

function pushedBody () {
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
  return JSON.parse(webPush.sendNotification.mock.calls[0][1]).notification.body
}

test('notifyMention pushes the teaser for a walled item', async () => {
  await webPushLib.notifyMention({ models, userId: 99, item: item() })

  const body = pushedBody()
  expect(body).toContain('public intro')
  expect(body).not.toContain('secret body')
  expect(body).not.toContain('[monerowall]')
})

test('notifyItemMention rewrites links on the gated teaser only', async () => {
  const referrerItem = item({ id: 7, text: 'see https://stasher.news/items/5\n[monerowall]\nsecret body' })

  await webPushLib.notifyItemMention({ models, referrerItem, refereeItem: item({ id: 42 }) })

  const body = pushedBody()
  expect(body).toBe('see #5')
})

test('notifyMention pushes walled items fully public after removal, minus the marker', async () => {
  const removed = item({ text: 'public intro\n[monerowall]\nnow public body', moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') })

  await webPushLib.notifyMention({ models, userId: 99, item: removed })

  const body = pushedBody()
  expect(body).toContain('now public body')
  expect(body).not.toContain('[monerowall]')
})

test('missing-user push filters follow promoted settings, including the batch path', async () => {
  models.user.findUnique.mockResolvedValue(null)
  models.user.findMany = jest.fn(async () => [])
  models.siteSettings = { findUnique: async () => ({ defaultPostsFilterPiconeros: 0n, defaultCommentsFilterPiconeros: 0n }) }
  const post = item({ title: 'post', netInvestment: -1n })
  expect(await webPushLib.meetsUserSatFilter(99, post)).toBe(false)
  expect(await webPushLib.getUsersPassingSatFilter([99], post)).toEqual(new Set())
})

test('subscription confirmation rejects instead of claiming activation after provider failure', async () => {
  webPush.sendNotification.mockRejectedValue({ statusCode: 401 })
  await expect(webPushLib.sendPushSubscriptionReply({ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })).rejects.toThrow()
})

test('long multibyte notification bodies stay within the encrypted push payload budget', async () => {
  await webPushLib.notifyMention({ models, userId: 99, item: item({ moneroWallEnabledAt: null, text: '🎉'.repeat(6000) }) })
  const payload = webPush.sendNotification.mock.calls[0][1]
  expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(3800)
  expect(JSON.parse(payload).notification.body).not.toContain('\uFFFD')
})

test('push delivery sets a socket timeout and a short message expiry', async () => {
  await webPushLib.sendPushSubscriptionReply({ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })
  const options = webPush.sendNotification.mock.calls[0][2]
  expect(options.timeout).toBeGreaterThan(0)
  expect(options.timeout).toBeLessThanOrEqual(10000)
  expect(options.TTL).toBeLessThanOrEqual(86400)
})

test('transient provider failures retry without discarding a valid subscription', async () => {
  jest.useFakeTimers()
  webPush.sendNotification.mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValue({ statusCode: 201 })
  try {
    const sending = webPushLib.sendPushSubscriptionReply({ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })
    await jest.runAllTimersAsync()
    await sending
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

test.each(['http://push.example/1', 'https://127.0.0.1/1', 'https://[::1]/1', 'https://user:password@push.example/1', 'https://untrusted.example/push', 'https://fcm.googleapis.com.attacker.example/1', 'https://jmt17.google.com.attacker.example/1', 'https://other.google.com/fcm/send/test'])('refuses unsafe push endpoints: %s', async endpoint => {
  await expect(webPushLib.sendPushSubscriptionReply({ id: 1, endpoint, p256dh: 'p', auth: 'a' })).rejects.toThrow()
  expect(webPush.sendNotification).not.toHaveBeenCalled()
})

test('push sockets use the public-address DNS guard', async () => {
  await webPushLib.sendPushSubscriptionReply({ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })
  expect(webPush.sendNotification.mock.calls[0][2].agent.options.lookup).toBe(require('../../lib/ssrf').ssrfSafeLookup)
})

test('expired endpoint cleanup cannot delete a subscription moved to a different account', async () => {
  models.pushSubscription.deleteMany = jest.fn(async () => ({ count: 0 }))
  webPush.sendNotification.mockRejectedValue({ statusCode: 410 })
  await expect(webPushLib.sendPushSubscriptionReply({ id: 1, userId: 7, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })).rejects.toThrow()
  expect(models.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 1, endpoint: 'https://fcm.googleapis.com/1', userId: 7 } })
})

test.each(['https://fcm.googleapis.com/fcm/send/test', 'https://jmt17.google.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/test', 'https://wns2.notify.windows.com/test'])('accepts supported browser provider: %s', async endpoint => {
  await webPushLib.sendPushSubscriptionReply({ id: 1, endpoint, p256dh: 'p', auth: 'a' })
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
})

test('persistent transient failures stop after three attempts', async () => {
  jest.useFakeTimers()
  webPush.sendNotification.mockRejectedValue({ statusCode: 503 })
  try {
    const rejected = expect(webPushLib.sendPushSubscriptionReply({ id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: 'p', auth: 'a' })).rejects.toThrow()
    await jest.runAllTimersAsync()
    await rejected
    expect(webPush.sendNotification).toHaveBeenCalledTimes(3)
  } finally {
    jest.useRealTimers()
  }
})
