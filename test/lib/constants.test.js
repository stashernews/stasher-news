/* eslint-env jest */
import { DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER, HOMEPAGE_POSTS_PICONEROS_FILTER } from '@/lib/constants'

test('feed filters default to show-all with a -0.1 XMR homepage floor', () => {
  // null = -∞ (show all): user feeds hide nothing by default
  expect(DEFAULT_POSTS_PICONEROS_FILTER).toBe(null)
  expect(DEFAULT_COMMENTS_PICONEROS_FILTER).toBe(null)
  // -0.1 XMR = -100000000000 piconeros floor for logged-out homepage lit/top
  expect(HOMEPAGE_POSTS_PICONEROS_FILTER).toBe(-100000000000)
})
