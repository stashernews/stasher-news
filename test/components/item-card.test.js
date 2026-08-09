/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
// <Item> is mocked to a recording stub — the card's contract is to wrap the
// existing row untouched (rank, vote column, tip/downvote amounts, comments,
// user + badges, time, turf, action dropdown all live inside <Item>), so the
// test asserts the stub received every datum unchanged rather than re-rendering
// the heavy item graph. The renderer-selection tests import the real items.js
// module graph with the heavy listing children mocked.
//
// Module-resolution quirks (mirroring vote-column.test.js): jest.mock string
// args are not rewritten by SWC, so mocks are registered under runtime-computed
// absolute paths with process.cwd() inlined per call.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import fs from 'fs'
import path from 'path'
import ItemCard from '@/components/item-card'
import Item from '@/components/item'

jest.mock(`${process.cwd()}/components/item`, () => {
  const ItemMock = jest.fn((props) => (
    <div className='item-mock' data-rank={props.rank} data-item={props.item?.id}>
      {props.item?.title}
    </div>
  ))
  return { __esModule: true, default: ItemMock, ItemSkeleton: () => null }
})
jest.mock(`${process.cwd()}/components/item-job`, () => () => null)
jest.mock(`${process.cwd()}/components/comment`, () => ({ CommentFlat: 'div' }))
jest.mock(`${process.cwd()}/components/more-footer`, () => () => null)

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
  Item.mockClear()
  container.innerHTML = ''
})

async function renderCard (props = {}) {
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ItemCard
        item={{ id: '1', title: 'title', user: { name: 'u' } }}
        rank={1}
        {...props}
      />)
  })
  return root
}

describe('ItemCard', () => {
  it('renders the server-computed excerpt from item.excerpt', async () => {
    const root = await renderCard({ item: { id: '1', title: 'title', excerpt: 'a long body of post content', user: { name: 'u' } } })

    const excerpt = container.querySelector('.item-excerpt')
    expect(excerpt).toBeTruthy()
    expect(excerpt.tagName).toBe('P')
    expect(excerpt.textContent).toBe('a long body of post content')

    await act(async () => { root.unmount() })
  })

  it('omits the excerpt when there is no excerpt field', async () => {
    const root = await renderCard({ item: { id: '2', title: 'title', user: { name: 'u' } } })

    expect(container.querySelector('.item-excerpt')).toBeNull()

    await act(async () => { root.unmount() })
  })

  it('clamps the excerpt to 2 lines in the stylesheet', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'styles/stealth-theme.scss'), 'utf8')
    expect(css).toMatch(/\.item-excerpt/)
    expect(css).toMatch(/-webkit-line-clamp:\s*2/)
  })

  it('forwards the full row (item, rank, passthrough props) to Item untouched', async () => {
    const item = {
      id: '9',
      title: 'title',
      user: { name: 'u' },
      piconeros: '1000000000000',
      downPiconeros: '500000000000',
      ncomments: 3,
      meDontLikePiconeros: '0'
    }
    const root = await renderCard({ item, rank: 4, itemClassName: 'py-2', pinnable: false })

    // React 19 invokes function components as (props, ref), so assert on the
    // first argument only.
    expect(Item.mock.calls[0][0]).toEqual(expect.objectContaining({ item, rank: 4, itemClassName: 'py-2', pinnable: false }))

    await act(async () => { root.unmount() })
  })
})
