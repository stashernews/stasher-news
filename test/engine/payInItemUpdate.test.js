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
// Real-DB integration test (mirrors test/engine/payInItemCreate.test.js):
//   docker exec -u apprunner app npx jest test/engine/payInItemUpdate.test.js

import { PrismaClient } from '@prisma/client'
import { getInitial } from '@/api/payIn/types/itemUpdate'

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
  return id
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

afterAll(async () => {
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
  const itemId = await createRootPost(userId) // has a paid ITEM_CREATE payIn
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const result = await getInitial(prisma, { id: String(itemId), uploadIds: [uploadId] }, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001') // upload fee only
  expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
})
