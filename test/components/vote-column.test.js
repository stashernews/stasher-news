/* eslint-env jest */
// There is no component-render harness in this repo (no @testing-library, no
// jsdom; see test/components/downvote-modal.test.js), so this test renders the
// component with react-dom/client backed by linkedom (already in node_modules,
// CJS-loadable — happy-dom is ESM-only and jest cannot require it here).
//
// Module-resolution quirks this repo's jest setup enforces:
//  - jest.mock() string args are NOT rewritten by SWC, so mocks are registered
//    under runtime-computed absolute paths (process.cwd() = repo root).
//  - SWC hoists jest.mock above imports and const/let, so mock paths cannot
//    reference local variables — process.cwd() is inlined in each call.
//  - upvote.js drags in the lexical editor graph via tip-modal, so tip-modal is
//    mocked (it is never rendered by these tests).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import fs from 'fs'
import path from 'path'
import VoteColumn from '@/components/vote-column'
import DownvoteModal from '@/components/downvote-modal'

jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: null }) }))
jest.mock(`${process.cwd()}/components/modal`, () => ({ useShowModal: () => mockShowModal }))
jest.mock(`${process.cwd()}/components/tip-modal`, () => () => null)
jest.mock(`${process.cwd()}/components/form`, () => ({
  Form: 'div',
  Input: 'input',
  SubmitButton: 'button',
  CopyButton: 'button'
}))
// next/jest maps every .svg to a single shared fileMock module, so one mock
// factory covers BOTH the up-arrow and down-arrow imports (per-icon mock ids
// would collapse into the last factory — see header-merged.test.js). The exact
// down-arrow glyph is instead asserted against the svg file itself below.
jest.mock(`${process.cwd()}/svgs/up-arrow.svg`, () => ({ className }) => <svg className={className}><path d='arrow' /></svg>)

// var, not let/const: jest.mock factories may only reference out-of-scope
// names prefixed with "mock", and const/let here would be in TDZ when the
// hoisted jest.mock call runs.
var mockShowModal

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
  mockShowModal = jest.fn()
  container.innerHTML = ''
})

async function renderVoteColumn (props = {}) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<VoteColumn item={{ id: '1', mine: false }} {...props} />)
  })
  return root
}

describe('VoteColumn', () => {
  it('renders an upvote affordance with a visible downvote button', async () => {
    const root = await renderVoteColumn()

    expect(container.querySelector('.upvoteParent')).toBeTruthy()

    const downvote = container.querySelector('[aria-label="downvote"]')
    expect(downvote).toBeTruthy()
    expect(downvote.getAttribute('role')).toBe('button')
    expect(downvote.getAttribute('title')).toBe('downvote')
    expect(downvote.getAttribute('tabindex')).toBe('0')
    // the down arrow is an svg glyph
    expect(downvote.querySelector('svg')).toBeTruthy()

    await act(async () => { root.unmount() })
  })

  it('downvote uses a down arrow that mirrors the up arrow', () => {
    const up = fs.readFileSync(path.join(process.cwd(), 'svgs/up-arrow.svg'), 'utf8')
    const down = fs.readFileSync(path.join(process.cwd(), 'svgs/down-arrow.svg'), 'utf8')
    // down-arrow is the up-arrow path mirrored on the Y axis (y -> 24 - y)
    expect(up).toContain('M12 3L20 12L15 12L15 21L9 21L9 12L4 12Z')
    expect(down).toContain('M12 21L20 12L15 12L15 3L9 3L9 12L4 12Z')
  })

  it('clicking the downvote opens the same DownvoteModal the ⋮ menu uses', async () => {
    const root = await renderVoteColumn()

    const downvote = container.querySelector('[aria-label="downvote"]')
    await act(async () => {
      downvote.dispatchEvent(new win.Event('click', { bubbles: true }))
    })

    expect(mockShowModal).toHaveBeenCalledTimes(1)
    const contentFactory = mockShowModal.mock.calls[0][0]
    const node = contentFactory(() => {})
    expect(node.type).toBe(DownvoteModal)
    expect(node.props.item).toEqual({ id: '1', mine: false })

    await act(async () => { root.unmount() })
  })

  it('Enter key on the downvote button opens the modal too', async () => {
    const root = await renderVoteColumn()

    const downvote = container.querySelector('[aria-label="downvote"]')
    const keydown = new win.Event('keydown', { bubbles: true })
    Object.defineProperty(keydown, 'key', { value: 'Enter' })
    await act(async () => {
      downvote.dispatchEvent(keydown)
    })

    expect(mockShowModal).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
  })

  it('passes className and collapsed through to the up arrow', async () => {
    const root = await renderVoteColumn({ className: 'fancy-up', collapsed: true })

    const upArrow = container.querySelector('.upvoteParent svg')
    expect(upArrow.getAttribute('class')).toContain('fancy-up')
    // collapsed disables the upvote, adding the no-self-tip class
    expect(container.querySelector('.upvoteParent .noSelfTips')).toBeTruthy()

    await act(async () => { root.unmount() })
  })
})
