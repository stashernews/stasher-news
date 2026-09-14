/* eslint-env jest */

// Handler tests for the delayed opsSweep job (2026-09-14 A′ decoupling).
// Prisma + sweepOpsEarmark stubbed — no wallet/DB. Contract under test:
// user-funds-first guards, the stale-id guard (rollover double-count), the
// pg-boss job.data payload nesting, and the FAILED alert.

import { opsSweep, runOpsSweepOnce } from '@/worker/opsSweep'
import { alert } from '../../lib/alert'

jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))

const SETTLED = {
  id: 42,
  status: 'COMPLETE',
  opsAvailablePiconeros: 2_000_000_000n,
  opsSweptPiconeros: 0n,
  opsSweepState: 'NOT_SWEEPED',
  payouts: [{ state: 'SENT' }]
}

function makeModels (distribution) {
  return { rewardDistribution: { async findFirst () { return distribution } } }
}

beforeEach(() => { jest.clearAllMocks() })

test('no distribution: no-op, sweep not called', async () => {
  const sweep = jest.fn()
  const res = await runOpsSweepOnce({ models: makeModels(null), sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'NO_DISTRIBUTION' })
  expect(sweep).not.toHaveBeenCalled()
})

test('stale follow-up (a newer distribution exists) skips — the earmark has rolled forward', async () => {
  const sweep = jest.fn()
  const res = await runOpsSweepOnce({ models: makeModels(SETTLED), distributionId: 41, sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'STALE_DISTRIBUTION' })
  expect(sweep).not.toHaveBeenCalled()
})

test('skips while the latest distribution is SENDING (signer in flight)', async () => {
  const sweep = jest.fn()
  const res = await runOpsSweepOnce({ models: makeModels({ ...SETTLED, status: 'SENDING' }), sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'SKIPPED_IN_FLIGHT' })
  expect(sweep).not.toHaveBeenCalled()
})

test('skips while any payout is QUEUED (user funds first)', async () => {
  const sweep = jest.fn()
  const res = await runOpsSweepOnce({
    models: makeModels({ ...SETTLED, payouts: [{ state: 'SENT' }, { state: 'QUEUED' }] }),
    sweepOpsEarmark: sweep
  })
  expect(res).toEqual({ state: 'SKIPPED_PAYOUTS_PENDING' })
  expect(sweep).not.toHaveBeenCalled()
})

test('skips while any payout is FAILED (not settled)', async () => {
  const sweep = jest.fn()
  const res = await runOpsSweepOnce({
    models: makeModels({ ...SETTLED, payouts: [{ state: 'SENT' }, { state: 'FAILED' }] }),
    sweepOpsEarmark: sweep
  })
  expect(res).toEqual({ state: 'SKIPPED_PAYOUTS_PENDING' })
  expect(sweep).not.toHaveBeenCalled()
})

test('sweeps the latest settled distribution and returns the sweep result', async () => {
  const sweep = jest.fn().mockResolvedValue({ state: 'SWEPT', txHash: 'cd'.repeat(32), swept: 2_000_000_000n })
  const models = makeModels(SETTLED)
  const res = await runOpsSweepOnce({ models, distributionId: 42, sweepOpsEarmark: sweep })
  expect(sweep).toHaveBeenCalledWith({ distribution: SETTLED, models })
  expect(res).toEqual({ state: 'SWEPT', txHash: 'cd'.repeat(32), swept: 2_000_000_000n })
  expect(alert).not.toHaveBeenCalled()
})

test('a deferred sweep (SKIPPED_LOCKED) does not alert', async () => {
  const sweep = jest.fn().mockResolvedValue({ state: 'SKIPPED_LOCKED' })
  const res = await runOpsSweepOnce({ models: makeModels(SETTLED), sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(alert).not.toHaveBeenCalled()
})

test('a FAILED sweep alerts critical (deduped); the weekly rollover retries', async () => {
  const sweep = jest.fn().mockResolvedValue({ state: 'FAILED' })
  const res = await runOpsSweepOnce({ models: makeModels(SETTLED), sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'FAILED' })
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'rewards ops sweep failed',
    expect.stringContaining('distribution 42'),
    { dedupeKey: 'dist-42-sweep-failed' }
  )
})

test('accepts a CONFIRMED payout as settled (future-proofs PayoutState.CONFIRMED)', async () => {
  const sweep = jest.fn().mockResolvedValue({ state: 'SWEPT' })
  const res = await runOpsSweepOnce({
    models: makeModels({ ...SETTLED, payouts: [{ state: 'CONFIRMED' }] }),
    sweepOpsEarmark: sweep
  })
  expect(res).toEqual({ state: 'SWEPT' })
  expect(sweep).toHaveBeenCalled()
})

test('handler reads distributionId from job.data (pg-boss v9 nesting) — stale follow-up skips', async () => {
  // Regression lock for the review finding: jobWrapper spreads the raw job, so
  // a handler declared as ({ distributionId }) would get undefined and a stale
  // follow-up would silently sweep the latest row instead of skipping.
  const sweep = jest.fn()
  const res = await opsSweep({ data: { distributionId: 41 }, models: makeModels(SETTLED), sweepOpsEarmark: sweep })
  expect(res).toEqual({ state: 'STALE_DISTRIBUTION' })
  expect(sweep).not.toHaveBeenCalled()
})

test('handler passes a matching data.distributionId through to the sweep', async () => {
  const sweep = jest.fn().mockResolvedValue({ state: 'SWEPT' })
  const models = makeModels(SETTLED)
  await opsSweep({ data: { distributionId: 42 }, models, sweepOpsEarmark: sweep })
  expect(sweep).toHaveBeenCalledWith({ distribution: SETTLED, models })
})
