/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import TopHeader from '@/components/top-header'

// const for mockPush/mockRouter (never reassigned), let for mockSelectProps
// (reassigned per-test); jest.mock factories reference these lazily
// (mock*-prefixed per babel-plugin-jest-hoist), so TDZ never applies.
const mockPush = jest.fn()
const mockRouter = { query: { when: 'day' }, push: (...args) => mockPush(...args) }
let mockSelectProps = {}

jest.mock('next/router', () => ({ useRouter: () => mockRouter }))

jest.mock(`${process.cwd()}/components/form`, () => ({
  Form: ({ children }) => children,
  Select: props => {
    mockSelectProps[props.name] = props
    return null
  },
  DatePicker: () => null
}))

jest.mock(`${process.cwd()}/components/territory-domains`, () => ({
  usePrefix: () => ''
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
})

afterEach(() => {
  act(() => root.unmount())
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
  mockSelectProps = {}
  root = createRoot(container)
})

test('when select on /top/stashers navigates to /top/stashers/<when>', async () => {
  await act(async () => {
    root.render(<TopHeader cat='stackers' />)
  })

  await act(async () => {
    await mockSelectProps.when.onChange(
      { values: { what: 'stackers', by: 'value', when: 'day', from: '', to: '' } },
      { target: { value: 'week' } }
    )
  })

  expect(mockPush).toHaveBeenCalledWith({ pathname: '/top/stashers/week', query: {} })
})

test('what select picking stashers navigates to /top/stashers/day', async () => {
  await act(async () => {
    root.render(<TopHeader cat='posts' />)
  })

  await act(async () => {
    await mockSelectProps.what.onChange(
      { values: { what: 'posts', by: 'sats', when: 'day', from: '', to: '' } },
      { target: { value: 'stackers' } }
    )
  })

  expect(mockPush).toHaveBeenCalledWith({ pathname: '/top/stashers/day', query: {} })
})
