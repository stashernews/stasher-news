/* eslint-env jest */
import { runWebhookCleanupOnce } from '@/worker/webhookCleanup'

function modelsWith (tips, dvMaps = [], confirmedDv = []) {
  const updated = []
  const dvUpdated = []
  return {
    _updated: updated,
    _dvUpdated: dvUpdated,
    models: {
      observedTip: {
        findMany: async () => tips.slice(),
        update: async ({ where, data }) => { updated.push({ id: where.id, ...data }); return {} }
      },
      downvotePidMap: {
        findMany: async () => dvMaps.slice(),
        update: async ({ where, data }) => { dvUpdated.push({ paymentId: where.paymentId, ...data }); return {} }
      },
      // Mirror the real query: CONFIRMED observations for the candidate maps'
      // payment ids only (the sweep scopes the WHERE to candidates).
      observedDownvote: {
        findMany: async ({ where }) => confirmedDv.filter(o => where.paymentId.in.includes(o.paymentId))
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

// ---- downvote pid-map webhook sweep ----

test('downvote: expired map with no observation is swept (never-paid downvote leak)', async () => {
  const deleted = []
  const monero = { deleteWebhook: async (id) => { deleted.push(id); return {} } }
  const { _dvUpdated, models } = modelsWith(
    [],
    [{ paymentId: 'dv1', webhookEventId: 'evt-dv1', expiresAt: new Date(Date.now() - 3600e3), consumedAt: null }]
  )
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(deleted).toEqual(['evt-dv1'])
  expect(_dvUpdated).toEqual([{ paymentId: 'dv1', webhookEventId: null }])
  expect(out.cleaned).toBe(1)
})

test('downvote: unexpired map with a CONFIRMED observation is swept (missed/failed delete at confirm)', async () => {
  const deleted = []
  const monero = { deleteWebhook: async (id) => { deleted.push(id); return {} } }
  const { _dvUpdated, models } = modelsWith(
    [],
    [{ paymentId: 'dv2', webhookEventId: 'evt-dv2', expiresAt: new Date(Date.now() + 3600e3), consumedAt: new Date() }],
    [{ paymentId: 'dv2' }]
  )
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(deleted).toEqual(['evt-dv2'])
  expect(_dvUpdated).toEqual([{ paymentId: 'dv2', webhookEventId: null }])
  expect(out.cleaned).toBe(1)
})

test('downvote: unexpired map with only a DETECTED observation is NOT swept (live pending downvote)', async () => {
  const monero = { deleteWebhook: async () => { throw new Error('should not be called') } }
  const { _dvUpdated, models } = modelsWith(
    [],
    [{ paymentId: 'dv3', webhookEventId: 'evt-dv3', expiresAt: new Date(Date.now() + 3600e3), consumedAt: new Date() }],
    [{ paymentId: 'dvX' }]
  )
  const out = await runWebhookCleanupOnce({ models, monero })
  expect(out.cleaned).toBe(0)
  expect(_dvUpdated).toEqual([])
})

test('downvote: deleteWebhook failure warns and KEEPS the id (retried next hourly run)', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const monero = { deleteWebhook: async () => { throw new Error('lws 503') } }
    const { _dvUpdated, models } = modelsWith(
      [],
      [{ paymentId: 'dv4', webhookEventId: 'evt-dv4', expiresAt: new Date(Date.now() - 3600e3), consumedAt: null }]
    )
    const out = await runWebhookCleanupOnce({ models, monero })
    expect(out.cleaned).toBe(0)
    expect(_dvUpdated).toEqual([])
    expect(warn).toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
