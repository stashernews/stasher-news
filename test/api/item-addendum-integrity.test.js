/* eslint-env jest */
// Real-DB integrity for the post-window addendum (2026-10-04 spec):
// concurrency (row lock + revision token), money-path isolation, atomic
// rollback, deletion interplay, and monerowall gating through the real wall
// loader. Mirrors test/engine/payInItemUpdate.test.js fixture style; the
// engine/money machinery itself is NOT exercised (the addendum mutation never
// calls pay()).
//
//   docker exec -u apprunner app npx jest test/api/item-addendum-integrity.test.js
import { PrismaClient } from '@prisma/client'
import addendumResolvers from '@/api/resolvers/item-addendum'
import { deleteItemByAuthor } from '@/lib/item'
import { createMoneroWallLoader } from '@/lib/monero-wall/loader'
import { PUBLIC_MEDIA_URL } from '@/lib/constants'

// lexicalHTMLGenerator's module graph is ESM-only (github-slugger) and cannot
// load in jest's sandbox; the lock tests below assert null paths, which never
// reach generation. Same treatment for lexical/server/mentions (ESM
// mdast-util-from-markdown), reached transitively via resolvers/item → the
// payIn types barrel — the exact stub payInItemUpdate.test.js uses.
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: jest.fn(() => '<p>addendum html</p>')
}))
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))

const prisma = new PrismaClient()
const created = { users: [], items: [], payIns: [], uploads: [] }

afterAll(async () => {
  await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  await prisma.itemPayIn.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  await prisma.itemAddendumUpload.deleteMany({ where: { itemId: { in: created.items } } }).catch(() => {})
  for (const id of created.payIns) await prisma.payIn.delete({ where: { id } }).catch(() => {})
  for (const id of created.items) await prisma.item.delete({ where: { id } }).catch(() => {})
  for (const id of created.uploads) await prisma.upload.delete({ where: { id } }).catch(() => {})
  for (const id of created.users) await prisma.user.delete({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

// 1h ago: a paid creation anchored here is always past the 600s window.
const anchor = () => new Date(Date.now() - 3_600_000)

async function createUser () {
  const user = await prisma.user.create({ data: {} })
  created.users.push(user.id)
  return user.id
}

// Owned post with a PAID ITEM_CREATE whose settlement stamp is 1h old.
async function createExpiredOwnedItem (userId) {
  const item = await prisma.item.create({
    data: { userId, title: 'addendum integrity post', subNames: ['meta'], text: 'original body' }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n, payInStateChangedAt: anchor() }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return item.id
}

const save = (itemId, text, expectedRevision, viewerId) =>
  addendumResolvers.Mutation.updateItemAddendum(
    null, { id: String(itemId), text, expectedRevision },
    { me: { id: viewerId }, models: prisma }
  )

test('concurrent saves with the same revision: exactly one lands, original text untouched', async () => {
  const userId = await createUser()
  const itemId = await createExpiredOwnedItem(userId)

  const [first, second] = await Promise.allSettled([
    save(itemId, '**first tab**', 0, userId),
    save(itemId, '**second tab**', 0, userId)
  ])
  const fulfilled = [first, second].filter(r => r.status === 'fulfilled')
  const rejected = [first, second].filter(r => r.status === 'rejected')
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(rejected[0].reason.message).toMatch(/reload/)

  const row = await prisma.item.findUnique({ where: { id: itemId } })
  const winner = fulfilled[0].value.addendumText === '**first tab**' ? '**first tab**' : '**second tab**'
  expect(row.addendumText).toBe(winner)
  expect(row.addendumRevision).toBe(1)
  // the original body, its proof hash, and the money rows are untouched
  expect(row.text).toBe('original body')
  expect(row.otsHash).toBeNull()
  expect(await prisma.itemUpload.count({ where: { itemId } })).toBe(0)
  expect(await prisma.itemPayIn.count({ where: { itemId } })).toBe(1)
})

test('save then author-delete leaves no addendum; delete then save is rejected', async () => {
  const userId = await createUser()
  const savedFirst = await createExpiredOwnedItem(userId)
  await save(savedFirst, 'kept until deletion', 0, userId)
  const item = await prisma.item.findUnique({ where: { id: savedFirst } })
  await deleteItemByAuthor({ models: prisma, id: savedFirst, item })
  const deleted = await prisma.item.findUnique({ where: { id: savedFirst } })
  expect(deleted.addendumText).toBeNull()
  expect(deleted.addendumUpdatedAt).toBeNull()
  // one increment from the save, one from the deletion — never reset
  expect(deleted.addendumRevision).toBe(2)
  await expect(save(savedFirst, 'zombie', 1, userId)).rejects.toThrow(/item not found/)

  const deletedFirst = await createExpiredOwnedItem(userId)
  await deleteItemByAuthor({ models: prisma, id: deletedFirst, item: null })
  await expect(save(deletedFirst, 'late', 0, userId)).rejects.toThrow(/item not found/)
})

test('a pin-write failure rolls the whole save back (text, time, revision, pins)', async () => {
  const userId = await createUser()
  const itemId = await createExpiredOwnedItem(userId)
  const upload = await prisma.upload.create({ data: { userId, size: 1024, type: 'image/png' } })
  created.uploads.push(upload.id)

  const brokenModels = {
    $transaction: (fn, opts) => prisma.$transaction(async tx => {
      const proxied = new Proxy(tx, {
        get (target, prop, receiver) {
          if (prop === 'itemAddendumUpload') {
            return {
              ...tx.itemAddendumUpload,
              createMany: async () => { throw new Error('injected pin failure') }
            }
          }
          return Reflect.get(target, prop, receiver)
        }
      })
      return fn(proxied)
    }, opts)
  }
  // the save references a real upload so the pin createMany actually runs.
  // PUBLIC_MEDIA_URL, not process.env.NEXT_PUBLIC_MEDIA_URL directly:
  // AWS_S3_URL_REGEXP is compiled from this same constant at import time, and
  // CI runners define only NEXT_PUBLIC_MEDIA_DOMAIN (no .env.development).
  await expect(addendumResolvers.Mutation.updateItemAddendum(
    null, { id: String(itemId), text: `${PUBLIC_MEDIA_URL}/${upload.id}`, expectedRevision: 0 },
    { me: { id: userId }, models: brokenModels }
  )).rejects.toThrow(/injected pin failure/)

  const row = await prisma.item.findUnique({ where: { id: itemId } })
  expect(row.addendumText).toBeNull()
  expect(row.addendumUpdatedAt).toBeNull()
  expect(row.addendumRevision).toBe(0)
  expect(await prisma.itemAddendumUpload.count({ where: { itemId } })).toBe(0)
  // the referenced upload itself is untouched (existence-only policy)
  expect(await prisma.upload.findUnique({ where: { id: upload.id } })).not.toBeNull()
})

describe('monerowall gating through the real loader', () => {
  test('locked viewers get no addendum content; the author does', async () => {
    const userId = await createUser()
    const otherId = await createUser()
    const itemId = await createExpiredOwnedItem(userId)
    await save(itemId, 'walled addendum', 0, userId)
    await prisma.item.update({
      where: { id: itemId },
      data: { moneroWallPricePiconeros: 1_000_000_000n, moneroWallEnabledAt: new Date() }
    })

    const authorLoader = createMoneroWallLoader({ models: prisma, me: { id: userId } })
    const lockedLoader = createMoneroWallLoader({ models: prisma, me: { id: otherId } })
    const authorCtx = { me: { id: userId }, models: prisma, moneroWallLoader: authorLoader }
    const lockedCtx = { me: { id: otherId }, models: prisma, moneroWallLoader: lockedLoader }

    // the save itself was never wall-gated (walls gate X/T, not addenda)
    expect(await addendumResolvers.Item.addendumText({ ...await prisma.item.findUnique({ where: { id: itemId } }) }, {}, authorCtx)).toBe('walled addendum')
    const raw = await prisma.item.findUnique({ where: { id: itemId } })
    expect(await addendumResolvers.Item.addendumText(raw, {}, lockedCtx)).toBeNull()
    expect(await addendumResolvers.Item.addendumUpdatedAt(raw, {}, lockedCtx)).toBeNull()
    expect(await addendumResolvers.Item.addendumLexicalState(raw, {}, lockedCtx)).toBeNull()
    expect(await addendumResolvers.Item.addendumHtml(raw, {}, lockedCtx)).toBeNull()
    // revision remains a visible counter
    expect(await addendumResolvers.Item.addendumRevision(raw, {}, lockedCtx)).toBe(1)
  })
})
