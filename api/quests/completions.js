import { QUEST } from '@/lib/quests'
import { questDayRange } from '@/lib/questClock'

/** True iff the user has a detected/confirmed tip inside [gte, lt) — the
 * UPVOTE quest check (the upvote arrow IS the tip flow). */
export async function tippedInWindow (prisma, userId, { gte, lt } = {}) {
  if (userId == null || gte == null || lt == null) return false
  const rows = await prisma.$queryRaw`
    SELECT 1 AS n FROM "ObservedTip"
    WHERE "tipperId" = ${userId}::INTEGER AND state IN ('DETECTED', 'CONFIRMED')
      AND "detectedAt" >= ${gte} AND "detectedAt" < ${lt}
    LIMIT 1`
  return rows.length > 0
}

/**
 * Derive a day's quest completions for a user's draw (spec §2.1).
 * UPVOTE = ObservedTip by tipper in the UTC day window; BOOST = a BOOST payIn
 * created in the window; FIRST_RESPONDER = a comment in the window on a parent
 * that had no earlier comment; TURF = a post OR comment in the window carrying
 * the drawn turf. All checks are indexed reads; no writes.
 */
export async function completionsFor (models, { userId, day, draw }) {
  const { gte, lt } = questDayRange(day)
  const out = { UPVOTE: false, BOOST: false, FIRST_RESPONDER: false, TURF: false }
  if (userId == null || !draw) return out

  if (draw.upvote === QUEST.UPVOTE) {
    out.UPVOTE = await tippedInWindow(models, userId, { gte, lt })
  }
  if (draw.drawn === QUEST.BOOST) {
    out.BOOST = !!(await models.payIn.findFirst({
      where: { userId, payInType: 'BOOST', createdAt: { gte, lt } },
      select: { id: true }
    }))
  }
  if (draw.drawn === QUEST.FIRST_RESPONDER) {
    const rows = await models.$queryRaw`
      SELECT 1 AS n FROM "Item" c
      WHERE c."userId" = ${userId}::INTEGER AND c."parentId" IS NOT NULL AND c."deletedAt" IS NULL
        AND c.created_at >= ${gte} AND c.created_at < ${lt}
        AND NOT EXISTS (
          SELECT 1 FROM "Item" o
          WHERE o."parentId" = c."parentId" AND o."deletedAt" IS NULL AND o.created_at < c.created_at
        )
      LIMIT 1`
    out.FIRST_RESPONDER = rows.length > 0
  }
  if (draw.drawn === QUEST.TURF) {
    // Rev 5: "post or comment" — any item by the user in the window counts
    // (posts, comments, polls, links, bounties), anywhere, no turf targeting.
    const rows = await models.$queryRaw`
      SELECT 1 AS n FROM "Item" i
      WHERE i."userId" = ${userId}::INTEGER AND i."deletedAt" IS NULL
        AND i.created_at >= ${gte} AND i.created_at < ${lt}
      LIMIT 1`
    out.TURF = rows.length > 0
  }
  return out
}
