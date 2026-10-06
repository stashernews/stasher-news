/* eslint-env jest */
import { QUEST, QUEST_POOL, BOOST_QUEST_LAST_DAY, utcDay, drawFor, cycleDay, flamePosition, ladderRewardForLevel, ladderCopyFor, questTitle, QUEST_REPLY_REWARDS, MAX_BANKED_REPLIES, BOOST_CREDIT_PICONEROS, BOOST_CREDIT_EXPIRY_DAYS, MAX_BANKED_BOOSTS } from '@/lib/quests'

// The first day the drawn quest can no longer be BOOST (the cutover itself).
// Falls back to an ancient date so a missing constant fails assertions below
// instead of crashing the suite on invalid date math.
const DAY_AFTER_BOOST = BOOST_QUEST_LAST_DAY
  ? utcDay(new Date(Date.parse(`${BOOST_QUEST_LAST_DAY}T00:00:00Z`) + 86_400_000))
  : '1970-01-02'

test('the BOOST cutover day is a calendar day constant', () => {
  expect(BOOST_QUEST_LAST_DAY).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(DAY_AFTER_BOOST).not.toBe(BOOST_QUEST_LAST_DAY)
})

test('utcDay is the UTC calendar date', () => {
  expect(utcDay(new Date('2026-09-24T23:59:59Z'))).toBe('2026-09-24')
  expect(utcDay(new Date('2026-09-25T00:00:00Z'))).toBe('2026-09-25')
})

test('the draw is deterministic and slot 1 is always UPVOTE', () => {
  const a = drawFor(7, DAY_AFTER_BOOST)
  const b = drawFor(7, DAY_AFTER_BOOST)
  expect(a).toEqual(b)
  expect(a.upvote).toBe(QUEST.UPVOTE)
  expect(QUEST_POOL).toContain(a.drawn)
  expect(a.drawn).not.toBe(QUEST.UPVOTE)
  expect(a.drawn).not.toBe(QUEST.BOOST)
})

test('different users/days vary the drawn quest', () => {
  const draws = new Set()
  for (let u = 1; u <= 40; u++) draws.add(drawFor(u, DAY_AFTER_BOOST).drawn)
  expect(draws.size).toBe(QUEST_POOL.length) // both remaining quests appear across 40 users
})

test('through the last BOOST day the drawn quest can still be BOOST', () => {
  // The cutover is day-keyed, so in-flight days keep their draw: a user who
  // woke up to BOOST on the last BOOST day keeps it all day (deploy-safe).
  const draws = new Set()
  for (let u = 1; u <= 60; u++) draws.add(drawFor(u, BOOST_QUEST_LAST_DAY).drawn)
  expect(draws.has(QUEST.BOOST)).toBe(true)
  expect(draws.size).toBe(3)
})

test('after the last BOOST day the drawn quest is never BOOST', () => {
  for (let u = 1; u <= 60; u++) {
    expect(drawFor(u, DAY_AFTER_BOOST).drawn).not.toBe(QUEST.BOOST)
  }
})

test('cycleDay wraps 1..7 and is null without a streak', () => {
  expect(cycleDay(null)).toBeNull()
  expect(cycleDay(1)).toBe(1)
  expect(cycleDay(7)).toBe(7)
  expect(cycleDay(8)).toBe(1)
  expect(cycleDay(15)).toBe(1)
  expect(cycleDay(9)).toBe(2)
})

test('the ladder pays a reply at day 3, the shield at day 4, and a boost at day 5', () => {
  expect(ladderRewardForLevel(3)).toBe('reply')
  expect(ladderRewardForLevel(4)).toBe('goldflame')
  expect(ladderRewardForLevel(5)).toBe('boost')
  expect(ladderRewardForLevel(11)).toBe('goldflame') // week 2 day 4 re-arms
})

test('the card shows the current cycle day and week', () => {
  // nothing earned yet, today's quests open -> day 1, nothing lit
  expect(flamePosition(0, false)).toEqual({ day: 1, week: 1, litThrough: 0 })
  // day 1 cleared
  expect(flamePosition(1, true)).toEqual({ day: 1, week: 1, litThrough: 1 })
  // day 1 earned, working on day 2
  expect(flamePosition(1, false)).toEqual({ day: 2, week: 1, litThrough: 1 })
  // a completed cycle, new day: week 2 day 1 with nothing lit
  expect(flamePosition(7, false)).toEqual({ day: 1, week: 2, litThrough: 0 })
  expect(flamePosition(7, true)).toEqual({ day: 7, week: 1, litThrough: 7 })
  expect(flamePosition(8, true)).toEqual({ day: 1, week: 2, litThrough: 1 })
})

test('ladderRewardForLevel maps total days through the cycle and the week parity', () => {
  // week 1 (odd): the original set
  expect(ladderRewardForLevel(1)).toBe('reply')
  expect(ladderRewardForLevel(2)).toBe('post')
  expect(ladderRewardForLevel(3)).toBe('reply')
  expect(ladderRewardForLevel(4)).toBe('goldflame')
  expect(ladderRewardForLevel(5)).toBe('boost')
  expect(ladderRewardForLevel(6)).toBe('post')
  expect(ladderRewardForLevel(7)).toBe('turfdiscount')
  expect(ladderRewardForLevel(8)).toBe('reply') // cycle restarts
  // week 2 (even): day 2 a boost credit, day 5 a post, day 6 a reply
  expect(ladderRewardForLevel(9)).toBe('boost') // week 2 day 2
  expect(ladderRewardForLevel(12)).toBe('post') // week 2 day 5
  expect(ladderRewardForLevel(13)).toBe('reply') // week 2 day 6
  // week 3 (odd): the original set returns
  expect(ladderRewardForLevel(16)).toBe('post') // week 3 day 2
  expect(ladderRewardForLevel(19)).toBe('boost') // week 3 day 5
  // week 4 (even) swaps again
  expect(ladderRewardForLevel(23)).toBe('boost') // week 4 day 2
})

test('quest copy keeps the drawn quests readable', () => {
  expect(questTitle(QUEST.UPVOTE)).toBe('send an upvote')
  expect(questTitle(QUEST.BOOST)).toBe('send a boost')
  expect(questTitle(QUEST.FIRST_RESPONDER)).toBe('first responder')
  expect(questTitle(QUEST.TURF)).toBe('post or comment')
})

test('ladder copy carries no em dashes and names the shield and the discount', () => {
  for (const week of [1, 2, 3, 4]) {
    for (let d = 1; d <= 7; d++) expect(ladderCopyFor(d, week)).not.toContain('—')
  }
  expect(ladderCopyFor(4, 1)).toBe('day 4 · golden flame absorbs your next missed streak day')
  expect(ladderCopyFor(7, 2)).toBe('day 7 · turf creation discount')
})

test('every ladder day has tooltip copy on both week parities', () => {
  for (const week of [1, 2]) {
    for (let d = 1; d <= 7; d++) expect(ladderCopyFor(d, week)).toBeTruthy()
  }
})

test('day 1 banks a reply at every week\'s restart, not just a run\'s first', () => {
  expect(ladderRewardForLevel(1)).toBe('reply')
  expect(ladderRewardForLevel(8)).toBe('reply') // every week's day 1, not just a run's first
  expect(ladderRewardForLevel(15)).toBe('reply')
})

test('all quest completions reward one reply and the bank cap is ten', () => {
  expect(Object.values(QUEST_REPLY_REWARDS)).toEqual([1, 1, 1, 1])
  expect(MAX_BANKED_REPLIES).toBe(10)
})

test('rev 4 copy: the day 1 tooltip reads free reply, em-dash free', () => {
  expect(ladderCopyFor(1, 1)).toBe('day 1 · free reply')
  expect(ladderCopyFor(1, 2)).toBe('day 1 · free reply')
  for (const week of [1, 2]) {
    for (let d = 1; d <= 7; d++) expect(ladderCopyFor(d, week)).not.toContain('—')
  }
})

test('the boost credit rung is day 5 on odd weeks and day 2 on even weeks: amount, exact expiry, cap, and tooltips', () => {
  // The strength of the paid 0.5 mXMR boost, as rank-only promo units.
  expect(BOOST_CREDIT_PICONEROS).toBe(500_000_000n)
  // Exactly 30 days after grant — never a calendar month, never a compressed
  // quest day (the expiry is pinned again against the DB in
  // test/api/quests/boost-credit.test.js).
  expect(BOOST_CREDIT_EXPIRY_DAYS).toBe(30)
  // Non-stacking: a held credit suppresses the rung instead of refreshing.
  expect(MAX_BANKED_BOOSTS).toBe(1)
  expect(ladderCopyFor(5, 1)).toBe('day 5 · one boost credit')
  expect(ladderCopyFor(5, 3)).toBe('day 5 · one boost credit') // odd weeks keep the set
  expect(ladderCopyFor(2, 2)).toBe('day 2 · one boost credit')
  // even weeks swap the day-5 and day-6 rungs too: a post, then a reply
  expect(ladderCopyFor(5, 2)).toBe('day 5 · +1 free post')
  expect(ladderCopyFor(6, 2)).toBe('day 6 · +1 free reply')
  expect(ladderCopyFor(2, 1)).toBe('day 2 · +1 free post')
  expect(ladderCopyFor(6, 1)).toBe('day 6 · +1 free post')
})

test('BOOST_CREDIT_EXPIRY_DAYS is exactly 30 spans of 24 real hours', () => {
  expect(BOOST_CREDIT_EXPIRY_DAYS * 86_400_000).toBe(2_592_000_000)
})
