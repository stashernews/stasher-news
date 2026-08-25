/* eslint-env jest */
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
// last svg mock wins for ALL svg imports; hand-coin registered last so HandCoin renders
jest.mock(`${process.cwd()}/svgs/hand-coin-fill.svg`, () => ({ __esModule: true, default: props => <svg data-testid='hand-coin' {...props} /> }))
jest.mock('@apollo/client/react', () => ({
  useQuery: () => ({
    data: {
      notifications: {
        notifications: [{
          __typename: 'Earn',
          id: '1',
          minSortTime: '2026-08-24T00:00:00.000Z',
          sortTime: '2026-08-24T00:00:00.000Z',
          earnedPiconeros: '1000000000000',
          sources: { posts: 0, comments: 0, tipPosts: 0, tipComments: 0 }
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

describe('Earn notification renderer', () => {
  test('says weekly and uses the orange primary color', async () => {
    await act(async () => {
      root.render(<Notifications />)
    })

    expect(container.textContent).toContain('SN distributes the XMR it earns to top stashers like you weekly.')
    const icon = container.querySelector('[data-testid="hand-coin"]')
    // linkedom's SVGElement.className is an SVGAnimatedString proxy that never reflects the
    // class attribute, so read the class via getAttribute (see linkedom esm/svg/element.js)
    expect(icon.getAttribute('class')).toContain('fill-primary')
    expect(icon.getAttribute('class')).not.toContain('fill-boost')
    expect(container.querySelector('.text-primary')).toBeTruthy()
    expect(container.querySelector('.text-boost')).toBeNull()
  })
})
