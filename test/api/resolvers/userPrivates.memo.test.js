/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'
import { __resetFeeConfigCacheForTests } from '@/api/monero/postingFee'
import { __resetSiteSettingsForTests } from '@/lib/siteSettings'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

// `me` (polled by every logged-in client) selects many UserPrivates fields off
// a few shared bundles. Each bundle must be computed once per request, not
// once per field.

const { UserPrivates } = userResolvers
const CONFIG = { freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7, commentFeePiconeros: 600_000_000n }
const user = { id: 1, streak: 4, freeCommentCount: 0, freeCommentResetAt: null, freePostCount: 0, freePostResetAt: null, lastFreeReplyAt: null, stackedPiconeros: 0n, createdAt: new Date() }

// bundle -> the fields `me` selects from it (fragments/users.js)
const BUNDLES = {
  commentQuota: ['freeCommentsLeft', 'freeCommentsQuota', 'freeReplyAvailable'],
  questState: ['questUpvoteComplete', 'questDrawnType', 'questDrawnComplete', 'questsCompletedToday', 'flameCycleDay', 'flameWeek'],
  postQuota: ['freePostsLeft', 'freePostsQuota', 'freePostCredits', 'freePostCreditsExpireAt'],
  postingFee: ['postingFeeRequired', 'postingFeePiconeros', 'postingFeeFloorPiconeros', 'freePostThresholdPiconeros', 'freePostMinAgeDays'],
  territoryFee: ['territoryMonthlyPiconeros', 'territoryYearlyPiconeros', 'territoryOncePiconeros', 'commentFeePiconeros']
}

function mkModels () {
  const models = {
    platformFeeConfig: { findUnique: jest.fn(async () => CONFIG) },
    user: { findUnique: jest.fn(async () => user) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('StreakReward')) return [{ credits: 1, nextExpiresAt: null }]
      if (sql.includes('PENDING_FEE')) return [{ comments: 0, posts: 0 }]
      return []
    })
  }
  models.queries = () => models.platformFeeConfig.findUnique.mock.calls.length +
    models.user.findUnique.mock.calls.length + models.$queryRaw.mock.calls.length
  return models
}

async function resolve (fields, ctx) {
  return Promise.all(fields.map(field => UserPrivates[field](user, {}, ctx)))
}

beforeEach(() => {
  __resetFeeConfigCacheForTests()
  __resetSiteSettingsForTests()
})

test('every field of a bundle costs what one field costs, within one request', async () => {
  const one = mkModels()
  await resolve(Object.values(BUNDLES).map(fields => fields[0]), { models: one, me: { id: user.id } })

  __resetFeeConfigCacheForTests()
  __resetSiteSettingsForTests()
  const all = mkModels()
  await resolve(Object.values(BUNDLES).flat(), { models: all, me: { id: user.id } })

  expect(all.queries()).toBe(one.queries())
  // the posting-fee bundle reuses the post quota rather than re-reading it
  const postCreditReads = all.$queryRaw.mock.calls.filter(c => String(c[0].join('')).includes("'POST'"))
  expect(postCreditReads).toHaveLength(1)
})

test('the memo never outlives its request', async () => {
  const models = mkModels()
  await resolve(BUNDLES.postingFee, { models, me: { id: user.id } })
  const first = models.$queryRaw.mock.calls.length
  await resolve(BUNDLES.postingFee, { models, me: { id: user.id } })
  expect(models.$queryRaw.mock.calls.length).toBe(2 * first)
})
