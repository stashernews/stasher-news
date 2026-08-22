/* eslint-env jest */
import { evaluateDeadman, deadmanAlerts, WORKER_STALE_MS, BACKUP_STALE_MS } from '@/lib/deadman'
import handler, { __resetDeadmanThrottle } from '@/pages/api/health'
import { alert } from '@/lib/alert'

// next/jest's SWC transform rewrites `@/` in import statements but NOT in
// jest.mock()/require() specifiers (no jsconfig moduleNameMapper is emitted),
// so mocks use repo-convention relative paths that resolve to the same modules.
jest.mock('../../api/models', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn()
  }
}))
jest.mock('../../lib/alert', () => ({
  __esModule: true,
  alert: jest.fn()
}))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logger: {},
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const { default: models } = require('../../api/models')

function resStub () {
  return {
    statusCode: 0,
    body: null,
    setHeader: jest.fn(),
    status (code) { this.statusCode = code; return this },
    json (body) { this.body = body; return this }
  }
}

function completedAtRows ({ healthProbe, dbBackup }) {
  return [
    { name: 'healthProbe', lastCompletedAt: healthProbe },
    { name: 'dbBackup', lastCompletedAt: dbBackup }
  ]
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetDeadmanThrottle()
  // default: everything fresh and healthy
  models.$queryRaw.mockImplementation(async (strings, ...vals) => {
    const sql = strings.join('')
    if (sql.includes('pgboss.job')) {
      return completedAtRows({ healthProbe: new Date(), dbBackup: new Date() })
    }
    return [{ failed: 0, pending: 0, oldestPending: null }] // checkQueue shape
  })
})

describe('evaluateDeadman (pure)', () => {
  const now = new Date('2026-08-21T12:00:00Z').getTime()

  test('fresh worker and backup are not stale', () => {
    const out = evaluateDeadman({
      workerLastCompletedAt: new Date(now - 60_000),
      backupLastCompletedAt: new Date(now - 3 * 60 * 60 * 1000),
      now
    })
    expect(out).toEqual({ workerStale: false, backupStale: false })
  })

  test('worker stale after WORKER_STALE_MS, backup stale after BACKUP_STALE_MS', () => {
    const out = evaluateDeadman({
      workerLastCompletedAt: new Date(now - WORKER_STALE_MS - 1),
      backupLastCompletedAt: new Date(now - BACKUP_STALE_MS - 1),
      now
    })
    expect(out).toEqual({ workerStale: true, backupStale: true })
  })

  test('null timestamps (fresh stack, unknown) are never stale', () => {
    const out = evaluateDeadman({ workerLastCompletedAt: null, backupLastCompletedAt: null, now })
    expect(out).toEqual({ workerStale: false, backupStale: false })
  })
})

describe('deadmanAlerts (pure)', () => {
  test('stale worker fires one critical alert with a stable dedupeKey', () => {
    const doAlert = jest.fn()
    const ts = new Date('2026-08-21T11:00:00Z')
    deadmanAlerts({ workerStale: true, backupStale: false, workerLastCompletedAt: ts, backupLastCompletedAt: null, alert: doAlert })
    expect(doAlert).toHaveBeenCalledTimes(1)
    expect(doAlert).toHaveBeenCalledWith('critical', 'worker heartbeat stale',
      expect.stringContaining('2026-08-21T11:00:00.000Z'), { dedupeKey: 'worker-heartbeat-stale' })
  })

  test('silent nightly backup fires its own alert', () => {
    const doAlert = jest.fn()
    deadmanAlerts({ workerStale: false, backupStale: true, workerLastCompletedAt: new Date(), backupLastCompletedAt: new Date('2026-08-19T03:00:00Z'), alert: doAlert })
    expect(doAlert).toHaveBeenCalledWith('critical', 'nightly backup missing',
      expect.any(String), { dedupeKey: 'dbBackup-silent' })
  })

  test('healthy state alerts nothing', () => {
    const doAlert = jest.fn()
    deadmanAlerts({ workerStale: false, backupStale: false, workerLastCompletedAt: new Date(), backupLastCompletedAt: new Date(), alert: doAlert })
    expect(doAlert).not.toHaveBeenCalled()
  })
})

describe('GET /api/health deadman wiring', () => {
  test('stale worker: alerts but still returns 200/ok=true (app container must not restart)', async () => {
    const stale = new Date(Date.now() - WORKER_STALE_MS - 60_000)
    models.$queryRaw.mockImplementation(async (strings) => {
      const sql = strings.join('')
      if (sql.includes("name IN ('healthProbe', 'dbBackup')")) {
        return completedAtRows({ healthProbe: stale, dbBackup: new Date() })
      }
      return [{ failed: 0, pending: 0, oldestPending: null }]
    })

    const res = resStub()
    await handler({ method: 'GET' }, res)

    expect(alert).toHaveBeenCalledWith('critical', 'worker heartbeat stale', expect.any(String), { dedupeKey: 'worker-heartbeat-stale' })
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.deadman).toMatchObject({ workerStale: true, backupStale: false })
  })

  test('throttled: an immediate second request skips the pgboss re-scan', async () => {
    const res1 = resStub()
    const res2 = resStub()
    await handler({ method: 'GET' }, res1)
    const scansBefore = models.$queryRaw.mock.calls.filter(c => c[0].join('').includes('healthProbe')).length
    await handler({ method: 'GET' }, res2)
    const scansAfter = models.$queryRaw.mock.calls.filter(c => c[0].join('').includes('healthProbe')).length
    expect(scansAfter).toBe(scansBefore) // second call within DEADMAN_MIN_INTERVAL_MS
    expect(res1.body.deadman).not.toBeNull()
    expect(res2.body.deadman).toBeNull() // skipped, not errored
  })

  test('a deadman DB failure never breaks /api/health', async () => {
    models.$queryRaw.mockImplementation(async (strings) => {
      if (strings.join('').includes("name IN ('healthProbe', 'dbBackup')")) throw new Error('relation does not exist')
      return [{ failed: 0, pending: 0, oldestPending: null }]
    })
    const res = resStub()
    await handler({ method: 'GET' }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.deadman).toBeNull()
  })
})
