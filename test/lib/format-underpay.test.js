/* eslint-env jest */
import { underpayHint } from '@/lib/format'

describe('underpayHint', () => {
  test('null when nothing has been received yet', () => {
    expect(underpayHint(0n, 1_000_000_000n)).toBeNull()
  })

  test('null when fully covered', () => {
    expect(underpayHint(1_000_000_000n, 1_000_000_000n)).toBeNull()
  })

  test('quotes received/total in mXMR and an XMR-first dual shortfall when partially paid', () => {
    expect(underpayHint(400_000_000n, 1_000_000_000n))
      .toBe('payment detected but short — received 0.4 mXMR of 1 mXMR. Send 0.0006 XMR (0.6 mXMR) to the same address to complete it.')
  })

  test('tolerates non-BigInt inputs (field not yet fetched)', () => {
    expect(underpayHint(undefined, 1_000_000_000n)).toBeNull()
    expect(underpayHint(null, 1_000_000_000n)).toBeNull()
  })
})
