/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/item-job.test.js for the harness). The
// "award bounty" dropdown entry must be ENABLED for any winner with an attached
// wallet (UserOptional.hasAttachedWallet) — even when UserOptional.hasWallet is
// false because the winner is below the canPostFree reputation gate — and
// DISABLED with an accurate tooltip when the winner has no wallet.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { AwardBountyDropdownItem } from '@/components/bounty-actions'

// react-bootstrap's ESM build cannot be require()d under this jest setup
// (typeof default === 'object'), so mimic Dropdown + Dropdown.Item directly
// and expose the props we assert on.
jest.mock('react-bootstrap/Dropdown', () => {
  const React = require('react')
  const Dropdown = ({ children }) => React.createElement('div', null, children)
  Dropdown.Item = ({ disabled, title, onClick, children }) =>
    React.createElement('button', { disabled, title, onClick, className: 'dropdown-item' }, children)
  return { __esModule: true, default: Dropdown }
})
// The dropdown only calls showModal(renderCb) on click; capture the callback
// without rendering the modal (the modal path is unchanged by this fix).
jest.mock(`${process.cwd()}/components/modal`, () => ({
  useShowModal: () => cb => { showModal = cb }
}))
// Module-load guard for the apollo hooks used by the (untouched) modal helpers.
jest.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ cache: { modify: jest.fn() } }),
  useMutation: () => [jest.fn(), { loading: false }]
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
  it('is enabled for a winner with an attached wallet even when hasWallet is false (below the reputation gate)', async () => {
    const root = await renderAwardItem(item({
      user: { id: 2, name: 'awardee', optional: { hasWallet: false, hasAttachedWallet: true } }
    }))

    const entry = container.querySelector('.dropdown-item')
    expect(entry).toBeTruthy()
    expect(entry.getAttribute('disabled')).toBeNull()
    expect(entry.getAttribute('title')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('is disabled with an accurate tooltip when the winner has no attached wallet', async () => {
    const root = await renderAwardItem(item({
      user: { id: 2, name: 'awardee', optional: { hasWallet: false, hasAttachedWallet: false } }
    }))

    const entry = container.querySelector('.dropdown-item')
    expect(entry).toBeTruthy()
    expect(entry.getAttribute('disabled')).not.toBeNull()
    expect(entry.getAttribute('title')).toBe('awardee has no wallet attached')

    await act(async () => { root.unmount() })
  })

  it('is disabled when the user object or optional is missing', async () => {
    const root = await renderAwardItem(item({ user: { id: 2, name: 'awardee' } }))

    const entry = container.querySelector('.dropdown-item')
    expect(entry.getAttribute('disabled')).not.toBeNull()

    await act(async () => { root.unmount() })
  })

  it('opens the award modal on click when enabled', async () => {
    const root = await renderAwardItem(item({
      user: { id: 2, name: 'awardee', optional: { hasAttachedWallet: true } }
    }))

    const entry = container.querySelector('.dropdown-item')
    await act(async () => { entry.click() })
    expect(showModal).toEqual(expect.any(Function))

    await act(async () => { root.unmount() })
  })
})
