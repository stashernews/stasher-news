/* eslint-env jest */
import { underpayHint } from '@/lib/format'

describe('underpayHint', () => {
  test('null when nothing has been received yet', () => {
    expect(underpayHint(0n, 1_000_000_000n)).toBeNull()
  })

  test('null when fully covered', () => {
    expect(underpayHint(1_000_000_000n, 1_000_000_000n)).toBeNull()
  })

  test('quotes received/total and the shortfall when partially paid', () => {
    expect(underpayHint(400_000_000n, 1_000_000_000n))
      .toBe('payment detected but short — received 0.0004 XMR of 0.001 XMR. Send 0.0006 XMR to the same address to complete it.')
  })

  test('tolerates non-BigInt inputs (field not yet fetched)', () => {
    expect(underpayHint(undefined, 1_000_000_000n)).toBeNull()
    expect(underpayHint(null, 1_000_000_000n)).toBeNull()
  })
})
