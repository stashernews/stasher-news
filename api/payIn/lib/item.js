import { USER_ID } from '@/lib/constants'
import { deleteReminders, getDeleteAt, getRemindAt } from '@/lib/item'

export async function getSubs (models, { subNames, parentId }) {
  if (!subNames && !parentId) {
    return []
  }

  if (parentId) {
    const subs = await models.$queryRaw`
      SELECT "Sub".*
      FROM "Item" i
      LEFT JOIN "Item" r ON r.id = i."rootId"
      JOIN "Sub" ON "Sub".name = ANY(COALESCE(r."subNames", i."subNames"))
      WHERE i.id = ${Number(parentId)}`

    return subs
  }

  return await models.sub.findMany({ where: { name: { in: subNames } } })
}

/**
 * True iff `userId` owns at least one of the turfs this item targets — a post's
 * own `subNames`, or (for comments) the parent thread's turfs resolved by
 * `getSubs`. Anon never owns (territories require auth to create). Used by the
 * ITEM_CREATE fee gate to waive posting/comment fees for turf owners.
 */
export async function ownsAnySub (models, { subNames, parentId, userId }) {
  if (userId === USER_ID.anon) return false
  const subs = await getSubs(models, { subNames, parentId })
  return subs.some(s => Number(s.userId) === Number(userId))
}

// ltree is unsupported in Prisma, so we have to query it manually (FUCK!)
export async function getItemResult (tx, { id }) {
  return (await tx.$queryRaw`
    SELECT *, ltree2text(path) AS path, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM "Item" WHERE id = ${id}::INTEGER`
  )[0]
}

export async function getMentions (tx, { names, userId }) {
  if (!names?.length) return []

  const users = await tx.user.findMany({
    where: {
      name: { in: names },
      id: { not: userId || USER_ID.anon }
    }
  })
  return users.map(user => ({ userId: user.id }))
}

export const getItemMentions = async (tx, { itemIds, userId }) => {
  if (!itemIds?.length) return []

  const referee = await tx.item.findMany({
    where: {
      id: { in: itemIds },
      userId: { not: userId || USER_ID.anon }
    }
  })
  return referee.map(r => ({ refereeId: r.id }))
}

export async function performBotBehavior (tx, { text, id, userId = USER_ID.anon }) {
  // delete any existing deleteItem or reminder jobs for this item
  id = Number(id)
  await tx.$queryRaw`
    DELETE FROM pgboss.job
    WHERE name = 'deleteItem'
    AND data->>'id' = ${id}::TEXT
    AND state <> 'completed'`
  await deleteReminders({ id, userId, models: tx })

  if (text) {
    const deleteAt = getDeleteAt(text)
    if (deleteAt) {
      // pg-boss v9 dropped the DB-side default on pgboss.job.id (uuids are now
      // minted by the JS client), so these raw INSERTs must supply it via gen_random_uuid.
      await tx.$queryRaw`
        INSERT INTO pgboss.job (id, name, data, startafter, keepuntil)
        VALUES (
          gen_random_uuid(),
          'deleteItem',
          jsonb_build_object('id', ${id}::INTEGER),
          ${deleteAt}::TIMESTAMP WITH TIME ZONE,
          ${deleteAt}::TIMESTAMP WITH TIME ZONE + interval '1 minute')`
    }

    const remindAt = getRemindAt(text)
    if (remindAt) {
      await tx.$queryRaw`
        INSERT INTO pgboss.job (id, name, data, startafter, keepuntil)
        VALUES (
          gen_random_uuid(),
          'reminder',
          jsonb_build_object('itemId', ${id}::INTEGER, 'userId', ${userId}::INTEGER),
          ${remindAt}::TIMESTAMP WITH TIME ZONE,
          ${remindAt}::TIMESTAMP WITH TIME ZONE + interval '1 minute')`
      await tx.reminder.create({
        data: {
          userId,
          itemId: Number(id),
          remindAt
        }
      })
    }
  }
}
