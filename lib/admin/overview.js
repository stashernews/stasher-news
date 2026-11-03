import { FIELDS, getFieldState } from './fields'
import { HEALTH_STALE_MS, readPendingTips, readFailedJobs, readLatestDistribution } from '@/lib/metrics'
import rewardsWallet from '@/api/resolvers/rewardsWallet'
import { readAdminGrowth } from '@/api/resolvers/growth'
import { readTrustWeighting } from '@/worker/curatorBudget'
import { formatXmr, formatFieldValue } from './units'

async function readWorkerCompletion (models) {
  const [row] = await models.$queryRaw`
    SELECT MAX(completedon) AS completed FROM (
      SELECT completedon FROM pgboss.job WHERE state = 'completed'
      UNION ALL
      SELECT completedon FROM pgboss.archive WHERE state = 'completed'
    ) jobs`
  return row?.completed?.toISOString() ?? null
}

function treasuryView (wallet) {
  if (!wallet) return { available: false }
  const keys = ['balancePiconeros', 'nextPoolPiconeros', 'opsEarmarkPiconeros', 'outstandingRewardsPiconeros', 'opsDeficitPiconeros', 'totalReceivedPiconeros', 'totalSentPiconeros', 'totalNetworkFeesPiconeros']
  const amounts = Object.fromEntries(keys.map(key => [key, { piconeros: String(wallet[key]), xmr: formatXmr(wallet[key]) }]))
  return { available: true, ...amounts, accountingUncertain: wallet.accountingUncertain, balanceNeedsReconciliation: wallet.balanceNeedsReconciliation, inflowBreakdown: wallet.inflowBreakdown }
}

function distributionView (row) {
  if (!row) return null
  const keys = ['id', 'periodStart', 'periodEnd', 'status', 'completedAt', 'poolPiconeros', 'distributedPiconeros', 'payoutCount', 'curatorBudgetMode', 'dynamicBudgetPiconeros', 'appliedCuratorBudgetPiconeros', 'dynamicBudgetMode', 'breakerTripped', 'curatorBudgetParams']
  return Object.fromEntries(keys.map(key => [key, row[key]]))
}

export function jsonSafe (value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]))
  return value
}

export async function adminOverview (models) {
  const errors = []
  const read = (name, promise) => promise.catch(() => { errors.push(name); return null })
  const [health, pendingTips, failedJobs, latest, wallet, activity, workerCompletedAt, fees, settings, trust] = await Promise.all([
    read('health', models.healthSnapshot.findUnique({ where: { id: 1 } })),
    read('pendingTips', readPendingTips(models)),
    read('failedJobs', readFailedJobs(models)),
    read('distribution', readLatestDistribution(models)),
    read('treasury', rewardsWallet.Query.rewardsWalletInfo(null, {}, { models })),
    read('activity', readAdminGrowth(models)),
    read('worker', readWorkerCompletion(models)),
    read('feeSettings', models.platformFeeConfig.findUnique({ where: { id: 1 } })),
    read('siteSettings', models.siteSettings.findUnique({ where: { id: 1 } })),
    read('trust', models.platformFeeConfig.findUnique({ where: { id: 1 } }).then(config => readTrustWeighting(models, config)))
  ])
  const stale = !health?.updatedAt || Date.now() - health.updatedAt.getTime() >= HEALTH_STALE_MS
  const state = { ...fees, ...settings }
  return jsonSafe({
    fetchedAt: new Date(),
    health: { stale, lws: stale ? null : health.lws, monerod: stale ? null : health.monerod, height: stale ? null : health.height, stalled: stale ? null : health.stalled, updatedAt: health?.updatedAt ?? null },
    pendingTips,
    failedJobs,
    workerCompletedAt,
    trust: { completedAt: health?.trustCompletedAt ?? null, effectiveFloor: trust?.trustWeightFloor ?? null, failSafeEngaged: trust?.trustStale ?? null },
    treasury: treasuryView(wallet),
    activity,
    distribution: distributionView(latest),
    rolloutModes: FIELDS.filter(field => field.rolloutMode).map(field => ({ key: field.key, label: field.label, storedValue: state[field.key] == null ? null : formatFieldValue(field, state[field.key]), effectiveValue: getFieldState(field, state).effectiveValue == null ? null : formatFieldValue(field, getFieldState(field, state).effectiveValue) })),
    errors: errors.sort()
  })
}
