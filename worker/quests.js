import { utcDay, QUEST } from '@/lib/quests'
import { resolveDraw } from '@/api/quests/draw'
import { completionsFor } from '@/api/quests/completions'
import { notifyFlameAdvanced, notifyQuestCompleted } from '@/lib/webPush'
import { advanceQuestStreak } from '@/worker/streak'

// Look back further than the cron cadence (*/5) so a delayed tick can't miss
// an action; the QuestCompletion unique key makes overlap harmless.
const LOOKBACK_MS = 10 * 60 * 1000

/**
 * Detect quest completions for today's draw and record them (spec §4.2).
 * Candidates = users with a qualifying action in the lookback window; the
 * draw is deterministic, so no per-day state is needed for the check itself.
 * The insert is the idempotency guard AND the notification trigger.
 */
export async function sweepQuestCompletions ({ models, now = new Date() }) {
  const dayNow = utcDay(now)
  const since = new Date(now.getTime() - LOOKBACK_MS)
  // A tick just after midnight straddles two UTC days: the tail of yesterday is
  // still inside the lookback window, and the 00:10 streak job evaluates that
  // day — so sweep both (the QuestCompletion unique key makes overlap harmless).
  const daySince = utcDay(since)
  const days = daySince === dayNow ? [dayNow] : [daySince, dayNow]

  const candidates = await models.$queryRaw`
    SELECT DISTINCT id FROM (
      SELECT "tipperId" AS id FROM "ObservedTip" WHERE "detectedAt" >= ${since} AND "tipperId" IS NOT NULL
      UNION
      SELECT "userId" AS id FROM "PayIn" WHERE "payInType" = 'BOOST' AND created_at >= ${since}
      UNION
      SELECT "userId" AS id FROM "Item" WHERE created_at >= ${since}
    ) c
    WHERE id IS NOT NULL`

  for (const day of days) {
    for (const { id: userId } of candidates) {
      const draw = await resolveDraw(models, userId, day)
      if (draw.drawn === QUEST.TURF && !draw.turfName) continue // no turfs exist yet
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
        notifyQuestCompleted(userId, quest, { turfName: draw.turfName }).catch(console.error)
      }
    }
  }

  await advanceClearedDays({ models, days })
}

/**
 * Light the flame as soon as a day is cleared (spec §4.5): advance every day
 * whose completions are on record but whose streak has not counted it yet.
 * Driven by the recorded rows — not the action lookback — so a clear recorded
 * before a worker restart still lights, and a failed advance is retried on the
 * next tick (the day guard makes it idempotent). An active flame whose previous
 * day is still pending evaluation defers: the 00:10 job may yet apply a freeze
 * or end the run, which changes the level.
 */
async function advanceClearedDays ({ models, days }) {
  for (const day of days) {
    const dayDate = new Date(`${day}T00:00:00.000Z`)
    const pending = await models.$queryRaw`
      SELECT q."userId" FROM "QuestCompletion" q
      LEFT JOIN "Streak" s
        ON s."userId" = q."userId" AND s."type" = 'FLAME' AND s."endedAt" IS NULL
      WHERE q."day" = ${dayDate}
      GROUP BY q."userId", s."lastEvaluatedDay"
      HAVING count(*) >= 2 AND (s."lastEvaluatedDay" IS NULL OR s."lastEvaluatedDay" < ${dayDate})`
    for (const { userId } of pending) {
      const notification = await advanceQuestStreak({ models, userId, day, requirePrevSettled: true })
      if (notification) notifyFlameAdvanced(userId, notification).catch(console.error)
    }
  }
}
