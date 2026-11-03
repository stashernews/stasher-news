import {
  FREE_POSTS_PER_MONTH, FREE_COMMENTS_PER_WEEK, HOMEPAGE_POSTS_PICONEROS_FILTER,
  DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER,
  MAX_ITEM_TURFS, ITEM_EDIT_SECONDS, ANON_POST_FEE_MULTIPLIER, ANON_COMMENT_FEE_MULTIPLIER,
  ITEM_SPAM_FEE_ESCALATION_NUMERATOR, ITEM_SPAM_FEE_ESCALATION_DENOMINATOR
} from '@/lib/constants'
import { logWarn } from '@/lib/logger'
import { TRUST_DEFAULTS } from '@/lib/trust-defaults'

export const SITE_SETTINGS_DEFAULTS = Object.freeze({
  itemSpamIntervalMinutes: 10,
  spamEscalationNumerator: Number(ITEM_SPAM_FEE_ESCALATION_NUMERATOR),
  spamEscalationDenominator: Number(ITEM_SPAM_FEE_ESCALATION_DENOMINATOR),
  freePostsPerMonth: FREE_POSTS_PER_MONTH,
  freeCommentsPerWeek: FREE_COMMENTS_PER_WEEK,
  homepagePostsFilterPiconeros: BigInt(HOMEPAGE_POSTS_PICONEROS_FILTER),
  defaultPostsFilterPiconeros: BigInt(DEFAULT_POSTS_PICONEROS_FILTER),
  defaultCommentsFilterPiconeros: BigInt(DEFAULT_COMMENTS_PICONEROS_FILTER),
  maxItemTurfs: MAX_ITEM_TURFS,
  itemEditSeconds: ITEM_EDIT_SECONDS,
  anonPostFeeMultiplier: ANON_POST_FEE_MULTIPLIER,
  anonCommentFeeMultiplier: ANON_COMMENT_FEE_MULTIPLIER,
  ...TRUST_DEFAULTS,
  verifiedBadgeEnabled: false,
  nostrSocialPosting: null,
  opsSweepEnabled: null,
  newsletterAutoSend: null
})

export const ENV_FLAG_PARSERS = Object.freeze({
  nostrSocialPosting: value => value === '1',
  opsSweepEnabled: value => (value ?? 'true') !== 'false',
  newsletterAutoSend: value => value === 'true'
})

const TTL_MS = 60_000
let cache = new WeakMap()
let warned = false

export async function getSiteSettings (models, { fresh = false } = {}) {
  const now = Date.now()
  const entry = cache.get(models)
  if (!fresh && entry && now - entry.at < TTL_MS) return entry.value
  const currentCache = cache
  let value
  try {
    value = await models.siteSettings.findUnique({ where: { id: 1 } })
    if (!value) throw new Error('missing singleton')
  } catch {
    value = SITE_SETTINGS_DEFAULTS
    if (!warned) {
      warned = true
      logWarn('SiteSettings unavailable; using code defaults')
    }
  }
  // An in-flight read must not repopulate a cache cleared by an admin apply.
  if (models && (typeof models === 'object' || typeof models === 'function')) currentCache.set(models, { value, at: now })
  return value
}

export function effectiveFlag (dbValue, envName, parseEnv) {
  return dbValue == null
    ? { value: parseEnv(process.env[envName]), source: 'env' }
    : { value: dbValue, source: 'db' }
}

export function clearSiteSettingsCache () {
  cache = new WeakMap()
}

export function __resetSiteSettingsForTests () {
  clearSiteSettingsCache()
  warned = false
}
