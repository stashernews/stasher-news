/* eslint-env jest */
// Component test for the explicit per-turf pin action on the repo's
// react-dom/client + linkedom harness (no @testing-library): real gql parse,
// mocked Apollo useMutation and toast hook, stubbed Dropdown.Item shell.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import TurfPinDropdownItem from '@/components/turf-pin-dropdown-item'

jest.mock('react-bootstrap', () => ({
  Dropdown: {
    Item: props => <div role='button' disabled={props.disabled} onClick={props.onClick}>{props.children}</div>
  }
}))
jest.mock(`${process.cwd()}/components/toast`, () => ({
  useToast: () => ({ success: mockSuccess, danger: mockDanger })
}))
jest.mock('@apollo/client/react', () => ({
  useMutation: () => [mockSetTurfPin, { loading: mockLoading }],
  useApolloClient: () => mockApolloClient
}))

jest.mock('@apollo/client', () => ({
  gql: require('graphql-tag').gql
}))

let mockSetTurfPin
let mockLoading
let mockSuccess
let mockDanger
let mockApolloClient

let container
let root

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  global.window = parsed.window
  global.document = parsed.document
  global.navigator = parsed.window.navigator
  global.IS_REACT_ACT_ENVIRONMENT = true
  container = parsed.document.createElement('div')
  parsed.document.body.appendChild(container)
  root = createRoot(container)
})

afterAll(async () => {
  await act(async () => { root.render(null) })
  delete global.window
  delete global.document
  delete global.navigator
  delete global.IS_REACT_ACT_ENVIRONMENT
})

beforeEach(() => {
  mockSetTurfPin = jest.fn(async () => ({ data: { setTurfPin: { id: 1, turfPins: [] } } }))
  mockLoading = false
  mockSuccess = jest.fn()
  mockDanger = jest.fn()
  mockApolloClient = { refetchQueries: jest.fn(async () => []) }
})

afterEach(() => jest.clearAllMocks())

const render = async (turf) => {
  const item = { id: 1 }
  await act(async () => {
    root.render(<TurfPinDropdownItem item={item} turf={turf} />)
  })
  return container.querySelector('[role="button"]')
}

test('labels the action with the turf and its current state', async () => {
  const button = await render({ name: 'alpha', pinned: false })
  expect(button.textContent).toBe('pin to ~alpha')
  await act(async () => { root.render(null) })
  const unpinned = await render({ name: 'beta', pinned: true })
  expect(unpinned.textContent).toBe('unpin from ~beta')
})

test('click sends the desired state with the canonical turf name', async () => {
  const button = await render({ name: 'alpha', pinned: true })
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
  await act(async () => {})
  expect(mockSetTurfPin).toHaveBeenCalledTimes(1)
  expect(mockSetTurfPin.mock.calls[0][0].variables).toEqual({
    id: 1, subName: 'alpha', pinned: false
  })
  expect(mockSuccess).toHaveBeenCalledWith('unpinned from ~alpha')
  expect(mockDanger).not.toHaveBeenCalled()
})

test('a server error surfaces the toast and keeps state', async () => {
  mockSetTurfPin = jest.fn(async () => { throw new Error('max 6 pins allowed') })
  const button = await render({ name: 'alpha', pinned: false })
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
  await act(async () => {})
  expect(mockDanger).toHaveBeenCalledWith('max 6 pins allowed')
  expect(mockSuccess).not.toHaveBeenCalled()
})

test('the pin survives a failed refetch: success toast plus a refresh warning', async () => {
  mockApolloClient = { refetchQueries: jest.fn(async () => { throw new Error('offline') }) }
  const button = await render({ name: 'alpha', pinned: false })
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
  await act(async () => {})
  expect(mockSetTurfPin).toHaveBeenCalledTimes(1)
  expect(mockSuccess).toHaveBeenCalledWith('pinned to ~alpha')
  expect(mockDanger).toHaveBeenCalledWith(expect.stringMatching(/saved, but refresh failed/))
})

test('a successful refetch shows only the success toast', async () => {
  const button = await render({ name: 'alpha', pinned: false })
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })) })
  await act(async () => {})
  expect(mockApolloClient.refetchQueries).toHaveBeenCalled()
  expect(mockSuccess).toHaveBeenCalledWith('pinned to ~alpha')
  expect(mockDanger).not.toHaveBeenCalled()
})
