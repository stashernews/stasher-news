import { notifyFlameAdvanced, notifyFreezeUsed, notifyStreakLost } from '@/lib/webPush'
import { cycleDay, isGoldFlame, ladderRewardForLevel, utcDay } from '@/lib/quests'

const REWARD_TYPE = { post: 'POST', freeze: 'FREEZE', turfdiscount: 'TURF_DISCOUNT' }
const DAY_MS = 86_400_000

/**
 * Advance the flame for a UTC day whose quests are cleared (spec §4.5). The
 * quest sweep calls this as soon as both completions are on record, so the
 * flame lights — badge, filled circle, level rewards — the moment the day is
 * cleared instead of waiting for 00:10 UTC; the daily evaluation calls it too
 * as a backstop. `Streak.lastEvaluatedDay` marks the last day whose outcome is
 * settled, so this is idempotent per day. With `requirePrevSettled` (the
 * sweep's path) an active flame whose previous day is still pending evaluation
 * is left alone: that day may yet consume a freeze or end the run, which would
 * change the level. Returns the notification payload, or null when there was
 * nothing to do.
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
    // Deferral guard: the previous day's outcome is still pending, so this day's
    // level is not knowable yet.
    if (requirePrevSettled && streak && (!streak.lastEvaluatedDay || streak.lastEvaluatedDay < prevDate)) return

    const level = (user.streak ?? 0) + 1
    const row = streak ?? await tx.streak.create({
      data: { userId, type: 'FLAME', startedAt: dayDate }
    })
    await tx.user.update({ where: { id: userId }, data: { streak: level } })
    const rewards = await grantLadderRewards({ models: tx, userId, streak: row, from: row.rewardLevel, to: level })
    await tx.streak.update({ where: { id: row.id }, data: { lastEvaluatedDay: dayDate } })
    notification = { kind: 'advanced', level, cycleDay: cycleDay(level), goldFlame: isGoldFlame(level), rewards }
  })

  return notification
}

/**
 * Daily quest-streak evaluation (spec §4.5). Runs just after 00:10 UTC and
 * evaluates the UTC day that just ended: clearing both quests advances the
 * flame (normally already done by the sweep — this is the backstop for a sweep
 * that recorded the completions but crashed before advancing); a missed day is
 * absorbed by a held streak freeze or ends the streak. `Streak.lastEvaluatedDay`
 * makes re-runs for the same day no-ops. Ladder rewards are granted on advance,
 * idempotently via `Streak.rewardLevel`.
 */
export async function evaluateQuestStreaks ({ models }) {
  const day = utcDay(new Date(Date.now() - DAY_MS))
  const dayDate = new Date(`${day}T00:00:00.000Z`)

  // Every user with both completions recorded for the day (the sweep writes
  // them; the unique key guarantees at most one row per quest).
  const clearedRows = await models.$queryRaw`
    SELECT "userId" FROM "QuestCompletion"
    WHERE "day" = ${dayDate} GROUP BY "userId" HAVING count(*) >= 2`
  const cleared = new Set(clearedRows.map(r => r.userId))

  const active = await models.streak.findMany({ where: { type: 'FLAME', endedAt: null } })
  const activeByUser = new Map(active.map(s => [s.userId, s]))
  const userIds = new Set([...cleared, ...active.map(s => s.userId)])

  for (const userId of userIds) {
    const user = await models.user.findUnique({ where: { id: userId }, select: { streak: true } })
    if (!user) continue
    const known = activeByUser.get(userId)

    // Day guard: never evaluate the same UTC day twice for one streak run.
    if (known?.lastEvaluatedDay && known.lastEvaluatedDay >= dayDate) continue

    if (cleared.has(userId)) {
      // Already settled by the sweep in the normal case (the guard above would
      // have skipped us); this covers the crash-before-advance case.
      const notification = await advanceQuestStreak({ models, userId, day })
      if (notification) notifyFlameAdvanced(userId, notification).catch(console.error)
      continue
    }

    if (!known) continue

    // One transaction per user: the guard, the hold/end, and the marker commit
    // together, so a crash mid-evaluation can neither phantom-hold nor lose the
    // day on the retry.
    let notification = null
    await models.$transaction(async tx => {
      const streak = await tx.streak.findFirst({ where: { userId, type: 'FLAME', endedAt: null } })
      if (!streak) return
      if (streak.lastEvaluatedDay && streak.lastEvaluatedDay >= dayDate) return

      await tx.streak.update({ where: { id: streak.id }, data: { lastEvaluatedDay: dayDate } })
      const freeze = await tx.streakReward.findFirst({
        where: { userId, type: 'FREEZE', consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'asc' }
      })
      if (freeze) {
        await tx.streakReward.update({ where: { id: freeze.id }, data: { consumedAt: new Date() } })
        notification = { kind: 'freeze', day: cycleDay(user.streak) }
      } else {
        await tx.streak.update({ where: { id: streak.id }, data: { endedAt: dayDate } })
        await tx.user.update({ where: { id: userId }, data: { streak: null } })
        notification = { kind: 'lost', streak }
      }
    })

    if (notification?.kind === 'freeze') notifyFreezeUsed(userId, notification.day).catch(console.error)
    else if (notification?.kind === 'lost') notifyStreakLost(userId, notification.streak).catch(console.error)
  }
}

/**
 * Grant every ungranted ladder level up to `to`. POST credits always grant
 * (cycle days 2 and 6); FREEZE and TURF_DISCOUNT are suppressed while one is
 * already held (non-stacking). The marker advances even when a reward is
 * suppressed, so the next cycle re-attempts on its own day 4/7.
 */
export async function grantLadderRewards ({ models, userId, streak, from, to }) {
  const granted = []
  for (let level = from + 1; level <= to; level++) {
    const kind = ladderRewardForLevel(level)
    const type = REWARD_TYPE[kind]
    if (!type) continue // flame / reply / goldflame are cosmetic or live
    if (type !== 'POST') {
      const held = await models.streakReward.findFirst({
        where: { userId, type, consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true }
      })
      if (held) continue
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
