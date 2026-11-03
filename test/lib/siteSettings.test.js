/* eslint-env jest */
import { getSiteSettings, SITE_SETTINGS_DEFAULTS, effectiveFlag, clearSiteSettingsCache, __resetSiteSettingsForTests, ENV_FLAG_PARSERS } from '@/lib/siteSettings'
import { logWarn } from '@/lib/logger'

jest.mock('../../lib/logger', () => ({ logWarn: jest.fn() }))

beforeEach(() => {
  __resetSiteSettingsForTests()
  logWarn.mockClear()
  jest.useFakeTimers({ now: 100000 })
})
afterEach(() => jest.useRealTimers())

test('an unavailable models handle falls back without throwing on a disabled path', async () => {
  expect(await getSiteSettings(undefined)).toEqual(SITE_SETTINGS_DEFAULTS)
})

test('caches for 60 seconds, clears immediately, and permits fresh walk reads', async () => {
  let interval = 10
  const models = { siteSettings: { findUnique: jest.fn(async () => ({ ...SITE_SETTINGS_DEFAULTS, itemSpamIntervalMinutes: interval })) } }
  expect((await getSiteSettings(models)).itemSpamIntervalMinutes).toBe(10)
  interval = 20
  jest.advanceTimersByTime(59999)
  expect((await getSiteSettings(models)).itemSpamIntervalMinutes).toBe(10)
  jest.advanceTimersByTime(1)
  expect((await getSiteSettings(models)).itemSpamIntervalMinutes).toBe(20)
  interval = 30
  expect((await getSiteSettings(models, { fresh: true })).itemSpamIntervalMinutes).toBe(30)
  interval = 40
  clearSiteSettingsCache()
  expect((await getSiteSettings(models)).itemSpamIntervalMinutes).toBe(40)
})

test.each([null, new Error('database unavailable')])('missing row or query failure falls back and logs once', async result => {
  const models = { siteSettings: { findUnique: jest.fn(async () => { if (result instanceof Error) throw result; return result }) } }
  expect(await getSiteSettings(models)).toEqual(SITE_SETTINGS_DEFAULTS)
  jest.advanceTimersByTime(60000)
  expect(await getSiteSettings(models)).toEqual(SITE_SETTINGS_DEFAULTS)
  expect(logWarn).toHaveBeenCalledTimes(1)
})

test.each([
  [undefined, false, true, false], ['', false, true, false], ['0', false, true, false],
  ['1', true, true, false], ['true', false, true, true], ['false', false, false, false]
])('preserves legacy env parsing for %s', (input, nostr, ops, newsletter) => {
  const prior = process.env.ADMIN_TEST_FLAG
  if (input === undefined) delete process.env.ADMIN_TEST_FLAG
  else process.env.ADMIN_TEST_FLAG = input
  try {
    for (const [parser, expected] of [[ENV_FLAG_PARSERS.nostrSocialPosting, nostr], [ENV_FLAG_PARSERS.opsSweepEnabled, ops], [ENV_FLAG_PARSERS.newsletterAutoSend, newsletter]]) {
      expect(effectiveFlag(null, 'ADMIN_TEST_FLAG', parser)).toEqual({ value: expected, source: 'env' })
      expect(effectiveFlag(true, 'ADMIN_TEST_FLAG', parser)).toEqual({ value: true, source: 'db' })
      expect(effectiveFlag(false, 'ADMIN_TEST_FLAG', parser)).toEqual({ value: false, source: 'db' })
    }
  } finally {
    if (prior === undefined) delete process.env.ADMIN_TEST_FLAG
    else process.env.ADMIN_TEST_FLAG = prior
  }
})
