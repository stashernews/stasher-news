/* eslint-env jest */
// Post-window addendum mutation: unit tests for the free save path and the
// Item field resolvers. Mocks follow test/api/draft.test.js; the money path
// (payIn.create / upload.update / itemUpload writes) must never be touched —
// asserted explicitly in 'writes only addendum state'.
import resolvers from '@/api/resolvers/item-addendum'
import { moneroWallStateFor } from '../../api/resolvers/item'
import { uploadIdsFromText } from '../../api/resolvers/upload'
import { submitItemAddendum } from '../../lib/item-addendum'

jest.mock('../../api/resolvers/item', () => ({
  getItem: async (parent, { id }, { models }) => models.item.findUnique({ where: { id } }),
  moneroWallStateFor: jest.fn(async () => null)
}))
jest.mock('../../api/resolvers/upload', () => ({
  uploadIdsFromText: jest.fn(() => [])
}))
// lexicalHTMLGenerator's module graph is ESM-only (github-slugger) and cannot
// load in jest's sandbox; HTML generation is exercised at the SSR/integrity
// level, not in this unit suite.
jest.mock('../../lib/lexical/server/html', () => ({
  lexicalHTMLGenerator: jest.fn(() => '<p>addendum</p>')
}))

// 1h in the past: paid rows anchored here are always past the 600s window.
const anchor = new Date(Date.now() - 3_600_000)
const me = { id: 42 }

function makeRow (over = {}) {
  return {
    id: 123,
    userId: 42,
    createdAt: anchor,
    updatedAt: anchor,
    subNames: ['meta'],
    text: 'original body',
    otsHash: 'hash0',
    parentId: null,
    addendumText: null,
    addendumUpdatedAt: null,
    addendumRevision: 0,
    ...over
  }
}

function makeModels (row) {
  const tx = {
    $queryRaw: jest.fn(async () => (row ? [{ id: row.id }] : [])),
    $executeRaw: jest.fn(async () => 1),
    item: { findUnique: jest.fn(async () => row), update: jest.fn(async () => row) },
    user: { findUnique: jest.fn(async () => ({ bioId: null })) },
    payIn: {
      findFirst: jest.fn(async () => ({ payInState: 'PAID', payInStateChangedAt: anchor })),
      create: jest.fn()
    },
    itemAddendumUpload: { deleteMany: jest.fn(), createMany: jest.fn() },
    itemUpload: { deleteMany: jest.fn() },
    upload: { update: jest.fn(), findMany: jest.fn(async () => []) }
  }
  return {
    models: { $transaction: jest.fn(async (fn) => fn(tx)) },
    tx
  }
}

const save = (models, args, viewer = me) =>
  resolvers.Mutation.updateItemAddendum(null, args, { models, me: viewer })

describe('updateItemAddendum', () => {
  test('writes only addendum state, never original content or monetary fields', async () => {
    const { models, tx } = makeModels(makeRow())
    const args = { id: '123', text: '**Correction**', expectedRevision: 0 }
    await save(models, args)
    const data = tx.item.update.mock.calls[0][0].data
    expect(Object.keys(data).sort()).toEqual([
      'addendumRevision', 'addendumText', 'addendumUpdatedAt'
    ])
    expect(data.addendumRevision).toEqual({ increment: 1 })
    expect(data.addendumText).toBe('**Correction**')
    expect(data.addendumUpdatedAt).toBeInstanceOf(Date)
    expect(tx.itemUpload.deleteMany).not.toHaveBeenCalled()
    expect(tx.upload.update).not.toHaveBeenCalled()
    expect(tx.payIn.create).not.toHaveBeenCalled()
    // addendum-only pins are synced and the imgproxy refresh job is queued
    expect(tx.itemAddendumUpload.deleteMany).toHaveBeenCalledWith({ where: { itemId: 123 } })
    expect(tx.$executeRaw).toHaveBeenCalled()
  })

  test('pins reused Stasher uploads by id', async () => {
    uploadIdsFromText.mockReturnValueOnce([12, 13])
    const { models, tx } = makeModels(makeRow())
    tx.upload.findMany.mockResolvedValueOnce([{ id: 12 }, { id: 13 }])
    await save(models, { id: '123', text: '![](/uploads/12) /uploads/13', expectedRevision: 0 })
    expect(tx.upload.findMany).toHaveBeenCalledWith({ where: { id: { in: [12, 13] } }, select: { id: true } })
    expect(tx.itemAddendumUpload.createMany).toHaveBeenCalledWith({
      data: [{ itemId: 123, uploadId: 12 }, { itemId: 123, uploadId: 13 }]
    })
  })

  test('rejects a save referencing a no-longer-existing upload', async () => {
    uploadIdsFromText.mockReturnValueOnce([99])
    const { models, tx } = makeModels(makeRow())
    await expect(save(models, { id: '123', text: '/uploads/99', expectedRevision: 0 }))
      .rejects.toThrow(/no longer available/)
    expect(tx.item.update).not.toHaveBeenCalled()
  })

  test('empty text is an intentional clear: nulls content, advances revision', async () => {
    const when = new Date()
    const { models, tx } = makeModels(makeRow({ addendumText: 'old', addendumUpdatedAt: when, addendumRevision: 3 }))
    await save(models, { id: '123', text: '   ', expectedRevision: 3 })
    const data = tx.item.update.mock.calls[0][0].data
    expect(data.addendumText).toBeNull()
    expect(data.addendumUpdatedAt).toBeNull()
    expect(data.addendumRevision).toEqual({ increment: 1 })
  })

  test('a normalized unchanged save writes nothing and leaves the timestamp alone', async () => {
    const when = new Date()
    const { models, tx } = makeModels(makeRow({ addendumText: 'same', addendumUpdatedAt: when, addendumRevision: 2 }))
    const result = await save(models, { id: '123', text: '  same  ', expectedRevision: 2 })
    expect(tx.item.update).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 123 })
  })

  test('rejects a stale revision without writing (two-tab / clear-recreate safety)', async () => {
    const { models, tx } = makeModels(makeRow({ addendumRevision: 1 }))
    await expect(save(models, { id: '123', text: 'late', expectedRevision: 0 }))
      .rejects.toThrow(/reload/)
    expect(tx.item.update).not.toHaveBeenCalled()
  })

  test('rejects before the edit window has expired', async () => {
    const { models, tx } = makeModels(makeRow())
    tx.payIn.findFirst.mockResolvedValueOnce({ payInState: 'PAID', payInStateChangedAt: new Date() })
    await expect(save(models, { id: '123', text: 'early', expectedRevision: 0 }))
      .rejects.toThrow(/not in addendum edit mode/)
  })

  test('rejects pending and missing creation payIns (first-stage flow unchanged)', async () => {
    const pending = makeModels(makeRow())
    pending.tx.payIn.findFirst.mockResolvedValueOnce({ payInState: 'PENDING', payInStateChangedAt: anchor })
    await expect(save(pending.models, { id: '123', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/not in addendum edit mode/)

    const none = makeModels(makeRow())
    none.tx.payIn.findFirst.mockResolvedValueOnce(null)
    await expect(save(none.models, { id: '123', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/not in addendum edit mode/)
  })

  test('rejects missing, foreign, and deleted items uniformly', async () => {
    const missing = makeModels(null)
    missing.tx.item.findUnique.mockResolvedValueOnce(null)
    await expect(save(missing.models, { id: '123', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/item not found/)

    const foreign = makeModels(makeRow({ userId: 7 }))
    await expect(save(foreign.models, { id: '123', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/item not found/)

    const deleted = makeModels(makeRow({ deletedAt: new Date() }))
    await expect(save(deleted.models, { id: '123', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/item not found/)
  })

  test('rejects anonymous callers', async () => {
    const { models } = makeModels(makeRow())
    await expect(save(models, { id: '123', text: 'x', expectedRevision: 0 }, null))
      .rejects.toThrow(/logged in/)
  })

  test('rejects malformed ids and revisions before touching the database', async () => {
    const { models, tx } = makeModels(makeRow())
    await expect(save(models, { id: 'abc', text: 'x', expectedRevision: 0 })).rejects.toThrow(/id/)
    await expect(save(models, { id: '0', text: 'x', expectedRevision: 0 })).rejects.toThrow(/id/)
    await expect(save(models, { id: '123', text: 'x', expectedRevision: -1 })).rejects.toThrow(/revision/)
    await expect(save(models, { id: '123', text: 'x', expectedRevision: 1.5 })).rejects.toThrow(/revision/)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  test('a successful save returns the meta row (imgproxyUrls present for immediate proxied rendering)', async () => {
    const { models, tx } = makeModels(makeRow({ imgproxyUrls: { '/uploads/1': { video: true } } }))
    tx.item.update.mockResolvedValueOnce({ ...makeRow(), viaRawUpdate: true })
    const result = await save(models, { id: '123', text: 'with media', expectedRevision: 0 })
    // the raw update row lacks imgproxyUrls/rel; the returned item must be the
    // meta row so a just-saved media addendum renders proxied without refetch
    expect(result.imgproxyUrls).toBeDefined()
    expect(result.viaRawUpdate).toBeUndefined()
  })

  test('rejects ids beyond PostgreSQL INTEGER range with a clean input error', async () => {
    const { models } = makeModels(makeRow())
    await expect(save(models, { id: '9999999999', text: 'x', expectedRevision: 0 }))
      .rejects.toThrow(/id/)
  })

  test('rejects >200 characters and monerowall markers', async () => {
    const { models, tx } = makeModels(makeRow())
    await expect(save(models, { id: '123', text: 'a'.repeat(201), expectedRevision: 0 }))
      .rejects.toThrow(/200/)
    await expect(save(models, { id: '123', text: '[monerowall]', expectedRevision: 0 }))
      .rejects.toThrow(/monerowall/)
    expect(tx.item.update).not.toHaveBeenCalled()
  })
})

describe('Item addendum field resolvers', () => {
  const ctx = { me, models: {} }
  const row = () => makeRow({
    payIn: { payInState: 'PAID', payInStateChangedAt: anchor },
    user: { bioId: null },
    addendumText: '**Correction**',
    addendumUpdatedAt: anchor,
    addendumRevision: 1
  })

  test('editMode follows the shared helper from meta-carrying rows', async () => {
    expect(await resolvers.Item.editMode(row(), {}, ctx)).toBe('ADDENDUM')
    expect(await resolvers.Item.editMode(row(), {}, { me: { id: 7 }, models: {} })).toBe('NONE')
  })

  test('editExpiresAt exposes the canonical deadline for timed/addendum modes only', async () => {
    const expiry = await resolvers.Item.editExpiresAt(row(), {}, ctx)
    expect(expiry.getTime()).toBe(+anchor + 600000)
    const unpaid = row()
    unpaid.payIn = { payInState: 'PENDING', payInStateChangedAt: anchor }
    expect(await resolvers.Item.editExpiresAt(unpaid, {}, ctx)).toBeNull()
    expect(await resolvers.Item.editExpiresAt(row(), {}, { me: { id: 7 }, models: {} })).toBeNull()
  })

  test('editExpiresAt survives NULL subNames (legacy rows) for the author', async () => {
    const legacy = row()
    legacy.subNames = null
    const expiry = await resolvers.Item.editExpiresAt(legacy, {}, ctx)
    expect(expiry.getTime()).toBe(+anchor + 600000)
  })

  test('locked monerowall viewers get no addendum content; visible viewers do', async () => {
    expect(await resolvers.Item.addendumText(row(), {}, ctx)).toBe('**Correction**')
    expect(await resolvers.Item.addendumUpdatedAt(row(), {}, ctx)).toEqual(anchor)
    moneroWallStateFor.mockResolvedValueOnce({ locked: true })
    expect(await resolvers.Item.addendumText(row(), {}, ctx)).toBeNull()
    moneroWallStateFor.mockResolvedValueOnce({ locked: true })
    expect(await resolvers.Item.addendumUpdatedAt(row(), {}, ctx)).toBeNull()
    moneroWallStateFor.mockResolvedValueOnce({ locked: true })
    expect(await resolvers.Item.addendumLexicalState(row(), {}, ctx)).toBeNull()
    moneroWallStateFor.mockResolvedValueOnce({ locked: true })
    expect(await resolvers.Item.addendumHtml(row(), {}, ctx)).toBeNull()
    // revision is a counter, not content: visible even under a lock
    moneroWallStateFor.mockResolvedValueOnce({ locked: true })
    expect(await resolvers.Item.addendumRevision(row(), {}, ctx)).toBe(1)
    moneroWallStateFor.mockClear()
  })
})

describe('submitItemAddendum (form submit logic)', () => {
  test('conflict throws a tagged error so the Form preserves the localStorage draft', async () => {
    const conflict = { graphQLErrors: [{ extensions: { code: 'E_ADDENDUM_CONFLICT' } }] }
    await expect(submitItemAddendum({
      updateItemAddendum: async () => { throw conflict }, id: '1', text: 'x', expectedRevision: 0
    })).rejects.toThrow(/changed in another session/)
  })

  test('success resolves; foreign errors propagate untouched', async () => {
    await expect(submitItemAddendum({
      updateItemAddendum: async () => ({}), id: '1', text: 'x', expectedRevision: 0
    })).resolves.toBeUndefined()
    await expect(submitItemAddendum({
      updateItemAddendum: async () => { throw new Error('boom') }, id: '1', text: 'x', expectedRevision: 0
    })).rejects.toThrow(/boom/)
  })
})

describe('GraphQL schema surface', () => {
  test('updateItemAddendum accepts only id, text, and expectedRevision', async () => {
    const { makeExecutableSchema } = require('@graphql-tools/schema')
    const { graphql } = require('graphql')
    const typeDefs = require('../../api/typeDefs').default
    const schema = makeExecutableSchema({ typeDefs, resolvers: [] })
    const { errors } = await graphql({
      schema,
      source: 'mutation { updateItemAddendum(id: "1", text: "x", expectedRevision: 0, title: "hax") { id } }'
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toMatch(/title/)
  })
})
