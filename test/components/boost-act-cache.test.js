/* eslint-env jest */
// The boost act response's ItemAct result carries `path` straight from
// Item.path (an Unsupported("ltree") column Prisma cannot read). Before the
// boost onBegin fix (api/payIn/types/boost.js), every boost response had
// path: null over GraphQL, and updateAncestors crashed on null.split('.')
// with "Cannot read properties of null (reading 'split')" — surfaced as the
// boost modal's "failed to boost" toast. The cache phase must tolerate a
// null/absent path (no ancestors to walk) instead of throwing.
import { getActCachePhases } from '@/components/item-act'

jest.mock('react-bootstrap/Button', () => () => null)
jest.mock('react-bootstrap/InputGroup', () => () => null)
jest.mock(`${process.cwd()}/components/form`, () => ({ Form: () => null, Input: () => null, SubmitButton: () => null }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: null }) }))
jest.mock(`${process.cwd()}/components/upvote`, () => ({ defaultTipIncludingRandom: () => 1000000000 }))
jest.mock(`${process.cwd()}/components/animation`, () => ({ useAnimation: () => () => {} }))
jest.mock(`${process.cwd()}/components/toast`, () => ({ useToast: () => ({ danger: jest.fn() }) }))
jest.mock(`${process.cwd()}/wallets/client/errors`, () => ({ toastPayError: jest.fn(), isTransientNetworkError: () => false }))
jest.mock(`${process.cwd()}/components/payIn/hooks/use-pay-in-mutation`, () => () => [jest.fn(), {}])
jest.mock(`${process.cwd()}/svgs/up-arrow.svg`, () => () => null)

describe('getActCachePhases onPaid with a boost result', () => {
  const makeCache = () => ({ modify: jest.fn() })
  // the item's own id is the LAST path segment (path = parent.child.id)
  const makeData = (path, id) => ({
    act: {
      payerPrivates: {
        result: { id, piconeros: '0', act: 'BOOST', path }
      }
    }
  })

  test('walks ancestors when the path is present', () => {
    const cache = makeCache()
    // a root post: the only path segment is the item itself, so the walk skips
    // it and there are no ancestor updates
    getActCachePhases(null).onPaid(cache, { data: makeData('1', 1) })
    expect(cache.modify).not.toHaveBeenCalled()
  })

  test('walks the parent ancestors of a reply', () => {
    const cache = makeCache()
    getActCachePhases(null).onPaid(cache, { data: makeData('2.3', 3) })
    expect(cache.modify).toHaveBeenCalledWith({
      id: 'Item:2',
      fields: {
        commentBoost: expect.any(Function)
      }
    })
  })

  test('does not throw when the boost response has a null path (the live bug)', () => {
    const cache = makeCache()
    expect(() => getActCachePhases(null).onPaid(cache, { data: makeData(null, 1) })).not.toThrow()
    expect(cache.modify).not.toHaveBeenCalled()
  })

  test('does not throw when the path is absent entirely', () => {
    const cache = makeCache()
    expect(() => getActCachePhases(null).onPaid(cache, { data: makeData(undefined, 1) })).not.toThrow()
  })
})
