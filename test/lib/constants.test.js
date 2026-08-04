/* eslint-env jest */
import { DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER, HOMEPAGE_POSTS_PICONEROS_FILTER } from '@/lib/constants'

test('feed filter defaults are piconero-scale', () => {
  expect(DEFAULT_POSTS_PICONEROS_FILTER).toBe(1000000000) // 0.001 XMR = posting fee
  expect(HOMEPAGE_POSTS_PICONEROS_FILTER).toBe(1000000000)
  expect(DEFAULT_COMMENTS_PICONEROS_FILTER).toBe(0)
})
