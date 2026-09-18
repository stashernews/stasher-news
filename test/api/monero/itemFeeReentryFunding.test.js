/* eslint-env jest */
import { itemFeeReentryFunding } from '@/api/monero/postingFee'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'

const ADDR = '5' + 'F'.repeat(94)
const FEE_URI = (xmr) => `monero:${ADDR}?tx_amount=${xmr}`

const PAY_IN = {
  id: 1,
  payInType: 'ITEM_CREATE',
  moneroUri: FEE_URI('0.001'),
  moneroSubaddressMajor: 2,
  moneroSubaddressMinor: 7
}

const models = (receivedPiconeros) => ({
  payIn: { findUnique: async () => PAY_IN },
  feeObservation: {
    aggregate: async () => ({ _sum: { piconeros: receivedPiconeros } })
  },
  observedSubFee: {
    aggregate: async () => ({ _sum: { piconeros: 0n } })
  }
})

describe('itemFeeReentryFunding', () => {
  test('quotes only the REMAINDER after a partial payment', async () => {
    const res = await itemFeeReentryFunding(models(400_000_000n), { feeStatus: 'PENDING_FEE', feePayInId: 1, parentId: null })
    expect(moneroUriAddress(res.moneroUri)).toBe(ADDR)
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(600_000_000n) // 1.0 - 0.4 remainder
    expect(res.receivedPiconeros).toBe(400_000_000n)
    expect(res.expectedPiconeros).toBe(1_000_000_000n)
  })

  test('owner leg: underpayment counts ObservedSubFee receipts, remainder re-quoted not full', async () => {
    // item 18658 shape: expected 0.003, 0.001 received via the fee: webhook
    const m = {
      payIn: { findUnique: async () => ({ ...PAY_IN, moneroUri: FEE_URI('0.003') }) },
      feeObservation: { aggregate: async () => ({ _sum: { piconeros: null } }) },
      observedSubFee: { aggregate: async () => ({ _sum: { piconeros: 1_000_000_000n } }) }
    }
    const res = await itemFeeReentryFunding(m, { feeStatus: 'PENDING_FEE', feePayInId: 1, parentId: null })
    expect(res.receivedPiconeros).toBe(1_000_000_000n)
    expect(res.expectedPiconeros).toBe(3_000_000_000n)
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(2_000_000_000n)
  })

  test('nothing received -> full fee', async () => {
    const res = await itemFeeReentryFunding(models(0n), { feeStatus: 'PENDING_FEE', feePayInId: 1, parentId: null })
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(1_000_000_000n)
  })

  test('fully covered -> full fee (clamped, hint would be null)', async () => {
    const res = await itemFeeReentryFunding(models(1_000_000_000n), { feeStatus: 'PENDING_FEE', feePayInId: 1, parentId: null })
    expect(moneroUriAmountPiconeros(res.moneroUri)).toBe(1_000_000_000n)
  })

  test('null when the item is not PENDING_FEE', async () => {
    expect(await itemFeeReentryFunding(models(0n), { feeStatus: 'FEE_PAID', feePayInId: 1, parentId: null })).toBeNull()
  })

  test('null when there is no fee PayIn', async () => {
    expect(await itemFeeReentryFunding(models(0n), { feeStatus: 'PENDING_FEE', feePayInId: null, parentId: null })).toBeNull()
  })

  test('null when the stored URI has no address', async () => {
    const m = {
      payIn: { findUnique: async () => ({ ...PAY_IN, moneroUri: null }) },
      feeObservation: { aggregate: async () => ({ _sum: { piconeros: 0n } }) }
    }
    expect(await itemFeeReentryFunding(m, { feeStatus: 'PENDING_FEE', feePayInId: 1, parentId: null })).toBeNull()
  })
})
