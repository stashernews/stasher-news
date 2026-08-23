/* eslint-env jest */
// Renders the shared Brand component with react-dom/client backed by linkedom
// (repo harness — see test/components/vote-column.test.js for the quirks:
// runtime-absolute jest.mock paths, let mock symbols).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { Brand } from '@/components/nav/common'

let mockBranding = {}

jest.mock(`${process.cwd()}/components/territory-branding`, () => ({
  useBranding: () => mockBranding
}))

jest.mock(`${process.cwd()}/lib/rebrand`, () => ({
  DISPLAY_FONT: 'Chakra Petch'
}))

jest.mock(`${process.cwd()}/lib/rebrand-copy`, () => ({
  COPY: {}
}))

jest.mock(`${process.cwd()}/components/sub-select`, () => () => null)
jest.mock(`${process.cwd()}/components/form`, () => ({
  Form: 'div',
  Input: 'input',
  SubmitButton: 'button',
  CopyButton: 'button'
}))
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  cookieOptions: () => ({}),
  MULTI_AUTH_ANON: 'anon',
  MULTI_AUTH_POINTER: 'pointer'
}))
jest.mock(`${process.cwd()}/components/user-header`, () => ({
  NymActionDropdown: () => null,
  default: () => null
}))
jest.mock(`${process.cwd()}/components/use-cookie`, () => ({
  default: () => [null, () => {}]
}))
jest.mock(`${process.cwd()}/wallets/client/hooks`, () => ({
  useWalletIndicator: () => ({})
}))

jest.mock('next/link', () => {
  const React = require('react')
  return ({ href, children, ...rest }) => React.createElement('a', { href, ...rest }, children)
})

jest.mock('react-bootstrap', () => {
  const React = require('react')
  return {
    Navbar: {
      Brand: ({ as: As, href, className, children }) =>
        As
          ? React.createElement(As, { href, className }, children)
          : React.createElement('a', { href, className }, children)
    },
    Button: ({ children, ...rest }) => React.createElement('button', rest, children),
    Dropdown: ({ children }) => React.createElement('div', null, children),
    Nav: ({ children }) => React.createElement('div', null, children)
  }
})

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

async function renderBrand (props = {}) {
  const root = createRoot(container)
  await act(async () => { root.render(<Brand {...props} />) })
  return root
}

describe('Brand', () => {
  it('renders the wordmark with an orange dot', async () => {
    const root = await renderBrand()
    const wordmark = container.querySelector('.brandWordmark')
    expect(wordmark).toBeTruthy()
    expect(wordmark.textContent).toContain('stasher news')
    expect(wordmark.querySelector('.brandDot')).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it('renders the compact s. mark when compact', async () => {
    const root = await renderBrand({ compact: true })
    const mark = container.querySelector('.brandMark')
    expect(mark).toBeTruthy()
    expect(mark.textContent).toBe('s.')
    expect(container.querySelector('.brandWordmark')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('keeps the territory logo image when a territory is active', async () => {
    mockBranding = { logoId: 'logo-1' }
    const root = await renderBrand()
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.querySelector('.brandWordmark')).toBeNull()
    mockBranding = {}
    await act(async () => { root.unmount() })
  })
})
