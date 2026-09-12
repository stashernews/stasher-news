/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
//
// Contract: the title row shows the grey VideoIcon whenever the post contains a
// video upload — whether it is the post's link (url) or embedded in the body —
// and it stays visible even when the user has hidden images/videos. The icon is
// only an indicator, so it must not be gated by media-visibility settings.
//
// Harness note: next/jest maps EVERY `*.svg` import to the same fileMock, so a
// per-icon jest.mock cannot distinguish VideoIcon from ImageIcon — both resolve
// to the last registered factory. We therefore assert on a shared `media-icon`
// testid and prove the video branch specifically via the settings gate: with
// showImagesAndVideos=false the image branch is suppressed (mediaType returns
// undefined), so any icon that still renders can only come from the video
// branch (hasVideoUpload). The distinct video/image rendering is covered by the
// hasVideoUpload unit tests plus browser verification.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import Item from '@/components/item'

jest.mock('next/link', () => {
  const React = require('react')
  return function MockLink ({ href, children, className, ...rest }) {
    return React.createElement('a', { href: typeof href === 'string' ? href : '/', className, ...rest }, children)
  }
})
jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/components/upvote`, () => () => null)
jest.mock(`${process.cwd()}/components/vote-column`, () => () => null)
jest.mock(`${process.cwd()}/components/item-info`, () => () => null)
jest.mock(`${process.cwd()}/components/x-preview`, () => ({ XPreviewCard: () => null }))
jest.mock(`${process.cwd()}/components/item-popover`, () => () => null)
jest.mock(`${process.cwd()}/components/boost-button`, () => () => null)
jest.mock(`${process.cwd()}/components/action-tooltip`, () => ({ __esModule: true, default: ({ children }) => children }))
jest.mock(`${process.cwd()}/components/text`, () => ({ SearchText: () => null }))
jest.mock(`${process.cwd()}/svgs/video-on-fill.svg`, () => (props) => <svg {...props} data-testid='media-icon' />)
jest.mock(`${process.cwd()}/svgs/image-fill.svg`, () => (props) => <svg {...props} data-testid='media-icon' />)

// let, not const: reassigned per-test; jest.mock factories reference this
// lazily (mock*-prefixed per babel-plugin-jest-hoist), so TDZ never applies.
let mockMe

let container

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  global.window = parsed.window
  global.document = parsed.document
  global.navigator = parsed.window.navigator
  global.HTMLElement = parsed.window.HTMLElement
  global.Node = parsed.window.Node
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

async function renderItem (item) {
  const root = createRoot(container)
  await act(async () => { root.render(<Item item={{ id: '342452', title: 'sdgasdg', user: { name: 'jerry' }, ...item }} />) })
  return root
}

const icon = () => container.querySelector('[data-testid="media-icon"]')

describe('Item video icon', () => {
  it('shows an icon for an embedded video upload (empty url)', async () => {
    const root = await renderItem({ url: '', imgproxyUrls: { 'https://media.test/uploads/42': { video: true } } })

    expect(icon()).toBeTruthy()

    await act(async () => { root.unmount() })
  })

  it('keeps showing the icon for an embedded video when showImagesAndVideos is false', async () => {
    mockMe = { privates: { showImagesAndVideos: false } }
    const root = await renderItem({ url: '', imgproxyUrls: { 'https://media.test/uploads/42': { video: true } } })

    // the settings gate suppresses mediaType, so this icon can only be the
    // always-on video indicator
    expect(icon()).toBeTruthy()

    await act(async () => { root.unmount() })
  })

  it('keeps showing the icon for a video link post when showImagesAndVideos is false', async () => {
    mockMe = { privates: { showImagesAndVideos: false } }
    const url = 'https://media.test/uploads/42'
    const root = await renderItem({ url, imgproxyUrls: { [url]: { video: true } } })

    expect(icon()).toBeTruthy()

    await act(async () => { root.unmount() })
  })

  it('suppresses the icon for an image link post when showImagesAndVideos is false', async () => {
    mockMe = { privates: { showImagesAndVideos: false } }
    const url = 'https://media.test/uploads/7'
    const root = await renderItem({ url, imgproxyUrls: { [url]: { '640w': '/x', video: false } } })

    expect(icon()).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('shows the icon for an image link post by default', async () => {
    const url = 'https://media.test/uploads/7'
    const root = await renderItem({ url, imgproxyUrls: { [url]: { '640w': '/x', video: false } } })

    expect(icon()).toBeTruthy()

    await act(async () => { root.unmount() })
  })

  it('does not show an icon when there is no media', async () => {
    const root = await renderItem({})

    expect(icon()).toBeNull()

    await act(async () => { root.unmount() })
  })
})
