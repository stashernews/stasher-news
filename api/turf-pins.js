import { GqlAuthenticationError, GqlInputError } from '@/lib/error'

// Membership pins never write Item.pinId (reserved for reply/global pins).
// Writers lock Item, then Sub rows in canonical order. Compaction must not
// lock sibling Items; the membership trigger excludes position-only updates.

const MAX_PINS_PER_TURF = 6

function assertValidItemId (id) {
  const parsed = Number(id)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GqlInputError('invalid item id')
  }
  return parsed
}

// Deduplicate and sort caller-supplied names for deterministic SQL; the query's
// ORDER BY (canonical CITEXT) is the real lock-order authority.
function tidyNames (subNames) {
  return [...new Set((subNames ?? []).map(name => String(name)))]
    .filter(name => name.length > 0)
}

// Canonical Sub rows for the given names, locked FOR UPDATE in name order.
export async function lockTurfRows (tx, subNames) {
  const names = tidyNames(subNames)
  if (names.length === 0) return []
  return tx.$queryRaw`
    SELECT "name", "userId" FROM "Sub"
    WHERE "name" = ANY(${names}::CITEXT[])
    ORDER BY "name" ASC
    FOR UPDATE`
}

// Re-derive dense 1..n positions for a turf's live pins and drop pins on
// soft-deleted items. Writes only ItemSub rows — never the parent Items — so
// a compaction holds no Item row locks beyond the caller's own target.
export async function normalizeTurfPins (tx, subNames) {
  const names = tidyNames(subNames)
  if (names.length === 0) return
  await tx.$queryRaw`
    UPDATE "ItemSub" isp
    SET "pinPosition" = NULL
    WHERE "pinPosition" IS NOT NULL
      AND "subName" = ANY(${names}::CITEXT[])
      AND EXISTS (
        SELECT 1 FROM "Item" i
        WHERE i.id = isp."itemId" AND i."deletedAt" IS NOT NULL)`
  await tx.$queryRaw`
    UPDATE "ItemSub" isp
    SET "pinPosition" = ranked.rn
    FROM (
      SELECT "itemId", "subName",
        ROW_NUMBER() OVER (PARTITION BY "subName" ORDER BY "pinPosition", "itemId") AS rn
      FROM "ItemSub"
      WHERE "pinPosition" IS NOT NULL
        AND "subName" = ANY(${names}::CITEXT[])
    ) ranked
    WHERE isp."itemId" = ranked."itemId"
      AND isp."subName" = ranked."subName"
      AND isp."pinPosition" <> ranked.rn`
}

// Full pin metadata for a post, sorted by turf name. Empty for comments,
// bios, and deleted posts — the same surfaces the feed queries exclude.
export async function readTurfPins (tx, id) {
  const pins = await tx.$queryRaw`
    SELECT isp."subName", isp."pinPosition" AS position
    FROM "ItemSub" isp
    JOIN "Item" i ON i.id = isp."itemId"
    WHERE isp."itemId" = ${Number(id)}
      AND isp."pinPosition" IS NOT NULL
      AND i."parentId" IS NULL
      AND i."deletedAt" IS NULL
    ORDER BY isp."subName" ASC`
  return pins.map(pin => ({ subName: String(pin.subName), position: Number(pin.position) }))
}

// Clear this post's pins in the named turfs and compact those turfs. The
// caller must already hold the Item row lock (delete/remove-membership paths).
export async function clearItemTurfPins (tx, { id, subNames }) {
  const names = tidyNames(subNames)
  if (names.length === 0) return
  await lockTurfRows(tx, names)
  await tx.itemSub.updateMany({
    where: { itemId: Number(id), subName: { in: names }, pinPosition: { not: null } },
    data: { pinPosition: null }
  })
  await normalizeTurfPins(tx, names)
}

async function applyTurfPinState (tx, { item, turf, itemId, desired }) {
  const membership = await tx.itemSub.findUnique({
    where: { itemId_subName: { itemId, subName: turf.name } }
  })
  if (!membership) throw new GqlInputError('post is not in this turf')
  await normalizeTurfPins(tx, [turf.name])

  const current = await tx.itemSub.findUnique({
    where: { itemId_subName: { itemId, subName: turf.name } }
  })
  if (desired !== (current.pinPosition !== null)) {
    if (desired) {
      const [{ count }] = await tx.$queryRaw`
        SELECT COUNT(*)::int AS count FROM "ItemSub"
        WHERE "subName" = ${turf.name} AND "pinPosition" IS NOT NULL`
      if (count >= MAX_PINS_PER_TURF) throw new GqlInputError('max 6 pins allowed')
      await tx.itemSub.update({
        where: { itemId_subName: { itemId, subName: turf.name } },
        data: { pinPosition: count + 1 }
      })
    } else {
      await tx.itemSub.update({
        where: { itemId_subName: { itemId, subName: turf.name } },
        data: { pinPosition: null }
      })
      await normalizeTurfPins(tx, [turf.name])
    }
  }
  return { id: item.id, turfPins: await readTurfPins(tx, itemId) }
}

async function withTurfPinTransaction (models, me, id, resolveTarget) {
  if (!me) throw new GqlAuthenticationError()
  const itemId = assertValidItemId(id)
  return models.$transaction(async tx => {
    const [item] = await tx.$queryRaw`
      SELECT id, "parentId", bio, "deletedAt", status, "feeStatus", "bountyPiconeros", "bountyStatus"
      FROM "Item" WHERE id = ${itemId} FOR NO KEY UPDATE`
    if (!item || item.deletedAt) throw new GqlInputError('item not found')
    if (item.parentId || item.bio) throw new GqlInputError('only turf posts can be pinned')

    const target = await resolveTarget(tx, item)
    if (!target.turf) throw new GqlInputError('turf not found')
    if (Number(target.turf.userId) !== Number(me.id)) throw new GqlInputError('not your turf')

    const unfundedBounty = item.bountyPiconeros > 0n &&
      !['FUNDED', 'EXPIRED', 'AWARDED', 'REFUNDED', 'ROLLED_OVER'].includes(item.bountyStatus)
    if (target.desired && (item.status !== 'ACTIVE' || item.feeStatus === 'PENDING_FEE' || unfundedBounty)) {
      throw new GqlInputError('post is not live')
    }

    return applyTurfPinState(tx, { item, turf: target.turf, itemId, desired: target.desired })
  })
}

// Desired-state writes are safe to retry without toggling a committed pin.
export async function setTurfPin ({ id, subName, pinned }, { me, models }) {
  if (typeof pinned !== 'boolean') throw new GqlInputError('pinned must be a boolean')
  if (typeof subName !== 'string' || subName.trim().length === 0) {
    throw new GqlInputError('subName is required')
  }
  return withTurfPinTransaction(models, me, id, async tx => {
    const [turf] = await lockTurfRows(tx, [subName.trim()])
    return { turf, desired: pinned }
  })
}

// Resolve the legacy toggle's single membership only after locking the Item.
export async function toggleSingleTurfPin ({ id }, { me, models }) {
  return withTurfPinTransaction(models, me, id, async tx => {
    const memberships = await tx.itemSub.findMany({ where: { itemId: assertValidItemId(id) } })
    if (memberships.length === 0) {
      throw new GqlInputError('post does not belong to a turf')
    }
    if (memberships.length !== 1) {
      throw new GqlInputError('use setTurfPin with a turf name')
    }
    const [turf] = await lockTurfRows(tx, [memberships[0].subName])
    return { turf, desired: !(memberships[0].pinPosition !== null) }
  })
}
