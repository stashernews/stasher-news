/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { pickUploadKey, buildPreview, previewDisabled, CardMedia } from '@/components/card-media'

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

  // prod sets only NEXT_PUBLIC_MEDIA_DOMAIN (see .env.production); the upload
  // regex must fall back to it the same way lib/constants.js does
  it('picks uploads keyed by the MEDIA_DOMAIN fallback when MEDIA_URL is unset', () => {
    const prevMediaUrl = process.env.NEXT_PUBLIC_MEDIA_URL
    const prevMediaDomain = process.env.NEXT_PUBLIC_MEDIA_DOMAIN
    delete process.env.NEXT_PUBLIC_MEDIA_URL
    process.env.NEXT_PUBLIC_MEDIA_DOMAIN = 'm.stasher.news'
    try {
      const urls = {
        'https://m.stasher.news/42': {},
        'https://external.example.com/1.png': {}
      }
      expect(pickUploadKey(urls, undefined)).toBe('https://m.stasher.news/42')
    } finally {
      if (prevMediaUrl === undefined) delete process.env.NEXT_PUBLIC_MEDIA_URL
      else process.env.NEXT_PUBLIC_MEDIA_URL = prevMediaUrl
      if (prevMediaDomain === undefined) delete process.env.NEXT_PUBLIC_MEDIA_DOMAIN
      else process.env.NEXT_PUBLIC_MEDIA_DOMAIN = prevMediaDomain
    }
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

// ---- CardMedia render tests (linkedom harness) ----

jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/svgs/video-on-fill.svg`, () => (props) => <svg {...props} data-testid='play-badge'><path d='play' /></svg>)
// render Link as a plain anchor so clicks are testable without Next router state
jest.mock('next/link', () => ({ href, children, ...props }) => <a href={href} {...props}>{children}</a>)

// var (not let/const): jest.mock factories can only reference mock-prefixed
// out-of-scope names; const/let would be in TDZ when the hoisted mock runs.
var mockMe

let win
let container

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  win = parsed.window
  global.window = win
  global.document = parsed.document
  global.navigator = win.navigator
  global.HTMLElement = win.HTMLElement
  global.Node = win.Node
  global.IS_REACT_ACT_ENVIRONMENT = true
  container = parsed.document.createElement('div')
  parsed.document.body.appendChild(container)
})

afterAll(() => {
  delete global.window
  delete global.document
  delete global.navigator
  delete global.HTMLElement
  delete global.Node
  delete global.IS_REACT_ACT_ENVIRONMENT
})

beforeEach(() => {
  mockMe = null
  container.innerHTML = ''
})

async function render (item, props = {}) {
  const root = createRoot(container)
  await act(async () => { root.render(<CardMedia item={item} {...props} />) })
  return root
}

const upload = (over = {}) => ({
  'https://media.test/uploads/42': {
    '640w': '/p/fit640',
    '960w': '/p/fit960',
    dimensions: { width: 1000, height: 600 },
    ...over
  }
})

describe('CardMedia render', () => {
  it('renders a capped <img> for an image upload', async () => {
    const root = await render({ imgproxyUrls: upload() })
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('https://cdn.test/p/fit640')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(container.querySelector('[data-testid="play-badge"]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('adds a play badge for a video upload', async () => {
    const root = await render({ imgproxyUrls: upload({ video: true }) })
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.querySelector('[data-testid="play-badge"]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it('renders nothing for a link-only item (no upload)', async () => {
    const root = await render({
      url: 'https://example.com/a',
      imgproxyUrls: { 'https://example.com/a': { '640w': '/x' } }
    })
    expect(container.querySelector('img')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('renders nothing when showImagesAndVideos is false', async () => {
    mockMe = { privates: { showImagesAndVideos: false } }
    const root = await render({ imgproxyUrls: upload() })
    expect(container.querySelector('img')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('wraps the preview in a link to the post and forwards onClick', async () => {
    const onClick = jest.fn()
    const root = await render({ id: '42', imgproxyUrls: upload() }, { onClick })
    const link = container.querySelector('a')
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/items/42')
    expect(link.getAttribute('aria-label')).toBe('view post 42')
    await act(async () => {
      link.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
  })
})
