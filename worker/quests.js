import { MAX_BANKED_REPLIES, QUEST_REPLY_REWARDS } from '@/lib/quests'
import { questDay } from '@/lib/questClock'
import { resolveDraw } from '@/api/quests/draw'
import { completionsFor } from '@/api/quests/completions'
import { notifyFlameAdvanced, notifyQuestCompleted } from '@/lib/webPush'
import { advanceQuestStreak } from '@/worker/streak'
import { lockRewardUser } from '@/api/quests/boost-credit'

// Look back further than the cron cadence (*/5) so a delayed tick can't miss
// an action; the QuestCompletion unique key makes overlap harmless.
const LOOKBACK_MS = 10 * 60 * 1000

/**
 * Detect quest completions for today's draw and record them (spec §4.2).
 * Candidates = users with a qualifying action in the lookback window; the
 * draw is deterministic, so no per-day state is needed for the check itself.
 * The insert is the idempotency guard AND the notification trigger.
 */
export async function sweepQuestCompletions ({ models, now = new Date(), userIds } = {}) {
  const dayNow = questDay(now)
  const since = new Date(now.getTime() - LOOKBACK_MS)
  // A tick just after midnight straddles two UTC days: the tail of yesterday is
  // still inside the lookback window, and the 00:10 streak job evaluates that
  // day, so sweep both (the QuestCompletion unique key makes overlap harmless).
  const daySince = questDay(since)
  const days = daySince === dayNow ? [dayNow] : [daySince, dayNow]

  const candidates = await models.$queryRaw`
    SELECT DISTINCT id FROM (
      SELECT "tipperId" AS id FROM "ObservedTip" WHERE "detectedAt" >= ${since} AND "tipperId" IS NOT NULL
      UNION
      SELECT "userId" AS id FROM "PayIn" p
      WHERE p."payInType" = 'BOOST' AND p.created_at >= ${since}
        AND (
          EXISTS (SELECT 1 FROM "FeeObservation" f
                  WHERE f."payInId" = p.id AND f.state IN ('DETECTED', 'CONFIRMED'))
          OR EXISTS (SELECT 1 FROM "ObservedSubFee" s WHERE s."pay_in_id" = p.id)
        )
      UNION
      SELECT "userId" AS id FROM "Item" WHERE created_at >= ${since}
    ) c
    WHERE id IS NOT NULL`

  // M4 residual (2026-09-26 review): the BOOST candidate leg above is keyed on
  // the PayIn CREATION inside the lookback, but the observation can land much
  // later (wallet sync delay, paying the URI minutes after the dialog closed) —
  // after that, the user never re-enters the sweep and nothing re-derives the
  // day, so a genuinely paid boost is lost. Key a second candidacy on the
  // OBSERVATION instead, scoped to the quest day the PayIn was CREATED in
  // (questDay, so the dev compressed clock matches) — which also covers the
  // cross-midnight case a creation-keyed lookback cannot.
  const lateObserved = (await models.$queryRaw`
    SELECT p."userId" AS id, p.created_at AS "createdAt"
    FROM "PayIn" p
    WHERE p."payInType" = 'BOOST' AND p.created_at < ${since}
      AND (
        EXISTS (SELECT 1 FROM "FeeObservation" f
                WHERE f."payInId" = p.id AND f."detectedAt" >= ${since})
        OR EXISTS (SELECT 1 FROM "ObservedSubFee" s
                   WHERE s."pay_in_id" = p.id AND s."detected_at" >= ${since})
      )`)
    .filter(c => c.id != null && (!userIds || userIds.includes(c.id)))
    .map(c => ({ id: c.id, day: questDay(new Date(c.createdAt)) }))

  // Record this tick's completions first; the advance below must see them.
  // A user allowlist (test isolation) scopes every stage below to those ids.
  const scopedCandidates = userIds ? candidates.filter(c => userIds.includes(c.id)) : candidates
  // (user, day) checks: action candidates sweep every straddle day; a rescued
  // late observation sweeps the day its PayIn was created in. The seen-set
  // dedupes the overlap.
  const checks = []
  for (const { id: userId } of scopedCandidates) {
    for (const day of days) checks.push({ userId, day })
  }
  for (const { id: userId, day } of lateObserved) {
    checks.push({ userId, day })
  }
  const seenChecks = new Set()
  const recorded = []
  for (const { userId, day } of checks) {
    const key = `${userId}|${day}`
    if (seenChecks.has(key)) continue
    seenChecks.add(key)
    const draw = await resolveDraw(models, userId, day)
    const done = await completionsFor(models, { userId, day, draw })
    for (const quest of [draw.upvote, draw.drawn]) {
      if (!done[quest]) continue
      try {
        await models.questCompletion.create({
          data: { userId, day: new Date(`${day}T00:00:00.000Z`), quest }
        })
      } catch (err) {
        if (err?.code === 'P2002') continue // already recorded by an earlier tick
        throw err
      }
      notifyQuestCompleted(userId, quest).catch(console.error)
      recorded.push({ userId, quest })
    }
  }

  // Advance the flame BEFORE banking (spec rev 3 §2.4): a run's first cleared
  // day has no active FLAME row until the immediate advance creates it, and
  // the banking SELECT matches nothing without one. Completions are already on
  // record at that point, so a banking-first order would lose those credits
  // for good (later ticks P2002-skip the recorded completions).
  await advanceClearedDays({ models, days: [...new Set([...days, ...lateObserved.map(l => l.day)])], userIds })

  // Bank each quest's reply credit (flat +1 per completion, quest-rebalance
  // spec §3.1): only with an active flame, never past the banked-reply cap,
  // one capped insert per credit so the grant fills to the cap and stops.
  // The cap gates new grants only: rows held above it are grandfathered and
  // nothing here deletes or claws back — spending rows down is what lets a
  // fresh completion bank again. Ladder rewards granted by the advance above
  // are independent (marker-keyed), so this adds per-quest credits without
  // double-granting. Each insert runs in a short transaction that takes the
  // user row lock first (task 3): the same lock the advance holds, so the
  // count predicate reads committed state and a race between this banking
  // and a same-day ladder rung can never cross MAX_BANKED_REPLIES.
  for (const { userId, quest } of recorded) {
    const amount = QUEST_REPLY_REWARDS[quest] ?? 1
    for (let i = 0; i < amount; i++) {
      await models.$transaction(async tx => {
        if (!await lockRewardUser(tx, userId)) return
        await tx.$queryRaw`
          INSERT INTO "StreakReward" ("userId", "streakId", created_at, "grantedAt", "expiresAt", "type")
          SELECT ${userId}, s.id, now_utc(), now_utc(), now_utc() + interval '1 month', 'REPLY'::"StreakRewardType"
          FROM "Streak" s
          WHERE s."userId" = ${userId} AND s."type" = 'FLAME' AND s."endedAt" IS NULL
            AND (SELECT count(*) FROM "StreakReward" r
                 WHERE r."userId" = ${userId} AND r."type" = 'REPLY'
                   AND r."consumedAt" IS NULL AND r."expiresAt" > now_utc()) < ${MAX_BANKED_REPLIES}`
      })
    }
  }
}

/**
 * Light the flame as soon as a day is cleared (spec §4.5): advance every day
 * whose completions are on record but whose streak has not counted it yet.
 * Driven by the recorded rows, not the action lookback, so a clear recorded
 * before a worker restart still lights, and a failed advance is retried on the
 * next tick (the day guard makes it idempotent). An active flame whose previous
 * day is still pending evaluation defers: the 00:10 evaluation may yet absorb
 * the miss with the golden flame shield or end the run, which changes the level.
 */
async function advanceClearedDays ({ models, days, userIds }) {
  for (const day of days) {
    const dayDate = new Date(`${day}T00:00:00.000Z`)
    const pending = (await models.$queryRaw`
      SELECT q."userId" FROM "QuestCompletion" q
      LEFT JOIN "Streak" s
        ON s."userId" = q."userId" AND s."type" = 'FLAME' AND s."endedAt" IS NULL
      WHERE q."day" = ${dayDate}
      GROUP BY q."userId", s."lastEvaluatedDay"
      HAVING count(*) >= 2 AND (s."lastEvaluatedDay" IS NULL OR s."lastEvaluatedDay" < ${dayDate})`)
      .filter(p => !userIds || userIds.includes(p.userId))
    for (const { userId } of pending) {
      const notification = await advanceQuestStreak({ models, userId, day, requirePrevSettled: true })
      if (notification) notifyFlameAdvanced(userId, notification).catch(console.error)
    }
  }
}
