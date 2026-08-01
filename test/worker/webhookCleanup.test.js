/* eslint-env jest */
import { runWebhookCleanupOnce } from '@/worker/webhookCleanup'

function modelsWith (tips) {
  const updated = []
  return {
    _updated: updated,
    models: {
      observedTip: {
        findMany: async () => tips.slice(),
        update: async ({ where, data }) => { updated.push({ id: where.id, ...data }); return {} }
      }
    }
  }
}

test('deletes + nulls webhookEventId for CONFIRMED and EXPIRED tips', async () => {
  const deleted = []
  const monero = { deleteWebhook: async (id) => { deleted.push(id); return {} } }
  const { _updated, models } = modelsWith([
    { id: 1n, webhookEventId: 'evt-1', state: 'CONFIRMED' },
    { id: 2n, webhookEventId: 'evt-2', state: 'EXPIRED' }
  ])
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(out.cleaned).toBe(2)
  expect(deleted).toEqual(['evt-1', 'evt-2'])
  expect(_updated.every(u => u.webhookEventId === null)).toBe(true)
})

test('does NOT touch DETECTED tips (their webhook is still legitimately receiving conf callbacks) or already-null rows', async () => {
  const monero = { deleteWebhook: async () => { throw new Error('should not be called') } }
  const { models } = modelsWith([
    { id: 3n, webhookEventId: 'evt-3', state: 'DETECTED' },
    { id: 4n, webhookEventId: null, state: 'CONFIRMED' }
  ])
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(out.cleaned).toBe(0)
})

test('a deleteWebhook failure is logged + the row is still nullled (best-effort, won’t retry forever)', async () => {
  const monero = { deleteWebhook: async () => { throw new Error('lws 500') } }
  const { _updated, models } = modelsWith([{ id: 5n, webhookEventId: 'evt-5', state: 'CONFIRMED' }])
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(out.cleaned).toBe(1)
  expect(_updated[0].webhookEventId).toBe(null)
})
