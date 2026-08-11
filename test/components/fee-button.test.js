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

  test('established authors with free posts left see a free post freebie line', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: false, postingFeePiconeros: 0, freePostsLeft: 5 } }
    })
    expect(lines.baseCost.term).toBe(1)
    expect(lines.baseCost.label).toBe('post')
    expect(lines.baseCost.op).toBe('_')
    expect(lines.baseCost.allowFreebies).toBe(true)
    expect(lines.baseCost.isComment).toBe(false)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('a zero posting fee yields no fee lines', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 0 } }
    })
    expect(lines).toEqual({})
  })

  test('anonymous post authors see the posting fee x10', () => {
    const lines = postCommentBaseLineItems({ me: null })
    expect(Object.keys(lines).sort()).toEqual(['anonCharge', 'postingFee'])
    // base posting fee (0.001) then x10 anon mult -> total 0.01
    const total = [lines.postingFee, lines.anonCharge]
      .sort((a, b) => (a.op === '_' ? -1 : 1))
      .reduce((cost, line) => line.modifier(cost), 0)
    expect(piconerosToXmr(BigInt(total) * 1000n)).toBe('0.01 XMR')
  })

  test('anonymous comments show the comment fee x3', () => {
    const lines = postCommentBaseLineItems({ comment: true, me: null })
    expect(Object.keys(lines).sort()).toEqual(['anonCharge', 'commentFee'])
    // base comment fee (0.001) then x3 anon mult -> total 0.003
    const total = [lines.commentFee, lines.anonCharge]
      .sort((a, b) => (a.op === '_' ? -1 : 1))
      .reduce((cost, line) => line.modifier(cost), 0)
    expect(piconerosToXmr(BigInt(total) * 1000n)).toBe('0.003 XMR')
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

describe('postCommentBaseLineItems — turf owners (ownsSub)', () => {
  test('a low-rep owner sees the free post line in their turf, not the posting fee', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0 } },
      ownsSub: true
    })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.label).toBe('post')
    expect(lines.baseCost.allowFreebies).toBe(true)
    expect(lines.baseCost.ownerFree).toBe(true)
    expect(lines.baseCost.isComment).toBe(false)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('an owner past the comment quota sees the free comment line in their turf', () => {
    const lines = postCommentBaseLineItems({
      comment: true,
      me: { privates: { freeCommentsLeft: 0, commentFeePiconeros: 1000000000 } },
      ownsSub: true
    })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.label).toBe('comment')
    expect(lines.baseCost.allowFreebies).toBe(true)
    expect(lines.baseCost.ownerFree).toBe(true)
    expect(lines.baseCost.isComment).toBe(true)
    expect(lines).not.toHaveProperty('commentFee')
  })

  test('ownsSub does not change bio behavior (bios are always free)', () => {
    const lines = postCommentBaseLineItems({ bio: true, me: { privates: { freeCommentsLeft: 0 } }, ownsSub: true })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.allowFreebies).toBe(true)
  })

  test('ownsSub false preserves the existing low-rep posting fee', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000 } },
      ownsSub: false
    })
    expect(Object.keys(lines)).toEqual(['postingFee'])
  })
})
