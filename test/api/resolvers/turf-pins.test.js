/* eslint-env jest */
// GraphQL wiring for turf pins: the setTurfPin mutation delegation, the
// Item.turfPins metadata resolver (attached array vs DB fallback), and the
// legacy pinItem compatibility behavior for top-level posts.
import itemResolvers from '@/api/resolvers/item'
import { GqlInputError } from '@/lib/error'
import { resolveItemComments } from '../../../api/resolvers/comment-tree'
import { setTurfPin, toggleSingleTurfPin, readTurfPins } from '@/api/turf-pins'

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

// api/resolvers/item.js imports the payIn barrel at module load, which builds
// a Prisma client from DATABASE_URL — stub it like repostItem.test.js.
jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

// capture the sort Item.comments derives, without the SQL machinery
jest.mock('../../../api/resolvers/comment-tree', () => ({
  __esModule: true,
  resolveItemComments: jest.fn(async (item, sort) => ({ comments: [], cursor: null, sort }))
}))

jest.mock('../../../api/turf-pins', () => ({
  __esModule: true,
  setTurfPin: jest.fn(async () => ({ id: 10, turfPins: [{ subName: 'monero', position: 1 }] })),
  toggleSingleTurfPin: jest.fn(async () => ({ id: 10, turfPins: [{ subName: 'monero', position: 1 }] })),
  readTurfPins: jest.fn(async (models, id) => [{ subName: 'fallback', position: 2 }]),
  lockTurfRows: jest.fn(),
  normalizeTurfPins: jest.fn(),
  clearItemTurfPins: jest.fn()
}))

beforeEach(() => jest.clearAllMocks())

// The pin mutations re-read the item after the service runs, so the client
// gets the full row; the stubbed item query returns this one.
const REFETCHED = { id: 10, title: 'pinned', turfPins: [{ subName: 'monero', position: 1 }] }
const itemQuery = (otherRows = []) => jest.fn(async sql => sql.includes('requested(id, rank)') ? [{ ...REFETCHED, rank: 0 }] : otherRows)

describe('Mutation.setTurfPin wiring', () => {
  test('is registered in the Mutation map, delegates to the service and returns the re-read item', async () => {
    expect(typeof itemResolvers.Mutation.setTurfPin).toBe('function')
    const models = { $queryRawUnsafe: itemQuery() }
    const result = await itemResolvers.Mutation.setTurfPin(
      null, { id: '10', subName: 'monero', pinned: true }, { me: { id: 7 }, models }
    )
    expect(setTurfPin).toHaveBeenCalledWith(
      { id: '10', subName: 'monero', pinned: true }, { me: { id: 7 }, models }
    )
    expect(result).toEqual(REFETCHED)
  })

  test('unauthenticated requests reject before the service runs', async () => {
    await expect(itemResolvers.Mutation.setTurfPin(
      null, { id: '10', subName: 'monero', pinned: true }, { me: null, models: {} }
    )).rejects.toThrow()
    expect(setTurfPin).not.toHaveBeenCalled()
  })
})

describe('Item.turfPins metadata resolver', () => {
  const resolver = itemResolvers.Item.turfPins

  test('is registered', () => {
    expect(typeof resolver).toBe('function')
  })

  test('uses the attached array without touching the database', async () => {
    const attached = [{ subName: 'alpha', position: 1 }]
    const result = await resolver({ id: 1, turfPins: attached }, {}, { models: {} })
    expect(result).toBe(attached)
    expect(readTurfPins).not.toHaveBeenCalled()
  })

  test('falls back to the database for rows without attached metadata', async () => {
    const models = { marker: true, $queryRaw: jest.fn() }
    const result = await resolver({ id: 42 }, {}, { models })
    expect(readTurfPins).toHaveBeenCalledWith(models, 42)
    expect(result).toEqual([{ subName: 'fallback', position: 2 }])
  })

  test('treats a client without raw query capability as having no pins', async () => {
    await expect(resolver({ id: 42 }, {}, { models: {} })).resolves.toEqual([])
    expect(readTurfPins).not.toHaveBeenCalled()
  })

  test('returns [] for comments, bios, and deleted items without querying', async () => {
    await expect(resolver({ id: 1, parentId: 9 }, {}, { models: {} })).resolves.toEqual([])
    await expect(resolver({ id: 1, bio: true }, {}, { models: {} })).resolves.toEqual([])
    await expect(resolver({ id: 1, deletedAt: new Date() }, {}, { models: {} })).resolves.toEqual([])
    expect(readTurfPins).not.toHaveBeenCalled()
  })
})

describe('turf pins never leak into legacy pin fields', () => {
  test('Item.position stays null for an item with only turf pins', async () => {
    const result = await itemResolvers.Item.position(
      { id: 1, pinId: null, turfPins: [{ subName: 'alpha', position: 1 }] }, {}, { models: {} }
    )
    expect(result).toBeNull()
  })

  test('a turf-pinned thread defaults its comment sort to new', async () => {
    const item = { id: 5, parentId: null, bioId: null, pinId: null, ncomments: 1, createdAt: new Date() }
    const lastSort = () => resolveItemComments.mock.calls[resolveItemComments.mock.calls.length - 1][1]
    const ctx = { models: { $queryRaw: jest.fn() }, me: null }
    await itemResolvers.Item.comments(item, {}, { ...ctx, item: { ...item, turfPins: [{ subName: 'alpha', position: 1 }] } })
    expect(lastSort()).toBe('new')
    await itemResolvers.Item.comments({ ...item, turfPins: [] }, {}, ctx)
    expect(lastSort()).toBe('lit')
    // an explicit user sort is honored regardless of pins
    await itemResolvers.Item.comments({ ...item, turfPins: [{ subName: 'alpha', position: 1 }] }, { sort: 'top' }, ctx)
    expect(lastSort()).toBe('top')
  })
})

describe('legacy pinItem compatibility for top-level posts', () => {
  const pinItem = itemResolvers.Mutation.pinItem
  const models = item => ({
    item: { findUnique: async () => item },
    $queryRawUnsafe: itemQuery([{ count: 0 }]),
    pin: { delete: jest.fn() },
    $transaction: jest.fn(async fn => fn({
      item: { update: jest.fn() },
      pin: { delete: jest.fn() },
      $queryRawUnsafe: async () => []
    }))
  })

  test('a bio is rejected without running the toggle', async () => {
    const item = { id: 5, parentId: null, bio: true, pinId: null }
    await expect(pinItem(null, { id: '5' }, { me: { id: 7 }, models: models(item) }))
      .rejects.toThrow('only turf posts can be pinned')
    expect(toggleSingleTurfPin).not.toHaveBeenCalled()
  })

  test('a single-turf post toggles its membership through the service', async () => {
    const item = { id: 10, parentId: null, bio: false, pinId: null, subs: [{ sub: { userId: 7 } }] }
    const m = models(item)
    const result = await pinItem(null, { id: '10' }, { me: { id: 7 }, models: m })
    expect(toggleSingleTurfPin).toHaveBeenCalledWith({ id: '10' }, { me: { id: 7 }, models: m })
    expect(result).toEqual(REFETCHED)
  })

  test('an ambiguous multi-turf post surfaces the explicit-API error', async () => {
    const item = { id: 10, parentId: null, bio: false, pinId: null, subs: [{ sub: { userId: 7 } }, { sub: { userId: 7 } }] }
    toggleSingleTurfPin.mockRejectedValueOnce(new GqlInputError('use setTurfPin with a turf name'))
    await expect(pinItem(null, { id: '10' }, { me: { id: 7 }, models: models(item) }))
      .rejects.toThrow('use setTurfPin with a turf name')
  })
})
