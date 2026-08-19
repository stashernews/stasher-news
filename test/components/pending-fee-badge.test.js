/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import PendingFeeBadge from '@/components/pending-fee-badge'

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

async function renderBadge (item) {
  await act(async () => {
    root.render(<PendingFeeBadge item={item} />)
  })
}

describe('PendingFeeBadge', () => {
  test('renders nothing for a paid item', async () => {
    await renderBadge({ feeStatus: 'FEE_PAID', deletedAt: null })
    expect(container.textContent).toBe('')
  })

  test('renders the pending payment badge for a PENDING_FEE item', async () => {
    await renderBadge({ feeStatus: 'PENDING_FEE', deletedAt: null, payIn: null })
    expect(container.textContent).toContain('pending payment')
  })

  test('renders the underpaid hint when a partial payment exists', async () => {
    const item = { feeStatus: 'PENDING_FEE', deletedAt: null, payIn: { moneroUri: URI_FULL }, feeReceivedPiconeros: 400000000 }
    await renderBadge(item)
    expect(container.textContent).toContain('pending payment')
    expect(container.textContent).toMatch(/payment detected but short/)
  })

  test('renders nothing for a deleted item', async () => {
    await renderBadge({ feeStatus: 'PENDING_FEE', deletedAt: new Date().toISOString(), payIn: null })
    expect(container.textContent).toBe('')
  })
})
