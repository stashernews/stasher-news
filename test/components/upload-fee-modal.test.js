/* eslint-env jest */
// Component test using the repo's react-dom/client + linkedom harness (no
// @testing-library — see test/components/territory-pending-fee-modal.test.js).
// UploadFeeModal tracks the >10MB upload fee attached to a turf/post edit: the
// fee payIn is born PAID, so the modal polls PayIn.feeCovered and must only
// report success once the observations cover the quoted amount. The QR and
// CopyButton leaves are stubbed; the real MoneroPaymentView renders.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import UploadFeeModal from '@/components/upload-fee-modal'

jest.mock(`${process.cwd()}/components/animation`, () => ({ useAnimation: () => jest.fn() }))
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: () => <button data-testid='copy' />
}))
// next/jest maps every .svg to one shared fileMock module (an object), which
// React cannot render — stub the success view's glyph (territory-form-premiums
// pattern).
jest.mock(`${process.cwd()}/svgs/keyhole.svg`, () => ({
  __esModule: true,
  default: props => <svg {...props} />
}))

// the modal polls payIn(id) { feeCovered } via useQuery from '@apollo/client/react'
const mockUseQuery = jest.fn()
jest.mock('@apollo/client/react', () => ({ useQuery: (...args) => mockUseQuery(...args) }))

// Valid base58 (charset [1-9A-HJ-NP-Za-km-z], 95 chars) so moneroUriAddress()
// accepts it. Leading '5' mimics a stagenet primary address; content is filler.
const URI_FULL = 'monero:5' + 'F'.repeat(94) + '?tx_amount=0.001'

let mockOnClose
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

afterEach(async () => {
  await act(async () => { root.render(null) })
  jest.useRealTimers()
  jest.clearAllMocks()
})

async function renderModal ({ polledPayIn } = {}) {
  mockUseQuery.mockReturnValue({
    data: polledPayIn ? { payIn: polledPayIn } : null
  })
  await act(async () => {
    root.render(<UploadFeeModal moneroUri={URI_FULL} payInId={42} onClose={mockOnClose} />)
  })
}

describe('UploadFeeModal', () => {
  beforeEach(() => {
    mockOnClose = jest.fn()
  })

  test('shows the QR and the quoted amount while the fee is not covered', async () => {
    await renderModal({ polledPayIn: { id: 42, feeCovered: false } })
    expect(container.textContent).toContain('Pay the upload fee')
    expect(container.textContent).toContain('1 mXMR (0.001 XMR)')
    expect(container.textContent).not.toMatch(/payment detected/i)
    expect(mockOnClose).not.toHaveBeenCalled()
  })

  test('shows the success view once the fee is covered', async () => {
    await renderModal({ polledPayIn: { id: 42, feeCovered: true } })
    expect(container.textContent).toMatch(/payment detected/i)
    expect(container.textContent).not.toContain('Pay the upload fee')
  })

  test('auto-closes shortly after the success view', async () => {
    jest.useFakeTimers()
    await renderModal({ polledPayIn: { id: 42, feeCovered: true } })
    await act(async () => { jest.advanceTimersByTime(1500) })
    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })
})
