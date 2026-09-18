/* eslint-env jest */
import { postCommentBaseLineItems, legacySatsToPiconeros, payableFeeTotal } from '@/components/fee-button'
import { piconerosToMXmr } from '@/lib/format'

// components/fee-button imports ./form, which pulls in the lexical editor whose
// node_modules deps (github-slugger, the mdast chain) are ESM-only and
// untransformable by next/jest. Stub the editor away — it is irrelevant to the
// pure function here.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

describe('postCommentBaseLineItems — posts', () => {
  test('low-rep authors see a single posting-fee line quoting 1 mXMR', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000 } }
    })
    expect(Object.keys(lines)).toEqual(['postingFee'])
    expect(lines.postingFee.op).toBe('_')
    expect(lines.postingFee.term).toBe('+ 1 mXMR')
    expect(lines.postingFee.label).toBe('posting fee')
    expect(piconerosToMXmr(BigInt(lines.postingFee.modifier(0)) * 1000n)).toBe('1 mXMR')
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
    expect(piconerosToMXmr(BigInt(total) * 1000n)).toBe('10 mXMR')
  })

  test('anonymous comments show the comment fee x3', () => {
    const lines = postCommentBaseLineItems({ comment: true, me: null })
    expect(Object.keys(lines).sort()).toEqual(['anonCharge', 'commentFee'])
    // base comment fee (0.001) then x3 anon mult -> total 0.003
    const total = [lines.commentFee, lines.anonCharge]
      .sort((a, b) => (a.op === '_' ? -1 : 1))
      .reduce((cost, line) => line.modifier(cost), 0)
    expect(piconerosToMXmr(BigInt(total) * 1000n)).toBe('3 mXMR')
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
    expect(lines.commentFee.term).toBe('+ 1 mXMR')
    expect(lines.commentFee.label).toBe('comment fee')
    expect(lines.commentFee.isComment).toBe(true)
    expect(piconerosToMXmr(BigInt(lines.commentFee.modifier(0)) * 1000n)).toBe('1 mXMR')
  })
})

describe('postCommentBaseLineItems — turf owners (subs)', () => {
  test('a low-rep owner sees the free post line when all turfs are owned', () => {
    const lines = postCommentBaseLineItems({
      me: { id: 1, privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0 } },
      subs: [{ name: 'myturf', userId: 1 }]
    })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.label).toBe('post')
    expect(lines.baseCost.ownerFree).toBe(true)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('an owner past the comment quota sees the free comment line when all turfs owned', () => {
    const lines = postCommentBaseLineItems({
      comment: true,
      me: { id: 1, privates: { freeCommentsLeft: 0, commentFeePiconeros: 1000000000 } },
      subs: [{ name: 'myturf', userId: 1 }]
    })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.ownerFree).toBe(true)
    expect(lines).not.toHaveProperty('commentFee')
  })

  test('a post to 2 non-owned turfs shows a scaled posting fee (2 mXMR)', () => {
    const lines = postCommentBaseLineItems({
      me: { id: 1, privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0 } },
      subs: [{ name: 'a', userId: 2 }, { name: 'b', userId: 3 }]
    })
    expect(lines.postingFee).toBeTruthy()
    expect(lines.postingFee.term).toBe('+ 2 mXMR')
    expect(lines.postingFee.label).toBe('posting fee \u00d7 2 turfs')
  })

  test('a mixed post (1 owned + 1 non-owned) shows a single posting fee', () => {
    const lines = postCommentBaseLineItems({
      me: { id: 1, privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0 } },
      subs: [{ name: 'mine', userId: 1 }, { name: 'yours', userId: 2 }]
    })
    expect(lines.postingFee).toBeTruthy()
    expect(lines.postingFee.term).toBe('+ 1 mXMR')
    expect(lines.postingFee.label).toBe('posting fee')
  })

  test('a comment past quota with 2 non-owned turfs shows the flat comment fee (no turf scaling)', () => {
    const lines = postCommentBaseLineItems({
      comment: true,
      me: { id: 1, privates: { freeCommentsLeft: 0, commentFeePiconeros: 1000000000 } },
      subs: [{ name: 'a', userId: 2 }, { name: 'b', userId: 3 }]
    })
    expect(Object.keys(lines)).toEqual(['commentFee'])
    expect(lines.commentFee.term).toBe('+ 1 mXMR')
    expect(lines.commentFee.label).toBe('comment fee')
    expect(piconerosToMXmr(BigInt(lines.commentFee.modifier(0)) * 1000n)).toBe('1 mXMR')
  })

  test('a comment past quota in a mixed (1 owned + 1 non-owned) turf thread shows the flat comment fee', () => {
    const lines = postCommentBaseLineItems({
      comment: true,
      me: { id: 1, privates: { freeCommentsLeft: 0, commentFeePiconeros: 1000000000 } },
      subs: [{ name: 'mine', userId: 1 }, { name: 'yours', userId: 2 }]
    })
    expect(Object.keys(lines)).toEqual(['commentFee'])
    expect(lines.commentFee.term).toBe('+ 1 mXMR')
    expect(lines.commentFee.label).toBe('comment fee')
  })

  test('bios stay free regardless of subs', () => {
    const lines = postCommentBaseLineItems({
      bio: true,
      me: { id: 1, privates: { freeCommentsLeft: 0 } },
      subs: [{ name: 'x', userId: 2 }]
    })
    expect(lines.baseCost).toBeTruthy()
    expect(lines.baseCost.allowFreebies).toBe(true)
  })
})

describe('legacySatsToPiconeros — fractional escalation totals never crash BigInt', () => {
  test('integer totals convert exactly (1 mXMR fee)', () => {
    expect(legacySatsToPiconeros(1_000_000)).toBe(1_000_000_000n)
  })

  test('the exact crash value from the live report (17085937.5) rounds instead of throwing', () => {
    // 1 mXMR base escalated x1.5^7: 1e6 * 1.5^7 = 17085937.5 legacy sats
    expect(() => legacySatsToPiconeros(17085937.5)).not.toThrow()
    expect(legacySatsToPiconeros(17085937.5)).toBe(17_085_938_000n)
  })

  test('negative-safe: null-ish totals return 0n rather than NaN BigInt', () => {
    expect(legacySatsToPiconeros(0)).toBe(0n)
  })
})

describe('postCommentBaseLineItems — turf premiums', () => {
  // sub fixtures carry postPremiumPiconeros as the client receives them via
  // SUB_FIELDS; dormant deployments hold 0 everywhere (server-zeroed at every
  // write path), so reading the premium directly mirrors the server fee math
  // (postFeePiconerosForSubs = Σ floor + premium per non-owned turf). The
  // premium LINE is gated on me.privates.turfOwnerFees — the client proxy for
  // the TURF_OWNER_FEES gate (privates.turfOwnerFees resolves server-side from
  // the env): premiums ride only owner-routed legs, so the receipt shows them
  // only while the feature can actually pay owners.
  const sub = (name, userId, post = 0) => ({ name, userId, postPremiumPiconeros: post })
  const lowRepMe = { id: 7, privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0, turfOwnerFees: true } }

  test('a single non-owned premium turf quotes floor + premium', () => {
    const lines = postCommentBaseLineItems({
      me: lowRepMe,
      subs: [sub('Revenue', 860, 2000000000)]
    })
    expect(lines.postingFee.term).toBe('+ 1 mXMR')
    expect(lines.postingFee.label).toBe('posting fee')
    expect(piconerosToMXmr(BigInt(lines.postingFee.modifier(0)) * 1000n)).toBe('1 mXMR')
    // the premium is its own receipt line, not folded into the posting fee
    expect(lines.turfPremium.term).toBe('+ 2 mXMR')
    expect(lines.turfPremium.label).toBe('turf owner premium')
    expect(piconerosToMXmr(BigInt(lines.turfPremium.modifier(0)) * 1000n)).toBe('2 mXMR')
  })

  test('the premium line is hidden when me.privates.turfOwnerFees is off (feature dormant)', () => {
    const lines = postCommentBaseLineItems({
      me: { id: 7, privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000, freePostsLeft: 0 } },
      subs: [sub('Revenue', 860, 2000000000)]
    })
    expect(lines.postingFee.term).toBe('+ 1 mXMR')
    expect(piconerosToMXmr(BigInt(lines.postingFee.modifier(0)) * 1000n)).toBe('1 mXMR')
    // stored premiums exist but the flag is off: premiums never ride a leg the
    // platform wallet would collect, so the receipt must not quote one
    expect(lines).not.toHaveProperty('turfPremium')
  })

  test('a cross-post sums floor + premium per non-owned turf', () => {
    const lines = postCommentBaseLineItems({
      me: lowRepMe,
      subs: [sub('Revenue', 860, 2000000000), sub('plain', 999)]
    })
    // posting fee: 1 mXMR x 2 = 2 mXMR; premium: 2 mXMR; total 4 mXMR
    expect(lines.postingFee.term).toBe('+ 2 mXMR')
    expect(lines.postingFee.label).toBe('posting fee \u00d7 2 turfs')
    expect(lines.turfPremium.term).toBe('+ 2 mXMR')
    const total = [lines.postingFee, lines.turfPremium]
      .sort((a, b) => (a.op === '_' && b.op !== '_' ? -1 : a.op !== '_' && b.op === '_' ? 1 : 0))
      .reduce((cost, line) => line.modifier(cost), 0)
    expect(piconerosToMXmr(BigInt(total) * 1000n)).toBe('4 mXMR')
  })

  test('owned turfs stay free even with a premium set', () => {
    const lines = postCommentBaseLineItems({
      me: lowRepMe,
      subs: [sub('mine', 7, 500000000)]
    })
    expect(lines.baseCost.allowFreebies).toBe(true)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('free posts stay free even with a premium turf selected', () => {
    const lines = postCommentBaseLineItems({
      me: { id: 7, privates: { postingFeeRequired: false, postingFeePiconeros: 0, freePostsLeft: 5, turfOwnerFees: true } },
      subs: [sub('Revenue', 860, 2000000000)]
    })
    expect(lines.baseCost.allowFreebies).toBe(true)
    expect(lines).not.toHaveProperty('postingFee')
  })

  test('zero-premium turfs keep the plain floor quote (dormant unchanged)', () => {
    const lines = postCommentBaseLineItems({
      me: lowRepMe,
      subs: [sub('a', 1), sub('b', 2)]
    })
    expect(lines.postingFee.term).toBe('+ 2 mXMR')
    expect(lines.postingFee.label).toBe('posting fee \u00d7 2 turfs')
    expect(lines).not.toHaveProperty('turfPremium')
  })

  test('missing premium fields (legacy cached subs) quote the plain floor', () => {
    const lines = postCommentBaseLineItems({
      me: lowRepMe,
      subs: [{ name: 'legacy', userId: 860 }]
    })
    expect(lines.postingFee.term).toBe('+ 1 mXMR')
    expect(lines).not.toHaveProperty('turfPremium')
  })

  test('anon posts (no me) hide the premium line and quote the floor x10', () => {
    const lines = postCommentBaseLineItems({ me: null, subs: [sub('Revenue', 860, 2000000000)] })
    expect(lines).not.toHaveProperty('turfPremium')
    const total = [lines.postingFee, lines.anonCharge]
      .sort((a, b) => (a.op === '_' ? -1 : 1))
      .reduce((cost, line) => line.modifier(cost), 0)
    // 1 mXMR x 10 = 10 mXMR (the server may still charge a premium on an
    // owner-routed anon leg — the receipt cannot know the route, so it
    // quotes the fallback floor like every other estimate it makes)
    expect(piconerosToMXmr(BigInt(total) * 1000n)).toBe('10 mXMR')
  })
})

describe('payableFeeTotal', () => {
  const freePostsMe = { privates: { postingFeeRequired: false, postingFeePiconeros: 0, freePostsLeft: 5 } }

  test('a free post with paid upload fees quotes exactly the upload fee', () => {
    const lines = postCommentBaseLineItems({ me: freePostsMe })
    const all = {
      ...lines,
      uploadFees: { term: '+ 2 mXMR', label: 'upload fee', op: '+', modifier: cost => cost + 2000000 }
    }
    const total = Object.values(all).reduce((acc, { modifier }) => modifier(acc), 0)
    const baseCostLine = Object.values(all).find(l => l.op === '_' && l.allowFreebies !== undefined)
    expect(total).toBe(2000001)
    expect(payableFeeTotal(baseCostLine, total)).toBe(2000000)
    expect(piconerosToMXmr(legacySatsToPiconeros(payableFeeTotal(baseCostLine, total)))).toBe('2 mXMR')
  })

  test('a freebie-only item pays nothing', () => {
    const lines = postCommentBaseLineItems({ me: freePostsMe })
    const baseCostLine = Object.values(lines).find(l => l.op === '_' && l.allowFreebies !== undefined)
    expect(payableFeeTotal(baseCostLine, 1)).toBe(0)
  })

  test('real fee lines are never excluded (allowFreebies false, not true)', () => {
    const lines = postCommentBaseLineItems({
      me: { privates: { postingFeeRequired: true, postingFeePiconeros: 1000000000 } }
    })
    const baseCostLine = Object.values(lines).find(l => l.op === '_' && l.allowFreebies !== undefined)
    expect(baseCostLine.allowFreebies).toBe(false)
    expect(payableFeeTotal(baseCostLine, 1000000)).toBe(1000000)
  })
})
