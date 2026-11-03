/* eslint-env jest */
import { parseXmr, formatXmr, parseFloatField, parseIntField, parseIdList, parseFieldValue, formatFieldValue } from '@/lib/admin/units'

test.each([
  ['0', 0n], ['0.000000000001', 1n], ['0.00001', 10000000n],
  ['0.0001', 100000000n], ['0.001', 1000000000n], ['0.1', 100000000000n],
  ['1', 1000000000000n], ['10', 10000000000000n], ['100', 100000000000000n],
  ['1000', 1000000000000000n], ['-1', -1000000000000n]
])('XMR %s parses exactly and round trips', (text, piconeros) => {
  expect(parseXmr(text, { allowNegative: true })).toBe(piconeros)
  expect(formatXmr(piconeros)).toBe(text)
})

test.each(['1e-3', '0.0000000000001', '-0.1', ' 1', '1 ', '1junk', '+1', '.1', '1.', '', 'Infinity', 'NaN'])('XMR rejects malformed or forbidden %s', value => {
  expect(() => parseXmr(value)).toThrow()
})

test('money conversion does not lose digits above the Number precision boundary', () => {
  expect(parseXmr('9007199254740993.123456789012')).toBe(9007199254740993123456789012n)
  expect(formatXmr(1000100000000n)).toBe('1.0001')
})

test('integer, decimal and ID-list fields reject junk, excess precision and unsafe integers', () => {
  expect(parseFloatField('0.000001')).toBe(0.000001)
  expect(parseIntField('1000000000000', { bigint: true })).toBe(1000000000000n)
  expect(parseIdList('1, 2,3')).toEqual([1, 2, 3])
  expect(parseIdList('')).toEqual([])
  for (const value of ['1e2', '0.0000001', 'NaN', ' 1', '1.']) expect(() => parseFloatField(value)).toThrow()
  for (const value of ['1.1', '1e2', '9007199254740992', ' 1']) expect(() => parseIntField(value)).toThrow()
  for (const value of ['0', '-1', '1,1', '1,,2', '1,x', Array.from({ length: 101 }, (_, i) => i + 1).join(',')]) expect(() => parseIdList(value)).toThrow()
})

test('registry type codecs keep nullable switches, enums and integer-piconero amounts exact', () => {
  expect(parseFieldValue({ type: 'nullableBool' }, 'null')).toBeNull()
  expect(parseFieldValue({ type: 'bool' }, 'false')).toBe(false)
  expect(() => parseFieldValue({ type: 'bool' }, '1')).toThrow()
  expect(parseFieldValue({ type: 'enum', options: ['LEGACY', 'ACTIVE'] }, 'ACTIVE')).toBe('ACTIVE')
  expect(() => parseFieldValue({ type: 'enum', options: ['LEGACY'] }, 'anything')).toThrow()
  expect(parseFieldValue({ type: 'int', bigint: true }, '1000000000000')).toBe(1000000000000n)
  expect(formatFieldValue({ type: 'int', bigint: true }, 1000000000000n)).toBe('1000000000000')
  expect(formatFieldValue({ type: 'nullableBool' }, null)).toBe('null')
})
