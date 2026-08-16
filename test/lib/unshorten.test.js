/* eslint-env jest */
import { unshorten, isProbablyShortened } from '@/lib/unshorten'

describe('isProbablyShortened', () => {
  it('recognizes known shortener hosts', () => {
    expect(isProbablyShortened('https://t.co/abc')).toBe(true)
    expect(isProbablyShortened('https://bit.ly/abc')).toBe(true)
  })
  it('passes through normal URLs', () => {
    expect(isProbablyShortened('https://example.com/post/123')).toBe(false)
  })
})

describe('unshorten', () => {
  it('returns the URL unchanged when it is not a known shortener', async () => {
    expect(await unshorten('https://example.com/x')).toBe('https://example.com/x')
  })
  it('returns null for invalid input', async () => {
    expect(await unshorten('not a url')).toBe(null)
    expect(await unshorten(null)).toBe(null)
  })
})
