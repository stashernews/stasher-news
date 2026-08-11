/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/item-card.test.js for the harness).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import BountyFundingNotice from '@/components/bounty-funding-notice'

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
})

async function renderNotice (item) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<BountyFundingNotice item={item} />)
  })
  return root
}

describe('BountyFundingNotice', () => {
  it('renders the visibility notice for the author of an unfunded bounty', async () => {
    const root = await renderNotice({ mine: true, bountyPiconeros: 10000000000, bountyStatus: 'UNFUNDED' })

    expect(container.querySelector('.alert')).toBeTruthy()
    expect(container.textContent).toMatch(/until the funding payment is sent and confirmed/i)
    expect(container.textContent).toMatch(/only visible to you/)

    await act(async () => { root.unmount() })
  })

  it('renders while funding is pending or detected', async () => {
    for (const status of ['PENDING_FUNDING', 'DETECTED']) {
      const root = await renderNotice({ mine: true, bountyPiconeros: 10000000000, bountyStatus: status })
      expect(container.querySelector('.alert')).toBeTruthy()
      expect(container.textContent).toMatch(/only visible to you/)
      await act(async () => { root.unmount() })
    }
  })

  it('is hidden once the bounty is funded', async () => {
    for (const status of ['FUNDED', 'EXPIRED', 'AWARDED', 'REFUNDED', 'ROLLED_OVER']) {
      const root = await renderNotice({ mine: true, bountyPiconeros: 10000000000, bountyStatus: status })
      expect(container.querySelector('.alert')).toBeNull()
      await act(async () => { root.unmount() })
    }
  })

  it('is hidden for non-bounty items and for other users', async () => {
    for (const item of [
      { mine: true, bountyPiconeros: 0, bountyStatus: 'UNFUNDED' },
      { mine: false, bountyPiconeros: 10000000000, bountyStatus: 'UNFUNDED' }
    ]) {
      const root = await renderNotice(item)
      expect(container.querySelector('.alert')).toBeNull()
      await act(async () => { root.unmount() })
    }
  })
})
