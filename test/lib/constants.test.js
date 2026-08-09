/* eslint-env jest */
import { DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER, HOMEPAGE_POSTS_PICONEROS_FILTER } from '@/lib/constants'

test('feed filter defaults are piconero-scale', () => {
  expect(DEFAULT_POSTS_PICONEROS_FILTER).toBe(-2000000000) // -0.002 XMR = show downvoted content
  expect(HOMEPAGE_POSTS_PICONEROS_FILTER).toBe(-2000000000)
  expect(DEFAULT_COMMENTS_PICONEROS_FILTER).toBe(-2000000000)
})
