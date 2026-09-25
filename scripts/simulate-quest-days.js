#!/usr/bin/env node
/**
 * Dev-only: simulate UTC days passing for the daily-quests / flame system.
 *
 * Uses the REAL advance/evaluation code paths (the same functions the quest
 * sweep and the 00:10 UTC job call), so the flame, the ladder grants, the
 * shield absorption and the loss behave exactly as they do in production.
 *
 *   npx tsx --tsconfig jsconfig.json scripts/simulate-quest-days.js status <nym>
 *   npx tsx --tsconfig jsconfig.json scripts/simulate-quest-days.js draws  <nym> [days]
 *   npx tsx --tsconfig jsconfig.json scripts/simulate-quest-days.js clear  <nym> <dayOffset>
 *   npx tsx --tsconfig jsconfig.json scripts/simulate-quest-days.js miss   <nym> <dayOffset>
 *   npx tsx --tsconfig jsconfig.json scripts/simulate-quest-days.js reset  <nym>
 *
 * dayOffset is relative to today's UTC day: 0 = today, 1 = tomorrow, -1 = yesterday.
 *
 * Examples:
 *   # advance the flame one simulated day (both quests cleared)
 *   ... clear alice 1
 *   # walk a fresh ladder: clear 0, then 1..7
 *   # simulate a missed day (freeze absorption or loss)
 *   ... miss alice 2
 *   # back to no flame
 *   ... reset alice
 */
import models from '@/api/models'
import { advanceQuestStreak, evaluateQuestStreaks } from '@/worker/streak'
import { resolveDraw } from '@/api/quests/draw'
import { cycleDay, utcDay } from '@/lib/quests'

const DAY_MS = 86_400_000

function usage () {
  console.log(`usage:
  simulate-quest-days.js status <nym>
  simulate-quest-days.js draws  <nym> [days]
  simulate-quest-days.js clear  <nym> <dayOffset>
  simulate-quest-days.js miss   <nym> <dayOffset>
  simulate-quest-days.js reset  <nym>

dayOffset is relative to today's UTC day: 0 = today, 1 = tomorrow, -1 = yesterday.`)
}

const dayAt = offset => utcDay(new Date(Date.now() + offset * DAY_MS))
const dayDate = day => new Date(`${day}T00:00:00.000Z`)

async function findUser (nym) {
  const user = await models.user.findUnique({ where: { name: nym }, select: { id: true, name: true, streak: true, noteQuests: true } })
  if (!user) throw new Error(`no user named ${nym}`)
  return user
}

async function state (userId) {
  const [row] = await models.streak.findMany({ where: { userId, type: 'FLAME', endedAt: null }, orderBy: { id: 'desc' }, take: 1 })
  const held = await models.streakReward.findMany({ where: { userId, consumedAt: null, expiresAt: { gt: new Date() } }, select: { type: true } })
  const current = await models.user.findUnique({ where: { id: userId }, select: { streak: true } })
  const streak = current?.streak ?? null
  return {
    streak,
    cycleDay: cycleDay(streak),
    gold: row?.goldActive ?? false,
    rewardLevel: row?.rewardLevel ?? null,
    lastEvaluatedDay: row?.lastEvaluatedDay ? utcDay(row.lastEvaluatedDay) : null,
    held: held.map(h => h.type)
  }
}

async function main () {
  const [cmd, nym, arg] = process.argv.slice(2)
  if (!cmd || !nym) return usage()
  const user = await findUser(nym)

  if (cmd === 'status') {
    console.log(JSON.stringify(await state(user.id), null, 2))
    const today = dayAt(0)
    const draw = await resolveDraw(models, user.id, today)
    console.log(`today ${today}: drawn=${draw.drawn}`)
    const completions = await models.questCompletion.findMany({ where: { userId: user.id }, orderBy: { day: 'desc' }, take: 5 })
    console.log('recent completions:', completions.map(c => `${utcDay(c.day)} ${c.quest}`).join(', ') || '(none)')
    return
  }

  if (cmd === 'draws') {
    const days = Number(arg || 7)
    for (let i = 0; i < days; i++) {
      const day = dayAt(i)
      const draw = await resolveDraw(models, user.id, day)
      console.log(`${day}  ${draw.drawn}`)
    }
    return
  }

  if (cmd === 'clear') {
    const day = dayAt(Number(arg))
    const draw = await resolveDraw(models, user.id, day)
    const quests = [draw.upvote, draw.drawn]
    for (const quest of quests) {
      await models.questCompletion.upsert({
        where: { userId_day_quest: { userId: user.id, day: dayDate(day), quest } },
        create: { userId: user.id, day: dayDate(day), quest },
        update: {}
      })
    }
    const notification = await advanceQuestStreak({ models, userId: user.id, day, requirePrevSettled: true })
    console.log(`cleared ${day} (${quests.join(' + ')})`)
    console.log(notification
      ? `flame advanced -> level ${notification.level} (cycle day ${notification.cycleDay}${notification.goldFlame ? ', gold' : ''})` +
        (notification.rewards.length ? `; granted ${notification.rewards.map(r => `${r.kind}@${r.level}`).join(', ')}` : '')
      : 'no advance (the previous day is not settled yet, or this day was already counted)')
    console.log(JSON.stringify(await state(user.id), null, 2))
    return
  }

  if (cmd === 'miss') {
    const day = dayAt(Number(arg))
    const before = await state(user.id)
    // evaluateQuestStreaks evaluates the day before `now`: aim at noon after `day`
    await evaluateQuestStreaks({ models, now: new Date(dayDate(day).getTime() + DAY_MS + 12 * 3_600_000) })
    const after = await state(user.id)
    console.log(`evaluated ${day} as missed (no completions recorded)`)
    console.log('before:', JSON.stringify(before))
    console.log('after: ', JSON.stringify(after))
    return
  }

  if (cmd === 'reset') {
    await models.streakReward.deleteMany({ where: { userId: user.id } })
    await models.questCompletion.deleteMany({ where: { userId: user.id } })
    await models.streak.deleteMany({ where: { userId: user.id, type: 'FLAME' } })
    await models.user.update({ where: { id: user.id }, data: { streak: null } })
    console.log(`reset ${nym}: flame, rewards and quest completions cleared`)
    return
  }

  usage()
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
