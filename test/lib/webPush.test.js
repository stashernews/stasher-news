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
  jest.resetModules()
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
  models.pushSubscription.findMany.mockResolvedValue([{ id: 1, endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }])
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
