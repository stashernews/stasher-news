/* eslint-env jest */

// Unit test for the Daily Dead Drop job (worker/dailyDeadDrop.js): the day
// counter, the once-per-UTC-day guard, and the day-1 bootstrap that creates
// the global Pin. models and pay are stubs; the real ITEM_CREATE flow is
// exercised by the payIn tests.

import { dailyDeadDrop, deadDropDay, deadDropTitle } from '@/worker/dailyDeadDrop'
import { USER_ID } from '@/lib/constants'

jest.mock('../../api/payIn', () => ({ __esModule: true, default: jest.fn() }))

const NOW = new Date('2026-11-01T00:00:05Z')

function stubModels (latest) {
  return {
    item: { findFirst: jest.fn().mockResolvedValue(latest) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 77 }])
  }
}

function stubPay () {
  return jest.fn().mockResolvedValue({ result: { id: 1000 } })
}

test('title round-trips through the day parser', () => {
  expect(deadDropTitle(412)).toBe('Daily Dead Drop: day 412')
  expect(deadDropDay(deadDropTitle(412))).toBe(412)
  expect(deadDropDay('Daily Dead Drop')).toBeNull()
  expect(deadDropDay(undefined)).toBeNull()
})

test('posts the next day on the existing pin', async () => {
  const models = stubModels({ id: 9, title: 'Daily Dead Drop: day 411', pinId: 5, createdAt: new Date('2026-10-31T00:00:03Z') })
  const pay = stubPay()

  const out = await dailyDeadDrop({ models, pay, now: NOW })

  expect(out).toEqual({ skipped: false, itemId: 1000, day: 412 })
  expect(models.$queryRaw).not.toHaveBeenCalled()
  expect(pay).toHaveBeenCalledWith('ITEM_CREATE', expect.objectContaining({
    title: 'Daily Dead Drop: day 412',
    userId: USER_ID.deadDrop,
    subNames: [],
    pinId: 5
  }), { me: { id: USER_ID.deadDrop }, custodialOnly: true })
})

test('bootstraps day 1 and a global pin when no drop exists', async () => {
  const models = stubModels(null)
  const pay = stubPay()

  const out = await dailyDeadDrop({ models, pay, now: NOW })

  expect(out.day).toBe(1)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1)
  expect(pay).toHaveBeenCalledWith('ITEM_CREATE', expect.objectContaining({
    title: 'Daily Dead Drop: day 1',
    pinId: 77
  }), expect.anything())
})

test('a second run on the same UTC day is a no-op', async () => {
  const models = stubModels({ id: 9, title: 'Daily Dead Drop: day 412', pinId: 5, createdAt: new Date('2026-11-01T00:00:01Z') })
  const pay = stubPay()

  const out = await dailyDeadDrop({ models, pay, now: NOW })

  expect(out).toEqual({ skipped: true, itemId: 9 })
  expect(pay).not.toHaveBeenCalled()
})

test('a failed bootstrap post deletes the pin it created', async () => {
  const models = { ...stubModels(null), pin: { delete: jest.fn().mockResolvedValue({}) } }
  const pay = jest.fn().mockRejectedValue(new Error('boom'))

  await expect(dailyDeadDrop({ models, pay, now: NOW })).rejects.toThrow('boom')
  expect(models.pin.delete).toHaveBeenCalledWith({ where: { id: 77 } })
})
