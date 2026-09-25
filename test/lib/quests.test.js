/* eslint-env jest */
import { QUEST, QUEST_POOL, utcDay, drawFor, cycleDay, flamePosition, ladderRewardForLevel, questTitle, LADDER_COPY, QUEST_REPLY_REWARDS } from '@/lib/quests'

test('utcDay is the UTC calendar date', () => {
  expect(utcDay(new Date('2026-09-24T23:59:59Z'))).toBe('2026-09-24')
  expect(utcDay(new Date('2026-09-25T00:00:00Z'))).toBe('2026-09-25')
})

test('the draw is deterministic and slot 1 is always UPVOTE', () => {
  const a = drawFor(7, '2026-09-24')
  const b = drawFor(7, '2026-09-24')
  expect(a).toEqual(b)
  expect(a.upvote).toBe(QUEST.UPVOTE)
  expect(QUEST_POOL).toContain(a.drawn)
  expect(a.drawn).not.toBe(QUEST.UPVOTE)
})

test('different users/days vary the drawn quest', () => {
  const draws = new Set()
  for (let u = 1; u <= 40; u++) draws.add(drawFor(u, '2026-09-24').drawn)
  expect(draws.size).toBe(QUEST_POOL.length) // all three appear across 40 users
})

test('the draw is deterministic and slot 1 is always UPVOTE', () => {
  const a = drawFor(7, '2026-09-24')
  const b = drawFor(7, '2026-09-24')
  expect(a).toEqual(b)
  expect(a.upvote).toBe(QUEST.UPVOTE)
  expect(QUEST_POOL).toContain(a.drawn)
  expect(a.drawn).not.toBe(QUEST.UPVOTE)
})

test('cycleDay wraps 1..7 and is null without a streak', () => {
  expect(cycleDay(null)).toBeNull()
  expect(cycleDay(1)).toBe(1)
  expect(cycleDay(7)).toBe(7)
  expect(cycleDay(8)).toBe(1)
  expect(cycleDay(15)).toBe(1)
  expect(cycleDay(9)).toBe(2)
})

test('the ladder arms the shield at day 4 and pays replies at days 3 and 5', () => {
  expect(ladderRewardForLevel(3)).toBe('reply')
  expect(ladderRewardForLevel(4)).toBe('goldflame')
  expect(ladderRewardForLevel(5)).toBe('reply')
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

test('ladderRewardForLevel maps total days through the cycle', () => {
  expect(ladderRewardForLevel(1)).toBe('reply')
  expect(ladderRewardForLevel(2)).toBe('post')
  expect(ladderRewardForLevel(3)).toBe('reply')
  expect(ladderRewardForLevel(4)).toBe('goldflame')
  expect(ladderRewardForLevel(5)).toBe('reply')
  expect(ladderRewardForLevel(6)).toBe('post')
  expect(ladderRewardForLevel(7)).toBe('turfdiscount')
  expect(ladderRewardForLevel(8)).toBe('reply') // cycle restarts
  expect(ladderRewardForLevel(9)).toBe('post') // re-grant next cycle
})

test('quest copy keeps the drawn quests readable', () => {
  expect(questTitle(QUEST.UPVOTE)).toBe('send an upvote')
  expect(questTitle(QUEST.BOOST)).toBe('send a boost')
  expect(questTitle(QUEST.FIRST_RESPONDER)).toBe('first responder')
  expect(questTitle(QUEST.TURF)).toBe('post or comment')
})

test('ladder copy carries no em dashes and names the shield and the discount', () => {
  for (const line of Object.values(LADDER_COPY)) {
    expect(line).not.toContain('—')
  }
  expect(LADDER_COPY[4]).toBe('day 4 · golden flame absorbs your next missed streak day')
  expect(LADDER_COPY[7]).toBe('day 7 · turf creation discount')
})

test('every ladder day has tooltip copy', () => {
  for (let d = 1; d <= 7; d++) expect(LADDER_COPY[d]).toBeTruthy()
})

test('rev 4: day 1 banks a reply and the comment quests pay double', () => {
  expect(ladderRewardForLevel(1)).toBe('reply')
  expect(ladderRewardForLevel(8)).toBe('reply') // every week's day 1, not just a run's first
  expect(ladderRewardForLevel(15)).toBe('reply')
  expect(QUEST_REPLY_REWARDS[QUEST.UPVOTE]).toBe(1)
  expect(QUEST_REPLY_REWARDS[QUEST.BOOST]).toBe(1)
  expect(QUEST_REPLY_REWARDS[QUEST.FIRST_RESPONDER]).toBe(2)
  expect(QUEST_REPLY_REWARDS[QUEST.TURF]).toBe(2)
})

test('rev 4 copy: the day 1 tooltip reads free reply, em-dash free', () => {
  expect(LADDER_COPY[1]).toBe('day 1 · free reply')
  for (const line of Object.values(LADDER_COPY)) expect(line).not.toContain('—')
})
