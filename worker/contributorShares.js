import { Prisma } from '@prisma/client'
import { USER_ID } from '@/lib/constants'
import { itemTurfSql, zapTrustSql } from '@/worker/curatorShares'
import { nymsToIds } from '@/lib/founderNyms'
import { effectiveWords } from '@/lib/contributorWords'
import { lengthMultiplier, scorePost } from '@/lib/contributorPool'

// computeContributorShares — candidate selection and scoring for the weekly
// contributor pool.
//
// Read-only: it takes a transaction client, runs SELECTs only and returns the
// ranked winners. Money allocation lives in lib/contributorPool.js. The
// turf/trust fragments are imported from worker/curatorShares.js so a
// tipper's trust cannot drift from curator rewards.
//
// The candidate window is normally [weekStart - 14d, weekStart - 7d) so each
// post's own 7-day tip window has closed by weekStart (the run's UTC Monday,
// never the drifting inflow periodStart); catch-up starts where the last
// scored window ended, capped at MAX_WINDOW_WEEKS (readWindowStart).

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
export const MAX_WINDOW_WEEKS = 4
export const CONTRIBUTOR_EXCLUDED_NYMS = ['stasher', 'sn']

// Start of this run's candidate window: the end of the latest recorded scored
// window (SHADOW or ACTIVE), clamped to [end - MAX_WINDOW_WEEKS, end - 1 week].
// With no scored window on record, or one that already reaches `end`, the
// normal one-week window applies. Read-only; call inside the run's snapshot.
//
// `degraded`: this run is configured ACTIVE but behaves as SHADOW (the curator
// budget fell back). It pays nothing and is not marked scored, so it scores
// only the normal week; the next run that really pays catches the unscored
// weeks up. Without this a lasting degradation would re-scan up to four weeks
// and warn every Monday.
//
// Anchor: the end of the latest scored window; with none on record, the start
// of the earliest not-scored (degraded) window after it.
export async function readWindowStart (tx, weekStart, { degraded = false } = {}) {
  const end = new Date(weekStart.getTime() - WEEK_MS)
  const normal = new Date(end.getTime() - WEEK_MS)
  if (degraded) return normal
  const [scored] = await tx.$queryRaw`
    SELECT "contributorParams"->'window'->>1 AS "windowEnd", "periodEnd"
    FROM "RewardDistribution"
    WHERE "contributorParams"->'window' IS NOT NULL
    ORDER BY "periodEnd" DESC, id DESC
    LIMIT 1`
  const [unscored] = await tx.$queryRaw`
    SELECT min("contributorParams"->'windowNotScored'->>0) AS "windowStart"
    FROM "RewardDistribution"
    WHERE "contributorParams"->'windowNotScored' IS NOT NULL
      AND (${scored?.periodEnd ?? null}::timestamp IS NULL OR "periodEnd" > ${scored?.periodEnd ?? null}::timestamp)`
  const scoredEnd = scored?.windowEnd ? new Date(scored.windowEnd) : null
  const unscoredStart = unscored?.windowStart ? new Date(unscored.windowStart) : null
  const valid = d => d && !Number.isNaN(d.getTime())
  const last = valid(scoredEnd) ? scoredEnd : (valid(unscoredStart) ? unscoredStart : null)
  if (!last || last.getTime() >= end.getTime()) return normal
  const earliest = new Date(end.getTime() - MAX_WINDOW_WEEKS * WEEK_MS)
  const start = last.getTime() < earliest.getTime() ? earliest : last
  return start.getTime() < normal.getTime() ? start : normal
}

async function loadCandidates (tx, start, end) {
  const i = Prisma.raw('i')
  const root = Prisma.raw('root')
  return await tx.$queryRaw`
    SELECT i.id, i."userId" AS "authorId", i.created_at AS "createdAt",
      LEFT(COALESCE(i.title, ''), 90) AS title, i.text, i.url,
      i."pollCost", i."bountyPiconeros"::text AS "bountyPiconeros",
      i."weightedDownVotes",
      i."contributorDisqualifiedAt" IS NOT NULL AS disqualified,
      ${itemTurfSql(i, root)}::text AS turf,
      u.created_at AS "authorCreatedAt",
      (SELECT ma.address FROM "MoneroAccount" ma WHERE ma."ownerUserId" = i."userId" ORDER BY ma.id LIMIT 1) AS "recipientAddress",
      (SELECT count(*) FROM "ItemUpload" iu JOIN "Upload" up ON up.id = iu."uploadId"
        WHERE iu."itemId" = i.id AND up."userId" = i."userId")::int AS "ownUploads"
    FROM "Item" i
    LEFT JOIN "Item" root ON root.id = i."rootId"
    JOIN users u ON u.id = i."userId"
    WHERE i."parentId" IS NULL
      AND i.created_at >= ${start}
      AND i.created_at < ${end}
      AND i."deletedAt" IS NULL
      AND i.status <> 'STOPPED'
      AND COALESCE(i."feeStatus", 'FEE_NOT_REQUIRED') <> 'PENDING_FEE'
      AND NOT i.bio
    ORDER BY i.id`
}

// Per-payment tips inside each post's own 7-day window, with the tipper's
// post trust in the post's turf and the reciprocity flag (the author tipped
// this tipper's content in the reciprocityDays before the post).
async function loadTips (tx, ids, reciprocityDays) {
  if (!ids.length) return []
  const i = Prisma.raw('i')
  const root = Prisma.raw('root')
  const ust = Prisma.raw('ust')
  return await tx.$queryRaw`
    SELECT t."postId", t."tipperId", t.piconeros::text AS piconeros,
      ${zapTrustSql(i, ust)}::float8 AS trust,
      EXISTS (
        SELECT 1 FROM "ObservedTip" t2
        JOIN "Item" i2 ON i2.id = t2."postId"
        WHERE t2."tipperId" = i."userId"
          AND i2."userId" = t."tipperId"
          AND t2.state = 'CONFIRMED'
          AND t2."confirmedAt" >= i.created_at - make_interval(days => ${reciprocityDays}::int)
          AND t2."confirmedAt" < i.created_at
      ) AS reciprocal
    FROM "ObservedTip" t
    JOIN "Item" i ON i.id = t."postId"
    LEFT JOIN "Item" root ON root.id = i."rootId"
    LEFT JOIN "UserSubTrust" ust
      ON ust."subName" = ${itemTurfSql(i, root)}
     AND ust."userId" = t."tipperId"
    WHERE t."postId" = ANY(${ids}::int[])
      AND t.state = 'CONFIRMED'
      AND t."tipperId" IS NOT NULL
      AND t."tipperId" <> i."userId"
      AND t."confirmedAt" >= i.created_at
      AND t."confirmedAt" < i.created_at + interval '7 days'`
}

async function loadCommenters (tx, ids) {
  if (!ids.length) return []
  const p = Prisma.raw('p')
  const root = Prisma.raw('root')
  return await tx.$queryRaw`
    SELECT DISTINCT p.id AS "postId", c."userId",
      COALESCE(ust."zapPostTrust", 0)::float8 AS trust
    FROM "Item" p
    LEFT JOIN "Item" root ON root.id = p."rootId"
    JOIN "Item" c ON c."rootId" = p.id
    LEFT JOIN "UserSubTrust" ust
      ON ust."subName" = ${itemTurfSql(p, root)}
     AND ust."userId" = c."userId"
    WHERE p.id = ANY(${ids}::int[])
      AND c."parentId" IS NOT NULL
      AND c."userId" <> p."userId"
      AND c."deletedAt" IS NULL
      AND c.status <> 'STOPPED'
      AND COALESCE(c."feeStatus", 'FEE_NOT_REQUIRED') <> 'PENDING_FEE'
      AND c.created_at >= p.created_at
      AND c.created_at < p.created_at + interval '7 days'`
}

// First failing eligibility rule, in a fixed order.
export function ineligibleReason (c, { excludedIds, params }) {
  if (c.url) return 'link_post'
  if (c.pollCost != null) return 'poll'
  if (c.bountyPiconeros && BigInt(c.bountyPiconeros) > 0n) return 'bounty'
  if (c.authorId === USER_ID.anon) return 'anon'
  if (excludedIds.has(c.authorId)) return 'excluded_author'
  if (c.createdAt.getTime() - c.authorCreatedAt.getTime() < params.minAccountAgeDays * DAY_MS) return 'young_account'
  if (!c.recipientAddress) return 'no_wallet'
  if (c.disqualified) return 'disqualified'
  return null
}

// Rank by S, one post per author (the author's best), ties by earlier
// createdAt then lower item id.
export function rankScoredPosts (scored, topN) {
  const bestByAuthor = new Map()
  for (const p of scored) {
    const cur = bestByAuthor.get(p.authorId)
    if (!cur || p.S > cur.S || (p.S === cur.S && p.createdAt < cur.createdAt) ||
        (p.S === cur.S && p.createdAt.getTime() === cur.createdAt.getTime() && p.itemId < cur.itemId)) {
      bestByAuthor.set(p.authorId, p)
    }
  }
  const ranked = [...bestByAuthor.values()].sort((a, b) =>
    b.S - a.S || a.createdAt - b.createdAt || a.itemId - b.itemId)
  return { ranked, winners: ranked.slice(0, topN) }
}

/**
 * @param {object} tx Prisma transaction client (only SELECTs are issued)
 * @param {{ weekStart: Date, params: object, excludedIds: Iterable<number> }} opts
 *   weekStart is the run's UTC Monday 00:00; params from resolveContributorPoolConfig.
 * @returns {Promise<{ window: Date[], candidates: number, ineligible: object, eligible: number,
 *   scored: object[], qualifying: number, ranked: object[], winners: object[], nearMisses: number }>}
 */
export async function computeContributorShares (tx, { weekStart, params, excludedIds, windowStart }) {
  // Platform accounts (stasher, sn — resolved by nym) never author a winning
  // post and their tips and comments never count. Founder accounts outside
  // that list compete like any other author.
  const excluded = new Set([...excludedIds, ...await nymsToIds(tx, CONTRIBUTOR_EXCLUDED_NYMS)])
  const end = new Date(weekStart.getTime() - WEEK_MS)
  const start = windowStart ?? new Date(end.getTime() - WEEK_MS)

  const posts = await loadCandidates(tx, start, end)
  const ineligible = {}
  const eligible = []
  for (const c of posts) {
    const reason = ineligibleReason(c, { excludedIds: excluded, params })
    if (reason) ineligible[reason] = (ineligible[reason] || 0) + 1
    else eligible.push(c)
  }

  const ids = eligible.map(c => c.id)
  const tipRows = await loadTips(tx, ids, params.reciprocityDays)
  const commentRows = await loadCommenters(tx, ids)

  const tipsBy = new Map()
  for (const t of tipRows) {
    if (excluded.has(t.tipperId)) continue
    const arr = tipsBy.get(t.postId) || []
    arr.push({ tipperId: t.tipperId, piconeros: BigInt(t.piconeros), trust: Number(t.trust), reciprocal: !!t.reciprocal })
    tipsBy.set(t.postId, arr)
  }
  const commentersBy = new Map()
  for (const c of commentRows) {
    if (excluded.has(c.userId)) continue // same exclusions as tippers
    const arr = commentersBy.get(c.postId) || []
    arr.push({ userId: c.userId, trust: Number(c.trust) })
    commentersBy.set(c.postId, arr)
  }

  const scored = eligible.map(c => {
    const s = scorePost({
      tips: tipsBy.get(c.id) || [],
      commenters: commentersBy.get(c.id) || [],
      weightedDownVotes: Number(c.weightedDownVotes) || 0
    }, params)
    const words = effectiveWords(c.text, c.ownUploads)
    const L = lengthMultiplier(words.words, params)
    return {
      itemId: c.id,
      authorId: c.authorId,
      // payout address, read in the same snapshot as the wallet check; never
      // recorded or exposed
      recipientAddress: c.recipientAddress,
      title: c.title,
      turf: c.turf,
      createdAt: c.createdAt,
      ...s,
      words: words.words,
      L,
      weight: Math.sqrt(s.S) * L,
      nearMiss: !s.qualifies && s.trustedTippers === params.minTrustedTippers - 1
    }
  })

  const qualifying = scored.filter(p => p.qualifies && p.S > 0)
  const { ranked, winners } = rankScoredPosts(qualifying, params.topN)
  return {
    window: [start, end],
    // whole weeks scored beyond the normal one (0 = no catch-up)
    catchUpWeeks: Math.max(0, Math.round((end.getTime() - start.getTime()) / WEEK_MS) - 1),
    candidates: posts.length,
    ineligible,
    eligible: eligible.length,
    scored,
    qualifying: qualifying.length,
    ranked,
    winners,
    nearMisses: scored.filter(p => p.nearMiss).length
  }
}
