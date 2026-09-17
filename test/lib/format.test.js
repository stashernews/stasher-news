/* eslint-env jest */
import { moneroUriAmountPiconeros, moneroUriAddress, piconerosToXmr, piconerosToXmrDecimal, piconerosToMXmr, piconerosToMXmrDecimal, piconerosToMXmrDual, legacySatsSeriesToMXmr, piconerosToSats, xmrToPiconeros, signedXmrToPiconeros, snapToFilterGrid, formatDaysHours, FILTER_STEP_XMR } from '@/lib/format'

describe('piconerosToXmrDecimal re-export', () => {
  it('is re-exported from lib/format (settings + tip modal import it from here)', () => {
    expect(typeof piconerosToXmrDecimal).toBe('function')
    expect(piconerosToXmrDecimal(xmrToPiconeros('0.001'))).toBe('0.001')
  })
})

describe('piconerosToMXmr', () => {
  it('formats piconeros with an mXMR suffix', () => {
    expect(piconerosToMXmr(1_000_000_000n)).toBe('1 mXMR')
    expect(piconerosToMXmr(100_000_000n)).toBe('0.1 mXMR')
    expect(piconerosToMXmr(1_234_567_890_123n)).toBe('1234.567890123 mXMR')
    expect(piconerosToMXmr(-1_000_000_000n)).toBe('-1 mXMR')
  })

  it('caps decimals when asked (nav rewards readout)', () => {
    expect(piconerosToMXmr(4_163_900_000n, 0)).toBe('4 mXMR')
  })
})

describe('piconerosToMXmrDecimal re-export', () => {
  it('is re-exported from lib/format', () => {
    expect(piconerosToMXmrDecimal(xmrToPiconeros('0.001'))).toBe('1')
  })
})

describe('piconerosToMXmrDual', () => {
  it('renders the mXMR amount with its XMR equivalent', () => {
    expect(piconerosToMXmrDual(1_000_000_000n)).toBe('1 mXMR (0.001 XMR)')
    expect(piconerosToMXmrDual(600_000_000n)).toBe('0.6 mXMR (0.0006 XMR)')
    expect(piconerosToMXmrDual(1_200_000_000n)).toBe('1.2 mXMR (0.0012 XMR)')
  })
})

describe('legacySatsSeriesToMXmr', () => {
  it('converts growth-series values from legacy sats to numeric mXMR', () => {
    const series = [
      { time: 't1', data: [{ name: 'TIP', value: 2_500_000 }, { name: 'POSTING', value: 1_000 }] },
      { time: 't2', data: [{ name: 'TIP', value: 0 }] }
    ]
    expect(legacySatsSeriesToMXmr(series)).toEqual([
      { time: 't1', data: [{ name: 'TIP', value: 2.5 }, { name: 'POSTING', value: 0.001 }] },
      { time: 't2', data: [{ name: 'TIP', value: 0 }] }
    ])
  })

  it('passes through a missing series', () => {
    expect(legacySatsSeriesToMXmr(undefined)).toBeUndefined()
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

describe('signedXmrToPiconeros', () => {
  test('parses positive amounts', () => {
    expect(signedXmrToPiconeros('0.001')).toBe(1000000000n)
  })

  test('parses negative amounts', () => {
    expect(signedXmrToPiconeros('-0.001')).toBe(-1000000000n)
    expect(signedXmrToPiconeros(-0.01)).toBe(-10000000000n)
  })

  test('accepts exponent notation defensively', () => {
    // sub-grid values (e.g. the legacy 10n piconeros default) collapse onto the grid
    expect(signedXmrToPiconeros('1e-11')).toBe(0n)
    expect(signedXmrToPiconeros('-1e-11')).toBe(0n)
  })

  test('quantizes floating-point noise onto the filter grid', () => {
    // slider stepping (min + n*step) emits doubles like these; their shortest
    // decimal representation exceeds xmrToPiconeros' 12-decimal guard
    expect(signedXmrToPiconeros(-0.025500000000000002)).toBe(-25500000000n)
    expect(signedXmrToPiconeros(-0.024999999999999994)).toBe(-25000000000n)
    expect(signedXmrToPiconeros(0.0035000000000000005)).toBe(3500000000n)
  })

  test('converts every grid point without throwing', () => {
    for (let k = -1000; k <= 100; k++) {
      const xmr = k * FILTER_STEP_XMR
      expect(signedXmrToPiconeros(xmr)).toBe(BigInt(k) * 100000000n)
    }
  })
})

describe('snapToFilterGrid', () => {
  test('collapses sub-step values onto the 0.0001 grid', () => {
    expect(snapToFilterGrid(1e-11)).toBe(0)
    expect(snapToFilterGrid(0.001)).toBe(0.001)
    expect(snapToFilterGrid(0.0010000000001)).toBe(0.001)
    expect(snapToFilterGrid(-0.001)).toBe(-0.001)
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

describe('moneroUriAddress', () => {
  const ADDR = '5eHvZCqU7kP2fJwaDrV8mQ3gKxbEsW9nR4hLycFtXAoS5iMzdGuYBpT6jN1eHvZCqU7kP2fJwaDrV8mQ3gKxbEsW9nR4hLy'

  it('extracts the raw address from a monero: URI', () => {
    expect(moneroUriAddress(`monero:${ADDR}?tx_amount=0.001&tx_description=StasherNews+posting+fee`)).toBe(ADDR)
  })

  it('returns the address when there is no query string', () => {
    expect(moneroUriAddress(`monero:${ADDR}`)).toBe(ADDR)
  })

  it('returns null for a non-string', () => {
    expect(moneroUriAddress(undefined)).toBeNull()
    expect(moneroUriAddress(null)).toBeNull()
    expect(moneroUriAddress(123)).toBeNull()
  })

  it('returns null when the address is not base58', () => {
    expect(moneroUriAddress('monero:not-an-address?tx_amount=0.001')).toBeNull()
  })

  it('returns null when the scheme prefix is missing', () => {
    expect(moneroUriAddress(`${ADDR}?tx_amount=0.001`)).toBeNull()
  })

  it('returns the address for a 106-char integrated address', () => {
    const integrated = ADDR + 'JnUv6d9e2Af'
    expect(moneroUriAddress(`monero:${integrated}?tx_amount=0.001`)).toBe(integrated)
  })
})

describe('formatDaysHours', () => {
  const H = 60 * 60 * 1000
  const D = 24 * H

  it('formats a week-plus as days + hours', () => {
    expect(formatDaysHours(6 * D + 21 * H)).toBe('6d 21h')
    expect(formatDaysHours(D + 14 * H + 30 * 60 * 1000)).toBe('1d 14h')
    expect(formatDaysHours(7 * D)).toBe('7d 0h')
  })

  it('formats a day or less as hours only', () => {
    expect(formatDaysHours(D)).toBe('1d 0h')
    expect(formatDaysHours(4 * H + 59 * 60 * 1000)).toBe('4hr')
    expect(formatDaysHours(H)).toBe('1hr')
    expect(formatDaysHours(23 * H)).toBe('23hr')
  })

  it('shows <1h under an hour, zero, negative or garbage', () => {
    expect(formatDaysHours(59 * 60 * 1000)).toBe('<1h')
    expect(formatDaysHours(0)).toBe('<1h')
    expect(formatDaysHours(-5)).toBe('<1h')
    expect(formatDaysHours(NaN)).toBe('<1h')
  })
})

describe('piconerosToSats', () => {
  it('converts piconeros to the legacy-sat units of the fee-button accumulator (1 sat = 1000 piconeros)', () => {
    expect(piconerosToSats(0n)).toBe(0)
    expect(piconerosToSats(1_000_000_000n)).toBe(1_000_000) // 0.001 XMR -> 1e6 sats
    expect(piconerosToSats(2_000_000_000n)).toBe(2_000_000) // the bug-A upload fee (2 fee units)
  })

  it('accepts numbers as well as BigInts (GraphQL BigInt fields reach the client as numbers)', () => {
    expect(piconerosToSats(2000000000)).toBe(2000000)
  })

  it('truncates sub-sat piconeros', () => {
    expect(piconerosToSats(1_999n)).toBe(1)
  })

  it('reproduces the fee-button display end to end: a 2e9-piconero upload fee renders as 0.002 XMR, not 2 XMR', () => {
    // regression for the 1000x upload-fee display bug (2026-09-11): the upload
    // fee modifier fed raw piconeros into the sat-unit accumulator, which the
    // fee button displays after a x1000 back-conversion (legacySatsToPiconeros)
    const total = piconerosToSats(2_000_000_000n) // bug A shipped: Number(2e9) — 1000x
    expect(piconerosToXmr(BigInt(total) * 1000n)).toBe('0.002 XMR')
  })
})
