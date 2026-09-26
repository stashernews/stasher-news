import { notifyFlameAdvanced, notifyShieldUsed, notifyStreakLost } from '@/lib/webPush'
import { cycleDay, ladderRewardForLevel, MAX_BANKED_POSTS, MAX_BANKED_REPLIES } from '@/lib/quests'
import { questDay } from '@/lib/questClock'

const REWARD_TYPE = { post: 'POST', reply: 'REPLY', turfdiscount: 'TURF_DISCOUNT' }
const BANKED_CAP = { POST: MAX_BANKED_POSTS, REPLY: MAX_BANKED_REPLIES }
const DAY_MS = 86_400_000

/**
 * Advance the flame for a UTC day whose quests are cleared (spec §4.5). The
 * quest sweep calls this as soon as both completions are on record, so the
 * flame lights — badge, filled circle, level rewards — the moment the day is
 * cleared instead of waiting for 00:10 UTC; the daily evaluation calls it too
 * as a backstop. `Streak.lastEvaluatedDay` marks the last day whose outcome is
 * settled, so this is idempotent per day. With `requirePrevSettled` (the
 * sweep's path) an active flame whose previous day is still pending evaluation
 * is left alone: that day may yet consume the shield or end the run, which
 * would change the level. Returns the notification payload, or null when there
 * was nothing to do.
 */
export async function advanceQuestStreak ({ models, userId, day, requirePrevSettled = false }) {
  const dayDate = new Date(`${day}T00:00:00.000Z`)
  const prevDate = new Date(dayDate.getTime() - DAY_MS)
  let notification = null

  await models.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { streak: true } })
    if (!user) return
    const streak = await tx.streak.findFirst({ where: { userId, type: 'FLAME', endedAt: null } })

    // Day guard: never count the same UTC day twice for one streak run.
    if (streak?.lastEvaluatedDay && streak.lastEvaluatedDay >= dayDate) return
    // Settled-run guard: with no active streak, a day at or before the last
    // (ended) run's settled day already belongs to that run — re-advancing it
    // would phantom-restart the run and collide with its row on the unique key.
    if (!streak) {
      const last = await tx.streak.findFirst({
        where: { userId, type: 'FLAME', endedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { lastEvaluatedDay: true }
      })
      if (last?.lastEvaluatedDay && last.lastEvaluatedDay >= dayDate) return
    }
    // Deferral guard: the previous day's outcome is still pending, so this day's
    // level is not knowable yet.
    if (requirePrevSettled && streak && (!streak.lastEvaluatedDay || streak.lastEvaluatedDay < prevDate)) return

    const level = (user.streak ?? 0) + 1
    const row = streak ?? await tx.streak.create({
      data: { userId, type: 'FLAME', startedAt: dayDate }
    })
    await tx.user.update({ where: { id: userId }, data: { streak: level } })
    const rewards = await grantLadderRewards({ models: tx, userId, streak: row, from: row.rewardLevel, to: level })
    // Read the row back AFTER the grants: grantLadderRewards may have armed the
    // shield, and the arming advance must report the post-grant goldFlame.
    const settled = await tx.streak.update({ where: { id: row.id }, data: { lastEvaluatedDay: dayDate } })
    notification = { kind: 'advanced', level, cycleDay: cycleDay(level), goldFlame: settled.goldActive, rewards }
  })

  return notification
}

/**
 * Daily quest-streak evaluation (spec §4.5). Runs just after 00:10 UTC and
 * evaluates the UTC day that just ended (`now` minus a day, so a caller may
 * simulate a day passing): clearing both quests advances the flame (normally
 * already done by the sweep — this is the backstop for a sweep that recorded
 * the completions but crashed before advancing); a missed day is absorbed by
 * the golden flame shield when it is armed, or ends the streak when it is not.
 * `Streak.lastEvaluatedDay` makes re-runs for the same day no-ops. Ladder
 * rewards are granted on advance, idempotently via `Streak.rewardLevel`.
 */
export async function evaluateQuestStreaks ({ models, now = new Date(), userIds } = {}) {
  const day = questDay(new Date(now.getTime() - DAY_MS))
  const dayDate = new Date(`${day}T00:00:00.000Z`)

  // Every user with both completions recorded for the day (the sweep writes
  // them; the unique key guarantees at most one row per quest). When a user
  // allowlist is given (test isolation), only those users are evaluated —
  // other runs are left exactly as they are.
  const clearedRows = await models.$queryRaw`
    SELECT "userId" FROM "QuestCompletion"
    WHERE "day" = ${dayDate} GROUP BY "userId" HAVING count(*) >= 2`
  const scope = userIds ? new Set(userIds) : null
  const cleared = new Set(clearedRows.map(r => r.userId).filter(id => !scope || scope.has(id)))

  const active = (await models.streak.findMany({ where: { type: 'FLAME', endedAt: null } }))
    .filter(s => !scope || scope.has(s.userId))
  const activeByUser = new Map(active.map(s => [s.userId, s]))
  const userIdsIter = new Set([...cleared, ...active.map(s => s.userId)])

  for (const userId of userIdsIter) {
    const user = await models.user.findUnique({ where: { id: userId }, select: { streak: true } })
    if (!user) continue
    const known = activeByUser.get(userId)

    // Day guard: never evaluate the same UTC day twice for one streak run.
    if (known?.lastEvaluatedDay && known.lastEvaluatedDay >= dayDate) continue

    let notification = null
    if (cleared.has(userId)) {
      // Already settled by the sweep in the normal case (the guard above would
      // have skipped us); this covers the crash-before-advance case.
      notification = await advanceQuestStreak({ models, userId, day })
    } else if (known) {
      // One transaction per user: the guard, the shield consume or run end, and
      // the marker commit together, so a crash mid-evaluation can neither
      // phantom-hold nor lose the day on the retry.
      await models.$transaction(async tx => {
        const streak = await tx.streak.findFirst({ where: { userId, type: 'FLAME', endedAt: null } })
        if (!streak) return
        if (streak.lastEvaluatedDay && streak.lastEvaluatedDay >= dayDate) return

        await tx.streak.update({ where: { id: streak.id }, data: { lastEvaluatedDay: dayDate } })
        if (streak.goldActive) {
          await tx.streak.update({ where: { id: streak.id }, data: { goldActive: false } })
          notification = { kind: 'shield', day: cycleDay(user.streak) }
        } else {
          await tx.streak.update({ where: { id: streak.id }, data: { endedAt: dayDate } })
          await tx.user.update({ where: { id: userId }, data: { streak: null } })
          notification = { kind: 'lost', streak }
        }
      })
    }

    if (notification?.kind === 'advanced') notifyFlameAdvanced(userId, notification).catch(console.error)
    else if (notification?.kind === 'shield') notifyShieldUsed(userId).catch(console.error)
    else if (notification?.kind === 'lost') notifyStreakLost(userId, notification.streak).catch(console.error)
  }
}

/**
 * Grant every ungranted ladder level up to `to`. POST and REPLY bank capped
 * credits: grants stop at MAX_BANKED_POSTS / MAX_BANKED_REPLIES (spec rev 3
 * §2.4, count-before-insert). TURF_DISCOUNT stays non-stacking (suppressed
 * while one is held). The goldflame rung arms the golden flame shield instead
 * of granting a ledger row. The marker advances even when a reward is
 * suppressed, so the next cycle re-attempts on its own day.
 */
export async function grantLadderRewards ({ models, userId, streak, from, to }) {
  const granted = []
  for (let level = from + 1; level <= to; level++) {
    const kind = ladderRewardForLevel(level)
    if (kind === 'goldflame') {
      // The shield: armed (or re-armed) at every cycle day 4, kept until a
      // missed day consumes it.
      await models.streak.update({ where: { id: streak.id }, data: { goldActive: true } })
      continue
    }
    const type = REWARD_TYPE[kind]
    if (!type) continue // flame is cosmetic
    if (type !== 'POST' && type !== 'REPLY') {
      const held = await models.streakReward.findFirst({
        where: { userId, type, consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true }
      })
      if (held) continue
    } else {
      // Banked credits stop at the cap (spec rev 3 §2.4).
      const [row] = await models.$queryRaw`
        SELECT count(*)::int AS held FROM "StreakReward"
        WHERE "userId" = ${userId} AND "type" = ${type}::"StreakRewardType"
          AND "consumedAt" IS NULL AND "expiresAt" > now_utc()`
      if ((row?.held ?? 0) >= BANKED_CAP[type]) continue
    }
    await models.$queryRaw`
      INSERT INTO "StreakReward" ("userId", "streakId", created_at, "grantedAt", "expiresAt", "type")
      VALUES (${userId}, ${streak.id}, now_utc(), now_utc(), now_utc() + interval '1 month', ${type}::"StreakRewardType")`
    granted.push({ level, kind })
  }
  if (to > from) {
    await models.streak.update({ where: { id: streak.id }, data: { rewardLevel: to } })
  }
  return granted
}
