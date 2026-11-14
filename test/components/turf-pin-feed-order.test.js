/* eslint-env jest */
// Rendered-feed regression for turf pin placement (GraphQL-shaped data): a
// turf's pins arrive position-ordered but carry a NULL legacy position field
// (Item.position resolves legacy links only), so the legacy positional merge
// cannot apply — pins must be prepended consecutively and never duplicated.
// Global pins (home feed) keep the existing positional merge.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import Items from '@/components/items'

jest.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: mockData, fetchMore: jest.fn() })
}))
jest.mock('../../components/item-card', () => ({
  __esModule: true,
  default: ({ item }) => <div class='row' data-kind='item'>{String(item.id)}</div>
}))
jest.mock('../../components/item-job', () => ({
  __esModule: true,
  default: ({ item }) => <div class='row' data-kind='job'>{String(item.id)}</div>
}))
jest.mock('../../components/comment', () => ({
  CommentFlat: ({ item }) => <div class='row' data-kind='comment'>{String(item.id)}</div>
}))
jest.mock('../../components/more-footer', () => ({
  __esModule: true,
  default: () => <div data-testid='footer' />
}))
jest.mock('../../components/item', () => ({
  ItemSkeleton: () => <div data-testid='skeleton' />
}))
jest.mock('../../components/use-data', () => ({
  useData: (data, ssrData) => data ?? ssrData
}))

let mockData

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
  mockData = undefined
})

const renderItems = async variables => {
  await act(async () => {
    root.render(<Items variables={variables} />)
  })
  return [...container.querySelectorAll('.row')].map(row => row.textContent)
}

test('a turf feed prepends its pins consecutively and never duplicates them', async () => {
  mockData = {
    items: {
      // ordinary list, server-excluded pin ids absent; legacy position null
      items: [
        { id: 101, parentId: null, isJob: false },
        { id: 102, parentId: null, isJob: false },
        { id: 103, parentId: null, isJob: false }
      ],
      // turf pins: feed order from SQL, legacy position field null
      pins: [
        { id: 202, position: null, parentId: null, isJob: false, turfPins: [{ subName: 'alpha', position: 1 }] },
        { id: 201, position: null, parentId: null, isJob: false, turfPins: [{ subName: 'alpha', position: 2 }] }
      ],
      cursor: null
    }
  }
  const order = await renderItems({ sub: 'alpha', sort: 'lit', type: 'posts' })
  expect(order).toEqual(['202', '201', '101', '102', '103'])
})

test('the home feed keeps the legacy positional merge for global pins', async () => {
  mockData = {
    items: {
      items: [
        { id: 101, parentId: null, isJob: false },
        { id: 102, parentId: null, isJob: false }
      ],
      pins: [
        { id: 300, position: 1, parentId: null, isJob: false }
      ],
      cursor: null
    }
  }
  const order = await renderItems({ sort: 'lit', type: 'posts' })
  expect(order).toEqual(['300', '101', '102'])
})
