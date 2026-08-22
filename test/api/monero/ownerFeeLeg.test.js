/* eslint-env jest */
import { createOwnerFeeLeg } from '@/api/monero/ownerFeeLeg'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'

// stagenet primary (from payInItemCreate.test.js) — valid base58+checksum so
// makeIntegratedAddress can derive an integrated address from it.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

function mockModels () {
  const created = []
  return {
    created,
    subFeePidMap: {
      create: async ({ data }) => { created.push(data); return data }
    }
  }
}

function mockMonero () {
  const hooks = []
  return {
    hooks,
    addWebhook: async (args) => { hooks.push(args); return { event_id: '555' } }
  }
}

describe('createOwnerFeeLeg', () => {
  it('mints a fee: pid, builds an integrated-address URI quoting the amount, registers the webhook, and records the pid map', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const leg = await createOwnerFeeLeg(models, monero, {
      ownerAccount: { address: PRIMARY, ownerUserId: 42 },
      subName: 'turf',
      amountPiconeros: 1_500_000_000n,
      description: 'test fee'
    })

    expect(leg.paymentId).toMatch(/^[0-9a-f]{16}$/)
    // URI carries the INTEGRATED address and the full amount
    const addr = moneroUriAddress(leg.moneroUri)
    expect(addr).not.toBe(PRIMARY)
    expect(addr.length).toBeGreaterThan(PRIMARY.length)
    expect(moneroUriAmountPiconeros(leg.moneroUri)).toBe(1_500_000_000n)
    // webhook registered against the OWNER primary + pid with the 10-conf ceiling
    expect(monero.hooks[0]).toMatchObject({
      type: 'tx-confirmation', address: PRIMARY, paymentId: leg.paymentId, confirmations: 10
    })
    // pid map row denormalizes attribution + webhook id + 7d expiry
    expect(models.created[0]).toMatchObject({
      paymentId: leg.paymentId,
      subName: 'turf',
      ownerUserId: 42,
      amountPiconeros: 1_500_000_000n,
      webhookEventId: '555'
    })
    expect(models.created[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    // integrated address embeds exactly our pid
    expect(leg.integratedAddress).toBeTruthy()
  })

  it('mints distinct payment ids per leg', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const a = await createOwnerFeeLeg(models, monero, { ownerAccount: { address: PRIMARY, ownerUserId: 1 }, subName: 'a', amountPiconeros: 1n, description: 'x' })
    const b = await createOwnerFeeLeg(models, monero, { ownerAccount: { address: PRIMARY, ownerUserId: 1 }, subName: 'a', amountPiconeros: 1n, description: 'x' })
    expect(a.paymentId).not.toBe(b.paymentId)
  })
})
