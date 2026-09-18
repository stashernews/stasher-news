/* eslint-env jest */
// Regression test: the fund-bounty modal must quote the TOTAL payable
// (bounty + escrow fee) in its copyable amount field — matching the
// description text and the monero: URI — not the bare bounty amount.
// Mounts BountyFundingView with mocked Apollo/router and the REAL
// MoneroPaymentView, so the amount shown is derived from the URI exactly
// like production (harness pattern: test/components/monero-payment-view.test.js).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import BountyFundingView from '@/components/bounty-funding-view'

// CopyButton is mocked to expose the value it would put on the clipboard as a
// data attribute, so we can assert the BARE DECIMAL (not '0.012 XMR') is copied.
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: ({ value }) => <button data-testid='copy' data-value={value} />
}))

// Qr pulls in qrcode.react; we don't assert on the QR here, so stub it.
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)

// The component's Apollo hooks: fundBounty resolves with the escrow URI +
// fee; the bountyStatus poll returns nothing so the view stays on the payment
// screen (never flips to the success view).
const mockMutate = jest.fn()
const mockRefetch = jest.fn()
jest.mock('@apollo/client/react', () => ({
  useMutation: () => [mockMutate],
  useQuery: () => ({ data: null, refetch: mockRefetch })
}))

jest.mock('next/router', () => ({
  useRouter: () => ({ push: jest.fn() })
}))

// Valid base58 (charset [1-9A-HJ-NP-Za-km-z], 95 chars) so moneroUriAddress()
// accepts it. Leading '5' mimics a stagenet primary address; content is filler.
const B58 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789'
const ADDRESS = '5' + B58.repeat(2).slice(0, 94)
const URI_WITH_TOTAL = `monero:${ADDRESS}?tx_amount=0.012`

// 0.01 XMR bounty + 0.002 XMR escrow fee (feePiconeros 2e9), as a real
// fundBounty response would deliver for a floor-amount bounty.
const BOUNTY_PICONEROS = 10_000_000_000n
const FEE_PICONEROS = 2_000_000_000n

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
  jest.clearAllMocks()
})

async function renderView () {
  mockMutate.mockResolvedValue({
    data: { fundBounty: { uri: URI_WITH_TOTAL, feePiconeros: FEE_PICONEROS } }
  })
  await act(async () => {
    root.render(
      <BountyFundingView postId='5227' amountPiconeros={BOUNTY_PICONEROS} onClose={jest.fn()} />
    )
  })
}

const amountInput = () => container.querySelector('input[aria-label="Amount due (XMR)"]')
const copyButtons = () => Array.from(container.querySelectorAll('button[data-testid="copy"]'))

describe('BountyFundingView payable amount', () => {
  test('quotes the bounty + escrow fee total (not the bare bounty) in the copyable field', async () => {
    await renderView()

    expect(mockMutate).toHaveBeenCalled()
    // description states the total up front
    expect(container.textContent).toContain('Scan to send 12 mXMR (0.012 XMR)')

    // copyable amount field and its copy button carry the TOTAL (0.012), so a
    // user copying the amount sends the full 0.012 the escrow expects
    const input = amountInput()
    expect(input).toBeTruthy()
    expect(input.getAttribute('value')).toBe('0.012')

    const copies = copyButtons()
    expect(copies.length).toBe(2)
    expect(copies[0].getAttribute('data-value')).toBe('0.012')
    expect(copies[1].getAttribute('data-value')).toBe(ADDRESS)
  })
})
