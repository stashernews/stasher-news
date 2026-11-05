/* eslint-env jest */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import Login from '../../components/login'

let prepare, resume, setPointer
const setCookie = (...args) => setPointer(...args)
jest.mock('../../components/serviceworker', () => ({ useServiceWorker: () => ({ prepareAccountSwitch: prepare, resumePushSubscription: resume }) }))
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/login' }) }))
jest.mock('../../components/use-cookie', () => ({ __esModule: true, default: () => [null, setCookie] }))
jest.mock('../../components/form', () => ({ Form: ({ children }) => <form>{children}</form>, Input: () => <input />, SubmitButton: () => <button>login</button> }))
jest.mock('../../components/nostr-auth', () => ({ NostrAuthWithExplainer: () => null }))
jest.mock('../../components/phrase-login-form', () => ({ __esModule: true, default: () => null }))
jest.mock('../../components/account', () => ({ AccountChooser: () => null }))
jest.mock('../../components/login-button', () => ({ __esModule: true, default: () => null, LoginWithNymButton: () => null }))

test.each([false, true])('shared login entry waits for push revocation; custom-domain signup=%s', async customSignup => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  window.location = new URL('https://example.test/login')
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(global, { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })
  let complete
  prepare = jest.fn(() => new Promise(resolve => { complete = resolve }))
  resume = jest.fn()
  setPointer = jest.fn()
  const root = createRoot(window.document.getElementById('root'))
  try {
    await act(async () => root.render(<Login providers={{ email: { id: 'email', name: 'Email' } }} signin={!customSignup} multiAuth={!customSignup} domainData={customSignup ? { domain: 'example.test' } : null} />))
    expect(window.document.querySelector('form')).toBeNull()
    expect(setPointer).not.toHaveBeenCalled()
    await act(async () => complete())
    expect(window.document.querySelector('form')).not.toBeNull()
    if (customSignup) expect(setPointer).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(resume).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    Object.assign(global, old)
  }
})
