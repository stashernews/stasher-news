/* eslint-env jest */
import { createReorgDetector } from '@/lib/reorgDetector'

function setup () {
  const alert = jest.fn()
  const detectReorg = createReorgDetector({ alert })
  return { alert, detectReorg }
}

test('first observation establishes the baseline and fires no alert', () => {
  const { alert, detectReorg } = setup()
  expect(detectReorg(1000)).toEqual({ reorg: false, fromHeight: null, toHeight: 1000 })
  expect(alert).not.toHaveBeenCalled()
})

test('height advancement fires no alert', () => {
  const { alert, detectReorg } = setup()
  detectReorg(1000)
  expect(detectReorg(1001)).toEqual({ reorg: false, fromHeight: 1000, toHeight: 1001 })
  expect(alert).not.toHaveBeenCalled()
})

test('equal height fires no alert', () => {
  const { alert, detectReorg } = setup()
  detectReorg(1000)
  expect(detectReorg(1000).reorg).toBe(false)
  expect(alert).not.toHaveBeenCalled()
})

test('height regression fires a critical reorg alert with the reorg dedupeKey', () => {
  const { alert, detectReorg } = setup()
  detectReorg(1000)
  expect(detectReorg(997)).toEqual({ reorg: true, fromHeight: 1000, toHeight: 997 })
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'monero reorg detected',
    'chain height regressed 1000 -> 997',
    { dedupeKey: 'reorg' }
  )
})

test('non-number height (null/undefined) is ignored and preserves the baseline', () => {
  const { alert, detectReorg } = setup()
  detectReorg(1000)
  expect(detectReorg(null).reorg).toBe(false)
  expect(detectReorg(undefined).reorg).toBe(false)
  expect(alert).not.toHaveBeenCalled()
  expect(detectReorg(990).reorg).toBe(true)
  expect(alert).toHaveBeenCalledTimes(1)
})

test('each detector instance keeps independent state', () => {
  const a = createReorgDetector({ alert: jest.fn() })
  const b = createReorgDetector({ alert: jest.fn() })
  a(1000)
  b(5000)
  expect(a(999).reorg).toBe(true)
  expect(b(4999).reorg).toBe(true)
})

test('recovery after a reorg rebaselines; a later regression alerts again', () => {
  const { alert, detectReorg } = setup()
  detectReorg(1000)
  detectReorg(997)
  expect(alert).toHaveBeenCalledTimes(1)
  expect(detectReorg(998).reorg).toBe(false)
  expect(alert).toHaveBeenCalledTimes(1)
  expect(detectReorg(996).reorg).toBe(true)
  expect(alert).toHaveBeenCalledTimes(2)
  expect(alert).toHaveBeenLastCalledWith(
    'critical',
    'monero reorg detected',
    'chain height regressed 998 -> 996',
    { dedupeKey: 'reorg' }
  )
})
