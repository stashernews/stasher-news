/* eslint-env jest */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { signIn } from 'next-auth/react'

// component modules are required lazily inside each test, after the linkedom
// globals exist: react-bootstrap's Dropdown captures `window` through
// @restart/ui's context at first module load, so the load order matters
const loadLogin = () => require('../../components/login')

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }))
const mockReload = jest.fn()
jest.mock('next/router', () => ({
  useRouter: () => ({ query: {}, pathname: '/login', push: jest.fn(), reload: mockReload })
}))
const mockPointer = { current: null }
const mockSetPointer = jest.fn()
jest.mock('../../components/use-cookie', () => ({
  __esModule: true,
  default: () => [mockPointer.current, mockSetPointer]
}))
const mockPrepare = jest.fn(async () => {})
const mockResume = jest.fn()
jest.mock('../../components/serviceworker', () => ({ useServiceWorker: () => ({ prepareAccountSwitch: mockPrepare, resumePushSubscription: mockResume }) }))
jest.mock('../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../components/nostr-auth', () => ({ NostrAuthWithExplainer: () => null }))
const mockAccounts = [{ id: 7, name: 'alice' }, { id: 8, name: 'bob' }]
jest.mock('../../components/account', () => ({ AccountChooser: () => null, useAccounts: () => mockAccounts }))
jest.mock('../../components/phrase-login-form', () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/svgs/sn.svg`, () => ({ className, width }) => <svg className={className} width={width} />)
jest.mock(`${process.cwd()}/svgs/editor/toolbar/arrow-down.svg`, () => ({ width }) => <svg width={width} />)
// inert scaffolding for the bootstrap widgets: linkedom cannot satisfy the
// popper/computed-style stack a live Dropdown needs, and the tests here
// assert the handlers' wiring, not bootstrap's rendering
jest.mock('react-bootstrap', () => {
  const React = require('react')
  const passthrough = tag => ({ children, onClick, disabled, className, title, style, variant, split }) =>
    React.createElement(tag, { onClick, disabled, className, title, style }, children)
  const Dropdown = ({ children, as: As }) => <As>{children}</As>
  Dropdown.Toggle = passthrough('button')
  Dropdown.Menu = ({ children }) => <div>{children}</div>
  Dropdown.Item = passthrough('a')
  return { __esModule: true, Button: passthrough('button'), ButtonGroup: ({ children }) => <div>{children}</div>, Dropdown, Alert: ({ children }) => <div>{children}</div> }
})

const providers = {
  phrase: { id: 'phrase', name: 'Phrase', type: 'credentials' },
  email: { id: 'email', name: 'Email', type: 'email' },
  github: { id: 'github', name: 'GitHub', type: 'oauth' }
}

beforeEach(() => {
  mockPrepare.mockClear()
  mockResume.mockClear()
  mockReload.mockClear()
  mockSetPointer.mockClear()
})

async function renderLogin (buildElement) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  window.location = new URL('https://example.test/login')
  const stored = new Map()
  window.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(global, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(window.document.getElementById('root'))
  try {
    await act(async () => root.render(buildElement()))
    return window.document.getElementById('root').innerHTML
  } finally {
    await act(async () => root.unmount())
    Object.assign(global, old)
  }
}

test.each([true, 'true'])('offers recovery-phrase login when adding an existing account (multiAuth=%s)', async multiAuth => {
  const html = await renderLogin(() => {
    const Login = loadLogin().default
    return <Login providers={providers} signin multiAuth={multiAuth} />
  })

  expect(html).toMatch(/<button[^>]*>Log in without Email<\/button>/)
  expect(html).not.toContain('disabled=')
  expect(html).not.toContain('with GitHub')
})

test.each([true, 'true'])('offers an enabled email form when adding an existing account (multiAuth=%s)', async multiAuth => {
  const html = await renderLogin(() => {
    const Login = loadLogin().default
    return <Login providers={providers} signin multiAuth={multiAuth} text='Log in' />
  })

  expect(html).toContain('name="email"')
  expect(html).toContain('Log in with Email')
  expect(html).not.toContain('disabled=')
  expect(html).not.toContain('with GitHub')
})

test('submitting an email preserves the callback and account-switching intent', async () => {
  const originalWindow = global.window
  const setItem = jest.fn()
  global.window = { sessionStorage: { setItem } }
  try {
    const { EmailLoginForm } = loadLogin()
    const form = EmailLoginForm({ callbackUrl: '/settings', multiAuth: true })
    await form.props.onSubmit({ email: 'existing@example.com' })

    expect(setItem).toHaveBeenCalledWith('callback', JSON.stringify({ email: 'existing@example.com', callbackUrl: '/settings' }))
    expect(signIn).toHaveBeenCalledWith('email', {
      email: 'existing@example.com', callbackUrl: '/settings', multiAuth: true
    })
  } finally {
    global.window = originalWindow
  }
})

test('re-selecting the active nym neither revokes push nor reloads', async () => {
  mockPointer.current = '7'
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  window.location = new URL('https://example.test/login')
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(global, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(window.document.getElementById('root'))
  try {
    const { LoginWithNymButton } = require('../../components/login-button')
    await act(async () => root.render(<LoginWithNymButton callbackUrl='/' />))
    // the mocked Dropdown.Item renders its onClick handler on plain anchors
    const items = [...window.document.querySelectorAll('a')]
    expect(items).toHaveLength(2)
    // the already-active account is a no-op: a same-identity revocation
    // would persist a transition the identity hold never releases
    await act(async () => { items[0].click() })
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockReload).not.toHaveBeenCalled()
    expect(mockSetPointer).not.toHaveBeenCalled()
    // switching to the other account still revokes first
    await act(async () => { items[1].click() })
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    expect(mockSetPointer).toHaveBeenCalledWith(8, expect.anything())
    expect(mockReload).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    Object.assign(global, old)
  }
})
