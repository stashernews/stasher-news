/* eslint-env jest */
import resolvers from '@/api/resolvers/siteSettings'
import { SITE_SETTINGS_DEFAULTS, __resetSiteSettingsForTests } from '@/lib/siteSettings'
import { __resetFeeConfigCacheForTests } from '@/api/monero/postingFee'

beforeEach(() => { __resetSiteSettingsForTests(); __resetFeeConfigCacheForTests() })

test('public settings expose only behavioral display values and use live fee config', async () => {
  const models = {
    siteSettings: { findUnique: async () => ({ ...SITE_SETTINGS_DEFAULTS, maxItemTurfs: 8, verifiedBadgeEnabled: true }) },
    platformFeeConfig: { findUnique: async () => ({ postingFeeFloorPiconeros: 2000000000n, commentFeePiconeros: 300000000n }) }
  }
  const result = await resolvers.Query.siteSettings(null, {}, { models })
  expect(result).toMatchObject({ maxItemTurfs: 8, postingFeeFloorPiconeros: 2000000000n, commentFeePiconeros: 300000000n })
  expect(Object.keys(result).sort()).toEqual([
    'anonCommentFeeMultiplier', 'anonPostFeeMultiplier', 'commentFeePiconeros',
    'defaultCommentsFilterPiconeros', 'defaultPostsFilterPiconeros', 'homepagePostsFilterPiconeros',
    'itemEditSeconds', 'itemSpamIntervalMinutes', 'maxItemTurfs', 'postingFeeFloorPiconeros',
    'spamEscalationDenominator', 'spamEscalationNumerator'
  ].sort())
})

test('missing rows return server defaults, without requiring a session', async () => {
  const models = { siteSettings: { findUnique: async () => null }, platformFeeConfig: { findUnique: async () => null } }
  expect(await resolvers.Query.siteSettings(null, {}, { models })).toMatchObject({
    maxItemTurfs: 5, itemEditSeconds: 600, postingFeeFloorPiconeros: 1000000000n, commentFeePiconeros: 600000000n
  })
})
