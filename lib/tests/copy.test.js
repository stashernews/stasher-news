/* eslint-env jest */
import { parseHTML } from 'linkedom'
import { copy } from '@/lib/copy'

let parsed
let created = []

beforeAll(() => {
  parsed = parseHTML('<!doctype html><html><body></body></html>')
  global.window = parsed.window
  global.document = parsed.document
  global.navigator = parsed.window.navigator
  global.HTMLElement = parsed.window.HTMLElement
  global.Node = parsed.window.Node
  // linkedom lazily creates <head> on first document.body access; touching it
  // here (before createElement is mocked) stops it polluting the `created` array
  expect(document.body).toBeDefined()
})

afterAll(() => {
  delete global.window
  delete global.document
  delete global.navigator
  delete global.HTMLElement
  delete global.Node
})

beforeEach(() => {
  created = []
  // execCommand succeeds by default; each test may override it
  document.execCommand = jest.fn(() => true)
  const realCreateElement = document.createElement.bind(document)
  document.createElement = jest.fn((tag) => {
    const el = realCreateElement(tag)
    el.select = jest.fn()
    el.setSelectionRange = jest.fn()
    created.push(el)
    return el
  })
})

describe('copy via document.execCommand', () => {
  test('copies text synchronously and removes the temp textarea', async () => {
    await copy('5ABCDEF')

    expect(created).toHaveLength(1)
    expect(created[0].value).toBe('5ABCDEF')
    expect(created[0].select).toHaveBeenCalled()
    expect(created[0].setSelectionRange).toHaveBeenCalledWith(0, 7)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    // cleanup: the temp textarea is gone from the DOM
    expect(document.body.querySelector('textarea')).toBeNull()
  })
})

describe('copy fallbacks', () => {
  test('falls back to navigator.clipboard.writeText when execCommand is unavailable', async () => {
    document.execCommand = undefined
    const writeText = jest.fn().mockResolvedValue(undefined)
    global.navigator = { clipboard: { writeText } }

    await copy('5ABCDEF')

    expect(writeText).toHaveBeenCalledWith('5ABCDEF')
  })

  test('throws when neither execCommand nor the Clipboard API is available', async () => {
    document.execCommand = undefined
    global.navigator = {}

    await expect(copy('x')).rejects.toThrow('copy not supported')
  })
})
