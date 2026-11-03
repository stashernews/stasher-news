import { CURATOR_BUDGET_MODES, resolveCuratorBudgetConfig } from '@/lib/curatorBudget'

export const ANNOUNCEMENT_MAX_LENGTH = 280

function field (key, store, section, group, label, type, min, max, takesEffect, help, extra = {}) {
  return { key, store, section, group, label, type, min, max, takesEffect, help, ...extra }
}

const fee = (key, group, label, type, min, max, help, takesEffect = 'cache') => field(key, 'platformFeeConfig', 'fees', group, label, type, min, max, takesEffect, help)
const trust = (key, label, type, min, max, help) => field(key, 'platformFeeConfig', 'trust', 'Tip ranking', label, type, min, max, 'cache', help)
const walk = (key, label, type, min, max, help, extra) => field(key, 'siteSettings', 'trust', 'Trust walk', label, type, min, max, 'nextWalk', help, extra)
const rewards = (key, group, label, type, min, max, help, extra) => field(key, 'platformFeeConfig', 'rewards', group, label, type, min, max, 'nextRun:distribution', help, extra)
const content = (key, group, label, type, min, max, help) => field(key, 'siteSettings', 'content', group, label, type, min, max, 'cache', help)
const toggle = (key, store, group, label, type, takesEffect, help, extra) => field(key, store, 'site', group, label, type, undefined, undefined, takesEffect, help, extra)

export const FIELDS = [
  fee('postingFeeFloorPiconeros', 'Posting & replies', 'Posting fee floor', 'xmr', '0.0001', '0.1', 'Base fee before turf and spam multipliers.'),
  fee('commentFeePiconeros', 'Posting & replies', 'Reply fee', 'xmr', '0.0001', '0.1', 'Base fee for a comment or reply.'),
  fee('freePostThresholdPiconeros', 'Posting & replies', 'Free-post investment threshold', 'xmr', '0', '10', 'Investment required for a free posting allowance.'),
  fee('freePostMinAgeDays', 'Posting & replies', 'Free-post account age', 'int', '0', '365', 'Minimum account age in days for free posting.'),
  fee('minTipPiconeros', 'Tips & downvotes', 'Minimum tip', 'xmr', '0.00001', '1', 'Smallest accepted tip.'),
  fee('defaultDownvotePiconeros', 'Tips & downvotes', 'Default downvote', 'xmr', '0.0001', '1', 'Default downvote amount; cannot be below the minimum.'),
  fee('downvoteMinPiconeros', 'Tips & downvotes', 'Minimum downvote', 'xmr', '0.00001', '1', 'Smallest accepted downvote.'),
  fee('territoryMonthlyPiconeros', 'Territories', 'Monthly turf price', 'xmr', '0', '10', 'Applies to new purchases, not existing contracts.'),
  fee('territoryYearlyPiconeros', 'Territories', 'Yearly turf price', 'xmr', '0', '100', 'Applies to new purchases, not existing contracts.'),
  fee('territoryOncePiconeros', 'Territories', 'Lifetime turf price', 'xmr', '0', '1000', 'Applies to new purchases, not existing contracts.'),
  fee('maxTurfPremiumPiconeros', 'Territories', 'Maximum turf premium', 'xmr', '0', '1', 'Maximum additional premium a turf can charge.'),
  fee('bountyFeeMinPiconeros', 'Bounties', 'Minimum bounty fee', 'xmr', '0', '1', 'Bounty fee floor, still subject to the percentage cap.'),
  fee('bountyFeePct', 'Bounties', 'Bounty fee', 'pct', '0', '20', 'Percentage fee; the hard cap is 20%.'),
  fee('bountyExpiryDays', 'Bounties', 'Bounty expiry', 'int', '1', '365', 'Days until a newly funded bounty expires.', 'nextRun:newBounty'),
  trust('tipRankCapPiconeros', 'Per-tipper ranking cap', 'xmr', '0.001', '100', 'Caps the ranking influence from one tipper.'),
  trust('tipRankFactorFloor', 'Minimum account-age factor', 'float', '0', '1', 'Starting ranking factor for a new account.'),
  trust('tipRankRampDays', 'Account-age ramp', 'int', '0', '365', 'Days to full ranking weight; zero requires a factor floor of one.'),
  trust('anonTipRankCapPiconeros', 'Anonymous ranking cap', 'xmr', '0.001', '100', 'Collective cap on anonymous ranking influence.'),
  trust('anonTipRankFactor', 'Anonymous ranking factor', 'float', '0', '1', 'Ranking multiplier for anonymous tips.'),
  field('curatorTrustWeightFloor', 'platformFeeConfig', 'trust', 'Curator trust', 'Curator trust-weight floor', 'float', '0', '1', 'nextRun:distribution', 'Stale trust walks force an effective floor of one.'),
  walk('trustSeedWeight', 'Seed restart weight', 'float', '0', '1', 'Restart probability at each trust-walk step.'),
  walk('trustMaxDepth', 'Maximum walk depth', 'int', '1', '100', 'Number of trust-walk iterations.'),
  walk('trustPicoMin', 'Minimum tip edge', 'int', '1', '1000000000000', 'Tip-edge threshold in whole piconeros.', { bigint: true, unit: 'piconeros' }),
  walk('trustAgainstPicoMin', 'Minimum downvote edge', 'int', '1', '1000000000000', 'Downvote-edge threshold in whole piconeros.', { bigint: true, unit: 'piconeros' }),
  walk('trustIrrelevantCumulative', 'Irrelevant cumulative trust', 'float', '0', '0.1', 'Trust below this cumulative threshold is discarded.'),
  ...[
    ['downvoteRewardsPct', 'Downvote allocation'], ['postingFeeRewardsPct', 'Posting-fee allocation'],
    ['territoryFeeRewardsPct', 'Turf-fee allocation'], ['walletlessTipRewardsPct', 'Walletless-tip allocation'],
    ['boostRewardsPct', 'Boost allocation']
  ].map(([key, label]) => rewards(key, 'Allocation', label, 'pct', '0', '100', 'Percentage allocated to rewards; the remainder goes to operations.')),
  rewards('distributionTopN', 'Distribution', 'Maximum rewarded curators', 'int', '1', '100', 'Top curator count for the next distribution.'),
  rewards('distributionMinPayoutPiconeros', 'Distribution', 'Minimum curator payout', 'xmr', '0.0001', '1', 'Minimum payout for the next distribution.'),
  rewards('distributionExcludedCuratorIds', 'Distribution', 'Excluded curator ids', 'idList', undefined, undefined, 'Up to 100 existing user ids; the founder is always excluded.'),
  rewards('curatorBudgetMode', 'Curator budget', 'Budget mode', 'enum', undefined, undefined, 'LEGACY uses the fallback cap; SHADOW records; ACTIVE uses the dynamic budget.', { options: CURATOR_BUDGET_MODES, rolloutMode: true, validate: resolveCuratorBudgetConfig }),
  rewards('curatorBudgetMultBps', 'Curator budget', 'Budget multiple', 'bps', '1', '50000', '10,000 bps = 1×; the existing budget validator also requires at least 1×.'),
  rewards('curatorBudgetDrawdownWeeks', 'Curator budget', 'Reserve drawdown', 'int', '4', '104', 'Number of weeks over which reserves are drawn down.'),
  rewards('curatorBudgetAvgPeriods', 'Curator budget', 'Average periods', 'int', '1', '52', 'Historical periods averaged for eligible tips.'),
  rewards('curatorTipCapShareBps', 'Curator budget', 'Per-tipper cap on volume', 'bps', '0', '10000', 'Share of eligible volume from one tipper; the budget validator requires a nonzero share.'),
  rewards('curatorBreakerRatioBps', 'Curator budget', 'Spike-breaker ratio', 'bps', '10000', '100000', 'Spike multiple in bps; the budget validator requires strictly above 1×.'),
  rewards('curatorBreakerFloorMedianPeriods', 'Curator budget', 'Breaker median periods', 'int', '1', '104', 'History used for the breaker baseline median.'),
  rewards('curatorBreakerArmPeriods', 'Curator budget', 'Breaker arming periods', 'int', '1', '52', 'Minimum history before the spike breaker arms.'),
  content('itemSpamIntervalMinutes', 'Spam escalation', 'Spam interval', 'int', '0', '1440', 'Whole minutes in the spam window; anonymous posting uses zero.'),
  content('spamEscalationNumerator', 'Spam escalation', 'Escalation numerator', 'int', '1', '2147483647', 'Numerator divided by denominator must be between 1 and 3.'),
  content('spamEscalationDenominator', 'Spam escalation', 'Escalation denominator', 'int', '1', '2147483647', 'Positive denominator; the resulting factor must be between 1 and 3.'),
  content('freePostsPerMonth', 'Free quotas', 'Free posts per month', 'int', '0', '10', 'Monthly free posting quota for qualifying users.'),
  content('freeCommentsPerWeek', 'Free quotas', 'Free comments per week', 'int', '0', '20', 'Weekly free comment quota for qualifying users.'),
  content('homepagePostsFilterPiconeros', 'Feed filters', 'Homepage filter', 'xmr', '-1', '0', 'Default net-investment threshold for the homepage.'),
  content('defaultPostsFilterPiconeros', 'Feed filters', 'Default post filter', 'xmr', '-1', '0', 'Fallback post threshold when no user-specific filter exists.'),
  content('defaultCommentsFilterPiconeros', 'Feed filters', 'Default comment filter', 'xmr', '-1', '0', 'Fallback comment threshold when no user-specific filter exists.'),
  content('maxItemTurfs', 'Limits', 'Maximum turfs per item', 'int', '1', '10', 'Maximum turf memberships for a post.'),
  content('itemEditSeconds', 'Limits', 'Editing window', 'int', '60', '3600', 'Seconds during which an item can be edited.'),
  content('anonPostFeeMultiplier', 'Anonymous fees', 'Anonymous posting multiple', 'int', '1', '100', 'Multiplier applied to anonymous posting fees.'),
  content('anonCommentFeeMultiplier', 'Anonymous fees', 'Anonymous reply multiple', 'int', '1', '100', 'Multiplier applied to anonymous comment fees.'),
  toggle('maintenance', 'maintenance', 'Availability', 'Maintenance mode', 'bool', 'immediate', 'Public pages become unavailable; the private admin listener remains reachable.'),
  toggle('snl.live', 'snl', 'Announcement', 'Announcement banner', 'bool', 'immediate', 'Show the announcement message at the top of every public page.', { column: 'live' }),
  toggle('snl.message', 'snl', 'Announcement', 'Announcement message', 'text', 'immediate', 'Plain text, shown as written; http:// and https:// links become clickable. Required while the banner is on.', { column: 'message', maxLength: ANNOUNCEMENT_MAX_LENGTH }),
  toggle('verifiedBadgeEnabled', 'siteSettings', 'Features', 'Verified badge', 'bool', 'cache', 'Enable the verified-badge feature.'),
  toggle('nostrSocialPosting', 'siteSettings', 'Operations', 'Nostr social posting', 'nullableBool', 'nextRun:socialPoster', 'Reset to env to use the process environment.', { env: 'NOSTR_SOCIAL_POSTING' }),
  toggle('opsSweepEnabled', 'siteSettings', 'Operations', 'Rewards ops sweep', 'nullableBool', 'nextRun:opsSweep', 'Reset to env to use the process environment.', { env: 'REWARDS_OPS_SWEEP_ENABLED' }),
  toggle('newsletterAutoSend', 'siteSettings', 'Operations', 'Newsletter auto-send', 'nullableBool', 'nextRun:newsletter', 'Reset to env to use the process environment.', { env: 'NEWSLETTER_AUTO_SEND' })
]

export const FIELD_BY_KEY = new Map(FIELDS.map(field => [field.key, field]))
// requiredConfirmations is retained solely for the deployed base client's
// compatibility; dropping it is deferred to a later contract migration.
export const EXCLUDED_COLUMNS = { platformFeeConfig: ['id', 'requiredConfirmations'], siteSettings: ['id', 'updatedAt'] }

function matchesRule (rule, state) {
  return rule && ('equals' in rule ? state[rule.key] === rule.equals : state[rule.key] !== rule.notEquals)
}

export function getFieldState (field, state) {
  const locked = !!matchesRule(field.lockedWhen, state)
  const effective = !!matchesRule(field.effectiveWhen, state)
  return {
    locked,
    lockReason: locked ? field.lockedWhen.reason : null,
    effectiveValue: effective ? field.effectiveWhen.value : state[field.key],
    effectiveReason: effective ? field.effectiveWhen.reason : null
  }
}
