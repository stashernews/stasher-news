/* eslint-env jest */
import { QUEST, QUEST_POOL, utcDay, drawFor, pickTurf, cycleDay, isGoldFlame, ladderRewardForLevel, questTitle, LADDER_COPY } from '@/lib/quests'

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

test('pickTurf indexes the turf list by hash and tolerates empty lists', () => {
  const turfs = [{ id: 1, name: 'bitcoin' }, { id: 2, name: 'jobs' }, { id: 3, name: 'nostr' }]
  const picked = pickTurf(turfs, drawFor(7, '2026-09-24').turfHash)
  expect(turfs).toContain(picked)
  expect(pickTurf([], 123)).toBeNull()
})

test('cycleDay wraps 1..7 and is null without a streak', () => {
  expect(cycleDay(null)).toBeNull()
  expect(cycleDay(1)).toBe(1)
  expect(cycleDay(7)).toBe(7)
  expect(cycleDay(8)).toBe(1)
  expect(cycleDay(15)).toBe(1)
  expect(cycleDay(9)).toBe(2)
})

test('gold flame is cycle days 5-7', () => {
  expect(isGoldFlame(4)).toBe(false)
  expect(isGoldFlame(5)).toBe(true)
  expect(isGoldFlame(7)).toBe(true)
  expect(isGoldFlame(8)).toBe(false) // next cycle starts normal
  expect(isGoldFlame(null)).toBe(false)
})

test('ladderRewardForLevel maps total days through the cycle', () => {
  expect(ladderRewardForLevel(1)).toBe('flame')
  expect(ladderRewardForLevel(2)).toBe('post')
  expect(ladderRewardForLevel(3)).toBe('reply')
  expect(ladderRewardForLevel(4)).toBe('freeze')
  expect(ladderRewardForLevel(5)).toBe('goldflame')
  expect(ladderRewardForLevel(6)).toBe('post')
  expect(ladderRewardForLevel(7)).toBe('turfdiscount')
  expect(ladderRewardForLevel(8)).toBe('flame') // cycle restarts
  expect(ladderRewardForLevel(9)).toBe('post') // re-grant next cycle
})

test('quest copy renders the drawn turf', () => {
  expect(questTitle(QUEST.UPVOTE, null)).toBe('send an upvote')
  expect(questTitle(QUEST.BOOST, null)).toBe('send a boost')
  expect(questTitle(QUEST.FIRST_RESPONDER, null)).toBe('first responder')
  expect(questTitle(QUEST.TURF, 'bitcoin')).toBe('post or comment in ~bitcoin')
})

test('every ladder day has tooltip copy', () => {
  for (let d = 1; d <= 7; d++) expect(LADDER_COPY[d]).toBeTruthy()
})
