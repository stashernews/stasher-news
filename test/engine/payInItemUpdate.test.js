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
// Real-DB integration test (mirrors test/engine/payInItemCreate.test.js):
//   docker exec -u apprunner app npx jest test/engine/payInItemUpdate.test.js

import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { getInitial } from '@/api/payIn/types/itemUpdate'
import { getItem } from '@/api/resolvers/item'

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
// The engine test below drives pay('ITEM_UPDATE', ...), which imports the
// api/payIn/types barrel. Following payInItemCreate.test.js, the barrel is
// mocked to expose ONLY the real ITEM_UPDATE module (the spec must be relative;
// see the comment above on jest.mock vs the @/ alias). The update test has no
// upload beneficiaries, so MEDIA_UPLOAD is not needed here.
jest.mock('../../api/payIn/types', () => {
  const itemUpdate = jest.requireActual('../../api/payIn/types/itemUpdate')
  return { __esModule: true, default: { ITEM_UPDATE: itemUpdate } }
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
