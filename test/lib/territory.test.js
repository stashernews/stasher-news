/* eslint-env jest */
import { needsCadenceFee } from '@/lib/territory'

test('switching to a longer plan requires a fee', () => {
  expect(needsCadenceFee({ billingType: 'MONTHLY' }, 'YEARLY')).toBe(true)
  expect(needsCadenceFee({ billingType: 'MONTHLY' }, 'ONCE')).toBe(true)
  expect(needsCadenceFee({ billingType: 'YEARLY' }, 'ONCE')).toBe(true)
})

test('switching to a shorter plan or keeping the plan is free', () => {
  expect(needsCadenceFee({ billingType: 'YEARLY' }, 'MONTHLY')).toBe(false)
  expect(needsCadenceFee({ billingType: 'MONTHLY' }, 'MONTHLY')).toBe(false)
})

test('needsCadenceFee guards missing subs', () => {
  expect(needsCadenceFee(null, 'YEARLY')).toBe(false)
})
