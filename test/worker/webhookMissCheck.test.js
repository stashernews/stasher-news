/* eslint-env jest */
import { runWebhookMissCheckOnce } from '@/worker/webhookMissCheck'
import { alert } from '@/lib/alert'

// lib/alert is mocked so operator pages are assertable without a network side
// effect (reverseStaleDetections.test.js pattern).
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

beforeEach(() => { jest.clearAllMocks() })

const DATA = { paymentId: 'miss1', piconeros: '1000', context: 'tip 42 detection' }

const modelsWith = (tip) => ({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) } })

test('a tip still PENDING 30 min after the webhook fires exactly one warn', async () => {
  const models = modelsWith({ id: 42n, state: 'PENDING' })
  const out = await runWebhookMissCheckOnce({ models, data: DATA })
  expect(out).toEqual({ state: 'PENDING', alerted: true })
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'warn',
    'tip payment never landed after webhook',
    expect.stringContaining('paymentId miss1'),
    { dedupeKey: 'webhook-miss-miss1' }
  )
  expect(models.observedTip.findFirst).toHaveBeenCalledWith({
    where: { paymentId: 'miss1' },
    select: { id: true, state: true }
  })
})

test.each(['DETECTED', 'CONFIRMED', 'EXPIRED', 'EXCLUDED', 'REORGED'])('%s never alerts (the payment landed, was excluded, or the intent expired)', async (state) => {
  const out = await runWebhookMissCheckOnce({ models: modelsWith({ id: 42n, state }), data: DATA })
  expect(out).toEqual({ state, alerted: false })
  expect(alert).not.toHaveBeenCalled()
})

test('no ObservedTip row (non-tip payment id) never alerts', async () => {
  const out = await runWebhookMissCheckOnce({ models: modelsWith(null), data: DATA })
  expect(out).toEqual({ state: 'missing', alerted: false })
  expect(alert).not.toHaveBeenCalled()
})

test.each([{}, undefined])('malformed job data (%p) short-circuits before any query and never alerts', async (data) => {
  const models = modelsWith({ id: 42n, state: 'PENDING' })
  const out = await runWebhookMissCheckOnce({ models, data })
  expect(out).toEqual({ state: 'missing', alerted: false })
  expect(alert).not.toHaveBeenCalled()
  expect(models.observedTip.findFirst).not.toHaveBeenCalled()
})
