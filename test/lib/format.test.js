/* eslint-env jest */
import { moneroUriAmountPiconeros, xmrFromSats, piconerosToXmr, xmrToPiconeros } from '@/lib/format'

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

describe('xmrToPiconeros', () => {
  it('converts a whole-XMR string to piconeros', () => {
    expect(xmrToPiconeros('1')).toBe(1_000_000_000_000n)
    expect(xmrToPiconeros('2')).toBe(2_000_000_000_000n)
  })

  it('converts a decimal-XMR string to piconeros', () => {
    expect(xmrToPiconeros('0.001')).toBe(1_000_000_000n) // 1e9 piconeros
    expect(xmrToPiconeros('0.025')).toBe(25_000_000_000n) // 2.5e10 piconeros
    expect(xmrToPiconeros('0.0001')).toBe(100_000_000n) // 1e8 piconeros (min tip)
  })

  it('round-trips through piconerosToXmrDecimal', () => {
    for (const xmr of ['0.001', '0.01', '0.025', '1', '0.0001']) {
      const pico = xmrToPiconeros(xmr)
      // piconerosToXmrDecimal is in api/monero/uri.js; re-imported here for the round-trip
      // (lib/format re-exports piconerosToXmr which appends ' XMR', so compare with ' XMR' appended)
      expect(piconerosToXmr(pico)).toBe(xmr + ' XMR')
    }
  })

  it('accepts numbers as well as strings', () => {
    expect(xmrToPiconeros(0.001)).toBe(1_000_000_000n)
  })

  it('rejects more than 12 decimal places', () => {
    expect(() => xmrToPiconeros('0.0000000000001')).toThrow()
  })

  it('rejects negatives and non-numeric input', () => {
    expect(() => xmrToPiconeros('-1')).toThrow()
    expect(() => xmrToPiconeros('abc')).toThrow()
    expect(() => xmrToPiconeros('')).toThrow()
    expect(() => xmrToPiconeros(null)).toThrow()
  })
})

describe('moneroUriAmountPiconeros', () => {
  it('parses a valid decimal tx_amount to piconeros', () => {
    expect(moneroUriAmountPiconeros('monero:addr?tx_amount=0.001&description=x')).toBe(1_000_000_000n)
  })

  it('returns null when tx_amount is absent', () => {
    expect(moneroUriAmountPiconeros('monero:addr?description=x')).toBeNull()
    expect(moneroUriAmountPiconeros('monero:addr')).toBeNull()
  })

  it('returns null when tx_amount is malformed', () => {
    expect(moneroUriAmountPiconeros('monero:addr?tx_amount=abc')).toBeNull()
    expect(moneroUriAmountPiconeros('monero:addr?tx_amount=-1')).toBeNull()
    expect(moneroUriAmountPiconeros('monero:addr?tx_amount=')).toBeNull()
  })

  it('parses tx_amount with no other params', () => {
    expect(moneroUriAmountPiconeros('monero:addr?tx_amount=0.001')).toBe(1_000_000_000n)
  })
})
