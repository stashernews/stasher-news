/* eslint-env jest */
import { moneroUriAmountPiconeros, moneroUriAddress, piconerosToXmr, piconerosToXmrDecimal, xmrToPiconeros, signedXmrToPiconeros } from '@/lib/format'

describe('piconerosToXmrDecimal re-export', () => {
  it('is re-exported from lib/format (settings + tip modal import it from here)', () => {
    expect(typeof piconerosToXmrDecimal).toBe('function')
    expect(piconerosToXmrDecimal(xmrToPiconeros('0.001'))).toBe('0.001')
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
    expect(moneroUriAddress(`monero:${ADDR}?tx_amount=0.001&tx_description=StealthNews+posting+fee`)).toBe(ADDR)
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
