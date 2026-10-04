/* eslint-env jest */
import { getItemEditMode, itemEditDeadline, normalizeAddendumText, nextExpiryLatch } from '@/lib/item-addendum'

const anchor = new Date('2026-10-04T12:00:00.000Z')
const paidItem = {
  id: 123,
  userId: 42,
  createdAt: anchor,
  subNames: ['meta'],
  payIn: { payInState: 'PAID', payInStateChangedAt: anchor }
}

describe('getItemEditMode', () => {
  const options = { meId: 42, myBio: false, adminEdit: false }

  test('treats NULL subNames as not-a-job (legacy rows) instead of crashing', () => {
    expect(getItemEditMode({ ...paidItem, subNames: null }, { ...options, now: +anchor + 600000 })).toBe('ADDENDUM')
  })

  test('identifies the author via user.id when the cache omits userId', () => {
    const cacheShape = { ...paidItem, userId: undefined, user: { id: 42 } }
    expect(getItemEditMode(cacheShape, { ...options, now: +anchor + 600000 })).toBe('ADDENDUM')
    expect(getItemEditMode({ ...cacheShape, user: { id: 7 } }, { ...options, now: +anchor + 600000 })).toBe('NONE')
  })

  test('switches exactly at 600 seconds, anchored to the payIn stamp, not updated_at', () => {
    expect(getItemEditMode(paidItem, { ...options, now: +anchor + 599999 })).toBe('FULL')
    expect(getItemEditMode(paidItem, { ...options, now: +anchor + 600000 })).toBe('ADDENDUM')
    expect(getItemEditMode({ ...paidItem, updatedAt: new Date() }, { ...options, now: +anchor + 600001 })).toBe('ADDENDUM')
  })

  test('falls back to createdAt when the paid payIn carries no changed-at stamp', () => {
    const item = { ...paidItem, payIn: { payInState: 'PAID' } }
    expect(itemEditDeadline(item).getTime()).toBe(+anchor + 600000)
    expect(getItemEditMode(item, { ...options, now: +anchor + 600000 })).toBe('ADDENDUM')
  })

  test('an unpaid or pending creation stays in the first-stage flow', () => {
    expect(getItemEditMode({ ...paidItem, payIn: { payInState: 'PENDING' } }, { ...options, now: +anchor + 600000 })).toBe('FULL')
    expect(getItemEditMode({ ...paidItem, payIn: undefined }, { ...options, now: +anchor + 600000 })).toBe('FULL')
  })

  test('NONE for missing, anonymous, foreign, and deleted items', () => {
    expect(getItemEditMode(null, options)).toBe('NONE')
    expect(getItemEditMode(paidItem, { ...options, meId: null, now: +anchor + 600000 })).toBe('NONE')
    expect(getItemEditMode({ ...paidItem, userId: 7 }, { ...options, now: +anchor + 600000 })).toBe('NONE')
    expect(getItemEditMode({ ...paidItem, deletedAt: new Date() }, { ...options, now: +anchor + 600000 })).toBe('NONE')
  })

  test('existing full-edit exceptions hold past the window: jobs, admin items, bios', () => {
    expect(getItemEditMode({ ...paidItem, subNames: ['jobs'] }, { ...options, now: +anchor + 600000 })).toBe('FULL')
    expect(getItemEditMode(paidItem, { ...options, adminEdit: true, meId: 616, now: +anchor + 600000 })).toBe('FULL')
    expect(getItemEditMode(paidItem, { ...options, myBio: true, now: +anchor + 600000 })).toBe('FULL')
  })

  test('bios never enter addendum mode', () => {
    expect(getItemEditMode({ ...paidItem, bio: true }, { ...options, myBio: false, now: +anchor + 600000 })).toBe('NONE')
  })
})

describe('normalizeAddendumText', () => {
  test('caps the submitted Markdown source at 200 characters', () => {
    expect(normalizeAddendumText('a'.repeat(200))).toHaveLength(200)
    expect(() => normalizeAddendumText('a'.repeat(201))).toThrow(/200/)
    expect(() => normalizeAddendumText('😀'.repeat(101))).toThrow(/200/)
  })

  test('trims, permits clear, preserves links, rejects monerowall markers', () => {
    expect(normalizeAddendumText(' \n ')).toBe('')
    expect(normalizeAddendumText('  **Correction**  ')).toBe('**Correction**')
    expect(normalizeAddendumText('https://youtu.be/example')).toBe('https://youtu.be/example')
    expect(() => normalizeAddendumText('[monerowall]')).toThrow(/monerowall/)
    expect(() => normalizeAddendumText(undefined)).toThrow(/required/)
  })
})

describe('nextExpiryLatch (useCanEdit re-anchor)', () => {
  test('latch follows the NEW deadline when a late settlement re-anchors it', () => {
    const anchor = Date.now()
    // settled late: the new deadline is in the future — the latch must reset
    // so the new window arms its own timer instead of staying stuck expired
    expect(nextExpiryLatch(new Date(anchor + 600_000), anchor)).toBe(false)
    // once the NEW deadline passes, the latch flips
    expect(nextExpiryLatch(new Date(anchor + 600_000), anchor + 600_001)).toBe(true)
  })
})
