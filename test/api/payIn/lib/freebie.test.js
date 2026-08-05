/* eslint-env jest */
import { commentsFreeLeft } from '@/api/payIn/lib/freebie'

test('commentsFreeLeft returns the full monthly allotment for new users', () => {
  expect(commentsFreeLeft({ freeCommentCount: 0, freeCommentResetAt: null })).toBe(15)
})

test('commentsFreeLeft counts down within the month', () => {
  expect(commentsFreeLeft({ freeCommentCount: 12, freeCommentResetAt: null })).toBe(3)
})

test('commentsFreeLeft floors at zero', () => {
  expect(commentsFreeLeft({ freeCommentCount: 20, freeCommentResetAt: null })).toBe(0)
})

test('commentsFreeLeft resets after the reset date', () => {
  const user = { freeCommentCount: 15, freeCommentResetAt: new Date(Date.now() - 1000) }
  expect(commentsFreeLeft(user)).toBe(15)
})

test('commentsFreeLeft returns 0 for missing users', () => {
  expect(commentsFreeLeft(null)).toBe(0)
})
