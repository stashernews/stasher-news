/* eslint-env jest */
import { postCommentBaseLineItems } from '@/components/fee-button'
import { piconerosToXmr } from '@/lib/format'

// components/fee-button imports ./form, which pulls in the lexical editor whose
// node_modules deps (github-slugger, the mdast chain) are ESM-only and
// untransformable by next/jest. Stub the editor away (same trick as
// test/engine/activeSubs.test.js) — it is irrelevant to the pure function here.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

describe('postCommentBaseLineItems — posts', () => {
  test('low-rep authors see a single posting-fee line quoting 0.001 XMR', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000 } }
    })
    expect(Object.keys(lines)).toEqual(['postingFee'])
    expect(lines.postingFee.op).toBe('_')
    expect(lines.postingFee.term).toBe('+ 0.001 XMR')
    expect(lines.postingFee.label).toBe('posting fee')
    expect(piconerosToXmr(BigInt(lines.postingFee.modifier(0)) * 1000n)).toBe('0.001 XMR')
  })

  test('established authors see no fee lines', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: false, postingFeePiconeros: 0 } }
    })
    expect(lines).toEqual({})
  })

  test('a zero posting fee yields no fee lines', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 0 } }
    })
    expect(lines).toEqual({})
  })

  test('anonymous post authors see the flat posting-fee line', () => {
    const lines = postCommentBaseLineItems({ me: null })
    expect(Object.keys(lines)).toEqual(['postingFee'])
    expect(lines.postingFee.op).toBe('_')
    expect(piconerosToXmr(BigInt(lines.postingFee.modifier(0)) * 1000n)).toBe('0.001 XMR')
  })

  test('anonymous comments show the comment fee x10', () => {
    const lines = postCommentBaseLineItems({ comment: true, me: null })
    expect(Object.keys(lines).sort()).toEqual(['anonCharge', 'commentFee'])
    // base comment fee (0.001) then x10 anon mult -> total 0.01
    const total = [lines.commentFee, lines.anonCharge]
      .sort((a, b) => (a.op === '_' ? -1 : 1))
      .reduce((cost, line) => line.modifier(cost), 0)
    expect(piconerosToXmr(BigInt(total) * 1000n)).toBe('0.01 XMR')
  })
})

describe('postCommentBaseLineItems — comments and bios', () => {
  test('comments within the freebie quota show the free base line', () => {
    const lines = postCommentBaseLineItems({ comment: true, me: { privates: { freeCommentsLeft: 3 } } })
    expect(lines.baseCost.term).toBe(1)
    expect(lines.baseCost.label).toBe('comment')
    expect(lines.baseCost.isComment).toBe(true)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('comments beyond the freebie quota show the flat comment fee', () => {
    const lines = postCommentBaseLineItems({
      comment: true,
      me: { privates: { freeCommentsLeft: 0, commentFeePiconeros: 1000000000 } }
    })
    expect(Object.keys(lines)).toEqual(['commentFee'])
    expect(lines.commentFee.op).toBe('_')
    expect(lines.commentFee.term).toBe('+ 0.001 XMR')
    expect(lines.commentFee.label).toBe('comment fee')
    expect(lines.commentFee.isComment).toBe(true)
    expect(piconerosToXmr(BigInt(lines.commentFee.modifier(0)) * 1000n)).toBe('0.001 XMR')
  })

  test('bios stay free', () => {
    const lines = postCommentBaseLineItems({ bio: true, me: { privates: { freeCommentsLeft: 0 } } })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.allowFreebies).toBe(true)
  })
})
