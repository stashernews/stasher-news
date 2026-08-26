/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import fs from 'fs'
import path from 'path'
import { XPreviewCard } from '@/components/x-preview'

const PREVIEW = {
  authorName: 'ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ',
  handle: 'DontTraceMeBruh',
  text: 'ZEC is a joke x.com/XBTXMR/status/2092396519026561343',
  date: 'August 26, 2026',
  statusUrl: 'https://x.com/DontTraceMeBruh/status/2092467849000350095',
  image: { '640w': 'https://imgproxy/640.jpg', '960w': 'https://imgproxy/960.jpg' }
}

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
  container.innerHTML = ''
})

async function render (node) {
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  return root
}

describe('XPreviewCard', () => {
  it('renders author, handle, text, date and view-on-X link', async () => {
    const root = await render(<XPreviewCard xPreview={PREVIEW} url={PREVIEW.statusUrl} />)
    expect(container.textContent).toContain('ᴜɴᴛʀᴀᴄᴇᴀʙʟᴇ')
    expect(container.textContent).toContain('@DontTraceMeBruh')
    expect(container.textContent).toContain('ZEC is a joke')
    expect(container.textContent).toContain('August 26, 2026')
    expect(container.textContent).toContain('view on X')
    const links = Array.from(container.querySelectorAll('a'))
    expect(links.some(a => a.getAttribute('href') === PREVIEW.statusUrl)).toBe(true)
    await act(async () => { root.unmount() })
  })

  it('renders the proxied image when showImage and image are present', async () => {
    const root = await render(<XPreviewCard xPreview={PREVIEW} url={PREVIEW.statusUrl} />)
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('https://imgproxy/640.jpg')
    await act(async () => { root.unmount() })
  })

  it('omits the image when showImage is false', async () => {
    const root = await render(<XPreviewCard xPreview={PREVIEW} url={PREVIEW.statusUrl} showImage={false} />)
    expect(container.querySelector('img')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('renders from URL only when xPreview is absent', async () => {
    const root = await render(<XPreviewCard url='https://x.com/satoshi/status/123' />)
    expect(container.textContent).toContain('@satoshi')
    expect(container.querySelector('img')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('clamps the text to 3 lines in the stylesheet', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'components/x-preview.module.css'), 'utf8')
    expect(css).toMatch(/-webkit-line-clamp:\s*3/)
  })

  it('resolves a relative imgproxy path against NEXT_PUBLIC_IMGPROXY_URL', async () => {
    process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgproxy.example'
    const root = await render(<XPreviewCard xPreview={{ ...PREVIEW, image: { '640w': '/sig/rs:fit:640:360/abc' } }} url={PREVIEW.statusUrl} />)
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe('https://imgproxy.example/sig/rs:fit:640:360/abc')
    delete process.env.NEXT_PUBLIC_IMGPROXY_URL
    await act(async () => { root.unmount() })
  })

  it('applies the feed image cap class when feed is set', async () => {
    const root = await render(<XPreviewCard xPreview={PREVIEW} url={PREVIEW.statusUrl} feed />)
    const img = container.querySelector('img')
    expect(img.getAttribute('class')).toContain('imgFeed')
    await act(async () => { root.unmount() })
  })

  it('caps the feed image at the same max size as other media previews', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'components/x-preview.module.css'), 'utf8')
    expect(css).toMatch(/\.imgFeed\s*\{[^}]*max-height:\s*300px/)
    expect(css).toMatch(/\.imgFeed\s*\{[^}]*width:\s*auto/)
  })
})
