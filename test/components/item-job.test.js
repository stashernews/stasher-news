/* eslint-env jest */
// No @testing-library/jsdom in this repo; renders with react-dom/client backed
// by linkedom (see test/components/vote-column.test.js for the harness).
// The apply button contract: a job with a url opens that url (normalized to an
// absolute href so bare domains like "x.com" are not treated as relative
// links), a job with an email opens a mailto with the title in the subject,
// and a job with no apply address renders a disabled button.
// Heavy neighbors (dropdowns, share, badges, boost, toc) are mocked to null —
// they never render in these tests; next/jest resolves next/link and the
// MailOpenLine svg is explicitly mocked like the up-arrow in vote-column.
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import ItemJob from '@/components/item-job'

jest.mock('next/link', () => {
  const React = require('react')
  return function MockLink ({ href, children, className, ...rest }) {
    return React.createElement('a', { href: typeof href === 'string' ? href : '/', className, ...rest }, children)
  }
})
// react-bootstrap's ESM build cannot be require()d under this jest setup
// (typeof default === 'object'), so mimic Button/Image/Badge directly.
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
jest.mock('react-bootstrap/Image', () => {
  const React = require('react')
  return { __esModule: true, default: props => React.createElement('img', props) }
})
jest.mock('react-bootstrap', () => () => null)
jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: null }) }))
jest.mock(`${process.cwd()}/components/item`, () => ({ SearchTitle: ({ title }) => <span>{title}</span> }))
jest.mock(`${process.cwd()}/components/table-of-contents`, () => () => null)
jest.mock(`${process.cwd()}/components/share`, () => ({ __esModule: true, default: () => null, CopyLinkDropdownItem: () => null }))
jest.mock(`${process.cwd()}/components/badge`, () => ({ __esModule: true, default: () => null }))
jest.mock(`${process.cwd()}/components/sub-popover`, () => () => null)
jest.mock(`${process.cwd()}/components/item-info`, () => ({ PayInInfo: () => null, InfoDropdownItem: () => null }))
jest.mock(`${process.cwd()}/components/pending-fee-badge`, () => () => null)
jest.mock(`${process.cwd()}/components/pay-posting-fee-button`, () => () => null)
jest.mock(`${process.cwd()}/components/boost-button`, () => () => null)
jest.mock(`${process.cwd()}/components/action-dropdown`, () => () => null)
jest.mock(`${process.cwd()}/components/dont-link-this`, () => ({ DontLikeThisDropdownItem: () => null }))
jest.mock(`${process.cwd()}/components/bookmark`, () => ({ BookmarkDropdownItem: () => null }))
jest.mock(`${process.cwd()}/components/subscribe`, () => ({ SubscribeDropdownItem: () => null }))
jest.mock(`${process.cwd()}/components/mute`, () => ({ MuteDropdownItem: () => null }))
jest.mock(`${process.cwd()}/svgs/mail-open-line.svg`, () => ({ className }) => <svg className={className}><path d='mail' /></svg>)

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

function jobItem (overrides = {}) {
  return {
    id: '1',
    title: 'Sr Dev',
    company: 'ACME',
    piconeros: '0',
    boost: '0',
    cost: 0,
    user: { name: 'alice' },
    subNames: [],
    ...overrides
  }
}

async function renderJob (item) {
  const root = createRoot(container)
  await act(async () => {
    root.render(<ItemJob item={item}><div className='children-marker'>comments</div></ItemJob>)
  })
  return root
}

describe('ItemJob apply button', () => {
  it('opens a bare-domain apply url as an absolute href', async () => {
    const root = await renderJob(jobItem({ url: 'x.com' }))

    const apply = container.querySelector('a.btn')
    expect(apply).toBeTruthy()
    expect(apply.getAttribute('href')).toBe('http://x.com')
    expect(apply.getAttribute('target')).toBe('_blank')
    expect(apply.textContent).toContain('apply')

    await act(async () => { root.unmount() })
  })

  it('opens a fully qualified apply url unchanged', async () => {
    const root = await renderJob(jobItem({ url: 'https://example.com/apply' }))

    const apply = container.querySelector('a.btn')
    expect(apply.getAttribute('href')).toBe('https://example.com/apply')
    expect(apply.getAttribute('target')).toBe('_blank')

    await act(async () => { root.unmount() })
  })

  it('opens a mailto with the job title in the subject for email apply addresses', async () => {
    const root = await renderJob(jobItem({ url: 'hireme@example.com' }))

    const apply = container.querySelector('a.btn')
    expect(apply.getAttribute('href')).toMatch(/^mailto:hireme@example\.com\?subject=Sr%20Dev/)
    expect(apply.querySelector('svg')).toBeTruthy()

    const email = container.querySelector('.text-muted.fw-bold')
    expect(email?.textContent).toBe('hireme@example.com')

    await act(async () => { root.unmount() })
  })

  it('renders the apply button disabled when the job has no apply address', async () => {
    const root = await renderJob(jobItem({ url: null }))

    const apply = container.querySelector('button.btn')
    expect(apply).toBeTruthy()
    expect(apply.getAttribute('disabled')).not.toBeNull()
    expect(container.querySelector('a.btn')).toBeNull()

    await act(async () => { root.unmount() })
  })
})
