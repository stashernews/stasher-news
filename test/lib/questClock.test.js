/* eslint-env jest */
import { questDay, questDayRange, questResetsAt, __setQuestClockForTests, questClockActive } from '@/lib/questClock'
import { utcDay } from '@/lib/quests'

const EPOCH = '2026-09-25T16:00:55.000Z' // a rollover moment
const MS = 20 * 60 * 1000 // each quest day lasts 20 minutes
const at = s => new Date(s)

describe('with no override configured (production path)', () => {
  beforeEach(() => __setQuestClockForTests(null))

  test('questDay is the UTC calendar day', () => {
    expect(questDay(at('2026-09-24T23:59:59Z'))).toBe('2026-09-24')
    expect(questDay(at('2026-09-25T00:00:00Z'))).toBe('2026-09-25')
    expect(questDay()).toBe(utcDay(new Date()))
  })

  test('questDayRange is the label\'s UTC bounds', () => {
    const { gte, lt } = questDayRange('2026-09-24')
    expect(gte).toEqual(at('2026-09-24T00:00:00.000Z'))
    expect(lt).toEqual(at('2026-09-25T00:00:00.000Z'))
  })

  test('questResetsAt is the next UTC midnight', () => {
    expect(questResetsAt(at('2026-09-25T15:12:00Z'))).toEqual(at('2026-09-26T00:00:00.000Z'))
  })

  test('the clock is reported inactive', () => {
    expect(questClockActive()).toBe(false)
  })
})

describe('with a compressed clock configured (dev override)', () => {
  beforeEach(() => __setQuestClockForTests({ epoch: EPOCH, dayMs: MS }))
  afterEach(() => __setQuestClockForTests(null))

  test('the clock is reported active', () => {
    expect(questClockActive()).toBe(true)
  })

  test('the label advances one quest day per window', () => {
    expect(questDay(at('2026-09-25T16:00:55Z'))).toBe('2026-09-25') // epoch itself: day 0
    expect(questDay(at('2026-09-25T16:20:54Z'))).toBe('2026-09-25')
    expect(questDay(at('2026-09-25T16:20:55Z'))).toBe('2026-09-26')
    expect(questDay(at('2026-09-25T16:40:55Z'))).toBe('2026-09-27')
    expect(questDay(at('2026-09-25T17:00:55Z'))).toBe('2026-09-28')
    // 20 real hours = 60 compressed windows = 60 quest days
    expect(questDay(at('2026-09-26T12:00:55Z'))).toBe('2026-11-24')
  })

  test('each label maps to its own window', () => {
    expect(questDayRange('2026-09-25')).toEqual({ gte: at(EPOCH), lt: at('2026-09-25T16:20:55.000Z') })
    expect(questDayRange('2026-09-26')).toEqual({ gte: at('2026-09-25T16:20:55.000Z'), lt: at('2026-09-25T16:40:55.000Z') })
    expect(questDayRange('2026-09-27')).toEqual({ gte: at('2026-09-25T16:40:55.000Z'), lt: at('2026-09-25T17:00:55.000Z') })
  })

  test('an action lands in exactly one quest-day window', () => {
    const action = at('2026-09-25T16:30:00.000Z')
    const inDay0 = action >= questDayRange('2026-09-25').gte && action < questDayRange('2026-09-25').lt
    const inDay1 = action >= questDayRange('2026-09-26').gte && action < questDayRange('2026-09-26').lt
    expect(inDay0).toBe(false)
    expect(inDay1).toBe(true)
  })

  test('questResetsAt is the end of the current window', () => {
    expect(questResetsAt(at('2026-09-25T16:30:00Z'))).toEqual(at('2026-09-25T16:40:55.000Z'))
  })

  test('labels before the epoch keep UTC bounds', () => {
    const { gte, lt } = questDayRange('2026-09-20')
    expect(gte).toEqual(at('2026-09-20T00:00:00.000Z'))
    expect(lt).toEqual(at('2026-09-21T00:00:00.000Z'))
  })
})
