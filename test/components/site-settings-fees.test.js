/* eslint-env jest */
import { postCommentBaseLineItems } from '@/components/fee-button'

jest.mock('../../components/editor', () => ({ SNEditor: 'textarea' }))

test('anonymous fee estimate follows both live fee defaults and multipliers', () => {
  const siteSettings = { postingFeeFloorPiconeros: '2000000000', commentFeePiconeros: '300000000', anonPostFeeMultiplier: 4, anonCommentFeeMultiplier: 5 }
  const post = postCommentBaseLineItems({ me: null, siteSettings })
  expect(post.anonCharge.modifier(post.postingFee.modifier(0))).toBe(8000000)
  const reply = postCommentBaseLineItems({ me: null, comment: true, siteSettings })
  expect(reply.anonCharge.modifier(reply.commentFee.modifier(0))).toBe(1500000)
})
