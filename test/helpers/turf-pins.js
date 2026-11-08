import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

// Write-heavy fixtures must never target a shared or production database.
export function turfPinFixture () {
  if (new URL(process.env.DATABASE_URL).pathname !== '/stasher_turf_pins_test') {
    throw new Error('turf pin tests require the dedicated test database')
  }
  const db = new PrismaClient()
  const created = { users: [], subs: [], items: [], payIns: [], pins: [] }
  const tag = randomUUID().replaceAll('-', '').slice(0, 12)
  let subSeq = 0
  const user = async () => {
    const row = await db.user.create({ data: {} })
    created.users.push(row.id)
    return row
  }
  const sub = async (owner, suffix) => {
    const row = await db.sub.create({
      data: {
        name: `pin${tag}${suffix}${subSeq++}`,
        userId: owner.id,
        postTypes: ['DISCUSSION', 'LINK', 'POLL'],
        rankingType: 'WOT',
        billingType: 'ONCE',
        billingCost: 0
      }
    })
    created.subs.push(row.id)
    return row
  }
  const post = async (author, subs) => {
    const row = await db.item.create({
      data: {
        userId: author.id,
        title: 'turf pin test',
        text: 'body',
        subs: { create: subs.map(s => ({ subName: s.name })) }
      }
    })
    created.items.push(row.id)
    const payment = await db.payIn.create({
      data: { userId: author.id, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
    })
    created.payIns.push(payment.id)
    await db.itemPayIn.create({ data: { itemId: row.id, payInId: payment.id } })
    return row
  }
  const cleanup = async () => {
    await db.itemPayIn.deleteMany({ where: { itemId: { in: created.items } } })
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.payIn.deleteMany({ where: { id: { in: created.payIns } } })
    await db.pin.deleteMany({ where: { id: { in: created.pins } } })
    await db.sub.deleteMany({ where: { id: { in: created.subs } } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    await db.$disconnect()
  }
  return { db, created, user, sub, post, cleanup, tag }
}
