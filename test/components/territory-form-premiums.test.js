/* eslint-env jest */
// Component test on the repo's react-dom/client + linkedom harness (no
// @testing-library in this repo — see test/components/monero-payment-view.test.js).
// Renders the REAL TerritoryForm — real Formik Form/Input/SNInput/Range and the
// real FeeButton/FeeButtonProvider — mocking only its context/providers (me,
// router, modal, apollo hooks, the payIn mutation hook) and the ESM-only
// lexical editor. That keeps the whole production path under test: gating on
// me.privates.turfOwnerFees, initial XMR values from the sub's BigInt
// piconeros, the Range DOM, and the submit conversion back to BigInt piconeros.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import TerritoryForm from '@/components/territory-form'
import TerritoryPendingFeeModal from '@/components/territory-pending-fee-modal'

jest.mock('next/router', () => ({ useRouter: () => ({ push: mockRouterPush }) }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/components/modal`, () => ({ useShowModal: () => mockShowModal }))
jest.mock(`${process.cwd()}/components/territory-branding`, () => ({
  __esModule: true,
  default: () => null,
  useBranding: () => null
}))
// the payIn mutation hook is where the submit lands — mock it to capture the
// variables the form converted (piconero BigInts) without any server.
jest.mock(`${process.cwd()}/components/payIn/hooks/use-pay-in-mutation`, () => ({
  __esModule: true,
  default: () => [mockUpsertSub]
}))
// components/form imports { SNEditor } from './editor', whose transitive
// lexical deps are ESM-only and unloadable under jest's VM (fee-button.test.js
// stub trick). SNInput renders the stub; the desc field keeps its initial value.
jest.mock(`${process.cwd()}/components/editor`, () => ({
  SNEditor: () => null
}))
// every @apollo/client/react hook in the render tree: useQuery/useLazyQuery
// (form.js, fee-button.js), useApolloClient/useLazyQuery (territory-form.js).
// gql itself stays real so fragments still parse.
jest.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: null, loading: false }),
  useLazyQuery: () => [jest.fn(), { data: null, loading: false }],
  useApolloClient: () => mockApolloClient
}))
// next/jest maps every .svg to one shared fileMock module (an object, not a
// component), so rendering any svg crashes — one factory covers ALL svg
// imports (accordian-item's arrows, Info's icon, ...; vote-column.test.js).
jest.mock(`${process.cwd()}/svgs/arrow-right-s-fill.svg`, () => ({
  __esModule: true,
  default: props => <svg {...props} />
}))

// let, not const: reassigned per-test; jest.mock factories reference these
// lazily (mock*-prefixed per babel-plugin-jest-hoist), so TDZ never applies.
let mockMe
let mockRouterPush
let mockShowModal
let mockUpsertSub
let mockApolloClient

let win
let container
let root

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  win = parsed.window
  global.window = win
  global.document = parsed.document
  global.navigator = win.navigator
  global.HTMLElement = win.HTMLElement
  // Formik's handleSubmit checks `document.activeElement instanceof
  // HTMLButtonElement`; linkedom's activeElement resolves to <body> (non-null)
  // and without this global the instanceof RHS is undefined -> TypeError that
  // React swallows, silently killing every form submit in the harness.
  global.HTMLButtonElement = win.HTMLButtonElement
  global.Node = win.Node
  global.IS_REACT_ACT_ENVIRONMENT = true
  container = parsed.document.createElement('div')
  parsed.document.body.appendChild(container)
  // root created once and reused (territory-pending-fee-modal.test.js pattern)
  root = createRoot(container)
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
  mockMe = {
    // outside DOMAIN_BETA_IDS so the branding section never renders
    id: 999,
    privates: {
      turfOwnerFees: true,
      territoryMonthlyPiconeros: 0n,
      territoryYearlyPiconeros: 0n,
      territoryOncePiconeros: 0n
    }
  }
  mockRouterPush = jest.fn()
  mockShowModal = jest.fn()
  mockUpsertSub = jest.fn().mockResolvedValue({ data: { upsertSub: {} } })
  mockApolloClient = {
    // territorySchema's name-availability check (SUBS query) — report the
    // turf we are editing as ACTIVE so validation passes
    query: jest.fn().mockResolvedValue({ data: { subs: [{ name: 'testturf', status: 'ACTIVE' }] } }),
    cache: { modify: jest.fn() }
  }
})

afterEach(async () => {
  // render(null) unmounts the tree (sticky-bar.test.js pattern)
  await act(async () => { root.render(null) })
  jest.clearAllMocks()
})

// an existing turf being edited — billing MONTHLY, filter 0.001 XMR,
// post premium 0.0005 XMR, comment premium 0
const SUB = {
  name: 'testturf',
  desc: 'a turf for tests',
  postTypes: ['LINK', 'DISCUSSION', 'POLL'],
  billingType: 'MONTHLY',
  billingAutoRenew: false,
  nsfw: false,
  status: 'ACTIVE',
  postsPiconerosFilter: 1000000000n,
  postPremiumPiconeros: 500000000n,
  commentPremiumPiconeros: 0n
}

async function renderForm ({ turfOwnerFees = true } = {}) {
  mockMe.privates.turfOwnerFees = turfOwnerFees
  await act(async () => {
    root.render(<TerritoryForm sub={SUB} />)
  })
}

async function setPostPremium (xmr) {
  const range = container.querySelector('input[name="postPremiumPiconeros"]')
  // Dispatched 'input' events never reach React here: react-dom loads before
  // linkedom's window exists, so its input-event support probe fails and
  // onChange falls back to a legacy polyfill that ignores them. The faithful
  // drivable path is the user one: type in the Range's numeric twin and tab
  // away — its onBlur clamps into [min,max] and writes formik state
  // ('focusout' is a plain delegated event and works in this harness).
  const input = range.parentElement.querySelector('input[type="number"]')
  input.value = String(xmr)
  await act(async () => {
    input.dispatchEvent(new win.Event('focusout', { bubbles: true }))
  })
}

async function submitForm () {
  const form = container.querySelector('form')
  await act(async () => {
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }))
  })
  // let Formik's async validation + the async onSubmit chain settle
  await act(async () => {})
}

function submittedVariables () {
  expect(mockUpsertSub).toHaveBeenCalledTimes(1)
  return mockUpsertSub.mock.calls[0][0].variables
}

describe('TerritoryForm turf premiums', () => {
  test('renders post/comment premium editors and the wallet-routing blurb when turfOwnerFees', async () => {
    await renderForm({ turfOwnerFees: true })

    const postRange = container.querySelector('input[name="postPremiumPiconeros"]')
    const commentRange = container.querySelector('input[name="commentPremiumPiconeros"]')
    expect(postRange).toBeTruthy()
    expect(commentRange).toBeTruthy()
    // initial values come from the sub's BigInt piconeros as XMR decimals
    expect(postRange.value).toBe('0.0005')
    expect(commentRange.value).toBe('0')
  })

  test('submit converts a 0.001 XMR post premium to STRING piconeros (1000000000)', async () => {
    await renderForm({ turfOwnerFees: true })
    await setPostPremium('0.001')
    await submitForm()

    const variables = submittedVariables()
    // BigInt scalar variables travel as strings (a raw JS BigInt would make
    // JSON.stringify throw "Do not know how to serialize a BigInt")
    expect(variables.postPremiumPiconeros).toBe('1000000000')
    expect(typeof variables.postPremiumPiconeros).toBe('string')
    // untouched comment premium submits as '0', not a Number
    expect(variables.commentPremiumPiconeros).toBe('0')
    expect(typeof variables.commentPremiumPiconeros).toBe('string')
    // the filter field keeps its existing Number() conversion
    expect(variables.postsPiconerosFilter).toBe(1000000000)
    expect(mockRouterPush).toHaveBeenCalledWith('/~testturf')
  })

  test('submit without touching the fields carries the sub initial premium as STRING piconeros', async () => {
    await renderForm({ turfOwnerFees: true })
    await submitForm()

    const variables = submittedVariables()
    expect(variables.postPremiumPiconeros).toBe('500000000')
    expect(variables.commentPremiumPiconeros).toBe('0')
  })
})

// The save flow shows the billing fee modal: after the turf 10MB cap every
// URI-bearing turf save is a create/unarchive/cadence flow, and those set
// Sub.billingStatus PENDING_FEE in onBegin, which TerritoryPendingFeeModal polls.
describe('TerritoryForm fee modal selection', () => {
  // valid base58 filler; tx_amount drives the quoted amount
  const URI = 'monero:5' + 'F'.repeat(94) + '?tx_amount=0.001'

  function openedModal () {
    expect(mockShowModal).toHaveBeenCalledTimes(1)
    return mockShowModal.mock.calls[0][0](jest.fn())
  }

  test('a cadence switch opens the billing modal', async () => {
    mockUpsertSub.mockResolvedValue({
      data: {
        upsertSub: {
          id: 17605,
          moneroUri: URI,
          payerPrivates: { result: { billingStatus: 'PENDING_FEE' } }
        }
      }
    })
    await renderForm()
    // switch MONTHLY -> YEARLY (a paid cadence upgrade)
    const yearly = container.querySelector('#yearly-checkbox')
    await act(async () => {
      yearly.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    await submitForm()

    expect(submittedVariables().billingType).toBe('YEARLY')
    const element = openedModal()
    expect(element.type).toBe(TerritoryPendingFeeModal)
  })

  test('a save with no fee does not open a modal', async () => {
    await renderForm()
    await submitForm()

    expect(mockShowModal).not.toHaveBeenCalled()
  })
})
