import { gql } from '@apollo/client'

export const SITE_SETTINGS = gql`
  query SiteSettings {
    siteSettings {
      maxItemTurfs itemEditSeconds homepagePostsFilterPiconeros
      defaultPostsFilterPiconeros defaultCommentsFilterPiconeros
      anonPostFeeMultiplier anonCommentFeeMultiplier
      postingFeeFloorPiconeros commentFeePiconeros
      itemSpamIntervalMinutes spamEscalationNumerator spamEscalationDenominator
    }
  }
`
