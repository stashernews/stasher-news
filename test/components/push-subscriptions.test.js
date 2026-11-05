/* eslint-env jest */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { ServiceWorkerProvider, useServiceWorker } from '../../components/serviceworker'
import Login from '../../components/login'

jest.mock('workbox-window', () => ({ Workbox: jest.fn() }))
jest.mock('../../components/use-indexeddb', () => ({ requestPersistentStorage: jest.fn() }))
jest.mock('@apollo/client/react', () => ({ useMutation: jest.fn() }))
jest.mock('next/router', () => ({ useRouter: () => ({ query: {} }) }))
jest.mock('../../components/use-cookie', () => ({ __esModule: true, default: () => [null, setCookie] }))
jest.mock('../../components/form', () => ({ Form: ({ children }) => <form>{children}</form>, Input: () => null, SubmitButton: () => null }))
jest.mock('../../components/nostr-auth', () => ({ NostrAuthWithExplainer: () => null }))
jest.mock('../../components/phrase-login-form', () => ({ __esModule: true, default: () => null }))
jest.mock('../../components/account', () => ({ AccountChooser: () => null }))
jest.mock('../../components/login-button', () => ({ __esModule: true, default: () => null, LoginWithNymButton: () => null }))
const setCookie = () => {}

let sw, root, old, registration, current, saved, deleted, values, session
let activeUserId = 7
jest.mock('../../components/me', () => ({ useMe: () => ({ me: activeUserId === undefined ? undefined : (activeUserId ? { id: activeUserId } : null) }) }))
const validKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url')

function Consumer () { sw = useServiceWorker(); return <span>{String(sw.hasSubscription)}</span> }
const render = () => root.render(<ServiceWorkerProvider><Consumer /></ServiceWorkerProvider>)

beforeEach(async () => {
  activeUserId = 7
  old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT, env: { ...process.env } }
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  window.location = new URL('https://example.test/login')
  values = new Map()
  session = new Map()
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  window.sessionStorage = { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) }
  window.Notification = { permission: 'granted', requestPermission: async () => 'granted' }
  window.PushManager = class {}
  current = null
  registration = {
    active: { postMessage: jest.fn() },
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        current = { endpoint: 'https://push.example/1', keys: { p256dh: 'key', auth: 'auth' }, unsubscribe: async () => { current = null; return true } }
        return current
      }
    }
  }
  Object.assign(global, { window, document: window.document, navigator: { serviceWorker: { getRegistration: async () => registration, controller: registration.active } }, IS_REACT_ACT_ENVIRONMENT: true })
  process.env.NEXT_PUBLIC_VAPID_PUBKEY = validKey
  process.env.NODE_ENV = 'production'
  require('workbox-window').Workbox.mockImplementation(() => ({ register: async () => registration }))
  saved = jest.fn(async () => ({ data: { savePushSubscription: { id: 1 } } }))
  deleted = jest.fn(async () => ({ data: { deletePushSubscription: { id: 1 } } }))
  require('@apollo/client/react').useMutation.mockImplementation(query => [query.definitions[0].name.value === 'savePushSubscription' ? saved : deleted])
  root = createRoot(window.document.getElementById('root'))
  await act(async () => render())
})

afterEach(async () => {
  await act(async () => root.unmount())
  process.env = old.env
  delete old.env
  Object.assign(global, old)
})

test('successful opt-in updates visible subscription state and stores account ownership', async () => {
  await act(async () => sw.togglePushSubscription())
  expect(sw.hasSubscription).toBe(true)
  expect(saved.mock.calls[0][0].variables).toMatchObject({ expectedUserId: 7, sendConfirmation: true })
  expect(registration.active.postMessage).toHaveBeenCalledWith(expect.objectContaining({ subscription: expect.objectContaining({ userId: 7 }) }))
})

test('account switching revokes old delivery but remembers the browser opt-in', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.prepareAccountSwitch())
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
  expect(values.get('pushEnabled')).toBe('true')
  expect(deleted).toHaveBeenCalledWith({ variables: { endpoint: 'https://push.example/1' } })
})

test('explicit disable clears opt-in so subsequent logins do not resubscribe', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.togglePushSubscription())
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
  expect(values.get('pushEnabled')).not.toBe('true')
})

test('a failed confirmation is visible to the caller and rolls back browser delivery', async () => {
  saved.mockRejectedValue(new Error('push provider rejected configuration'))
  await act(async () => {
    await expect(sw.togglePushSubscription()).rejects.toThrow('push provider rejected configuration')
  })
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
})

test('a new active account resumes browser opt-in without sending another confirmation', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.prepareAccountSwitch())
  await act(async () => root.unmount())
  activeUserId = 8
  root = createRoot(window.document.getElementById('root'))
  await act(async () => render())
  expect(sw.hasSubscription).toBe(true)
  expect(saved.mock.calls.at(-1)[0].variables).toMatchObject({ expectedUserId: 8, sendConfirmation: false })
})

test('an anonymous session revokes delivery instead of retaining the previous account subscription', async () => {
  await act(async () => sw.togglePushSubscription())
  activeUserId = null
  await act(async () => render())
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
})

test('switching waits for an in-flight subscription before revoking it', async () => {
  let finishSave
  let started
  const saving = new Promise(resolve => { started = resolve })
  saved.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; started() }))
  await act(async () => {
    const enabling = sw.togglePushSubscription()
    await saving
    const switching = sw.prepareAccountSwitch()
    finishSave({ data: { savePushSubscription: { id: 1 } } })
    await Promise.all([enabling, switching])
  })
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
})

test('identity changes during a pending save reconcile the latest account without a remount', async () => {
  let finishSave, started, enabling
  const saving = new Promise(resolve => { started = resolve })
  saved.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; started() }))
  await act(async () => {
    enabling = sw.togglePushSubscription()
    await saving
  })
  await act(async () => {
    activeUserId = null
    render()
  })
  await act(async () => {
    finishSave({ data: { savePushSubscription: { id: 1 } } })
    await enabling
  })
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
})

test('canceling an account transition resumes the opted-in account', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.prepareAccountSwitch())
  await act(async () => sw.resumePushSubscription())
  expect(current).not.toBeNull()
  expect(sw.hasSubscription).toBe(true)
})

test('login holds push revoked while the authenticated identity hydrates', async () => {
  await act(async () => sw.togglePushSubscription())
  activeUserId = null
  const login = () => root.render(<ServiceWorkerProvider><Consumer /><Login signin multiAuth /></ServiceWorkerProvider>)
  await act(async () => login())
  expect(current).toBeNull()
  activeUserId = 7
  await act(async () => login())
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
  await act(async () => render())
  expect(current).not.toBeNull()
})

test('an unresolved identity neither revokes nor resumes existing delivery', async () => {
  await act(async () => sw.togglePushSubscription())
  activeUserId = undefined
  await act(async () => render())
  expect(current).not.toBeNull()
  expect(sw.hasSubscription).toBe(true)
  expect(deleted).not.toHaveBeenCalled()
})

test('a full page reload during an email switch keeps the revoked account offline', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.prepareAccountSwitch())
  expect(session.get('pushTransitionFrom')).toBe('7')
  await act(async () => root.unmount())
  root = createRoot(window.document.getElementById('root'))
  await act(async () => render())
  expect(current).toBeNull()
  expect(sw.hasSubscription).toBe(false)
  expect(session.get('pushTransitionFrom')).toBe('7')
})

test('completing the switch releases the held revocation for the new account', async () => {
  await act(async () => sw.togglePushSubscription())
  await act(async () => sw.prepareAccountSwitch())
  await act(async () => root.unmount())
  activeUserId = 8
  root = createRoot(window.document.getElementById('root'))
  await act(async () => render())
  expect(saved.mock.calls.at(-1)[0].variables).toMatchObject({ expectedUserId: 8, sendConfirmation: false })
  expect(current).not.toBeNull()
  expect(session.has('pushTransitionFrom')).toBe(false)
})

test('a failed switch attempt clears the held transition state', async () => {
  const failing = jest.fn(async () => { throw new Error('revocation failed') })
  deleted.mockImplementationOnce(failing)
  await act(async () => sw.togglePushSubscription())
  await act(async () => {
    await expect(sw.prepareAccountSwitch()).rejects.toThrow('revocation failed')
  })
  expect(session.has('pushTransitionFrom')).toBe(false)
})

test('an anonymous-origin transition does not persist across a page reload', async () => {
  // re-render first so the provider's prepare closure runs with the anonymous
  // identity, then revoke
  activeUserId = null
  await act(async () => render())
  await act(async () => sw.prepareAccountSwitch())
  await act(async () => root.unmount())
  root = createRoot(window.document.getElementById('root'))
  await act(async () => render())
  expect(session.has('pushTransitionFrom')).toBe(false)
  activeUserId = 7
  await act(async () => render())
  // the transition must not survive the reload: push changes are available
  // again once a real identity is confirmed
  await act(async () => sw.togglePushSubscription())
  expect(saved.mock.calls.at(-1)[0].variables).toMatchObject({ expectedUserId: 7, sendConfirmation: true })
})
