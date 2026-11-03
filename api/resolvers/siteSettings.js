import { getSiteSettings } from '@/lib/siteSettings'
import { getCachedPlatformFeeConfig } from '@/api/monero/postingFee'

export default {
  Query: {
    siteSettings: async (_parent, _args, { models }) => {
      const [settings, fees] = await Promise.all([getSiteSettings(models), getCachedPlatformFeeConfig(models)])
      const keys = [
        'maxItemTurfs', 'itemEditSeconds', 'homepagePostsFilterPiconeros',
        'defaultPostsFilterPiconeros', 'defaultCommentsFilterPiconeros',
        'anonPostFeeMultiplier', 'anonCommentFeeMultiplier', 'itemSpamIntervalMinutes',
        'spamEscalationNumerator', 'spamEscalationDenominator'
      ]
      return {
        ...Object.fromEntries(keys.map(key => [key, settings[key]])),
        postingFeeFloorPiconeros: fees?.postingFeeFloorPiconeros ?? 1000000000n,
        commentFeePiconeros: fees?.commentFeePiconeros ?? 600000000n
      }
    }
  }
}
