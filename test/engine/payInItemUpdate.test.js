/* eslint-env jest */

// ITEM_UPDATE upload-fee regression (A-07). getInitial used to read
// `totalFeesMsats` off uploadFees (renamed to totalFeesPiconeros in Task 1),
// which crashed the prospect with piconeros: undefined. Now getInitial builds a
// POSTING-subaddress URI covering the upload fee and attaches a MEDIA_UPLOAD
// beneficiary (onPaid is a no-op; Upload.paid flips in rewardsWalletObserver's
// flipPendingToLive when the covering fee is observed). The fee only attaches
// when the item already has a paid ITEM_CREATE payIn; otherwise getInitial
// throws ('cannot increase item cost with unpaid invoice').
//
// ITEM_UPDATE result-payIn regression (edit-countdown bug). afterBegin used to
// attach the edit's own ITEM_UPDATE payIn to the result item
// (`{ ...result, payIn }`), and Item.payIn returns an attached payIn as-is. The
// upsertComment fragment caches that as Item:<id>.payIn, so use-can-edit.js
// anchored the client's 10-minute window on the edit while updateItem kept
// anchoring on the item's PAID ITEM_CREATE payIn — the UI showed a live
// countdown that the server refused ("item can no longer be edited"). The
// result item must keep the ITEM_CREATE payIn for ITEM_UPDATE payIns (upstream
// 59f9f8d5; stripped by c0043ef3).
//
// Deferred fee-bearing edits (Task 3, 2026-09-17). An ITEM_UPDATE that attaches
// uploads over 10MB quotes the upload fee on its moneroUri (piconeros stays 0n),
// so the payIn is born PAID and onBegin used to apply the edit immediately — a
// user could attach >10MB media and never pay by dismissing the QR. onBegin now
// stores such an edit in PendingItemUpdate (args + the item's pre-edit text) and
// rewardsWalletObserver.flipPendingToLive applies it when the covering fee is
// observed. A pending row whose item was deleted or edited again while the fee
// was in flight is dropped (the upload stays paid and is re-attachable); free
// edits still apply at onBegin.
//
// Real-DB integration test (mirrors test/engine/payInItemCreate.test.js):
//   docker exec -u apprunner app npx jest test/engine/payInItemUpdate.test.js

import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { getInitial } from '@/api/payIn/types/itemUpdate'
import { getItem } from '@/api/resolvers/item'
import { flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { logError } from '@/lib/logger'
import { alert } from '@/lib/alert'

// itemUpdate.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown) and @/api/resolvers/item (getItem), neither of
// which getInitial exercises — stub both like payInItemCreate.test.js.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))
// Stub the fee-subaddress pool so getInitial never touches MoneroAccount /
// SubaddressIndex rows (deterministic; same stub as payInItemCreate.test.js).
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(async () => ({
    id: 1,
    major: 1,
    minor: 1,
    address: '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  }))
}))
// The observer's ITEM_UPDATE branch and applyPendingItemUpdate log/alert on
// drops and apply failures; mock both so the tests assert them directly and the
// output stays pristine.
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
// The engine tests below drive pay('ITEM_UPDATE', ...), which imports the
// api/payIn/types barrel. Following payInItemCreate.test.js, the barrel is
// mocked to expose ONLY the real ITEM_UPDATE and MEDIA_UPLOAD modules (the spec
// must be relative; see the comment above on jest.mock vs the @/ alias).
// MEDIA_UPLOAD must be real too: the deferred tests attach uploads, which
// creates a MEDIA_UPLOAD beneficiary through pay().
jest.mock('../../api/payIn/types', () => {
  const itemUpdate = jest.requireActual('../../api/payIn/types/itemUpdate')
  const mediaUpload = jest.requireActual('../../api/payIn/types/mediaUpload')
  return { __esModule: true, default: { ITEM_UPDATE: itemUpdate, MEDIA_UPLOAD: mediaUpload } }
})

const prisma = new PrismaClient()

const created = { users: [], items: [], payIns: [], uploads: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// Root post with a paid ITEM_CREATE payIn attached — an update can only charge
// upload fees when such a payIn exists (the fee attaches to it).
async function createRootPost (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${userId}::int, ${'upload-fee update test post'}, now())
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: id, payInId: payIn.id } })
  return { id, payInId: payIn.id }
}

async function createUpload (userId, { size }) {
  const upload = await prisma.upload.create({ data: { userId, size, type: 'image/png' } })
  created.uploads.push(upload.id)
  return upload.id
}

// PlatformFeeConfig id=1 exists in the dev DB with @default values; create it
// only if absent so the tests stay self-contained on a fresh database.
let feeConfigCreated = false
async function ensureFeeConfig () {
  const existing = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (existing) return
  await prisma.platformFeeConfig.create({ data: { id: 1 } })
  feeConfigCreated = true
}

// Delete pgboss jobs referencing an item so the worker never executes them
// against test rows (the edit path queues imgproxy; search triggers queue
// indexItem) — same cleanup as payInItemCreate.test.js.
async function deleteJobsForItem (itemId) {
  const id = String(itemId)
  await prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE data->>'id' = ${id} OR data->>'itemId' = ${id}`
}

afterAll(async () => {
  for (const id of created.items) {
    await deleteJobsForItem(id)
  }
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  for (const id of created.items) {
    await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  }
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  if (feeConfigCreated) {
    await prisma.platformFeeConfig.delete({ where: { id: 1 } }).catch(() => {})
  }
  await prisma.$disconnect()
})

// --- A-07 regression: ITEM_UPDATE with uploads no longer crashes (totalFeesMsats bug) ---
test('getInitial builds an upload-fee URI for an item update adding a >10MB upload', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId) // has a paid ITEM_CREATE payIn
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const result = await getInitial(prisma, { id: String(itemId), uploadIds: [uploadId] }, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001') // upload fee only
  expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
})

// --- edit-countdown regression: the result item must keep the ITEM_CREATE payIn ---
//
// Drives pay('ITEM_UPDATE', ...) end-to-end on a real DB. getItem is stubbed at
// the top of this file, so it returns the real ITEM_CREATE PayIn row exactly
// like the ITEM_CREATE-only SQL join in api/resolvers/item.js does. Before the
// fix, afterBegin overwrote result.payIn with the (free) edit's ITEM_UPDATE
// payIn; the client cached it and anchored the 10-minute edit countdown on the
// edit time while updateItem anchored on the create payIn's payInStateChangedAt.
test('pay("ITEM_UPDATE", ...) returns the ITEM_CREATE payIn on the result item, not the edit payIn', async () => {
  const userId = await createUser()
  const { id: itemId, payInId: createPayInId } = await createRootPost(userId)
  const createPayIn = await prisma.payIn.findUnique({ where: { id: createPayInId } })

  getItem.mockImplementationOnce(async () => ({ id: itemId, payIn: createPayIn }))

  const result = await pay('ITEM_UPDATE', { id: String(itemId), text: 'edited body' }, { me: { id: userId } })
  created.payIns.push(result.id)

  // the mutation's own payIn is the ITEM_UPDATE one...
  expect(result.payInType).toBe('ITEM_UPDATE')
  expect(result.payInState).toBe('PAID')
  expect(result.id).not.toBe(createPayInId)

  // ...but the result item must carry the item's PAID ITEM_CREATE payIn so the
  // client countdown and the server's updateItem window agree
  expect(result.result).toBeTruthy()
  expect(result.result.payIn).toBeTruthy()
  expect(result.result.payIn.payInType).toBe('ITEM_CREATE')
  expect(result.result.payIn.id).toBe(createPayInId)
  expect(result.result.payIn.payInState).toBe('PAID')
  expect(new Date(result.result.payIn.payInStateChangedAt).getTime()).toBe(new Date(createPayIn.payInStateChangedAt).getTime())

  // the edit itself landed
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBe('edited body')

  // the onPaid streak job references the test user (deleted in afterAll); drop
  // it so the worker never executes it against a deleted row
  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})

// --- fee-edit deferral: nothing attaches until the covering fee is observed ---
test('a fee-bearing edit is deferred: item, text and uploads stay untouched', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: `edited ![](http://media.test/uploads/${uploadId})`, uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  expect(result.payInType).toBe('ITEM_UPDATE')
  expect(result.payInState).toBe('PAID')
  expect(result.moneroUri).toMatch(/^monero:/)

  const deferred = await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })
  expect(deferred).toBeTruthy()
  expect(deferred.itemId).toBe(itemId)
  expect(deferred.oldText).toBeNull() // createRootPost seeds no text

  const untouched = await prisma.item.findUnique({ where: { id: itemId } })
  expect(untouched.text).toBeNull()
  expect(await prisma.itemUpload.findFirst({ where: { itemId } })).toBeNull()
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(false)

  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})

test('flipPendingToLive applies the deferred edit and marks the upload paid (idempotent)', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const editedText = `edited with media ![](http://media.test/uploads/${uploadId})`
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: editedText, uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe(editedText)
  expect(await prisma.itemUpload.findFirst({ where: { itemId, uploadId } })).toBeTruthy()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(true)

  // a replayed observation must not apply anything a second time
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)
  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe(editedText)

  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})

test('a deferred edit is dropped, not applied, when the item changed while the fee was in flight', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // a newer edit lands (e.g. a free typo fix) before the fee is observed
  await prisma.item.update({ where: { id: itemId }, data: { text: 'newer manual edit' } })

  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe('newer manual edit')
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  // a dropped edit also drops its fee payIn (the pending row is consumed by the
  // claim, so the abandonment sweep would never reach it)
  expect(await prisma.payIn.findUnique({ where: { id: result.id } })).toBeNull()
  // the fee still counts: the upload is paid and can be re-attached for free
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(true)

  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})

// The unused-image sweep can remove a deferred edit's unpaid upload before the
// fee lands (deleteUnusedImages now pins fee-due uploads with a live fee payIn,
// but manual/legacy deletions still happen). Attaching a missing upload would
// violate the ItemUpload FK and, uncaught, wedge the observer — the apply must
// drop the edit instead (pending row consumed, item untouched, alert raised).
test('a deferred edit whose upload vanished is dropped without an FK failure', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // the upload is gone before the fee lands
  await prisma.upload.delete({ where: { id: uploadId } })

  await expect(flipPendingToLive(prisma, payInRow, 1_000_000_000n)).resolves.toBeUndefined()

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  // the dropped edit's fee payIn is deleted with it (see the stale-edit test)
  expect(await prisma.payIn.findUnique({ where: { id: result.id } })).toBeNull()
  expect(alert).toHaveBeenCalledWith(
    'warn',
    expect.stringContaining('uploads missing'),
    expect.stringContaining(String(result.id)),
    expect.objectContaining({ dedupeKey: expect.any(String) })
  )

  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})

// Any unexpected apply failure must not fail the observer run: the cursor only
// advances on a clean run, so a throw here would re-process the same tx on every
// retry (conflict path) and re-run this flip — freezing ALL fee attribution
// until manual intervention (the 2026-08-10 item-2755 incident class).
// flipPendingToLive must catch, log, alert, and let the run finish; the apply
// transaction rolls back and the pending edit survives for the abandonment purge.
test('an unexpected apply failure is contained by flipPendingToLive and does not wedge the observer', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // getItem is the last call of applyItemUpdate; rejecting it stands in for any
  // unexpected failure after the apply has begun
  getItem.mockRejectedValueOnce(new Error('boom'))

  await expect(flipPendingToLive(prisma, payInRow, 1_000_000_000n)).resolves.toBeUndefined()

  // the apply tx rolled back: nothing applied, the pending row survives
  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('ITEM_UPDATE failed'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(String(result.id)),
    expect.objectContaining({ dedupeKey: expect.any(String) })
  )

  await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = 'checkStreak' AND data->>'id' = ${String(userId)}`
})
