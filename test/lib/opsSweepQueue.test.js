/* eslint-env jest */

// Lifecycle tests for the explicitly owned, send-only CLI queue client
// (Task 10). Pure — the boss factory is injected; no real pg-boss connection.

import { withOpsSweepQueue } from '@/lib/opsSweepQueue'

function fakeBoss () {
  return {
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(),
    stop: jest.fn().mockResolvedValue()
  }
}

test('CLI queue client always closes, even if the action fails', async () => {
  const boss = fakeBoss()
  const createBoss = jest.fn().mockReturnValue(boss)
  await expect(withOpsSweepQueue(async () => { throw new Error('action failed') }, { createBoss }))
    .rejects.toThrow('action failed')
  expect(boss.start).toHaveBeenCalledTimes(1)
  expect(boss.stop).toHaveBeenCalledTimes(1)
})

test('dry-run/no-send never starts a queue client', async () => {
  const createBoss = jest.fn()
  const action = jest.fn().mockResolvedValue('report')
  expect(await withOpsSweepQueue(action, { enabled: false, createBoss })).toBe('report')
  expect(action).toHaveBeenCalledWith(undefined)
  expect(createBoss).not.toHaveBeenCalled()
})

test('returns the action result and closes with graceful stop once', async () => {
  const boss = fakeBoss()
  const createBoss = jest.fn().mockReturnValue(boss)
  const action = jest.fn().mockResolvedValue('summary')
  expect(await withOpsSweepQueue(action, { createBoss })).toBe('summary')
  expect(action).toHaveBeenCalledWith(boss)
  expect(boss.on).toHaveBeenCalledWith('error', expect.any(Function))
  expect(boss.start).toHaveBeenCalledTimes(1)
  expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 1000 })
})

test('a client start failure is surfaced, sends nothing, and still stops the client', async () => {
  const boss = fakeBoss()
  boss.start.mockRejectedValue(new Error('start failed'))
  const createBoss = jest.fn().mockReturnValue(boss)
  const action = jest.fn()
  await expect(withOpsSweepQueue(action, { createBoss })).rejects.toThrow('start failed')
  expect(action).not.toHaveBeenCalled()
  expect(boss.stop).toHaveBeenCalledTimes(1)
})

test('an action failure still closes the client and never resolves on a failing cleanup', async () => {
  const boss = fakeBoss()
  boss.stop.mockRejectedValue(new Error('stop failed'))
  const createBoss = jest.fn().mockReturnValue(boss)
  // The finally-owned cleanup failure surfaces (the action error is already
  // recorded by the caller); the important guarantee is that failures never
  // resolve as success and payouts are never re-entered by this helper.
  await expect(withOpsSweepQueue(async () => { throw new Error('action failed') }, { createBoss }))
    .rejects.toThrow('stop failed')
  expect(boss.start).toHaveBeenCalledTimes(1)
  expect(boss.stop).toHaveBeenCalledTimes(1)
})

test('cleanup failure after a successful action is surfaced', async () => {
  const boss = fakeBoss()
  boss.stop.mockRejectedValue(new Error('stop failed'))
  const createBoss = jest.fn().mockReturnValue(boss)
  await expect(withOpsSweepQueue(async () => 'summary', { createBoss })).rejects.toThrow('stop failed')
})
