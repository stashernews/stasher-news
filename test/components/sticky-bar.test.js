/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
//
// StickyBar's desktop section is exercised with its REAL composition
// (components/nav/common.js subcomponents — Brand, Sorts, SearchItem,
// NavPrice, PostItem, RightCorner, Back — plus CommentsNavigator) through the
// shared MergedNavRow, so these tests double as parity checks: the sticky bar
// must contain every merged-header element (turf selector, sorts, post
// button, styled price pill). Only environment-level leaves are mocked (next
// router/link, the GraphQL-feeding hooks, the form-leaf SubSelect, and svgs —
// which resolve to string stubs under next/jest and cannot render as
// components).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import StickyBar from '@/components/nav/sticky-bar'
import { PriceCarouselProvider } from '@/components/nav/price-carousel'

// react-bootstrap's Dropdown keydown handler pulls the window from
// @restart/ui/useWindow, whose context default is computed at MODULE LOAD —
// before beforeAll runs, so no global window exists yet in jest's node env
// (undefined context crashes the effect). Mocking the module lets this factory
// bootstrap the linkedom window at import time and stash it for the harness.
jest.mock('@restart/ui/useWindow', () => {
  const win = parseHTML('<!doctype html><html><body></body></html>').window
  const store = new Map()
  win.localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear()
  }
  global.__TEST_WINDOW__ = win
  return {
    __esModule: true,
    default: () => win,
    WindowProvider: ({ children }) => children
  }
})

jest.mock('next/router', () => ({ useRouter: () => mockRouter }))
jest.mock('next/link', () => {
  const React = require('react')
  return function MockLink ({ href, children, className, ...rest }) {
    return React.createElement('a', { href: typeof href === 'string' ? href : '/', className, ...rest }, children)
  }
})
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/components/sub-select`, () => () => <span data-testid='turf-select' />)
jest.mock(`${process.cwd()}/components/badge`, () => () => null)
// account.js -> user-list -> user-header -> form -> lexical editor graph pulls
// github-slugger (ESM-only under jest CJS require); UserListRow is only used by
// SwitchAccountList which these tests never render, so mock the leaf module
jest.mock(`${process.cwd()}/components/user-list`, () => ({ UserListRow: () => null }))
// territory-branding/territory-domains/user-header -> form -> lexical editor
// graph pulls github-slugger (ESM-only under jest CJS require); their form
// components are only rendered in pages these tests never render, so mock the
// form module the same way test/components/vote-column.test.js does
jest.mock(`${process.cwd()}/components/form`, () => ({
  Form: 'div',
  Input: 'input',
  SubmitButton: 'button',
  CopyButton: 'button'
}))
// NavRewards runs a real useQuery; with no ApolloProvider in this node-env
// harness that throws Apollo invariant 28. With no data the real component
// renders null anyway (its `if (!total) return null`), so stub it to null —
// identical data-less output, no client needed. The module's other exports
// stay REAL (they are the parity surface these tests exercise).
jest.mock(`${process.cwd()}/components/nav/common`, () => {
  const actual = jest.requireActual(`${process.cwd()}/components/nav/common`)
  return { ...actual, NavRewards: () => null }
})
// lib/auth pulls in next-auth/jwt -> uuid (ESM-only under jest CJS require);
// the nav graph only uses its cookie helpers, so mock it at the module boundary
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  cookieOptions: () => ({ path: '/', maxAge: 2592000, httpOnly: false }),
  MULTI_AUTH_ANON: 'anonymous',
  MULTI_AUTH_POINTER: 'multi_auth.user-id',
  MULTI_AUTH_LIST: 'multi_auth',
  parseMultiAuthListCookie: () => []
}))
// next/jest maps every .svg to a single shared fileMock module, so one generic
// stub covers all svg imports (per-icon mock ids would collapse into the last
// factory); icons are asserted structurally via their wrapper components
jest.mock(`${process.cwd()}/svgs/arrow-left-line.svg`, () => ({ className, width }) => <svg className={className} width={width} />)
jest.mock(`${process.cwd()}/svgs/search-line.svg`, () => ({ className, width }) => <svg className={className} width={width} />)
jest.mock(`${process.cwd()}/svgs/notification-4-fill.svg`, () => ({ width }) => <svg width={width} />)

// var, not let/const: jest.mock factories may only reference out-of-scope
// names prefixed with "mock", and const/let here would be in TDZ when the
// hoisted jest.mock call runs.
var mockRouter = { asPath: '/~bitcoin' }
var mockMe = null

// props shape mirrors what components/nav/index.js builds for DesktopHeader
const TURF_PROPS = {
  prefix: '/~bitcoin',
  path: '/~bitcoin',
  pathname: '/~bitcoin',
  topNavKey: '',
  dropNavKey: 'bitcoin',
  sub: 'bitcoin'
}

let win
let container
let root

beforeAll(() => {
  // window/document/navigator come from the @restart/ui/useWindow mock, which
  // built them at import time (module-load-time window reads need them before
  // beforeAll runs)
  win = global.__TEST_WINDOW__
  global.window = win
  global.document = win.document
  global.navigator = win.navigator
  global.HTMLElement = win.HTMLElement
  global.Node = win.Node
  global.IS_REACT_ACT_ENVIRONMENT = true

  container = win.document.createElement('div')
  win.document.body.appendChild(container)
  root = createRoot(container)

  // linkedom ships no document.cookie; useCookie (used by PostItem ->
  // useIsLurker -> useAccounts and the account switch flow) parses it in an
  // effect
  let cookieStr = ''
  Object.defineProperty(win.document, 'cookie', {
    get: () => cookieStr,
    set: v => { cookieStr = v }
  })
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
  mockRouter = { asPath: '/~bitcoin' }
  mockMe = null
})

afterEach(async () => {
  // render(null) unmounts and empties the container; clearing innerHTML first
  // would orphan React's tracked nodes and break the next render
  await act(async () => { root.render(null) })
})

async function renderStickyBar (props = TURF_PROPS) {
  await act(async () => {
    root.render(<PriceCarouselProvider><StickyBar {...props} /></PriceCarouselProvider>)
  })
}

describe('StickyBar desktop parity with HeaderMerged', () => {
  it('contains every merged-header element on turf pages', async () => {
    await renderStickyBar(TURF_PROPS)

    // sticky wrapper (fixed on scroll)
    expect(container.querySelector('[class*="sticky"]')).toBeTruthy()
    // merged row classes on the desktop Nav
    expect(container.querySelector('.navMergedRow')).toBeTruthy()
    expect(container.querySelector('.navMerged')).toBeTruthy()
    // back arrow
    expect(container.querySelector('a[role="button"] svg')).toBeTruthy()
    // brand wordmark
    expect(container.querySelector('a[href="/"] .brandWordmark')).toBeTruthy()
    // turf selector (was missing from the sticky bar)
    expect(container.querySelector('[data-testid="turf-select"]')).toBeTruthy()
    // lit/new/top sorts (was missing)
    const linkTexts = Array.from(container.querySelectorAll('a')).map(a => a.textContent)
    expect(linkTexts).toEqual(expect.arrayContaining(['lit', 'new', 'top']))
    // search
    expect(container.querySelector('a[href="/search"] svg')).toBeTruthy()
    // price ticker pill
    expect(container.querySelector('.navMerged .nav-item')).toBeTruthy()
    // post button (was missing)
    const post = Array.from(container.querySelectorAll('a')).find(a => a.textContent === 'post')
    expect(post).toBeTruthy()
    expect(post.getAttribute('href')).toBe('/~bitcoin/post')
    // logged-out corner
    const buttonTexts = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
    expect(buttonTexts).toEqual(expect.arrayContaining(['sign up', 'login']))
  })

  it('keeps the mobile sticky section (back, price, sign up)', async () => {
    await renderStickyBar(TURF_PROPS)

    // mobile container exists and keeps the sign-up button for logged-out users
    expect(container.textContent).toContain('sign up')
    expect(container.querySelectorAll('a[role="button"] svg').length).toBeGreaterThan(0)
  })
})
