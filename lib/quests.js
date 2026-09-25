// Daily quests + flame ladder: pure and dependency-free so the client (module
// UI, badge color), the sweep worker, and the streak job all agree on the same
// deterministic draw. Spec: docs/superpowers/specs/2026-09-23-daily-quests-design.md

export const QUEST = {
  UPVOTE: 'UPVOTE',
  BOOST: 'BOOST',
  FIRST_RESPONDER: 'FIRST_RESPONDER',
  TURF: 'TURF'
}

// TURF is the historical id of the drawn quest; since rev 5 it means
// "post or comment (anywhere)" — any item on any turf completes it.

// Slot 2 is drawn from this pool; slot 1 is always UPVOTE.
export const QUEST_POOL = [QUEST.BOOST, QUEST.FIRST_RESPONDER, QUEST.TURF]

// Rev 4: quests that require spending a reply or post pay double, so
// completing them nets a gain. Upvote costs cents and boosts fund the
// rewards pool, so they stay at +1.
export const QUEST_REPLY_REWARDS = {
  [QUEST.UPVOTE]: 1,
  [QUEST.BOOST]: 1,
  [QUEST.FIRST_RESPONDER]: 2,
  [QUEST.TURF]: 2
}

// Day-7 ladder reward: percent off the next turf creation fee. Single source
// for the fee math (server) and every piece of UI + notification copy.
export const TURF_DISCOUNT_PERCENT = 15

// Banked credit caps (spec rev 3 §2.4): grants stop at the cap.
export const MAX_BANKED_REPLIES = 15
export const MAX_BANKED_POSTS = 5

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

// FNV-1a over the key string: stable, tiny, no dependencies.
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
    drawn: QUEST_POOL[hash(`${userId}:${day}`) % QUEST_POOL.length]
  }
}

/** Cycle position 1..7 of a total streak day count; null when not streaking. */
export function cycleDay (streak) {
  if (streak == null || streak < 1) return null
  return ((streak - 1) % FLAME_CYCLE_DAYS) + 1
}

/**
 * What the card shows for a flame: the day the viewer is on, its week, and how
 * many circles are lit. The day is the one being worked on until it is cleared,
 * so a fresh run shows day 1 with nothing lit, and a completed cycle rolls over
 * to day 1 of the next week on the following day. `litThrough` counts only the
 * days earned in the current cycle.
 */
export function flamePosition (streak, todayCleared) {
  const level = streak ?? 0
  const effective = level + (todayCleared ? 0 : 1)
  const day = ((effective - 1) % FLAME_CYCLE_DAYS) + 1
  const week = Math.floor((effective - 1) / FLAME_CYCLE_DAYS) + 1
  return { day, week, litThrough: todayCleared ? day : day - 1 }
}

const LADDER = {
  1: 'reply',
  2: 'post',
  3: 'reply',
  4: 'goldflame',
  5: 'reply',
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
  [QUEST.FIRST_RESPONDER]: 'first responder',
  [QUEST.TURF]: 'post or comment'
}

export function questTitle (type) {
  return QUEST_TITLES[type]
}

// Per-day hover copy for the flame circles (the module renders these in tooltips).
export const LADDER_COPY = {
  1: 'day 1 · free reply',
  2: 'day 2 · +1 free post',
  3: 'day 3 · +1 free reply',
  4: 'day 4 · golden flame absorbs your next missed streak day',
  5: 'day 5 · +1 free reply',
  6: 'day 6 · +1 free post',
  7: 'day 7 · turf creation discount'
}
