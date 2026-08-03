/* eslint-env jest */
import { isPostingFeeSubmit, shouldShowItemPaidAt, isPendingFeeItem, postingFeeModalPhase } from '@/lib/pay-in'

describe('isPostingFeeSubmit', () => {
  test('true when the submit result carries a monero: URI', () => {
    expect(isPostingFeeSubmit({ moneroUri: 'monero:abc?tx_amount=0.001&tx_description=StealthNews+posting+fee' })).toBe(true)
  })

  test('false when the submit result has no URI', () => {
    expect(isPostingFeeSubmit({ payerPrivates: { result: { id: 1405 } } })).toBe(false)
  })

  test('false for null/undefined results', () => {
    expect(isPostingFeeSubmit(null)).toBe(false)
    expect(isPostingFeeSubmit(undefined)).toBe(false)
  })
})

describe('shouldShowItemPaidAt', () => {
  test('true when the payIn is PAID and the posting fee is not pending', () => {
    expect(shouldShowItemPaidAt({ payIn: { payInState: 'PAID' }, feeStatus: 'FEE_PAID' })).toBe(true)
  })

  test('true for fee-exempt items (no posting fee ever required)', () => {
    expect(shouldShowItemPaidAt({ payIn: { payInState: 'PAID' }, feeStatus: 'FEE_NOT_REQUIRED' })).toBe(true)
  })

  test('false while the posting fee is still pending', () => {
    expect(shouldShowItemPaidAt({ payIn: { payInState: 'PAID' }, feeStatus: 'PENDING_FEE' })).toBe(false)
  })

  test('false when the payIn is not PAID', () => {
    expect(shouldShowItemPaidAt({ payIn: { payInState: 'PENDING' }, feeStatus: 'FEE_PAID' })).toBe(false)
  })

  test('false for undefined item', () => {
    expect(shouldShowItemPaidAt(undefined)).toBe(false)
  })
})

describe('isPendingFeeItem', () => {
  test('true only for PENDING_FEE items', () => {
    expect(isPendingFeeItem({ feeStatus: 'PENDING_FEE' })).toBe(true)
    expect(isPendingFeeItem({ feeStatus: 'FEE_PAID' })).toBe(false)
    expect(isPendingFeeItem({ feeStatus: 'FEE_NOT_REQUIRED' })).toBe(false)
    expect(isPendingFeeItem(undefined)).toBe(false)
    expect(isPendingFeeItem({})).toBe(false)
  })
})

describe('postingFeeModalPhase', () => {
  test('paid only when FEE_PAID', () => {
    expect(postingFeeModalPhase('FEE_PAID')).toBe('paid')
    expect(postingFeeModalPhase('PENDING_FEE')).toBe('waiting')
    expect(postingFeeModalPhase('FEE_NOT_REQUIRED')).toBe('waiting')
    expect(postingFeeModalPhase(undefined)).toBe('waiting')
  })
})
