/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import PayPostingFeeButton from '@/components/pay-posting-fee-button'

jest.mock('next/link', () => ({ href, children, ...props }) => <a href={href} {...props}>{children}</a>)
// PostingFeeModal is never rendered here (the test only asserts the button
// label), but importing it transitively pulls in monero-payment-view → form →
// the lexical editor, which breaks jest's module loader (ESM-only
// github-slugger). Stub the same leaves monero-payment-view.test.js stubs.
jest.mock(`${process.cwd()}/components/form`, () => ({
  CopyButton: ({ value }) => <button data-testid='copy' data-value={value} />
}))
jest.mock(`${process.cwd()}/components/qr`, () => () => <div data-testid='qr' />)

const ADDRESS = '5' + 'F'.repeat(94)
const URI_FULL = `monero:${ADDRESS}?tx_amount=0.001`

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

async function renderButton (item) {
  await act(async () => {
    root.render(<PayPostingFeeButton item={item} />)
  })
}

describe('PayPostingFeeButton', () => {
  test('renders nothing for a paid item', async () => {
    await renderButton({ feeStatus: 'FEE_PAID', id: '1', parentId: null, payIn: { moneroUri: URI_FULL } })
    expect(container.textContent).toBe('')
  })

  test('renders nothing when no moneroUri is set', async () => {
    await renderButton({ feeStatus: 'PENDING_FEE', id: '1', parentId: null, payIn: null })
    expect(container.textContent).toBe('')
  })

  test('renders "pay the posting fee" for a top-level item', async () => {
    await renderButton({ feeStatus: 'PENDING_FEE', id: '1', parentId: null, payIn: { moneroUri: URI_FULL } })
    expect(container.textContent).toContain('pay the posting fee')
  })

  test('renders "pay the comment fee" for a comment', async () => {
    await renderButton({ feeStatus: 'PENDING_FEE', id: '1', parentId: '2', payIn: { moneroUri: URI_FULL } })
    expect(container.textContent).toContain('pay the comment fee')
  })
})
