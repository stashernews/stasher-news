// Daily quests + flame ladder — pure and dependency-free so the client (module
// UI, badge color), the sweep worker, and the streak job all agree on the same
// deterministic draw. Spec: docs/superpowers/specs/2026-09-23-daily-quests-design.md

export const QUEST = {
  UPVOTE: 'UPVOTE',
  BOOST: 'BOOST',
  FIRST_RESPONDER: 'FIRST_RESPONDER',
  TURF: 'TURF'
}

// Slot 2 is drawn from this pool; slot 1 is always UPVOTE.
export const QUEST_POOL = [QUEST.BOOST, QUEST.FIRST_RESPONDER, QUEST.TURF]

// Turfs that are never drawn as quest targets: jobs and bounties are
// transactional settlement feeds, not community posting spots.
export const TURF_QUEST_EXCLUDED_TURFS = ['jobs', 'bounties']

// Day-7 ladder reward: percent off the next turf creation fee. Single source
// for the fee math (server) and every piece of UI + notification copy.
export const TURF_DISCOUNT_PERCENT = 15

/** Apply the held day-7 discount to a fee in piconeros. Floors to whole
 * piconeros and never makes the fee negative. */
export function applyTurfDiscount (feePiconeros) {
  return feePiconeros - (feePiconeros * BigInt(TURF_DISCOUNT_PERCENT)) / 100n
}

const FLAME_CYCLE_DAYS = 7

/** UTC calendar day as 'YYYY-MM-DD' (the quest-day boundary is 00:00 UTC). */
export function utcDay (date = new Date()) {
  return date.toISOString().slice(0, 10)
}

// FNV-1a over the key string — stable, tiny, no dependencies.
function hash (str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The day's draw. Deterministic in (userId, day); no storage. */
export function drawFor (userId, day) {
  return {
    upvote: QUEST.UPVOTE,
    drawn: QUEST_POOL[hash(`${userId}:${day}`) % QUEST_POOL.length],
    turfHash: hash(`${userId}:${day}:turf`)
  }
}

/** The drawn turf from a list ordered by id (deleted turfs never appear). */
export function pickTurf (turfs, turfHash) {
  if (!turfs || turfs.length === 0) return null
  return turfs[turfHash % turfs.length]
}

/** Cycle position 1..7 of a total streak day count; null when not streaking. */
export function cycleDay (streak) {
  if (streak == null || streak < 1) return null
  return ((streak - 1) % FLAME_CYCLE_DAYS) + 1
}

export function isGoldFlame (streak) {
  const day = cycleDay(streak)
  return day != null && day >= 5
}

const LADDER = {
  1: 'flame',
  2: 'post',
  3: 'reply',
  4: 'freeze',
  5: 'goldflame',
  6: 'post',
  7: 'turfdiscount'
}

/** The ladder reward for a total streak level (cycles re-grant at 8, 9, ...). */
export function ladderRewardForLevel (level) {
  const day = cycleDay(level)
  return day == null ? null : LADDER[day]
}

const QUEST_TITLES = {
  [QUEST.UPVOTE]: 'send an upvote',
  [QUEST.BOOST]: 'send a boost',
  [QUEST.FIRST_RESPONDER]: 'first responder'
}

export function questTitle (type, turfName) {
  if (type !== QUEST.TURF) return QUEST_TITLES[type]
  return turfName ? `post or comment in ~${turfName}` : 'post or comment in a turf'
}

// Per-day hover copy for the flame circles (the module renders these in tooltips).
export const LADDER_COPY = {
  1: 'day 1 · your flame lights up',
  2: 'day 2 · +1 free post',
  3: 'day 3 · +1 free reply',
  4: 'day 4 · streak freeze — absorbs your next missed day',
  5: 'day 5 · golden flame',
  6: 'day 6 · +1 free post',
  7: `day 7 · ${TURF_DISCOUNT_PERCENT}% off your next turf creation`
}
