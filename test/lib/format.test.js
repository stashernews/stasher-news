/* eslint-env jest */
import { xmrFromSats, piconerosToXmr } from '@/lib/format'

describe('xmrFromSats (rebrand bridge)', () => {
  it('renders sats (floor of piconeros/1000) as XMR decimal', () => {
    expect(xmrFromSats(1_000_000)).toBe('0.001 XMR') // 1e6 sats == 1e9 piconeros == 0.001 XMR
  })
  it('handles string/bigint like number', () => {
    expect(xmrFromSats('1000000')).toBe('0.001 XMR')
    expect(xmrFromSats(1000000n)).toBe('0.001 XMR')
  })
  it('is no less precise than the legacy sats field', () => {
    expect(xmrFromSats(1)).toBe(piconerosToXmr(1000n))
  })
})
