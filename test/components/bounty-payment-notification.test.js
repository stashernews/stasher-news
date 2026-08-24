/* eslint-env jest */
// Regression test: the bounty-award notification shows the hand-coin icon and
// the payout amount. Mounts the real Notifications list with a mocked
// useQuery delivering one BountyPayment row; all leaf item components are
// stubbed (harness pattern: test/components/bounty-funding-view.test.js).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import Notifications from '@/components/notifications'

jest.mock(`${process.cwd()}/components/comment`, () => ({
  __esModule: true,
  default: () => null,
  CommentSkeleton: () => null
}))
jest.mock(`${process.cwd()}/components/item`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/item-job`, () => () => null)
jest.mock(`${process.cwd()}/components/root`, () => ({ RootProvider: ({ children }) => children }))
jest.mock(`${process.cwd()}/components/more-footer`, () => () => null)
jest.mock(`${process.cwd()}/components/invite`, () => () => null)
jest.mock(`${process.cwd()}/components/use-data`, () => ({ useData: data => data }))
jest.mock(`${process.cwd()}/components/countdown`, () => ({ LongCountdown: () => null }))
jest.mock(`${process.cwd()}/components/serviceworker`, () => ({ useServiceWorker: () => ({}) }))
jest.mock(`${process.cwd()}/components/form`, () => ({ Checkbox: () => null, Form: { Group: () => null } }))
jest.mock(`${process.cwd()}/components/text`, () => () => null)
jest.mock(`${process.cwd()}/components/link-to-context`, () => ({ __esModule: true, default: ({ children }) => <a>{children}</a> }))
jest.mock(`${process.cwd()}/components/toast`, () => ({ useToast: () => () => {} }))
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({}) }))
jest.mock(`${process.cwd()}/components/item-act`, () => ({ withActBump: c => c }))
jest.mock(`${process.cwd()}/components/payIn/hooks/use-retry-pay-in`, () => ({
  getFailedRetryPayIn: () => null,
  runManualRetry: () => {},
  useRetryPayIn: () => {}
}))
jest.mock(`${process.cwd()}/components/payIn/hooks/use-auto-retry-pay-ins`, () => ({ isAutoRetryEligiblePayIn: () => false }))
jest.mock(`${process.cwd()}/lib/pay-in`, () => ({ isInvoiceSetupPending: () => false, toFailedPayIn: () => null }))
jest.mock(`${process.cwd()}/lib/apollo`, () => ({ reconcileNotificationItemCounters: () => {} }))
jest.mock(`${process.cwd()}/fragments/notifications`, () => ({ NOTIFICATIONS: 'NOTIFICATIONS' }))
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }) => <a>{children}</a> }))
jest.mock('react-bootstrap/Alert', () => ({ __esModule: true, default: () => null }))
jest.mock('react-bootstrap', () => ({ Badge: () => null, Button: () => null }))
jest.mock(`${process.cwd()}/svgs/check-double-line.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/user-add-fill.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/flame.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/coin.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/verified.svg`, () => () => null)
jest.mock(`${process.cwd()}/svgs/map.svg`, () => () => null)
// next/jest maps every .svg to a single shared fileMock module, so the LAST
// svg mock registered wins for ALL svg imports (see header-merged.test.js).
// hand-coin-fill.svg is registered last so the HandCoin icon renders with the
// data-testid the assertions below rely on.
jest.mock(`${process.cwd()}/svgs/hand-coin-fill.svg`, () => ({ __esModule: true, default: props => <svg data-testid='hand-coin' {...props} /> }))
jest.mock('@apollo/client/react', () => ({
  useQuery: () => ({
    data: {
      notifications: {
        notifications: [{
          __typename: 'BountyPayment',
          id: '1638',
          sortTime: '2026-08-24T05:15:15.000Z',
          earnedPiconeros: '10000000000000',
          item: { id: 24552, title: 'HEYOOOO' }
        }]
      }
    },
    fetchMore: jest.fn()
  }),
  useApolloClient: () => ({ cache: {} })
}))
jest.mock('next/router', () => ({
  useRouter: () => ({ query: {}, replace: jest.fn(), pathname: '', asPath: '', options: {} })
}))

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

describe('BountyPayment notification renderer', () => {
  test('shows the hand-coin icon and the payout amount', async () => {
    await act(async () => {
      root.render(<Notifications />)
    })

    expect(container.querySelector('[data-testid="hand-coin"]')).toBeTruthy()
    expect(container.textContent).toContain('you received a 10 XMR bounty payment')
  })
})
