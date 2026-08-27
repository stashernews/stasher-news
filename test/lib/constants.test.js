/* eslint-env jest */
import { DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER, HOMEPAGE_POSTS_PICONEROS_FILTER } from '@/lib/constants'

test('feed filters default to -0.025 XMR, logged-out floor aligned', () => {
  // -0.025 XMR = -25000000000 piconeros: one downvote can't bury a post, but
  // sustained downvoting (net investment below -0.025) hides it by default.
  expect(DEFAULT_POSTS_PICONEROS_FILTER).toBe(-25000000000)
  expect(DEFAULT_COMMENTS_PICONEROS_FILTER).toBe(-25000000000)
  // logged-out homepage lit/top floor + unconditional `related` floor; kept as
  // a separate knob so the front page can be re-tuned independently of DEFAULT_*
  expect(HOMEPAGE_POSTS_PICONEROS_FILTER).toBe(-25000000000)
})
