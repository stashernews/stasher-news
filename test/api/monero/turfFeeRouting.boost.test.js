/* eslint-env jest */

// BOOST fee routing (Task 8 turf-owner-revenue; revised for R08 2026-09-21):
// a boost ALWAYS routes to the platform rewards wallet via a DEDICATED major-5
// fee subaddress — never owner-direct, even for a single-turf item with a
// walleted owner. The owner-direct leg was removed because an item author
// could boost their own post in a colluding owner's turf, paying the owner
// (minus tx fees) and receiving the money back privately while buying ranking
// weight (boost feeds ranking 1:1) at network-fee cost. In-flight owner-leg
// boosts created before the change are still applied by
// api/monero/subFeeObservation.js.
//
// The jest.mock preamble mirrors test/api/monero/turfFeeRouting.itemCreate.test.js.
// Relative paths are required in jest.mock because next/jest registers no `@/*`
// moduleNameMapper for jest.mock specifiers. The fixture deliberately keeps a
// walleted owner and the old-route machinery (moneroAccount/subFeePidMap/
// lwsClient stubs) so the platform-routing assertions below would fail if
// owner-direct boost routing were reintroduced.

import { getInitial } from '@/api/payIn/types/boost'
import { reserveFeeSubaddress } from '@/api/monero/feePool'

jest.mock('../../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(async () => ({
    id: 1,
    major: 5,
    minor: 1,
    address: '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  }))
}))

// lwsClient stub so a regression to owner-direct boost routing would fail on
// the assertions below rather than a real webhook call.
jest.mock('../../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 1 })) }
}))

// stagenet primary (turfFeeRouting tests): valid base58+checksum, so the old
// owner-direct route's makeIntegratedAddress would derive an address.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const config = { minTipPiconeros: 100_000_000n }

function models ({ subNames = ['turf'], ownerHasWallet = true, parentId = null, rootSubs = null } = {}) {
  return {
    platformFeeConfig: { findUnique: async () => config },
    item: { findUnique: async () => ({ id: 1, subNames, parentId }) },
    // old-route machinery: kept so a reintroduced owner-direct branch would
    // resolve the route (ownerHasWallet defaults true) and fail the platform
    // assertions — the tests must be able to catch that regression.
    $queryRaw: async () => rootSubs ?? [],
    sub: { findUnique: async () => ({ name: 'turf', userId: 42 }) },
    moneroAccount: {
      findFirst: async () => ownerHasWallet
        ? { id: 9, ownerUserId: 42, address: PRIMARY }
        : null
    },
    subFeePidMap: { create: async () => ({}) }
  }
}

const me = { id: 7 }
beforeEach(() => { process.env.TURF_OWNER_FEES = '1'; jest.clearAllMocks() })
afterEach(() => { delete process.env.TURF_OWNER_FEES })

describe('BOOST getInitial routing (platform-only after R08)', () => {
  it('routes a single-turf item with a walleted owner to the platform major-5 subaddress', async () => {
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
    expect(r.moneroUri).toMatch(/^monero:/)
    expect(reserveFeeSubaddress).toHaveBeenCalledWith(expect.anything(), 'BOOST', { me })
  })
  it('routes a COMMENT boost in a single-turf root to the platform major-5 subaddress', async () => {
    const r = await getInitial(
      models({ subNames: null, parentId: 42, rootSubs: [{ name: 'turf', userId: 42 }] }),
      { id: '1', piconeros: '2000000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('routes cross-posted items to the platform', async () => {
    const r = await getInitial(models({ subNames: ['a', 'b'] }), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('routes non-turf items (subNames empty) to the platform', async () => {
    const r = await getInitial(models({ subNames: [] }), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('routes owner self-boosts to the platform', async () => {
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me: { id: 42 } })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
    expect(reserveFeeSubaddress).toHaveBeenCalled()
  })
  it('keeps platform routing with the gate off', async () => {
    delete process.env.TURF_OWNER_FEES
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('still enforces the min-tip floor', async () => {
    await expect(getInitial(models(), { id: '1', piconeros: '99999999' }, { me }))
      .rejects.toThrow(/below minimum/)
  })
})
