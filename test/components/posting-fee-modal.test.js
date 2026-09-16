/* eslint-env jest */
// Component test using the repo's react-dom/client + linkedom harness (no
// @testing-library in this repo — see test/components/monero-payment-view.test.js).
// The modal's 10s poll runs through useQuery from '@apollo/client/react'; mock it
// so each test feeds the polled Item fields directly (territory-pending-fee-modal.test.js
// pattern). The QR and CopyButton leaves are stubbed; the real MoneroPaymentView
// renders, so the copyable amount field is exercised like production.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import PostingFeeModal from '@/components/posting-fee-modal'

jest.mock('next/link', () => ({ href, children, ...props }) => <a href={href} {...props}>{children}</a>)
jest.mock(`${process.cwd()}/components/animation`, () => ({ useAnimation: () => jest.fn() }))
jest.mock(`${process.cwd()}/components/me`, () => ({
  useMe: () => ({ me: { privates: { postingFeePiconeros: '1000000000' } } })
}))
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: ({ value }) => <button data-testid='copy' data-value={value} />
}))

const mockUseQuery = jest.fn()
jest.mock('@apollo/client/react', () => ({ useQuery: (...args) => mockUseQuery(...args) }))

const ADDRESS = '5' + 'F'.repeat(94)
const URI_FULL = `monero:${ADDRESS}?tx_amount=0.001`
const URI_TOPUP = `monero:${ADDRESS}?tx_amount=0.0006`

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

// polledItem overrides the polled Item fields; omit it (null data) to simulate
// the first poll still in flight, so only the moneroUri prop seeds the amount.
async function renderModal ({ polledItem } = {}) {
  mockUseQuery.mockReturnValue({
    data: polledItem
      ? { item: { id: '1', feeStatus: 'PENDING_FEE', feeReceivedPiconeros: 0, feeTopUpUri: null, ...polledItem } }
      : null
  })
  await act(async () => {
    root.render(<PostingFeeModal moneroUri={URI_FULL} itemId='1' />)
  })
}

const amountInput = () => container.querySelector('input[aria-label="Amount due (XMR)"]')
const copyButtons = () => Array.from(container.querySelectorAll('button[data-testid="copy"]'))

describe('PostingFeeModal top-up amount', () => {
  test('quotes only the REMAINDER in the copyable amount after a partial payment', async () => {
    await renderModal({ polledItem: { feeReceivedPiconeros: 400000000, feeTopUpUri: URI_TOPUP } })
    const input = amountInput()
    expect(input).toBeTruthy()
    expect(input.getAttribute('value')).toBe('0.0006')
    const copies = copyButtons()
    expect(copies.length).toBe(2)
    expect(copies[0].getAttribute('data-value')).toBe('0.0006')
    expect(copies[1].getAttribute('data-value')).toBe(ADDRESS)
    expect(container.textContent).toContain('Scan to send 0.6 mXMR (0.0006 XMR)')
  })

  test('shows the full fee before the first poll resolves (fresh submit)', async () => {
    await renderModal()
    expect(amountInput().getAttribute('value')).toBe('0.001')
    expect(container.textContent).toContain('Scan to send 1 mXMR (0.001 XMR)')
  })

  test('shows the full fee when nothing has been received', async () => {
    await renderModal({ polledItem: { feeReceivedPiconeros: 0, feeTopUpUri: URI_FULL } })
    expect(amountInput().getAttribute('value')).toBe('0.001')
    expect(container.textContent).not.toMatch(/payment detected but short/)
  })

  test('shows the short-pay hint when the poll reports a partial payment', async () => {
    await renderModal({ polledItem: { feeReceivedPiconeros: 400000000, feeTopUpUri: URI_TOPUP } })
    expect(container.textContent).toMatch(/payment detected but short — received 0\.4 mXMR of 1 mXMR\. Send 0\.0006 XMR \(0\.6 mXMR\) to the same address to complete it\./)
  })
})
