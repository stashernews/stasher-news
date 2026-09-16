/* eslint-env jest */
import { isPostingFeeSubmit, shouldShowItemPaidAt, isPendingFeeItem, postingFeeModalPhase, shouldTriggerPaymentSuccess } from '@/lib/pay-in'
import { underpayHint, moneroUriAmountPiconeros } from '@/lib/format'

describe('isPostingFeeSubmit', () => {
  test('true when the submit result carries a monero: URI', () => {
    expect(isPostingFeeSubmit({ moneroUri: 'monero:abc?tx_amount=0.001&tx_description=StasherNews+posting+fee' })).toBe(true)
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
    expect(isPendingFeeItem(null)).toBe(false)
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

describe('shouldTriggerPaymentSuccess', () => {
  test('true on DETECTED (0-conf detection)', () => {
    expect(shouldTriggerPaymentSuccess('DETECTED')).toBe(true)
  })

  test('true on CONFIRMED — a confirmed tip/downvote must still trigger success (not a silent terminal)', () => {
    expect(shouldTriggerPaymentSuccess('CONFIRMED')).toBe(true)
  })

  test('false for the states that must keep the modal waiting', () => {
    expect(shouldTriggerPaymentSuccess('PENDING')).toBe(false)
    expect(shouldTriggerPaymentSuccess(null)).toBe(false)
    expect(shouldTriggerPaymentSuccess(undefined)).toBe(false)
  })

  test('false for failure terminals', () => {
    expect(shouldTriggerPaymentSuccess('REORGED')).toBe(false)
    expect(shouldTriggerPaymentSuccess('EXPIRED')).toBe(false)
  })
})

describe('underpayHint', () => {
  const URI = 'monero:5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J?tx_amount=0.001'

  test('moneroUriAmountPiconeros parses the quoted amount', () => {
    expect(moneroUriAmountPiconeros(URI)).toBe(1_000_000_000n)
    expect(moneroUriAmountPiconeros(null)).toBe(null)
  })

  test('returns null when nothing has been received', () => {
    expect(underpayHint(0n, 1_000_000_000n)).toBe(null)
  })

  test('returns null when fully covered', () => {
    expect(underpayHint(1_000_000_000n, 1_000_000_000n)).toBe(null)
    expect(underpayHint(1_500_000_000n, 1_000_000_000n)).toBe(null)
  })

  test('quotes received / expected / remaining when short', () => {
    const hint = underpayHint(400_000_000n, 1_000_000_000n)
    expect(hint).toContain('received 0.4 mXMR of 1 mXMR')
    expect(hint).toContain('Send 0.0006 XMR (0.6 mXMR)')
  })
})
