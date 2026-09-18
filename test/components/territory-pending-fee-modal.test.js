/* eslint-env jest */
// Component test using the repo's react-dom/client + linkedom harness (no
// @testing-library in this repo — see test/components/monero-payment-view.test.js).
// The modal's 10s poll runs through useQuery from '@apollo/client/react'; mock it
// so each test feeds the polled Sub fields directly (bounty-funding-view.test.js
// pattern). The QR and CopyButton leaves are stubbed; the real MoneroPaymentView
// renders, so the hint placement inside it is exercised like production.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import TerritoryPendingFeeModal from '@/components/territory-pending-fee-modal'

jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock(`${process.cwd()}/components/animation`, () => ({ useAnimation: () => jest.fn() }))
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: () => <button data-testid='copy' />
}))

// The modal polls Sub.feeReceivedPiconeros / billingFeePiconeros via useQuery
// from '@apollo/client/react' — mock it (bounty-funding-view.test.js pattern).
const mockUseQuery = jest.fn()
jest.mock('@apollo/client/react', () => ({ useQuery: (...args) => mockUseQuery(...args) }))

// Valid base58 (charset [1-9A-HJ-NP-Za-km-z], 95 chars) so moneroUriAddress()
// accepts it. Leading '5' mimics a stagenet primary address; content is filler.
const URI_FULL = 'monero:5' + 'F'.repeat(94) + '?tx_amount=0.001'

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
  // root created once and reused — re-creating it per render logs redundant
  // createRoot() warnings, which the review gate treats as test-output noise.
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
  // render(null) unmounts the tree and empties the container (sticky-bar.test.js
  // pattern); clearing innerHTML first would orphan React's tracked nodes.
  await act(async () => { root.render(null) })
  jest.clearAllMocks()
})

// polledSub overrides the polled Sub fields; omit it (null data) to simulate the
// first poll still in flight, so only the paySub-response props seed the hint.
async function renderModal ({ polledSub, initialReceived, initialExpected } = {}) {
  mockUseQuery.mockReturnValue({
    data: polledSub
      ? { sub: { name: 'test-turf', billingStatus: 'PENDING_FEE', ...polledSub } }
      : null
  })
  await act(async () => {
    root.render(
      <TerritoryPendingFeeModal
        moneroUri={URI_FULL}
        subName='test-turf'
        receivedPiconeros={initialReceived}
        expectedPiconeros={initialExpected}
      />
    )
  })
}

describe('TerritoryPendingFeeModal', () => {
  test('uses the paySub response to seed the hint before the first poll resolves', async () => {
    await renderModal({ initialReceived: 400000000, initialExpected: 1000000000 })
    expect(container.textContent).toMatch(/payment detected but short/)
  })
})
