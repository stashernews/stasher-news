/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { SubAnalyticsHeader } from '@/components/sub-analytics-header'

var mockPush = jest.fn()
var mockRouter = { query: { sub: 'all', when: 'day' }, push: (...args) => mockPush(...args) }
var mockSubSelectProps

jest.mock('next/router', () => ({ useRouter: () => mockRouter }))

jest.mock(`${process.cwd()}/components/form`, () => ({
  Select: props => {
    if (props.name === 'sub') mockSubSelectProps = props
    return null
  },
  DatePicker: () => null
}))

jest.mock(`${process.cwd()}/components/sub-select`, () => ({
  useSubs: () => [{ label: 'all', value: 'all' }, { label: 'monero', value: 'monero' }]
}))

let container

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
  mockPush.mockClear()
  mockSubSelectProps = undefined
})

test('turf select navigates to /stashers/<sub>/<when>', async () => {
  await act(async () => {
    createRoot(container).render(<SubAnalyticsHeader />)
  })

  await act(async () => {
    await mockSubSelectProps.onChange(null, { target: { value: 'monero' } })
  })

  expect(mockPush).toHaveBeenCalledWith({ pathname: '/stashers/monero/day', query: {} })
})
