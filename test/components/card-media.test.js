/* eslint-env jest */
import { pickUploadKey, buildPreview, previewDisabled } from '@/components/card-media'

// call-time env read lets us set it here deterministically
beforeAll(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = 'https://media.test/uploads'
  process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://cdn.test'
})

describe('pickUploadKey', () => {
  it('returns the first key whose src is an upload URL', () => {
    const urls = {
      'https://media.test/uploads/42': {},
      'https://media.test/uploads/43': {}
    }
    expect(pickUploadKey(urls, undefined)).toBe('https://media.test/uploads/42')
  })

  it('ignores the link-post url and external image hosts', () => {
    const itemUrl = 'https://example.com/article'
    const urls = {
      'https://example.com/article': {},
      'https://imgur.com/abc.png': {},
      'https://media.test/uploads/9': {}
    }
    expect(pickUploadKey(urls, itemUrl)).toBe('https://media.test/uploads/9')
  })

  it('returns undefined when there is no upload', () => {
    expect(pickUploadKey({ 'https://imgur.com/a.png': {} }, undefined)).toBeUndefined()
    expect(pickUploadKey(undefined, undefined)).toBeUndefined()
  })
})

describe('buildPreview', () => {
  const entry = {
    '640w': '/sig/rs:fit:640:360/aHR0cHM',
    '960w': '/sig/rs:fit:960:540/aHR0cHM',
    dimensions: { width: 1000, height: 600 },
    video: false
  }

  it('builds the src and 1x/2x srcSet from imgproxy paths', () => {
    const p = buildPreview(entry, { imgproxyUrl: 'https://cdn.test' })
    expect(p.src).toBe('https://cdn.test/sig/rs:fit:640:360/aHR0cHM')
    expect(p.srcSet).toBe('https://cdn.test/sig/rs:fit:640:360/aHR0cHM 1x, https://cdn.test/sig/rs:fit:960:540/aHR0cHM 2x')
    expect(p.isVideo).toBe(false)
    expect(p.aspectRatio).toBe('1000 / 600')
  })

  it('omits srcSet when only 640w is present', () => {
    const p = buildPreview({ '640w': '/x', dimensions: { width: 10, height: 10 } }, { imgproxyUrl: 'https://cdn.test' })
    expect(p.srcSet).toBeUndefined()
  })

  it('omits aspectRatio when dimensions are absent', () => {
    const p = buildPreview({ '640w': '/x' }, { imgproxyUrl: 'https://cdn.test' })
    expect(p.aspectRatio).toBeUndefined()
    expect(p.isVideo).toBe(false)
  })

  it('flags video and returns null when no 640w variant', () => {
    expect(buildPreview({ '640w': '/x', video: true }, { imgproxyUrl: 'https://cdn.test' }).isVideo).toBe(true)
    expect(buildPreview({}, { imgproxyUrl: 'https://cdn.test' })).toBeNull()
    expect(buildPreview(undefined, { imgproxyUrl: 'https://cdn.test' })).toBeNull()
  })
})

describe('previewDisabled', () => {
  const imageEntry = { video: false }
  const videoEntry = { video: true }

  it('is enabled by default and when showImagesAndVideos is true', () => {
    expect(previewDisabled(null, imageEntry)).toBe(false)
    expect(previewDisabled({ privates: { showImagesAndVideos: true } }, imageEntry)).toBe(false)
  })

  it('disables everything when showImagesAndVideos is false', () => {
    expect(previewDisabled({ privates: { showImagesAndVideos: false } }, imageEntry)).toBe(true)
  })

  it('disables only videos when imgproxyOnly is set', () => {
    const me = { privates: { imgproxyOnly: true } }
    expect(previewDisabled(me, imageEntry)).toBe(false)
    expect(previewDisabled(me, videoEntry)).toBe(true)
  })
})
