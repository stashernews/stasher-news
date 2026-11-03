/* eslint-env jest */
import { isVerifiedBadgeEnabled } from '@/lib/verified-badge-flag'
import { sweepOpsEarmark } from '@/api/monero/rewards'
import { SITE_SETTINGS_DEFAULTS, __resetSiteSettingsForTests } from '@/lib/siteSettings'
import { newsletterCampaign } from '@/worker/newsletterCampaign'

jest.mock('../../lib/newsletterContent', () => ({ gatherNewsletterContent: async () => [] }))
jest.mock('../../lib/newsletterTemplate', () => ({ renderNewsletter: () => ({ subject: 'test', html: '', text: '' }) }))
jest.mock('../../lib/newsletter', () => ({
  isNewsletterEnabled: () => true,
  checkNewsletterConfig: () => [],
  updateBroadcastDraft: async () => ({ ok: true }),
  sendBroadcast: async () => ({ ok: true })
}))

beforeEach(() => __resetSiteSettingsForTests())
const modelsFor = values => ({ siteSettings: { findUnique: async () => ({ ...SITE_SETTINGS_DEFAULTS, ...values }) } })

test.each([true, false])('verified badge reads the stored %s switch', async value => {
  expect(await isVerifiedBadgeEnabled(modelsFor({ verifiedBadgeEnabled: value }))).toBe(value)
})

test.each([
  [null, 'false', 'DISABLED'], [null, 'true', 'FAILED'], [true, 'false', 'FAILED'], [false, 'true', 'DISABLED']
])('ops sweep uses db=%s over env=%s', async (stored, env, expected) => {
  const prior = { flag: process.env.REWARDS_OPS_SWEEP_ENABLED, address: process.env.REWARDS_COLD_STORAGE_ADDRESS }
  process.env.REWARDS_OPS_SWEEP_ENABLED = env
  process.env.REWARDS_COLD_STORAGE_ADDRESS = 'test-only-unused'
  try {
    const result = await sweepOpsEarmark({ models: modelsFor({ opsSweepEnabled: stored }), distribution: { opsSweptPiconeros: 1n } })
    expect(result.state).toBe(expected)
  } finally {
    for (const [key, value] of [['REWARDS_OPS_SWEEP_ENABLED', prior.flag], ['REWARDS_COLD_STORAGE_ADDRESS', prior.address]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test.each([[null, 'false', 'DRAFT'], [null, 'true', 'SENT'], [true, 'false', 'SENT'], [false, 'true', 'DRAFT']])(
  'newsletter auto-send uses db=%s over env=%s', async (stored, env, expected) => {
    const previous = { ...process.env }
    process.env.NEWSLETTER_AUTO_SEND = env
    delete process.env.NEWSLETTER_TEST_TO
    delete process.env.NEWSLETTER_DRY_RUN
    const row = { id: 1, status: 'DRAFT', resendBroadcastId: 'fake-draft' }
    const models = {
      ...modelsFor({ newsletterAutoSend: stored }),
      newsletterCampaign: {
        findFirst: async () => null,
        findUnique: async () => row,
        updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 } },
        update: async ({ data }) => Object.assign(row, data)
      },
      healthSnapshot: { upsert: async () => ({}) }
    }
    try {
      await newsletterCampaign({ models })
      expect(row.status).toBe(expected)
    } finally { process.env = previous }
  })
