/* eslint-env jest */
import { countWords, effectiveWords } from '@/lib/contributorWords'

// Effective word counting for the contributor pool.

describe('countWords', () => {
  it('counts word-like segments only', () => {
    expect(countWords('Hello, world! 42 times.')).toBe(4)
    expect(countWords('')).toBe(0)
    expect(countWords('... --- ???')).toBe(0)
  })
})

describe('effectiveWords', () => {
  it('dedupes repeats and drops quotes, urls and link targets (the 7-word case)', () => {
    const r = effectiveWords('Hello world. Hello world.\n\n> quoted text here\n\nSee https://example.com and [this link](https://x.y) now.')
    expect(r.proseWords).toBe(2 + 5)
    expect(r.duplicateUnits).toBe(1)
  })

  it('counts fenced code at half weight and adds own uploads', () => {
    const r = effectiveWords('Intro.\n```\nconst a = b\n```\nOutro.', 2)
    expect(r.codeWords).toBe(3)
    expect(r.proseWords).toBe(2)
    expect(r.words).toBeCloseTo(2 + 1.5 + 200, 9)
  })

  it('caps uploads at three images', () => {
    expect(effectiveWords('x', 1).imageWords).toBe(100)
    expect(effectiveWords('x', 10).imageWords).toBe(300)
    expect(effectiveWords('x', -2).imageWords).toBe(0)
  })

  it('segments CJK text', () => {
    expect(effectiveWords('ビットコインは素晴らしいです。').proseWords).toBeGreaterThanOrEqual(3)
  })

  it('counts a url-only or image-only post as zero prose', () => {
    expect(effectiveWords('https://example.com/a/b').words).toBe(0)
    expect(effectiveWords('![alt text](https://x.y/z.png)').words).toBe(0)
    expect(effectiveWords('<iframe src="https://x.y"></iframe>').words).toBe(0)
  })

  it('strips markdown syntax, keeps link text, handles ~~~ fences and CRLF', () => {
    const r = effectiveWords('# Title here\r\n\r\n**bold** and _italic_ [link text](https://a.b)\r\n~~~\r\nfoo bar\r\n~~~')
    expect(r.proseWords).toBe(2 + 5)
    expect(r.codeWords).toBe(2)
  })

  it('handles null and an unterminated fence', () => {
    expect(effectiveWords(null).words).toBe(0)
    expect(effectiveWords('```\none two').codeWords).toBe(2)
  })

  it('crafted unclosed markup stays fast (no quadratic regex backtracking)', () => {
    for (const text of ['<'.repeat(100000), '![x'.repeat(33333), '<!['.repeat(33333), '[a'.repeat(50000)]) {
      const t0 = Date.now()
      effectiveWords(text)
      expect(Date.now() - t0).toBeLessThan(500)
    }
  })

  it('still strips well-formed images, links and tags', () => {
    const r = effectiveWords('A ![pic](https://x.y/z.png) B [link text](https://a.b) C <b>bold</b> D')
    expect(r.proseWords).toBe(7) // A B link text C bold D
  })

  it('honors custom image settings', () => {
    expect(effectiveWords('', 2, { wordsPerImage: 10, maxImages: 1 }).words).toBe(10)
  })
})
