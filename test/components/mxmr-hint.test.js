/* eslint-env jest */
import { mxmrHintText } from '@/components/mxmr-hint'

describe('mxmrHintText', () => {
  test('maps a decimal XMR value to its mXMR reading', () => {
    expect(mxmrHintText('0.001')).toBe('= 1 mXMR')
    expect(mxmrHintText('0.01')).toBe('= 10 mXMR')
    expect(mxmrHintText('0.0001')).toBe('= 0.1 mXMR')
    expect(mxmrHintText('0.0005')).toBe('= 0.5 mXMR')
  })

  test('maps numeric values (number or String()) like the form fields deliver', () => {
    expect(mxmrHintText(0.001)).toBe('= 1 mXMR')
  })

  test('maps negative filter values (signed parsing)', () => {
    expect(mxmrHintText('-0.025')).toBe('= -25 mXMR')
    expect(mxmrHintText('-0.1')).toBe('= -100 mXMR')
  })

  test('keeps off-grid amounts exact (no filter-grid snapping)', () => {
    expect(mxmrHintText('0.00123')).toBe('= 1.23 mXMR')
    expect(mxmrHintText('0.00015')).toBe('= 0.15 mXMR')
    expect(mxmrHintText('0.00005')).toBe('= 0.05 mXMR')
  })

  test('returns null for blank or invalid values', () => {
    expect(mxmrHintText('')).toBeNull()
    expect(mxmrHintText(undefined)).toBeNull()
    expect(mxmrHintText(null)).toBeNull()
    expect(mxmrHintText('abc')).toBeNull()
  })

  test('returns null for zero', () => {
    expect(mxmrHintText('0')).toBeNull()
    expect(mxmrHintText(0)).toBeNull()
  })
})
