/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/item-job.test.js for the harness). The
// "award bounty" dropdown entry is ALWAYS enabled — wallet presence is checked
// by the server inside payBounty ('the winner must attach a wallet to receive
// the bounty') and surfaced as a danger toast by useBountyAction, so no
// per-commenter pre-check (or wallet field on the comment fragment) is needed.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { AwardBountyDropdownItem } from '@/components/bounty-actions'

// react-bootstrap's ESM build cannot be require()d under this jest setup
// (typeof default === 'object'), so mimic the components directly and expose
// the props we assert on.
jest.mock('react-bootstrap/Dropdown', () => {
  const React = require('react')
  const Dropdown = ({ children }) => React.createElement('div', null, children)
  Dropdown.Item = ({ disabled, title, onClick, children }) =>
    React.createElement('button', { disabled, title, onClick, className: 'dropdown-item' }, children)
  return { __esModule: true, default: Dropdown }
})
jest.mock('react-bootstrap/Button', () => {
  const React = require('react')
  return { __esModule: true, default: ({ disabled, onClick, children }) => React.createElement('button', { disabled, onClick, className: 'btn' }, children) }
})
// The dropdown only calls showModal(renderCb) on click; capture the callback
// so the modal body (BountyConfirmBody + its confirm button) can be rendered
// by the error-toast test below.
jest.mock(`${process.cwd()}/components/modal`, () => ({
  useShowModal: () => cb => { showModal = cb }
}))
// Module-load guard for the apollo hooks used by the (untouched) modal helpers.
// submitFn is swappable per test so the error path can reject.
let submitFn = jest.fn()
jest.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ cache: { modify: jest.fn() } }),
  useMutation: () => [submitFn, { loading: false }]
}))
// useBountyAction surfaces mutation errors via toaster.danger(error.message) —
// the server's wallet-less-winner rejection must land there.
const dangerMock = jest.fn()
const successMock = jest.fn()
jest.mock(`${process.cwd()}/components/toast`, () => ({
  useToast: () => ({ danger: dangerMock, success: successMock })
}))
// The modal render path (AwardBountyModal -> useBountyAction) also calls
// useAnimation — stub it so rendering the confirm modal stays linkedom-safe.
jest.mock(`${process.cwd()}/components/animation`, () => ({
  useAnimation: () => jest.fn()
}))

let showModal
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
  showModal = null
  submitFn = jest.fn()
  dangerMock.mockClear()
  successMock.mockClear()
})

function item (overrides = {}) {
  return {
    id: '1',
    parentId: '0',
    user: { id: 2, name: 'awardee' },
    ...overrides
  }
}

async function renderAwardItem (winner) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<AwardBountyDropdownItem item={winner} root={{ id: '0' }} />)
  })
  return root
}

describe('AwardBountyDropdownItem', () => {
  it('is always enabled, with no wallet tooltip, even when the winner has no optional data', async () => {
    const root = await renderAwardItem(item({ user: { id: 2, name: 'awardee' } }))

    const entry = container.querySelector('.dropdown-item')
    expect(entry).toBeTruthy()
    expect(entry.getAttribute('disabled')).toBeNull()
    expect(entry.getAttribute('title')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('is enabled regardless of the winner wallet signals (no client pre-check)', async () => {
    // hasWallet/hasAttachedWallet are irrelevant now: the server re-checks at
    // award time. The entry must not depend on either signal.
    const root = await renderAwardItem(item({
      user: { id: 2, name: 'awardee', optional: { hasWallet: false, hasAttachedWallet: false } }
    }))

    const entry = container.querySelector('.dropdown-item')
    expect(entry.getAttribute('disabled')).toBeNull()
    expect(entry.getAttribute('title')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('opens the award modal on click', async () => {
    const root = await renderAwardItem(item({
      user: { id: 2, name: 'awardee', optional: { hasWallet: false } }
    }))

    const entry = container.querySelector('.dropdown-item')
    await act(async () => { entry.click() })
    expect(showModal).toEqual(expect.any(Function))

    await act(async () => { root.unmount() })
  })

  it('surfaces the server wallet rejection as a danger toast on submit', async () => {
    // The full UX for a wallet-less winner: author clicks award, confirms, the
    // payBounty mutation rejects with the server's message, and the toast
    // shows it. This is the behavior that replaces the disabled-entry pre-check.
    submitFn = jest.fn().mockRejectedValue(new Error('the winner must attach a wallet to receive the bounty'))
    const root = await renderAwardItem(item({ user: { id: 2, name: 'awardee' } }))

    const entry = container.querySelector('.dropdown-item')
    await act(async () => { entry.click() })

    // render the captured modal callback into the same container
    const modalRoot = createRoot(container.appendChild(container.ownerDocument.createElement('div')))
    await act(async () => { modalRoot.render(showModal(() => {})) })

    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'award')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click() })

    expect(submitFn).toHaveBeenCalled()
    expect(dangerMock).toHaveBeenCalledWith('the winner must attach a wallet to receive the bounty')

    await act(async () => { root.unmount() })
    await act(async () => { modalRoot.unmount() })
  })
})
