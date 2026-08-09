/* eslint-env jest */
import { makeExcerpt } from '@/lib/excerpt'

describe('makeExcerpt', () => {
  it('returns null for empty input', () => {
    expect(makeExcerpt(null)).toBeNull()
    expect(makeExcerpt(undefined)).toBeNull()
    expect(makeExcerpt('')).toBeNull()
    expect(makeExcerpt('   \n  ')).toBeNull()
  })

  it('returns short plain text as-is', () => {
    expect(makeExcerpt('hello world')).toBe('hello world')
  })

  it('collapses whitespace', () => {
    expect(makeExcerpt('line one\n\n   line two')).toBe('line one line two')
  })

  it('truncates long text on a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(200)
    const excerpt = makeExcerpt(long)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(301)
    expect(excerpt.length).toBeGreaterThan(250)
  })

  it('does not truncate at exactly the limit', () => {
    const exact = 'a'.repeat(300)
    expect(makeExcerpt(exact)).toBe(exact)
  })

  it('strips links down to their labels', () => {
    expect(makeExcerpt('[the truth](https://example.com) is out there'))
      .toBe('the truth is out there')
  })

  it('strips images down to their alt text', () => {
    expect(makeExcerpt('![a sleeping dog](https://example.com/dog.png) is cute'))
      .toBe('a sleeping dog is cute')
  })

  it('drops fenced code blocks', () => {
    expect(makeExcerpt('intro\n```js\nconst x = 1\n```\noutro'))
      .toBe('intro outro')
  })

  it('strips headings, emphasis and blockquotes', () => {
    expect(makeExcerpt('# Big **bold** title\n\n> a quote\n\n_em_'))
      .toBe('Big bold title a quote em')
  })

  it('decodes common html entities', () => {
    expect(makeExcerpt('a &amp; b &lt;c&gt;')).toBe('a & b <c>')
  })
})
