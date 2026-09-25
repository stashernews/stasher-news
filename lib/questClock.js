import { utcDay } from '@/lib/quests'

const DAY_MS = 86_400_000

// Dev-only quest clock override (spec 2026-09-23-daily-quests): compresses
// quest days so a full week's progression can be tested in minutes.
// QUEST_DAY_EPOCH (ISO, a rollover moment) + QUEST_DAY_MS (quest-day length)
// make the quest-day label advance one step per window. Unset everywhere in
// production (validateEnv refuses them there); unset behaves as exact UTC.
let testClock = null

/** Test hook: set/clear the clock override in memory (wins over the env). */
export function __setQuestClockForTests (clock) {
  testClock = clock ? { epoch: new Date(clock.epoch), dayMs: Number(clock.dayMs) } : null
}

/** Whether the compressed clock is configured. */
export function questClockActive () {
  return clock() !== null
}

function clock () {
  // Under jest the ambient container env must not leak into suites: only the
  // explicit test hook applies there.
  if (process.env.JEST_WORKER_ID) return testClock
  if (testClock) return testClock
  const epoch = process.env.QUEST_DAY_EPOCH
  const ms = process.env.QUEST_DAY_MS
  if (!epoch || !ms) return null
  const e = new Date(epoch)
  const len = Number(ms)
  if (Number.isNaN(e.getTime()) || !Number.isFinite(len) || len <= 0) return null
  return { epoch: e, dayMs: len }
}

/** The quest-day label ('YYYY-MM-DD') for a moment: without the override, the
 * UTC calendar day; with it, one label step per configured window starting
 * from the epoch. */
export function questDay (now = new Date()) {
  const c = clock()
  if (!c || now < c.epoch) return utcDay(now)
  const n = Math.floor((now.getTime() - c.epoch.getTime()) / c.dayMs)
  return utcDay(new Date(c.epoch.getTime() + n * DAY_MS))
}

/** The action window [gte, lt) a quest-day label covers. Without the override
 * these are the label's UTC bounds; with it, windows are the compressed
 * slots, so completion checks split actions at exactly the window edges. */
export function questDayRange (day) {
  const c = clock()
  const start = new Date(`${day}T00:00:00.000Z`)
  if (!c) return { gte: start, lt: new Date(start.getTime() + DAY_MS) }
  const base = utcDay(c.epoch)
  const n = Math.round((start.getTime() - Date.parse(`${base}T00:00:00.000Z`)) / DAY_MS)
  if (n < 0 || !Number.isInteger(n)) return { gte: start, lt: new Date(start.getTime() + DAY_MS) }
  return {
    gte: new Date(c.epoch.getTime() + n * c.dayMs),
    lt: new Date(c.epoch.getTime() + (n + 1) * c.dayMs)
  }
}

/** The next rollover moment — the card's reset timer. */
export function questResetsAt (now = new Date()) {
  return questDayRange(questDay(now)).lt
}
