/* eslint-env jest */
// There is no component-render harness in this repo (no @testing-library, no
// jsdom), so this test renders the component with react-dom/client backed by
// linkedom (already in node_modules, CJS-loadable — happy-dom is ESM-only and
// jest cannot require it here).
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
// factory covers the up-arrow/down-arrow imports (per-icon mock ids would
// collapse into the last factory — see header-merged.test.js).
jest.mock(`${process.cwd()}/svgs/up-arrow.svg`, () => ({ className }) => <svg className={className}><path d='arrow' /></svg>)

// let, not const: reassigned per-test; jest.mock factories reference these
// lazily (mock*-prefixed per babel-plugin-jest-hoist), so TDZ never applies.
let mockShowModal

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
})
