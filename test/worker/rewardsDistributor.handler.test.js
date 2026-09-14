/* eslint-env jest */

// Unit tests for the delayed opsSweep follow-up enqueue (2026-09-14 A′).
// Pure — fake boss, no DB, no wallet.

import { enqueueOpsSweep, OPS_SWEEP_DELAY_SECONDS } from '@/worker/rewardsDistributor'

test('enqueues a one-shot opsSweep follow-up 1h after a COMPLETE distribution', async () => {
  const send = jest.fn()
  await enqueueOpsSweep({ send }, { id: 42, status: 'COMPLETE' })
  expect(OPS_SWEEP_DELAY_SECONDS).toBe(3600)
  expect(send).toHaveBeenCalledWith(
    'opsSweep',
    { distributionId: 42 },
    { startAfter: 3600, singletonKey: 'opsSweep-42' }
  )
})

test('does not enqueue when the distribution is not COMPLETE', async () => {
  const send = jest.fn()
  await enqueueOpsSweep({ send }, { id: 42, status: 'FAILED' })
  await enqueueOpsSweep({ send }, { id: 43, status: 'SENDING' })
  expect(send).not.toHaveBeenCalled()
})

test('no-ops without a boss (manual runDistributionOnce path)', async () => {
  await expect(enqueueOpsSweep(undefined, { id: 42, status: 'COMPLETE' })).resolves.toBeUndefined()
})
