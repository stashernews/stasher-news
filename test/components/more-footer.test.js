/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
// more-footer is light: with cursor=null only the empty/no-more branch renders,
// so the heavy neighbors (Button, Link) never render — they are mocked only so
// the module loads under this jest setup (react-bootstrap's ESM build cannot
// be require()d here, see item-job.test.js).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import MoreFooter from '@/components/more-footer'

jest.mock('next/link', () => {
  const React = require('react')
  return function MockLink ({ href, children, className, ...rest }) {
    return React.createElement('a', { href: typeof href === 'string' ? href : '/', className, ...rest }, children)
  }
})
jest.mock('react-bootstrap/Button', () => {
  const React = require('react')
  return {
    __esModule: true,
    default: ({ href, target, disabled, children, ...rest }) => {
      const cls = ['btn', 'btn-primary'].join(' ')
      return React.createElement(
        href ? 'a' : 'button',
        { href, target, disabled: href ? undefined : disabled, className: cls, ...rest },
        children
      )
    }
  }
})

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

async function renderFooter (props = {}) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<MoreFooter cursor={null} count={0} {...props} />)
  })
  return root
}

describe('MoreFooter', () => {
  it('renders EMPTY when count is 0 and no emptyText is provided', async () => {
    const root = await renderFooter()
    expect(container.textContent).toBe('EMPTY')
    await act(async () => { root.unmount() })
  })

  it('renders the custom emptyText when count is 0 and emptyText is provided', async () => {
    const root = await renderFooter({ emptyText: 'NOTHING OUTLAWED. Your filters hide nothing.' })
    expect(container.textContent).toBe('NOTHING OUTLAWED. Your filters hide nothing.')
    expect(container.textContent).not.toContain('EMPTY')
    await act(async () => { root.unmount() })
  })

  it('renders noMoreText (not emptyText) when count is non-zero', async () => {
    const root = await renderFooter({ count: 1, emptyText: 'NOTHING OUTLAWED. Your filters hide nothing.' })
    expect(container.textContent).toBe('GENESIS')
    expect(container.textContent).not.toContain('NOTHING OUTLAWED')
    await act(async () => { root.unmount() })
  })
})
