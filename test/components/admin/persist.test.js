/* eslint-env jest */
import { DRAFTS_KEY, readDrafts, sectionFromHash, writeDrafts } from '@/components/admin/persist'

const SECTIONS = [{ id: 'overview' }, { id: 'treasury' }]

function memoryStorage (initial = {}) {
  const items = { ...initial }
  return {
    items,
    getItem: key => (key in items ? items[key] : null),
    setItem: (key, value) => { items[key] = value },
    removeItem: key => { delete items[key] }
  }
}

test('the URL hash selects a known section only', () => {
  expect(sectionFromHash('#treasury', SECTIONS)).toBe('treasury')
  expect(sectionFromHash('treasury', SECTIONS)).toBe('treasury')
  expect(sectionFromHash('#nope', SECTIONS)).toBeNull()
  expect(sectionFromHash('', SECTIONS)).toBeNull()
  expect(sectionFromHash('#treasury', [])).toBeNull()
})

test('drafts round-trip through storage and clear when empty', () => {
  const storage = memoryStorage()
  const drafts = { minTipPiconeros: { expected: '0.0001', value: '0.0002' } }
  writeDrafts(storage, drafts)
  expect(readDrafts(storage)).toEqual(drafts)
  writeDrafts(storage, {})
  expect(storage.items).not.toHaveProperty(DRAFTS_KEY)
})

test('corrupt or malformed stored drafts are ignored, and storage failures never throw', () => {
  expect(readDrafts(memoryStorage({ [DRAFTS_KEY]: '{not json' }))).toEqual({})
  expect(readDrafts(memoryStorage({ [DRAFTS_KEY]: '[1]' }))).toEqual({})
  expect(readDrafts(memoryStorage({ [DRAFTS_KEY]: JSON.stringify({ a: { value: '1' }, b: { expected: '1', value: '2' } }) })))
    .toEqual({ b: { expected: '1', value: '2' } })
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
  expect(readDrafts(broken)).toEqual({})
  expect(() => writeDrafts(broken, { a: { expected: '1', value: '2' } })).not.toThrow()
  expect(readDrafts(null)).toEqual({})
})
