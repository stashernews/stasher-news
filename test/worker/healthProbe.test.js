/* eslint-env jest */
import { runHealthProbeOnce, __resetStallState } from '@/worker/healthProbe'

// The probe checks the two services independently: lws via the admin
// /list_accounts endpoint and monerod directly via JSON-RPC get_info.
function lwsUp () {
  return { listAccounts: async () => ({ active: [], inactive: [] }) }
}

function lwsDown () {
  return { listAccounts: async () => { throw new Error('lws network error sim') } }
}

function monerodUp (height) {
  return { getHeight: async () => height }
}

function monerodDown () {
  return { getHeight: async () => { throw new Error('monerod connection refused sim') } }
}

function alertCalls (mock, title) {
  return mock.mock.calls.filter(c => c[1] === title)
}

function opts (extras) {
  return { alert: jest.fn(), setStatus: jest.fn(), ...extras }
}

beforeEach(() => {
  __resetStallState()
})

test('healthy probe publishes status and fires no alert', async () => {
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(1000), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: true, monerodOk: true, height: 1000, stalled: false })
  expect(o.setStatus).toHaveBeenCalledWith({
    lws: true,
    monerod: true,
    height: 1000,
    stalled: false,
    updatedAt: new Date(0).toISOString()
  })
  expect(o.alert).not.toHaveBeenCalled()
})

test('monerod down (get_info probe throws) triggers debounced critical alert, lws not faulted', async () => {
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodDown(), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: true, monerodOk: false, height: 0, stalled: false })
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod down')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'monerod down')[0][3]).toEqual({ dedupeKey: 'monerod-down' })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(0)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: true, monerod: false })
})

test('lws down (list_accounts throws) triggers critical alert, monerod probed independently', async () => {
  const o = opts({ lwsClient: lwsDown(), daemonClient: monerodUp(500), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: false, monerodOk: true, height: 500, stalled: false })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'lws down')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'lws down')[0][3]).toEqual({ dedupeKey: 'lws-down' })
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(0)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: false, monerod: true })
})

test('both services down fires both critical alerts independently', async () => {
  const o = opts({ lwsClient: lwsDown(), daemonClient: monerodDown(), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: false, monerodOk: false, height: 0, stalled: false })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(1)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: false, monerod: false })
})

test('height stall: unchanged height past MONEROD_STALL_THRESHOLD_MS triggers stall alert', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
  const res = await runHealthProbeOnce({ ...o, now: () => threshold + 1 })
  expect(res.stalled).toBe(true)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod stalled')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'monerod stalled')[0][3]).toEqual({ dedupeKey: 'monerod-stall' })
  expect(o.setStatus.mock.calls[1][0]).toMatchObject({ stalled: true, monerod: false, height: 5000 })
})

test('height advancement resets the stall window (no stall alert)', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  const res = await runHealthProbeOnce({ ...o, daemonClient: monerodUp(5001), now: () => threshold + 1 })
  expect(res.stalled).toBe(false)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
})

test('monerod outage rebaselines the stall window so recovery is not misread as a stall', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  await runHealthProbeOnce({ ...o, daemonClient: monerodDown(), now: () => threshold })
  const res = await runHealthProbeOnce({ ...o, daemonClient: monerodUp(5000), now: () => threshold * 2 + 1 })
  expect(res.stalled).toBe(false)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
})
