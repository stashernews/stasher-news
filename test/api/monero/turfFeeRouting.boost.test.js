/* eslint-env jest */

// BOOST owner-direct fee routing (Task 8, turf-owner-revenue):
// mock-based unit tests of getInitial's routing decision — a boost on an item
// in exactly ONE turf whose owner has a registered wallet routes 100%
// owner-direct via a fee: payment-ID leg (TURF_OWNER_FEES gate on);
// cross-posts, non-turf items, walletless owners, and gate-off keep the
// platform rewards-wallet major-5 subaddress flow. Min-tip floor is unchanged.
//
// The jest.mock preamble mirrors test/api/monero/turfFeeRouting.itemCreate.test.js
// (which mirrors test/engine/payInItemCreate.test.js:37-68). Relative paths are
// required in jest.mock because next/jest registers no `@/*` moduleNameMapper —
// the task brief's '../../api/monero/...' depth was off by one for this
// spec's location (test/api/monero/) and is corrected to '../../../'. The
// feePool stub's address must be a VALID 95-char base58 primary (not the
// brief's 'BOOSTSUB' placeholder): the fallback branches build a monero: URI
// and buildMoneroUri validates the charset (api/monero/uri.js MONERO_ADDR_RE).
// babel-jest hoists these jest.mock calls above the ES imports below, so the
// stubs register before boost.js is evaluated.

import { getInitial } from '@/api/payIn/types/boost'
import { reserveFeeSubaddress } from '@/api/monero/feePool'

jest.mock('../../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 1 })) }
}))
jest.mock('../../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(async () => ({
    id: 1,
    major: 5,
    minor: 1,
    address: '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  }))
}))

// stagenet primary (payInItemCreate.test.js / ownerFeeLeg.test.js): valid
// base58+checksum, so makeIntegratedAddress can derive an integrated address.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const config = { minTipPiconeros: 100_000_000n }

function models ({ subNames = ['turf'], ownerHasWallet = true } = {}) {
  return {
    platformFeeConfig: { findUnique: async () => config },
    item: { findUnique: async () => ({ id: 1, subNames }) },
    sub: { findUnique: async () => ({ name: 'turf', userId: 42 }) },
    moneroAccount: { findFirst: async () => ownerHasWallet ? { id: 9, ownerUserId: 42, address: PRIMARY } : null },
    subFeePidMap: { create: async () => ({}) }
  }
}

const me = { id: 7 }
beforeEach(() => { process.env.TURF_OWNER_FEES = '1'; jest.clearAllMocks() })
afterEach(() => { delete process.env.TURF_OWNER_FEES })

describe('BOOST getInitial routing', () => {
  it('routes owner-direct for a single-turf item with a walleted owner', async () => {
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(r.moneroSubaddressMajor).toBeUndefined()
    expect(reserveFeeSubaddress).not.toHaveBeenCalled()
  })
  it('falls back to major-5 for cross-posted items', async () => {
    const r = await getInitial(models({ subNames: ['a', 'b'] }), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('falls back for non-turf items (subNames empty)', async () => {
    const r = await getInitial(models({ subNames: [] }), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('falls back when the owner has no wallet', async () => {
    const r = await getInitial(models({ ownerHasWallet: false }), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
  })
  it('falls back when the booster IS the turf owner (self-boost sybil)', async () => {
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me: { id: 42 } })
    expect(r.moneroPaymentId).toBeUndefined()
    expect(r.moneroSubaddressMajor).toBe(5)
    expect(reserveFeeSubaddress).toHaveBeenCalled()
  })
  it('keeps platform routing with the gate off', async () => {
    delete process.env.TURF_OWNER_FEES
    const r = await getInitial(models(), { id: '1', piconeros: '500000000' }, { me })
    expect(r.moneroSubaddressMajor).toBe(5)
  })
})
