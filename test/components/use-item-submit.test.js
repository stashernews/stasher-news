/* eslint-env jest */
// Hook harness on the repo's react-dom/client + linkedom setup (no
// testing-library). useItemSubmit is the shared submit path for posts, comments
// and their edits; the test drives its returned callback and asserts which fee
// modal the submit surfaces, because the two flows settle on different signals:
//   - a create (or a PENDING_FEE item) is gated by Item.feeStatus, which flips
//     to FEE_PAID when the posting fee is observed → PostingFeeModal
//   - an EDIT's upload fee has no record state that flips (Item.feeStatus still
//     reads FEE_PAID from the creation fee), so it must track the fee PayIn
//     directly → UploadFeeModal (polls PayIn.feeCovered)
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import useItemSubmit from '@/components/use-item-submit'
import PostingFeeModal from '@/components/posting-fee-modal'
import UploadFeeModal from '@/components/upload-fee-modal'
import { UPDATE_COMMENT } from '@/fragments/payIn'

jest.mock('next/router', () => ({ useRouter: () => ({ push: mockRouterPush }) }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: mockMe }) }))
jest.mock(`${process.cwd()}/components/modal`, () => ({ useShowModal: () => mockShowModal }))
jest.mock(`${process.cwd()}/components/toast`, () => ({ useToast: () => mockToaster }))
jest.mock(`${process.cwd()}/components/territory-branding`, () => ({
  __esModule: true,
  useBranding: () => null
}))
jest.mock(`${process.cwd()}/components/use-crossposter`, () => ({
  __esModule: true,
  default: () => mockCrossposter
}))
jest.mock(`${process.cwd()}/components/payIn/hooks/use-pay-in-mutation`, () => ({
  __esModule: true,
  default: () => [mockMutate]
}))
// PostingFeeModal/UploadFeeModal import useQuery at module scope; loading the
// real apollo client in this sandbox is unnecessary for a selection test
jest.mock('@apollo/client/react', () => ({ useQuery: () => ({ data: null }) }))
// components/form imports { SNEditor } from './editor', whose transitive
// lexical deps are ESM-only and unloadable under jest's VM (territory-form-
// premiums stub trick)
jest.mock(`${process.cwd()}/components/editor`, () => ({
  SNEditor: () => null
}))

// Valid base58 (charset [1-9A-HJ-NP-Za-km-z], 95 chars) so moneroUriAddress()
// accepts it. Leading '5' mimics a stagenet primary address; content is filler.
const URI_FULL = 'monero:5' + 'F'.repeat(94) + '?tx_amount=0.001'

let mockRouterPush
let mockMe
let mockShowModal
let mockToaster
let mockCrossposter
let mockMutate
let submitRef

let container
let root

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  global.window = parsed.window
  global.document = parsed.document
  global.navigator = parsed.window.navigator
  global.HTMLElement = parsed.window.HTMLElement
  global.Node = parsed.window.Node
  global.IS_REACT_ACT_ENVIRONMENT = true
  container = parsed.document.createElement('div')
  parsed.document.body.appendChild(container)
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
  mockRouterPush = jest.fn()
  mockMe = { id: 7, privates: {} }
  mockShowModal = jest.fn()
  mockToaster = { success: jest.fn(), warning: jest.fn(), danger: jest.fn(), info: jest.fn() }
  mockCrossposter = jest.fn()
  mockMutate = jest.fn()
})

afterEach(async () => {
  await act(async () => { root.render(null) })
  submitRef = undefined
  jest.clearAllMocks()
})

// the PayIn payload the mutation root field resolves to (PAY_IN_FIELDS subset)
function payInResponse (id) {
  return {
    id,
    payInState: 'PAID',
    moneroUri: URI_FULL,
    payerPrivates: { result: { __typename: 'Item', id: 99 } }
  }
}

function Harness ({ item, navigateOnSubmit }) {
  submitRef = useItemSubmit(UPDATE_COMMENT, { item, navigateOnSubmit })
  return null
}

async function submit ({ item, navigateOnSubmit }) {
  await act(async () => {
    root.render(<Harness item={item} navigateOnSubmit={navigateOnSubmit} />)
  })
  await act(async () => {
    await submitRef({ text: 'edited with a big video' }, { resetForm: jest.fn() })
  })
}

function openedModal () {
  expect(mockShowModal).toHaveBeenCalledTimes(1)
  return mockShowModal.mock.calls[0][0](jest.fn())
}

describe('useItemSubmit fee modal selection', () => {
  test('an edit with an upload fee opens the coverage-tracked upload fee modal', async () => {
    mockMutate.mockResolvedValue({ data: { upsertComment: payInResponse(17650) } })
    await submit({ item: { id: 99, text: 'old text' } })

    const element = openedModal()
    expect(element.type).toBe(UploadFeeModal)
    expect(element.props.payInId).toBe(17650)
    expect(element.props.moneroUri).toBe(URI_FULL)
    expect(element.props.itemId).toBe(99)
  })

  test('an in-place edit with an upload fee opens the modal without an itemId to navigate to', async () => {
    mockMutate.mockResolvedValue({ data: { upsertComment: payInResponse(17653) } })
    await submit({ item: { id: 99, text: 'old text' }, navigateOnSubmit: false })

    const element = openedModal()
    expect(element.type).toBe(UploadFeeModal)
    expect(element.props.itemId).toBeUndefined()
    expect(element.props.payInId).toBe(17653)
    expect(element.props.moneroUri).toBe(URI_FULL)
  })

  test('a create with a posting fee keeps the feeStatus-gated posting fee modal', async () => {
    mockMutate.mockResolvedValue({ data: { upsertComment: payInResponse(17651) } })
    await submit({ item: undefined })

    const element = openedModal()
    expect(element.type).toBe(PostingFeeModal)
    expect(element.props.itemId).toBe(99)
  })

  test('a submit with no fee navigates and opens no modal', async () => {
    mockMutate.mockResolvedValue({
      data: { upsertComment: { id: 17652, payerPrivates: { result: { __typename: 'Item', id: 99 } } } }
    })
    await submit({ item: { id: 99, text: 'old text' } })

    expect(mockShowModal).not.toHaveBeenCalled()
    expect(mockRouterPush).toHaveBeenCalledWith('/items/99')
  })
})
