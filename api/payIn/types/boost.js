import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { piconerosToXmr } from '@/lib/format'
import { getItemResult, getSubs } from '../lib/item'
import { getRedistributedPayOutCustodialTokens } from '../lib/payOutCustodialTokens'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.OPTIMISTIC
]

export async function getInitial (models, { sats, id }, { me }) {
  const { subNames, parentId } = await models.item.findUnique({ where: { id: parseInt(id) } })
  const subs = await getSubs(models, { subNames, parentId })

  const piconeros = BigInt(sats) * 1000n
  const payOutCustodialTokens = getRedistributedPayOutCustodialTokens({ subs, piconeros })

  return {
    payInType: 'BOOST',
    userId: me?.id,
    piconeros,
    itemPayIn: { itemId: parseInt(id) },
    payOutCustodialTokens
  }
}

export async function onRetry (tx, oldPayInId, newPayInId) {
  const { itemId, payIn } = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  const item = await getItemResult(tx, { id: itemId })
  return { id: item.id, path: item.path, piconeros: payIn.piconeros, act: 'BOOST' }
}

export async function onBegin (tx, payInId, { piconeros, id }) {
  const item = await getItemResult(tx, { id })
  return { id: item.id, path: item.path, piconeros: BigInt(piconeros), act: 'BOOST' }
}

export async function onPaid (tx, payInId) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId }, include: { itemPayIn: { include: { item: true } } } })

  // boost column is denominated in the fork's legacy sats (1 sats == 1000 piconeros)
  const boostSats = Number(BigInt(payIn.piconeros) / 1000n)
  const item = payIn.itemPayIn.item

  if (item.parentId) {
    // increment boost on item and propagate commentBoost to ancestors in a single statement
    // NOTE: ancestors are ORDER BY id for consistent lock ordering to prevent deadlocks
    await tx.$executeRaw`
      WITH item_boosted AS (
        UPDATE "Item"
        SET boost = boost + ${boostSats}::INTEGER
        WHERE id = ${item.id}::INTEGER
        RETURNING *
      )
      UPDATE "Item"
      SET "commentBoost" = "Item"."commentBoost" + ${boostSats}::INTEGER
      FROM (
        SELECT "Item".id
        FROM "Item", item_boosted
        WHERE "Item".path @> item_boosted.path AND "Item".id <> item_boosted.id
        ORDER BY "Item".id
      ) AS ancestors
      WHERE "Item".id = ancestors.id`
  } else {
    // for top-level posts, just increment boost (trigger computes litCenteredSum/ranklit)
    await tx.item.update({
      where: { id: item.id },
      data: {
        boost: { increment: boostSats }
      }
    })
  }
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { itemPayIn: true } })
  return `SN: boost #${payIn.itemPayIn.itemId} by ${piconerosToXmr(payIn.piconeros)}`
}
