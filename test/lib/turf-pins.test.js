/* eslint-env jest */
// Pure, browser-safe turf pin helpers: eligibility of owned pin actions,
// per-turf position lookup, and the any-pin predicate used by delete-menu and
// comment-sort behavior. No server imports.
import { ownedPinTurfs, turfPinPosition, hasAnyPin } from '@/lib/turf-pins'

describe('ownedPinTurfs', () => {
  test('lists both owned memberships but no unrelated owned turf', () => {
    const item = {
      parentId: null,
      deletedAt: null,
      bio: false,
      subs: [{ name: 'alpha', userId: 7 }, { name: 'beta', userId: 7 }, { name: 'other', userId: 8 }],
      turfPins: [{ subName: 'beta', position: 1 }]
    }
    expect(ownedPinTurfs(item, { id: '7' })).toEqual([
      { name: 'alpha', userId: 7, pinned: false },
      { name: 'beta', userId: 7, pinned: true }
    ])
  })

  test('matches turf names case-insensitively for pin state', () => {
    const item = {
      parentId: null,
      bio: false,
      deletedAt: null,
      subs: [{ name: 'Alpha', userId: 7 }],
      turfPins: [{ subName: 'ALPHA', position: 3 }]
    }
    expect(ownedPinTurfs(item, { id: 7 })[0].pinned).toBe(true)
    expect(turfPinPosition(item, 'alpha')).toBe(3)
    expect(turfPinPosition(item, 'beta')).toBeNull()
    expect(turfPinPosition(item, undefined)).toBeNull()
  })

  test('returns none for comments, bios, deleted items, and anonymous viewers', () => {
    const item = { parentId: 3, bio: false, deletedAt: null, subs: [{ name: 'alpha', userId: 7 }] }
    expect(ownedPinTurfs(item, { id: 7 })).toEqual([])
    expect(ownedPinTurfs({ ...item, parentId: null, bio: true }, { id: 7 })).toEqual([])
    expect(ownedPinTurfs({ ...item, parentId: null, deletedAt: new Date() }, { id: 7 })).toEqual([])
    expect(ownedPinTurfs({ parentId: null, bio: false, deletedAt: null, subs: [{ name: 'alpha', userId: 7 }] }, null)).toEqual([])
    expect(ownedPinTurfs(null, { id: 7 })).toEqual([])
  })

  test('sorts by turf name', () => {
    const item = {
      parentId: null,
      bio: false,
      deletedAt: null,
      subs: [{ name: 'zeta', userId: 7 }, { name: 'Alpha', userId: 7 }, { name: 'mid', userId: 7 }]
    }
    expect(ownedPinTurfs(item, { id: 7 }).map(t => t.name)).toEqual(['Alpha', 'mid', 'zeta'])
  })
})

describe('hasAnyPin', () => {
  test('true for legacy positions, legacy pin links, and turf pins', () => {
    expect(hasAnyPin({ position: 2 })).toBe(true)
    expect(hasAnyPin({ pinId: 9 })).toBe(true)
    expect(hasAnyPin({ turfPins: [{ subName: 'alpha', position: 1 }] })).toBe(true)
  })

  test('false for unpinned items and undefined/null', () => {
    expect(hasAnyPin({ position: null, turfPins: [] })).toBe(false)
    expect(hasAnyPin({})).toBe(false)
    expect(hasAnyPin(null)).toBe(false)
    expect(hasAnyPin(undefined)).toBe(false)
  })
})
