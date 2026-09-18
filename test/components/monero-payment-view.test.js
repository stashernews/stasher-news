/* eslint-env jest */
// MoneroPaymentView is a tiny presentational component; render it directly with
// the react-dom/client + linkedom harness used by test/components/vote-column.test.js
// (this repo has no @testing-library/jsdom). The QR and CopyButton leaves are
// mocked so assertions target the amount/address wiring only.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import MoneroPaymentView from '@/components/monero-payment-view'

// CopyButton is mocked to expose the value it would put on the clipboard as a
// data attribute, so we can assert the BARE DECIMAL (not '0.001 XMR') is copied.
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: ({ value }) => <button data-testid='copy' data-value={value} />
}))

// Qr pulls in qrcode.react; we don't assert on the QR here, so stub it.
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)

// Valid base58 (charset [1-9A-HJ-NP-Za-km-z], 95 chars) so moneroUriAddress()
// accepts it. Leading '5' mimics a stagenet primary address; content is filler.
const B58 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789'
const ADDRESS = '5' + B58.repeat(2).slice(0, 94)
const URI_WITH_AMOUNT = `monero:${ADDRESS}?tx_amount=0.001`
const URI_NO_AMOUNT = `monero:${ADDRESS}`

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
  // root is created exactly once and reused (header-merged.test.js pattern):
  // re-creating it per render makes React log redundant createRoot()
  // console.error warnings, which the review gate treats as test-output noise.
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
  // render(null) unmounts the tree and empties the container; clearing
  // innerHTML first would orphan React's tracked nodes (header-merged.test.js pattern)
  await act(async () => { root.render(null) })
})

async function renderView (props) {
  await act(async () => {
    root.render(<MoneroPaymentView {...props} />)
  })
}

const amountInput = () => container.querySelector('input[aria-label="Amount due (XMR)"]')
const copyButtons = () => Array.from(container.querySelectorAll('button[data-testid="copy"]'))

describe('MoneroPaymentView copyable amount', () => {
  it('renders the amount as a bare decimal in a copyable field above the address', async () => {
    await renderView({ moneroUri: URI_WITH_AMOUNT, amountPiconeros: 1000000000n })

    const input = amountInput()
    expect(input).toBeTruthy()
    // bare decimal — NOT '0.001 XMR'
    expect(input.getAttribute('value')).toBe('0.001')

    // XMR unit label is rendered within the amount row as a separate element
    // (robust to react-bootstrap's exact class naming — checks text, not class)
    expect(input.closest('.input-group')?.textContent).toContain('XMR')

    // amount's copy button is wired to the bare decimal; address copy follows it
    const copies = copyButtons()
    expect(copies.length).toBe(2)
    expect(copies[0].getAttribute('data-value')).toBe('0.001')
    expect(copies[1].getAttribute('data-value')).toBe(ADDRESS)
  })

  it('derives the amount from the monero URI when amountPiconeros is omitted', async () => {
    await renderView({ moneroUri: URI_WITH_AMOUNT })

    expect(amountInput()).toBeTruthy()
    expect(amountInput().getAttribute('value')).toBe('0.001')
  })

  it('omits the amount field when no amount is available, keeping the address', async () => {
    await renderView({ moneroUri: URI_NO_AMOUNT })

    expect(amountInput()).toBeNull()
    // only the address copy button remains
    const copies = copyButtons()
    expect(copies.length).toBe(1)
    expect(copies[0].getAttribute('data-value')).toBe(ADDRESS)
  })

  it('quotes the amount in mXMR with the XMR equivalent in the scan line', async () => {
    await renderView({ moneroUri: URI_WITH_AMOUNT, amountPiconeros: 1000000000n })
    expect(container.textContent).toContain('Scan to send 1 mXMR (0.001 XMR).')
  })
})
