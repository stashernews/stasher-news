import { COMMENT_DEPTH_LIMIT, COMMENTS_OF_COMMENT_LIMIT, FULL_COMMENTS_THRESHOLD } from './constants'
import { datePivot } from './time'
import { clearItemTurfPins } from '@/api/turf-pins'

export const defaultCommentSort = (pinned, bio, createdAt) => {
  // pins sort by new
  if (pinned) return 'new'
  // everything else sorts by lit
  return 'lit'
}

// a delete directive preceded by a non word character that isn't a backtick
const deletePattern = /\B@delete\s+in\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?/gi

// Legacy rows can carry NULL subNames (62/187 in the dev DB as of 2026-10-04);
// callers reach this with raw DB rows (item resolvers, worker/imgproxy), so a
// null must read as "not a job", never crash the calling query.
export const isJob = item => item?.subNames?.includes('jobs') ?? false

const deleteMentionPattern = /\B@delete/i

const reminderPattern = /\B@remindme\s+in\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?/gi

const reminderMentionPattern = /\B@remindme/i

export const hasDeleteMention = (text) => deleteMentionPattern.test(text ?? '')

export const getDeleteCommand = (text) => {
  if (!text) return false
  const matches = [...text.matchAll(deletePattern)]
  const commands = matches?.map(match => ({ number: parseInt(match[1]), unit: match[2] }))
  return commands.length ? commands[commands.length - 1] : undefined
}

export const getDeleteAt = (text) => {
  const command = getDeleteCommand(text)
  if (command) {
    const { number, unit } = command
    return datePivot(new Date(), { [`${unit}s`]: number })
  }
  return null
}

export const getRemindAt = (text) => {
  const command = getReminderCommand(text)
  if (command) {
    const { number, unit } = command
    return datePivot(new Date(), { [`${unit}s`]: number })
  }
  return null
}

export const hasDeleteCommand = (text) => !!getDeleteCommand(text)

export const hasReminderMention = (text) => reminderMentionPattern.test(text ?? '')

export const getReminderCommand = (text) => {
  if (!text) return false
  const matches = [...text.matchAll(reminderPattern)]
  const commands = matches?.map(match => ({ number: parseInt(match[1]), unit: match[2] }))
  return commands.length ? commands[commands.length - 1] : undefined
}

export const hasReminderCommand = (text) => !!getReminderCommand(text)

export const deleteItemByAuthor = async ({ models, id }) => {
  // The delete decision and pin cleanup use the row read under the Item lock,
  // not a potentially stale caller-supplied snapshot, so a concurrent
  // pin write (which locks the same Item row first) cannot leave a pinned
  // deleted post behind.
  return await models.$transaction(async tx => {
    const [current] = await tx.$queryRaw`
      SELECT id, "userId", text, title, url, "pollCost", bio
      FROM "Item" WHERE id = ${Number(id)} FOR NO KEY UPDATE`
    if (!current) {
      console.log('attempted to delete an item that does not exist', id)
      return
    }
    // Post-window addendum (2026-10-04 spec): a deleted item exposes no
    // addendum and must not accept a late one — null the content/time and bump
    // the revision so any in-flight save conflicts.
    const pinnedSubNames = await tx.$queryRaw`
      SELECT "subName" FROM "ItemSub" WHERE "itemId" = ${Number(id)} AND "pinPosition" IS NOT NULL`
    await clearItemTurfPins(tx, { id: Number(id), subNames: pinnedSubNames.map(row => row.subName) })
    await deleteReminders({ id, userId: Number(current.userId), models: tx })
    const updateData = {
      deletedAt: new Date(),
      addendumText: null,
      addendumUpdatedAt: null,
      addendumRevision: { increment: 1 }
    }
    if (current.text) {
      updateData.text = '*deleted by author*'
    }
    if (current.title) {
      updateData.title = 'deleted by author'
    }
    if (current.url) {
      updateData.url = null
    }
    if (current.pollCost) {
      updateData.pollCost = null
    }

    return await tx.item.update({ where: { id: Number(id) }, data: updateData })
  })
}

export const deleteReminders = async ({ id, userId, models }) => {
  await models.$queryRaw`
  DELETE FROM pgboss.job
  WHERE name = 'reminder'
  AND data->>'itemId' = ${id}::TEXT
  AND data->>'userId' = ${userId}::TEXT
  AND state <> 'completed'`
  await models.reminder.deleteMany({
    where: {
      itemId: Number(id),
      userId: Number(userId),
      remindAt: {
        gt: new Date()
      }
    }
  })
}

export const commentSubTreeRootId = (item, root) => {
  const path = item.path.split('.')

  // if this is a limited comment tree, we can't be sure comments at our depth are visible
  // beyond COMMENTS_OF_COMMENT_LIMIT, so COMMENTS_OF_COMMENT_LIMIT is the max depth we can navigate to
  if (item.root?.ncomments > FULL_COMMENTS_THRESHOLD || root?.ncomments > FULL_COMMENTS_THRESHOLD) {
    return path.slice(-COMMENTS_OF_COMMENT_LIMIT)[0]
  }
  return path.slice(-(COMMENT_DEPTH_LIMIT - 1))[0]
}
