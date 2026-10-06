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

// Slot 2 is drawn from QUEST_POOL since the BOOST cutover; slot 1 is always
// UPVOTE. The cutover is day-keyed (see BOOST_QUEST_LAST_DAY): through that
// UTC day the draw still uses the legacy pool below, so a day's draw never
// changes mid-flight — in particular a user who drew BOOST on the last BOOST
// day keeps it and can complete it normally after the update lands.
export const QUEST_POOL = [QUEST.FIRST_RESPONDER, QUEST.TURF]

// The last UTC day the drawn quest can be BOOST; from the next 00:00 UTC
// (the quest-day rollover itself) BOOST is no longer drawn. If a deploy slips
// past this date, bump the constant before deploying.
export const BOOST_QUEST_LAST_DAY = '2026-10-01'

const QUEST_POOL_LEGACY = [QUEST.BOOST, QUEST.FIRST_RESPONDER, QUEST.TURF]

// Flat quest rewards (quest-rebalance spec §3.1): every completed quest
// banks exactly one reply credit, whichever quest it was — completing one no
// longer nets a gain over the reply/post completing it cost.
export const QUEST_REPLY_REWARDS = {
  [QUEST.UPVOTE]: 1,
  [QUEST.BOOST]: 1,
  [QUEST.FIRST_RESPONDER]: 1,
  [QUEST.TURF]: 1
}

// Day-7 ladder reward: percent off the next turf creation fee. Single source
// for the fee math (server) and every piece of UI + notification copy.
export const TURF_DISCOUNT_PERCENT = 15

// Banked credit caps (spec rev 3 §2.4): grants stop at the cap, but a lowered
// cap never claws back rows already held (quest-rebalance spec §3.1) — the
// surplus stays spendable until consumed or expired, and fresh grants resume
// only once outstanding rows fall below the cap.
export const MAX_BANKED_REPLIES = 10
export const MAX_BANKED_POSTS = 5

// Day-5 boost credit (spec 2026-10-05-quest-rebalance-boost-credit): the
// rung banks the rank-only promo weight of a paid 0.5 mXMR boost
// (500,000,000 piconeros) — not money: no PayIn, no wallet movement, no
// monetary filter effect. A rung grant holds at most
// MAX_BANKED_BOOSTS credits at a time and expires exactly
// BOOST_CREDIT_EXPIRY_DAYS real days after granting — never a calendar
// month, never a compressed quest day (api/quests/boost-credit.js computes
// the timestamps inside the caller's transaction).
export const BOOST_CREDIT_PICONEROS = 500_000_000n
export const BOOST_CREDIT_EXPIRY_DAYS = 30
export const MAX_BANKED_BOOSTS = 1

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

/** The day's draw. Deterministic in (userId, day); no storage. The pool is
 * day-keyed, so the BOOST cutover lands exactly at the quest-day boundary. */
export function drawFor (userId, day) {
  const pool = day <= BOOST_QUEST_LAST_DAY ? QUEST_POOL_LEGACY : QUEST_POOL
  return {
    upvote: QUEST.UPVOTE,
    drawn: pool[hash(`${userId}:${day}`) % pool.length]
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

// Week-parity ladder sets (2026-10-06): odd flame weeks keep the original
// rungs; even weeks swap day 2 (post -> boost), day 5 (boost -> post) and
// day 6 (post -> reply). Days 1, 3, 4, 7 are identical every week.
const LADDER = {
  odd: {
    1: 'reply',
    2: 'post',
    3: 'reply',
    4: 'goldflame',
    5: 'boost',
    6: 'post',
    7: 'turfdiscount'
  },
  even: {
    1: 'reply',
    2: 'boost',
    3: 'reply',
    4: 'goldflame',
    5: 'post',
    6: 'reply',
    7: 'turfdiscount'
  }
}

/** The flame week a total streak level falls in (1-based; cycles of 7). */
function ladderWeek (level) {
  return Math.floor((level - 1) / FLAME_CYCLE_DAYS) + 1
}

/** The ladder reward for a total streak level (cycles re-grant at 8, 9, ...):
 * the rung depends on the cycle day AND the parity of the flame week. */
export function ladderRewardForLevel (level) {
  const day = cycleDay(level)
  if (day == null) return null
  return LADDER[ladderWeek(level) % 2 === 1 ? 'odd' : 'even'][day]
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

// Per-day hover copy for the flame circles (the module renders these in
// tooltips), one set per week parity — same split as LADDER above.
const LADDER_COPY = {
  odd: {
    1: 'day 1 · free reply',
    2: 'day 2 · +1 free post',
    3: 'day 3 · +1 free reply',
    4: 'day 4 · golden flame absorbs your next missed streak day',
    5: 'day 5 · one boost credit',
    6: 'day 6 · +1 free post',
    7: 'day 7 · turf creation discount'
  },
  even: {
    1: 'day 1 · free reply',
    2: 'day 2 · one boost credit',
    3: 'day 3 · +1 free reply',
    4: 'day 4 · golden flame absorbs your next missed streak day',
    5: 'day 5 · +1 free post',
    6: 'day 6 · +1 free reply',
    7: 'day 7 · turf creation discount'
  }
}

/** Tooltip copy for a flame-circle day (1..7) in a 1-based flame week. */
export function ladderCopyFor (day, week) {
  return LADDER_COPY[week % 2 === 1 ? 'odd' : 'even'][day]
}
