/* eslint-env jest */
import { lexicalStateLoader } from '@/lib/lexical/server/loader'
import { incrementFreePostCount } from '@/api/payIn/lib/freebie'
import { SITE_SETTINGS_DEFAULTS, __resetSiteSettingsForTests } from '@/lib/siteSettings'
import { USER_ID } from '@/lib/constants'

jest.mock('../../lib/lexical/server/interpolator', () => ({ prepareLexicalState: ({ context }) => context }))

beforeEach(() => __resetSiteSettingsForTests())

test.each([null, { id: 99 }])('SSR text masking uses promoted defaults for absent viewer row %s', async me => {
  const models = { siteSettings: { findUnique: async () => ({ ...SITE_SETTINGS_DEFAULTS, defaultCommentsFilterPiconeros: 0n }) } }
  const loader = lexicalStateLoader({ models, me, userLoader: { load: async () => null } })
  const result = await loader.load({ text: 'masked comment', context: { userId: 7, parentId: 1, netInvestment: -5000000000 } })
  expect(result.outlawed).toBe(true)
})

// The deaddrop bot's posts are platform-generated, so no quota setting ever
// meters them against a user freebie slot.
test.each([0, 1])('system post stays fee-exempt and unmetered at quota %i', async quota => {
  const updates = []
  const tx = {
    siteSettings: { findUnique: async () => ({ ...SITE_SETTINGS_DEFAULTS, freePostsPerMonth: quota }) },
    platformFeeConfig: { findUnique: async () => ({}) },
    user: { findUnique: async () => ({ id: USER_ID.deadDrop, freePostCount: 0, freePostResetAt: null }), update: async input => { updates.push(input) } },
    $queryRaw: async () => []
  }
  await incrementFreePostCount(tx, { item: { feeStatus: 'FEE_NOT_REQUIRED' }, userId: USER_ID.deadDrop })
  expect(updates).toHaveLength(0)
})
