/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
//
// The inline "award bounty" trigger replaced the three-dots dropdown item
// (7324a331). It is rendered by components/comment.js directly — deliberately
// NOT inside components/reply.js — so it stays visible when the reply editor
// is open (a comment's own /items/<commentId> page passes replyOpen) and on
// depth-limited comments that render "view all replies" instead of a reply
// row (bottomedOut). Reply is mocked to render no children (just an
// identifiable stub), so these tests pin Comment's own rendering decisions.
// The wallet-less-winner rejection is still enforced server-side inside
// payBounty and surfaced as a danger toast by the shared AwardBountyModal,
// covered in the second half.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import AwardBounty from '@/components/award-bounty'
import Comment from '@/components/comment'
import { COMMENT_DEPTH_LIMIT } from '@/lib/constants'

// react-bootstrap's ESM build cannot be require()d under this jest setup
// (typeof default === 'object'), so mimic the pieces the modal renders.
jest.mock('react-bootstrap/Button', () => {
  const React = require('react')
  return { __esModule: true, default: ({ disabled, onClick, children }) => React.createElement('button', { disabled, onClick, className: 'btn' }, children) }
})
jest.mock('react-bootstrap/Badge', () => ({ __esModule: true, default: () => null }))

// Comment's leaves are mocked so a render exercises only Comment's own
// visibility decisions. The Reply mock intentionally renders no children (the
// award trigger must not depend on Reply rendering anything — the regression)
// and is identifiable so a test can prove a surface did/didn't render it.
jest.mock(`${process.cwd()}/components/reply`, () => {
  const React = require('react')
  return { __esModule: true, default: () => React.createElement('div', { 'data-testid': 'reply' }) }
})
jest.mock(`${process.cwd()}/components/text`, () => ({ __esModule: true, default: () => null, SearchText: () => null }))
jest.mock(`${process.cwd()}/components/vote-column`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/upvote`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/boost-button`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/share`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/item-info`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/link-to-context`, () => ({ __esModule: true, default: ({ children }) => children }))
jest.mock(`${process.cwd()}/components/comment-edit`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/item-addendum-form`, () => ({
  __esModule: true,
  default: () => null,
  ExpiredFullEditNotice: () => null
}))
jest.mock(`${process.cwd()}/components/item-addendum`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/use-quote-reply`, () => ({
  useQuoteReply: () => ({ ref: null, quote: null, quoteReply: jest.fn(), cancelQuote: jest.fn() })
}))
jest.mock(`${process.cwd()}/components/use-can-edit`, () => () => [false, jest.fn(), null, 'NONE'])
jest.mock(`${process.cwd()}/svgs/eye-fill.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/eye-close-line.svg`, () => () => null)
jest.mock('next/link', () => {
  const React = require('react')
  return {
    __esModule: true,
    default: ({ href, children, ...rest }) => React.createElement('a', { href: typeof href === 'string' ? href : '/', ...rest }, children)
  }
})
jest.mock('next/router', () => ({ useRouter: () => mockRouter }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/components/root`, () => ({
  RootProvider: ({ children }) => children,
  useRoot: () => mockRoot
}))
// The trigger (and the modal) only call showModal(renderer) on click; capture
// the renderer so the rejection test can render the confirm body itself.
jest.mock(`${process.cwd()}/components/modal`, () => ({
  useShowModal: () => cb => { showModal = cb }
}))
// useBountyAction surfaces mutation errors via toaster.danger(error.message) —
// the server's wallet-less-winner rejection must land there.
jest.mock(`${process.cwd()}/components/toast`, () => ({
  useToast: () => ({ danger: mockDanger, success: mockSuccess })
}))
// The modal render path (AwardBountyModal -> useBountyAction) also calls
// useAnimation — stub it so rendering the confirm modal stays linkedom-safe.
jest.mock(`${process.cwd()}/components/animation`, () => ({ useAnimation: () => jest.fn() }))
// submitFn is swappable per test so the error path can reject.
jest.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ cache: { modify: jest.fn(), readFragment: () => null } }),
  useMutation: () => [submitFn, { loading: false }]
}))

let mockMe = null
let mockRoot = null
const mockRouter = { query: {}, push: jest.fn() }
let submitFn = jest.fn()
let showModal
const mockDanger = jest.fn()
const mockSuccess = jest.fn()

const AUTHOR = { id: 1, name: 'stasher', privates: {} }
const AWARDEE = { id: 2, name: 'awardee' }

function fundedRoot (overrides = {}) {
  return {
    id: '0',
    user: AUTHOR,
    bountyStatus: 'FUNDED',
    ncomments: 0,
    meCommentsViewedAt: new Date().toISOString(),
    lastCommentAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function commentItem (overrides = {}) {
  return {
    id: '1',
    parentId: '0',
    path: '0.1',
    user: AWARDEE,
    netInvestment: 1,
    ncomments: 0,
    nDirectComments: 0,
    comments: { comments: [] },
    ...overrides
  }
}

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

  // Comment persists its collapsed state in localStorage; linkedom has none.
  const store = new Map()
  win.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear()
  }

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
  mockMe = AUTHOR
  mockRoot = fundedRoot()
  submitFn = jest.fn()
  mockDanger.mockClear()
  mockSuccess.mockClear()
})

const awardControl = () => [...container.querySelectorAll('[role="button"]')]
  .find(el => el.textContent === 'award bounty')

async function renderComment ({ item, ...props } = {}) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<Comment item={item || commentItem()} {...props} />)
  })
  return root
}

async function renderAwardTrigger ({ item } = {}) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<AwardBounty item={item || commentItem()} />)
  })
  return root
}

describe('award trigger visibility on comments', () => {
  it('renders once on an ordinary comment (reply row present, no duplicate controls)', async () => {
    const root = await renderComment()
    const controls = [...container.querySelectorAll('[role="button"]')]
      .filter(el => el.textContent === 'award bounty')
    expect(controls).toHaveLength(1)
    expect(container.querySelector('[data-testid="reply"]')).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it("renders on a comment's own permalink surface (replyOpen)", async () => {
    // item-full.js renders a comment page as
    // <Comment topLevel replyOpen includeParent noComments>; Reply itself
    // renders no children there (its action row is replaced by the editor).
    const root = await renderComment({ topLevel: true, replyOpen: true, includeParent: true, noComments: true })
    expect(container.querySelector('[data-testid="reply"]')).toBeTruthy()
    expect(awardControl()).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it('renders on a depth-limited comment, which renders no Reply row at all', async () => {
    const root = await renderComment({ depth: COMMENT_DEPTH_LIMIT })
    expect(container.querySelector('[data-testid="reply"]')).toBeFalsy()
    expect(awardControl()).toBeTruthy()
    await act(async () => { root.unmount() })
  })

  it('does not render when the comment deliberately has no reply affordance (noReply)', async () => {
    const root = await renderComment({ noReply: true })
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })

  it('does not render for an anonymous viewer', async () => {
    mockMe = null
    const root = await renderComment()
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })

  it('does not render for a viewer who is not the bounty author', async () => {
    mockMe = { id: 99, name: 'someone-else', privates: {} }
    const root = await renderComment()
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })

  it('does not render when the root bounty is not FUNDED', async () => {
    mockRoot = fundedRoot({ bountyStatus: 'AWARDED' })
    const root = await renderComment()
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })

  it('does not render on the viewer-owned comment (awarding your own comment)', async () => {
    const root = await renderComment({ item: commentItem({ mine: true }) })
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })

  it('does not render on a deleted comment', async () => {
    const root = await renderComment({ item: commentItem({ deletedAt: new Date().toISOString() }) })
    expect(awardControl()).toBeFalsy()
    await act(async () => { root.unmount() })
  })
})

describe('shared award modal', () => {
  it('opens the award modal from the inline trigger', async () => {
    const root = await renderAwardTrigger()
    const trigger = awardControl()
    expect(trigger).toBeTruthy()

    await act(async () => { trigger.click() })
    expect(showModal).toEqual(expect.any(Function))

    await act(async () => { root.unmount() })
  })

  it('surfaces the server wallet rejection as a danger toast on submit', async () => {
    // The full UX for a wallet-less winner: author clicks award, confirms, the
    // payBounty mutation rejects with the server's message, and the toast
    // shows it. This is the behavior that replaces the disabled-entry
    // pre-check — the trigger is never gated on the winner's wallet.
    submitFn = jest.fn().mockRejectedValue(new Error('the winner must attach a wallet to receive the bounty'))
    const root = await renderAwardTrigger()
    await act(async () => { awardControl().click() })

    // render the captured modal renderer into the same container
    const modalRoot = createRoot(container.appendChild(container.ownerDocument.createElement('div')))
    await act(async () => { modalRoot.render(showModal(() => {})) })

    const confirm = [...container.querySelectorAll('button')].find(b => b.textContent === 'award')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click() })

    expect(submitFn).toHaveBeenCalledWith({ variables: { id: '0', winnerCommentId: '1' } })
    expect(mockDanger).toHaveBeenCalledWith('the winner must attach a wallet to receive the bounty')

    await act(async () => { root.unmount() })
    await act(async () => { modalRoot.unmount() })
  })
})
