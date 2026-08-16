/* eslint-env jest */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'
import { Select } from '@/components/form'

// components/form imports { SNEditor } from './editor', whose transitive
// lexical deps are ESM-only (github-slugger) and unloadable under jest's VM.
// Select does not use the editor, so stub it.
jest.mock(`${process.cwd()}/components/editor`, () => ({
  SNEditor: () => null
}))

let container

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  global.window = parsed.window
  global.document = parsed.document
  global.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  container = document.getElementById('root')
})

describe('Select item shapes', () => {
  it('renders {label, value} objects as labeled options', async () => {
    await act(async () => {
      createRoot(container).render(
        <Select
          noForm
          name='what'
          items={['posts', { label: 'stashers', value: 'stackers' }, 'territories']}
        />
      )
    })
    const options = [...container.querySelectorAll('option')]
    expect(options).toHaveLength(3)
    expect(options[1].getAttribute('value')).toBe('stackers')
    expect(options[1].textContent).toBe('stashers')
  })

  it('still renders {label, items} objects as optgroups', async () => {
    await act(async () => {
      createRoot(container).render(
        <Select
          noForm
          name='what'
          items={[{ label: 'group', items: ['a', 'b'] }]}
        />
      )
    })
    const group = container.querySelector('optgroup')
    expect(group.getAttribute('label')).toBe('group')
    expect(group.querySelectorAll('option')).toHaveLength(2)
  })
})
