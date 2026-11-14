import { validateContributorId } from './contributor-eligibility'
import { Prisma } from '@prisma/client'

const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const text = v => typeof v === 'string' ? v : null
const date = v => v != null && !isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const integer = v => Number.isInteger(v) && v >= 0 && v <= 2147483647 ? v : null
const money = v => v != null && /^(0|[1-9]\d*)$/.test(String(v)) ? String(v) : null
const mode = v => ['OFF', 'SHADOW', 'ACTIVE'].includes(v) ? v : 'UNKNOWN'
const parameterKeys = ['shareBps', 'topN', 'winnerCapBps', 'combinedCapBps', 'minTipPiconeros', 'trustThreshold', 'minTrustedTippers', 'tipperCapBps', 'breadthTarget', 'reciprocityMult', 'reciprocityDays', 'commentBonusBps', 'commentBonusMax', 'minAccountAgeDays', 'lengthFloor', 'lengthScaleWords', 'lengthCapWords']

export async function readContributorRuns (models, { beforeId = null } = {}) {
  if (beforeId != null) validateContributorId(beforeId)
  const rows = await models.rewardDistribution.findMany({
    where: { OR: [{ contributorPoolMode: { in: ['SHADOW', 'ACTIVE'] } }, { contributorParams: { not: Prisma.DbNull } }], ...(beforeId ? { id: { lt: beforeId } } : {}) },
    orderBy: { id: 'desc' },
    take: 21,
    select: { id: true, periodEnd: true, status: true, contributorPoolMode: true, contributorParams: true }
  })
  return {
    rows: rows.slice(0, 20).map(row => ({ id: row.id, periodEnd: date(row.periodEnd), mode: mode(row.contributorPoolMode), status: row.status, hasSnapshot: row.contributorParams != null })),
    nextBeforeId: rows.length > 20 ? rows[19].id : null
  }
}

function amounts (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(keys.map(key => [key, money(value[key])]))
}

function recordedTrustedIds (p) {
  const ids = p.trustedTipperIds
  if (!Array.isArray(ids) || ids.length !== integer(p.n) || new Set(ids).size !== ids.length || ids.some(id => integer(id) == null || id < 1)) return null
  return ids
}

function postProjection (p, current, tipperNames) {
  return {
    itemId: p.itemId,
    authorId: p.authorId,
    title: current?.deletedAt ? null : current?.title ?? null,
    authorName: current?.user?.name ?? null,
    available: !!current && !current.deletedAt,
    turf: text(p.turf),
    rank: integer(p.rank),
    qualifies: typeof p.qualifies === 'boolean' ? p.qualifies : null,
    tippers: integer(p.tippers),
    trustedTippers: integer(p.n),
    trustedTipperAccounts: recordedTrustedIds(p)?.map(id => ({ id, name: text(tipperNames.get(id)) })) ?? null,
    base: number(p.base),
    breadth: number(p.B),
    commenters: integer(p.E),
    commentMultiplier: number(p.G),
    score: number(p.S),
    words: integer(p.words),
    lengthMultiplier: number(p.L),
    weight: number(p.w),
    rawShare: money(p.rawShare),
    share: money(p.share),
    trims: (Array.isArray(p.trims) ? p.trims : []).filter(t => text(t?.rule)).map(t => ({ rule: t.rule, piconeros: money(t.piconeros) }))
  }
}

export async function readContributorSnapshot (models, id) {
  validateContributorId(id)
  const row = await models.rewardDistribution.findUnique({
    where: { id },
    select: {
      id: true,
      periodEnd: true,
      status: true,
      contributorPoolMode: true,
      contributorParams: true,
      contributorBudgetPiconeros: true,
      contributorDistributedPiconeros: true
    }
  })
  if (!row) return null
  const p = object(row.contributorParams)
  const saved = Array.isArray(p.scored) ? p.scored : []
  const scored = saved.slice(0, 2000).filter(p => integer(p?.itemId) > 0 && integer(p?.authorId) > 0)
  const labels = scored.length ? await models.item.findMany({ where: { id: { in: scored.map(p => p.itemId) } }, select: { id: true, title: true, deletedAt: true, user: { select: { name: true } } } }) : []
  const byId = new Map(labels.map(p => [p.id, p]))
  const tipperIds = [...new Set(scored.flatMap(p => recordedTrustedIds(p) ?? []))]
  const tippers = tipperIds.length ? await models.user.findMany({ where: { id: { in: tipperIds } }, select: { id: true, name: true } }) : []
  const tipperNames = new Map(tippers.map(user => [user.id, user.name]))
  const window = p.window ?? p.windowNotScored
  const funding = amounts(p.funding, ['curatorTarget', 'contributorTarget', 'room', 'curatorBudget', 'contributorBudget', 'fitBps'])
  if (funding) funding.scaled = typeof p.funding.scaled === 'boolean' ? p.funding.scaled : null
  return {
    id,
    periodEnd: date(row.periodEnd),
    status: row.status ?? 'UNKNOWN',
    mode: mode(row.contributorPoolMode),
    configuredMode: mode(p.configuredMode),
    available: row.contributorParams != null,
    warnings: ['Recorded rows are not the full list of posts checked. Missing or invalid optional values are shown as not recorded.', ...(saved.length > 2000 ? ['Snapshot display limited to 2000 rows.'] : [])],
    errors: (Array.isArray(p.errors) ? p.errors : []).filter(e => typeof e === 'string'),
    windowStart: date(window?.[0]),
    windowEnd: date(window?.[1]),
    windowScored: p.window ? true : p.windowNotScored ? false : null,
    catchUpWeeks: integer(p.catchUpWeeks),
    candidates: integer(p.candidates),
    eligible: integer(p.eligible),
    qualifying: integer(p.qualifying),
    nearMisses: integer(p.nearMisses),
    recordedRows: scored.length,
    exclusions: Object.entries(object(p.ineligible)).filter(([, n]) => integer(n) != null).map(([reason, count]) => ({ reason, count })),
    parameters: parameterKeys.filter(key => (typeof p.configured?.[key] === 'number' && Number.isFinite(p.configured[key])) || (key === 'minTipPiconeros' && money(p.configured?.[key]) != null)).map(key => ({ key, value: String(p.configured[key]) })),
    funding,
    allocation: amounts(p.allocation, ['paid', 'rolledOver', 'winnerCap', 'combinedCap']),
    appliedBudget: money(row.contributorBudgetPiconeros),
    distributedAmount: money(row.contributorDistributedPiconeros),
    posts: scored.map(p => postProjection(p, byId.get(p.itemId), tipperNames))
  }
}
