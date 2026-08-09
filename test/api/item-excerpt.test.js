/* eslint-env jest */
// Item.excerpt resolver behavior: stored excerpt wins, otherwise the excerpt
// is computed from item.text via makeExcerpt (bounded input, truncated with
// an ellipsis, null for empty/whitespace-only bodies).
//
// api/resolvers/item.js drags in heavy transitive deps (domino, lexical editor,
// url-unshort, page-metadata-parser); mirror test/api/resolvers/item-freebie.test.js
// and stub the pieces that are irrelevant to this pure function.
import { excerptResolver } from '@/api/resolvers/item'

jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

describe('Item.excerpt resolver', () => {
  test('long item.text is truncated with an ellipsis at the head window', () => {
    const excerpt = excerptResolver({ text: 'word '.repeat(5000) })
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(301)
  })

  test('empty or missing text yields null', () => {
    expect(excerptResolver({ text: '' })).toBeNull()
    expect(excerptResolver({ text: '   \n  ' })).toBeNull()
    expect(excerptResolver({ text: null })).toBeNull()
    expect(excerptResolver({ text: undefined })).toBeNull()
    expect(excerptResolver({})).toBeNull()
  })

  test('pre-set excerpt wins over recomputation', () => {
    const item = { text: 'word '.repeat(5000), excerpt: 'custom teaser' }
    expect(excerptResolver(item)).toBe('custom teaser')
  })
})
