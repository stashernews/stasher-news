/* eslint-env jest */
// Regression: Item.freebie must reflect the stored `freebie` column (a zero-cost
// comment or bio), NOT `cost === 0`. Using cost caused the "freebie" badge to
// render on posts that carried no per-item cost but were not freebies (e.g.
// posts that paid the posting fee). See api/payIn/types/itemCreate.js:126.
//
// api/resolvers/item.js drags in heavy transitive deps (domino, lexical editor,
// url-unshort, page-metadata-parser); mirror test/api/resolvers/item-filterClause.test.js
// and stub the pieces that are irrelevant to this pure function.
import { isFreebieItem } from '@/api/resolvers/item'

jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

describe('isFreebieItem', () => {
  test('free comment (freebie column true) is a freebie regardless of cost', () => {
    expect(isFreebieItem({ cost: 0, freebie: true })).toBe(true)
  })

  test('free post (cost 0 but freebie column false) is NOT a freebie', () => {
    expect(isFreebieItem({ cost: 0, freebie: false })).toBe(false)
  })

  test('post that paid the posting fee with no per-item cost is NOT a freebie', () => {
    expect(isFreebieItem({ parentId: null, cost: 0, freebie: false })).toBe(false)
  })

  test('missing freebie column defaults to false', () => {
    expect(isFreebieItem({ cost: 0 })).toBe(false)
  })
})
