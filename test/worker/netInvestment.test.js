/* eslint-env jest */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const created = { users: [], items: [] }

afterAll(async () => {
  for (const id of created.items) await prisma.item.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createItem (data = {}) {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  const item = await prisma.item.create({
    data: { userId: row.id, title: 'net-investment', status: 'ACTIVE', ...data }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  return item.id
}

test('tips raise netInvestment', async () => {
  const id = await createItem()
  await prisma.$executeRaw`UPDATE "Item" SET piconeros = piconeros + 1000000000 WHERE id = ${id}::int`
  const item = await prisma.item.findUnique({ where: { id } })
  expect(item.netInvestment).toBe(1000000000n)
})

test('cost/boost are 1000x-scaled into netInvestment', async () => {
  const id = await createItem({ cost: 10, boost: 1 })
  const item = await prisma.item.findUnique({ where: { id } })
  expect(item.netInvestment).toBe(11000n)
})

test('netInvestment is negative when downvotes exceed investment', async () => {
  const id = await createItem({ piconeros: 1000000000n })
  await prisma.$executeRaw`UPDATE "Item" SET "downPiconeros" = "downPiconeros" + 2000000000 WHERE id = ${id}::int`
  const item = await prisma.item.findUnique({ where: { id } })
  expect(item.netInvestment).toBe(-1000000000n)
})

test('feeInvestmentPiconeros folds into netInvestment', async () => {
  const id = await createItem()
  await prisma.$executeRaw`UPDATE "Item" SET "feeInvestmentPiconeros" = 1000000000 WHERE id = ${id}::int`
  const item = await prisma.item.findUnique({ where: { id } })
  expect(item.netInvestment).toBe(1000000000n)
})

test('unrelated updates do not recompute netInvestment', async () => {
  const id = await createItem()
  await prisma.item.update({ where: { id }, data: { title: 'renamed' } })
  const item = await prisma.item.findUnique({ where: { id } })
  expect(item.netInvestment).toBe(0n)
})
