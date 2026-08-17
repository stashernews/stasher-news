/* eslint-env jest */
// webPushEnabled is a module-scope const computed at import time, so the
// module is re-required (jest.resetModules) after each env change, mirroring
// test/api/monero/masterkey.test.js. api/models is mocked so no DB is
// needed; 'web-push' is mocked so no real HTTP send ever happens.
// jest.mock is given a relative path: the `@/*` path mapping applies to
// imports (jsconfig.json declares `"@/*": ["./*"]`), but jest.mock cannot
// resolve the alias specifier, so relative paths are used (matching
// test/worker/opsSweep.test.js).

const WEBPUSH_PATH = require.resolve('../../lib/webPush')

jest.mock('../../api/models', () => ({
  pushSubscription: {
    findMany: jest.fn()
  }
}))
jest.mock('web-push', () => ({
  sendNotification: jest.fn().mockResolvedValue({})
}))

const VALID_PUBKEY = 'BK9Zi9XzzIHsN1kD93h31ifevXxVa_-_qSekZXA5tvYB4xdr2S6XuT8nKdM-dImAqjrWWZfSAT1f6mheAzxALxs'
const VALID_PRIVKEY = 'TnyqXRYaPHWt4NOVKJ38hlpaRA3dAvqXG2iJ5-Bz-J8'
const SUBSCRIPTION_ROW = {
  id: 1,
  endpoint: 'https://push.example.test/sub/1',
  p256dh: 'abc',
  auth: 'xyz'
}

const VAPID_VARS = ['VAPID_MAILTO', 'NEXT_PUBLIC_VAPID_PUBKEY', 'VAPID_PRIVKEY', 'NEXT_PUBLIC_URL']
const _origNodeEnv = process.env.NODE_ENV

function clearVapidEnv () {
  for (const name of VAPID_VARS) delete process.env[name]
}

beforeEach(() => {
  clearVapidEnv()
  jest.resetModules()
})

afterEach(() => {
  clearVapidEnv()
  process.env.NODE_ENV = _origNodeEnv
})

test('skips sending in production when VAPID is unconfigured', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_URL = 'https://stasher.news'
  const { notifyReferral } = require(WEBPUSH_PATH)
  const { sendNotification } = require('web-push')
  require('../../api/models').pushSubscription.findMany.mockResolvedValue([SUBSCRIPTION_ROW])

  await notifyReferral(42)

  expect(require('../../api/models').pushSubscription.findMany).toHaveBeenCalled()
  expect(sendNotification).not.toHaveBeenCalled()
})

test('skips sending in development when VAPID is unconfigured', async () => {
  process.env.NODE_ENV = 'development'
  const { notifyReferral } = require(WEBPUSH_PATH)
  const { sendNotification } = require('web-push')
  require('../../api/models').pushSubscription.findMany.mockResolvedValue([SUBSCRIPTION_ROW])

  await notifyReferral(42)

  expect(require('../../api/models').pushSubscription.findMany).toHaveBeenCalled()
  expect(sendNotification).not.toHaveBeenCalled()
})

test('sends with vapidDetails when VAPID is configured', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_URL = 'https://stasher.news'
  process.env.VAPID_MAILTO = 'mailto:hello@stasher.news'
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = VALID_PUBKEY
  process.env.VAPID_PRIVKEY = VALID_PRIVKEY
  const { notifyReferral } = require(WEBPUSH_PATH)
  const { sendNotification } = require('web-push')
  require('../../api/models').pushSubscription.findMany.mockResolvedValue([SUBSCRIPTION_ROW])

  await notifyReferral(42)

  expect(sendNotification).toHaveBeenCalledTimes(1)
  const [subscription, , options] = sendNotification.mock.calls[0]
  expect(subscription).toEqual({
    endpoint: SUBSCRIPTION_ROW.endpoint,
    keys: { p256dh: SUBSCRIPTION_ROW.p256dh, auth: SUBSCRIPTION_ROW.auth }
  })
  expect(options.vapidDetails).toEqual({
    subject: 'mailto:hello@stasher.news',
    publicKey: VALID_PUBKEY,
    privateKey: VALID_PRIVKEY
  })
})
