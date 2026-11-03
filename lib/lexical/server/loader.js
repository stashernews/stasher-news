import DataLoader from 'dataloader'
import { prepareLexicalState } from '@/lib/lexical/server/interpolator'
import { getSiteSettings, SITE_SETTINGS_DEFAULTS } from '@/lib/siteSettings'

/**
 * creates a DataLoader that batches lexical state requests
 *
 * when multiple resolvers request the same text (e.g., for both lexicalState and html fields),
 * DataLoader ensures we only compute the state once per unique text within the same tick.
 *
 * when item fields (userId, parentId, netInvestment) are provided in the context,
 * computes outlawed status based on the viewer's sat filter settings vs the item's netInvestment.
 *
 * @param {Object} [params] - optional parameters
 * @param {Object} [params.me] - the current viewer from the request context
 * @param {DataLoader} [params.userLoader] - DataLoader for user lookups
 * @returns {DataLoader} DataLoader for lexical state
 */
export function lexicalStateLoader ({ me, userLoader, models } = {}) {
  let settingsPromise
  async function getUserFilters () {
    const user = me && userLoader ? await userLoader.load(me.id) : null
    const defaults = user ? null : await (settingsPromise ??= models ? getSiteSettings(models) : Promise.resolve(SITE_SETTINGS_DEFAULTS))
    return {
      postsPiconerosFilter: user ? user.postsPiconerosFilter : defaults.defaultPostsFilterPiconeros,
      commentsPiconerosFilter: user ? user.commentsPiconerosFilter : defaults.defaultCommentsFilterPiconeros,
      imgproxyOnly: user?.imgproxyOnly ?? false,
      showImagesAndVideos: user?.showImagesAndVideos ?? true
    }
  }

  return new DataLoader(
    async (keys) => {
      const userFilters = await getUserFilters()
      return Promise.all(
        keys.map(({ text, context }) => {
          const { userId, parentId, netInvestment, ...rest } = context || {}
          let outlawed = false
          if (netInvestment !== undefined) {
            const threshold = parentId ? userFilters.commentsPiconerosFilter : userFilters.postsPiconerosFilter
            outlawed = me?.id !== userId && threshold != null && (netInvestment ?? 0) < threshold
          }
          // filter out media if the user has disabled them
          const showImagesAndVideos = userFilters.showImagesAndVideos
          const imgproxyOnly = userFilters.imgproxyOnly

          try {
            const lexicalState = prepareLexicalState({ text, context: { ...rest, outlawed, showImagesAndVideos, imgproxyOnly } })
            return lexicalState
          } catch (error) {
            console.error('error preparing Lexical State:', error)
            return null
          }
        })
      )
    },
    {
      cacheKeyFn: ({ text, context }) => {
        const { imgproxyUrls, rel, userId, parentId, netInvestment } = context || {}
        return JSON.stringify({ text, imgproxyUrls, rel, userId, parentId, netInvestment })
      }
    }
  )
}
