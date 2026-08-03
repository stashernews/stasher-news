/* eslint-env jest */
import { postCommentBaseLineItems } from '@/components/fee-button'
import { xmrFromSats } from '@/lib/format'

// components/fee-button imports ./form, which pulls in the lexical editor whose
// node_modules deps (github-slugger, the mdast chain) are ESM-only and
// untransformable by next/jest. Stub the editor away (same trick as
// test/engine/activeSubs.test.js) — it is irrelevant to the pure function here.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

const SUBS = [{ name: 'monero', baseCost: 1, replyCost: 1 }]

describe('postCommentBaseLineItems — posts', () => {
  test('low-rep authors see a single posting-fee line quoting 0.001 XMR', () => {
    const lines = postCommentBaseLineItems({
      subs: SUBS,
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000 } }
    })
    expect(Object.keys(lines)).toEqual(['postingFee'])
    expect(lines.postingFee.op).toBe('+')
    expect(lines.postingFee.term).toBe('+ 0.001 XMR')
    expect(lines.postingFee.label).toBe('posting fee')
    expect(xmrFromSats(lines.postingFee.modifier(0))).toBe('0.001 XMR')
  })

  test('established authors see no fee lines', () => {
    const lines = postCommentBaseLineItems({
      subs: SUBS,
      me: { privates: { postingFeeRequired: false, postingFeePiconeros: 0 } }
    })
    expect(lines).toEqual({})
  })

  test('a zero posting fee yields no fee lines', () => {
    const lines = postCommentBaseLineItems({
      subs: SUBS,
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 0 } }
    })
    expect(lines).toEqual({})
  })

  test('anonymous authors see no fee lines', () => {
    expect(postCommentBaseLineItems({ subs: SUBS, me: null })).toEqual({})
  })
})

describe('postCommentBaseLineItems — comments and bios (unchanged)', () => {
  test('comments keep per-turf replyCost lines', () => {
    const lines = postCommentBaseLineItems({ subs: SUBS, comment: true, me: { privates: {} } })
    expect(lines['monero-baseCost'].term).toBe('+ 1')
    expect(lines['monero-baseCost'].label).toBe('~monero comment')
    expect(lines['monero-baseCost'].isComment).toBe(true)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('comments without subs keep the single baseCost line', () => {
    const lines = postCommentBaseLineItems({ subs: [], comment: true, me: { privates: {} } })
    expect(lines.baseCost.term).toBe(1)
    expect(lines.baseCost.isComment).toBe(true)
  })
})
