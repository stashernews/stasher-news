/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
//
// HeaderMerged is exercised with its REAL composition (components/nav/common.js
// subcomponents — Brand, Sorts, SearchItem, NavPrice, PostItem, RightCorner,
// Back — plus CommentsNavigator), so the tests double as zero-removal smoke
// checks: every element of the current two desktop bars must be present in the
// merged row. Only environment-level leaves are mocked (next router/link, the
// GraphQL-feeding hooks, the form-leaf SubSelect, and svgs — which resolve to
// string stubs under next/jest and cannot render as components).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import HeaderMerged from '@/components/nav/desktop/header-merged'
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
jest.mock('@apollo/client', () => {
  // fragments like ./payIn run the real graphql-tag parser at module load and
  // interpolate fragments built by this gql, so it must return real
  // DocumentNodes (graphql-tag is CJS; only @apollo/client itself is ESM-only)
  const { gql } = require('graphql-tag')
  return { __esModule: true, gql }
})
// NavRewards polls the public rewards pool via useQuery; nothing else in the
// header graph calls useQuery (HasNewNotesProvider is not rendered here), so
// the mock returns a stubbed result for the whole file.
jest.mock('@apollo/client/react', () => ({
  useQuery: () => ({
    data: { rewards: [{ total: mockRewardsTotal, time: mockRewardsTime }] }
  })
}))

// let, not const: reassigned per-test; jest.mock factories reference these
// lazily (mock*-prefixed per babel-plugin-jest-hoist), so TDZ never applies.
let mockRouter = { asPath: '/~bitcoin' }
let mockMe = null
let mockRewardsTotal = '1200000000000'
let mockRewardsTime = null

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
  mockRewardsTotal = '1200000000000'
  mockRewardsTime = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
})

afterEach(async () => {
  // render(null) unmounts and empties the container; clearing innerHTML first
  // would orphan React's tracked nodes and break the next render
  await act(async () => { root.render(null) })
})

async function renderHeader (props = TURF_PROPS) {
  await act(async () => {
    // PriceCarouselProvider mirrors components/nav/index.js, which wraps the
    // desktop header in it (Price destructures its array context value)
    root.render(<PriceCarouselProvider><HeaderMerged {...props} /></PriceCarouselProvider>)
  })
}

describe('HeaderMerged zero-removal', () => {
  it('contains every element of the current two desktop bars', async () => {
    await renderHeader(TURF_PROPS)

    // back arrow (top-bar), back arrow visible because asPath is not '/'
    expect(container.querySelector('a[role="button"] svg')).toBeTruthy()
    // brand wordmark
    expect(container.querySelector('a[href="/"] .brandWordmark')).toBeTruthy()
    // turf selector (second-bar)
    expect(container.querySelector('[data-testid="turf-select"]')).toBeTruthy()
    // lit/new/top sorts (second-bar)
    const linkTexts = Array.from(container.querySelectorAll('a')).map(a => a.textContent)
    expect(linkTexts).toEqual(expect.arrayContaining(['lit', 'new', 'top']))
    // sort links carry the global styling hook (navSortLink) used by the SCSS
    const sortLinks = Array.from(container.querySelectorAll('.navSortLink'))
    expect(sortLinks.length).toBe(3)
    expect(sortLinks.map(a => a.textContent)).toEqual(['lit', 'new', 'top'])
    // search (top-bar)
    expect(container.querySelector('a[href="/search"] svg')).toBeTruthy()
    // price ticker (top-bar): NavPrice's Nav.Item, which wraps the Price
    // component (renders nothing without a price in context)
    expect(container.querySelector('.navMerged .nav-item')).toBeTruthy()
    // post button (second-bar)
    const post = Array.from(container.querySelectorAll('a')).find(a => a.textContent === 'post')
    expect(post).toBeTruthy()
    expect(post.getAttribute('href')).toBe('/~bitcoin/post')
    // logged-out corner (top-bar RightCorner): sign up + login buttons
    const buttonTexts = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
    expect(buttonTexts).toEqual(expect.arrayContaining(['sign up', 'login']))
  })

  it('renders notifications, the @user dropdown and wallet balance when logged in', async () => {
    mockMe = { name: 'u1', bioId: 'x', privates: { piconeros: '5000000000000' } }
    await renderHeader(TURF_PROPS)

    // notifications bell (MeCorner)
    expect(container.querySelector('a[href="/notifications"] svg')).toBeTruthy()
    // @user dropdown toggle (MeCorner)
    expect(container.textContent).toContain('@u1')
    // wallet balance (MeCorner NavWalletSummary): abbrNum(5e12) = '5t'
    expect(container.textContent).toContain('5t')
  })

  it('omits the second-bar elements on non-turf pages like the two-bar header does', async () => {
    await renderHeader({ prefix: '/', path: '/', pathname: '/', topNavKey: 'hot', dropNavKey: '', sub: 'frontpage' })

    expect(container.querySelector('[data-testid="turf-select"]')).toBeNull()
    const linkTexts = Array.from(container.querySelectorAll('a')).map(a => a.textContent)
    expect(linkTexts).not.toEqual(expect.arrayContaining(['post']))
    // top-bar elements still present (brand wordmark)
    expect(container.querySelector('a[href="/"] .brandWordmark')).toBeTruthy()
  })
})

describe('NavRewards', () => {
  it('renders the rewards amount link and a days/hours countdown in the centered cluster', async () => {
    await renderHeader(TURF_PROPS)

    const cluster = container.querySelector('.navCenterCluster')
    expect(cluster).toBeTruthy()

    const amount = cluster.querySelector('a[href="/rewards"]')
    expect(amount).toBeTruthy()
    expect(amount.textContent).toBe('1.2 XMR in rewards')

    const timer = cluster.querySelector('.navRewards .navRewardsTimer')
    expect(timer).toBeTruthy()
    expect(timer.textContent).toMatch(/^\d+d \d{1,2}h$/)

    // divider separates the rewards readout from the price ticker
    expect(cluster.querySelector('.navCenterDivider')).toBeTruthy()

    // the price ticker Nav.Item also lives in the centered cluster
    expect(cluster.querySelectorAll('.nav-item').length).toBeGreaterThanOrEqual(2)
  })

  it('renders nothing when the rewards pool is not available', async () => {
    mockRewardsTotal = ''
    mockRewardsTime = null
    await renderHeader(TURF_PROPS)

    expect(container.querySelector('a[href="/rewards"]')).toBeNull()
    expect(container.querySelector('.navRewards')).toBeNull()
  })
})
