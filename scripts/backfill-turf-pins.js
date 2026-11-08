// One-time legacy pin backfill. Stop all app/worker writers; run --check
// before --apply. Mapping JSON: { "itemId": "canonicalTurfName" }.
// Cutover, blockers and rollback: docs/ops/turf-pin-cutover.md.

import { PrismaClient } from '@prisma/client'
import { readFile } from 'node:fs/promises'
import { normalizeTurfPins, lockTurfRows } from '@/api/turf-pins'

const MAX_PINS_PER_TURF = 6

const sameTurf = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

// Read-only preflight. `models` may be a client or a transaction.
export async function inspectLegacyTurfPins (models, mapping = {}) {
  const rows = await models.$queryRaw`
    SELECT i.id AS "itemId", i."parentId" AS "parentId", i."deletedAt" AS "deletedAt",
      i."pinId" AS "pinId", i."subNames" AS "scalarSubNames",
      p.position AS "legacyPosition", p.cron AS cron, p.timezone AS timezone,
      (SELECT array_agg(s."subName" ORDER BY s."subName") FROM "ItemSub" s WHERE s."itemId" = i.id) AS memberships
    FROM "Item" i
    JOIN "Pin" p ON p.id = i."pinId"
    WHERE i."parentId" IS NULL`

  const live = rows.filter(row => !row.deletedAt)
  const blockers = []
  const resolved = []
  // candidates: live top-level posts that actually carry memberships. A live
  // post whose scalar subNames is nonempty but has NO membership rows is data
  // drift the backfill must refuse to guess about — it would otherwise look
  // like a global post and its legacy pin would silently vanish from the new
  // turf feeds at cutover. Both-empty scalars and memberships are true global
  // pins and stay untouched.
  const candidates = []
  for (const row of live) {
    const hasMemberships = (row.memberships ?? []).length > 0
    const hasScalar = (row.scalarSubNames ?? []).length > 0
    if (hasMemberships) {
      candidates.push(row)
    } else if (hasScalar) {
      blockers.push({ itemId: String(row.itemId), reason: 'membership disagreement between subNames and memberships' })
    }
  }
  const staleDeleted = rows.filter(row => row.deletedAt && (row.memberships ?? []).length > 0)

  const candidateIds = candidates.map(row => BigInt(row.itemId))
  const shareCounts = new Map()
  if (candidateIds.length > 0) {
    const shares = await models.$queryRaw`
      SELECT i."pinId" AS "pinId", COUNT(*)::int AS n
      FROM "Item" i
      WHERE i."parentId" IS NULL AND i."deletedAt" IS NULL
        AND (SELECT COUNT(*) FROM "ItemSub" s WHERE s."itemId" = i.id) > 0
        AND i."pinId" IS NOT NULL
      GROUP BY i."pinId"`
    for (const share of shares) shareCounts.set(String(share.pinId), Number(share.n))
  }

  // Queued/scheduled repin jobs for candidate pins (pgboss only exists once
  // the worker schema has been installed).
  const [{ hasBoss }] = await models.$queryRaw`
    SELECT (to_regclass('pgboss.job') IS NOT NULL) AS "hasBoss"`
  const repinJobs = new Map()
  if (hasBoss && candidates.length > 0) {
    const names = candidates.map(row => `repin-${row.pinId}`)
    const jobs = await models.$queryRaw`
      SELECT name FROM pgboss.job
      WHERE name = ANY(${names}::text[]) AND state NOT IN ('completed', 'failed', 'cancelled')`
    for (const job of jobs) repinJobs.set(String(job.name), true)
  }

  // existing new-style pins per destination turf, plus per-candidate conflict.
  // Group by the canonical Sub name: ItemSub.subName is CITEXT and may carry
  // case-variant spellings of the same turf, which would otherwise split the
  // six-pin budget across aliases.
  const existingCounts = await models.$queryRaw`
    SELECT s."name" AS "subName", COUNT(*)::int AS n
    FROM "ItemSub" isp
    JOIN "Item" i ON i.id = isp."itemId" AND i."deletedAt" IS NULL
    JOIN "Sub" s ON s."name" = isp."subName"
    WHERE isp."pinPosition" IS NOT NULL
    GROUP BY s."name"`
  const existingByTurf = new Map(existingCounts.map(row => [String(row.subName), Number(row.n)]))
  const conflicts = await models.$queryRaw`
    SELECT "itemId" FROM "ItemSub"
    WHERE "pinPosition" IS NOT NULL AND "itemId" = ANY(${candidateIds}::bigint[])`
  const conflictedIds = new Set(conflicts.map(row => String(row.itemId)))

  const blocked = (row, reason) => blockers.push({ itemId: String(row.itemId), reason })

  for (const row of candidates) {
    const memberships = (row.memberships ?? []).map(String)
    const pinId = String(row.pinId)

    const scalar = (row.scalarSubNames ?? []).map(String)
    const membershipSet = memberships.map(n => n.toLowerCase()).sort()
    const scalarSet = scalar.map(n => n.toLowerCase()).sort()
    if (membershipSet.join(',') !== scalarSet.join(',')) {
      blocked(row, 'membership disagreement between subNames and memberships')
      continue
    }
    if (conflictedIds.has(String(row.itemId))) {
      blocked(row, 'conflicting existing membership pin on the destination')
      continue
    }
    if (row.cron || row.timezone) {
      blocked(row, 'scheduled legacy pin (cron/timezone)')
      continue
    }
    if ((shareCounts.get(pinId) ?? 0) > 1) {
      blocked(row, 'shared legacy pin referenced by multiple live turf posts')
      continue
    }
    if (repinJobs.has(`repin-${pinId}`)) {
      blocked(row, 'queued repin job for this pin')
      continue
    }

    let destination = null
    const mapped = mapping[String(row.itemId)]
    if (mapped != null && !memberships.some(name => sameTurf(name, mapped))) {
      blocked(row, 'explicit mapping does not name a membership of this post')
      continue
    }
    if (memberships.length === 1) {
      destination = memberships[0]
    } else if (mapped != null) {
      destination = memberships.find(name => sameTurf(name, mapped))
    } else {
      blocked(row, 'ambiguous legacy pin requires an explicit destination mapping')
      continue
    }

    resolved.push({ row, destination })
  }

  // Canonicalize destinations against the Sub rows: memberships may carry
  // case-variant CITEXT spellings, and the cap must count one budget per
  // canonical turf, not per spelling.
  const destinations = [...new Set(resolved.map(entry => entry.destination))]
  const canonicalRows = await lockTurfRows(models, destinations)
  for (const entry of resolved) {
    const canonical = canonicalRows.find(row => sameTurf(row.name, entry.destination))
    if (canonical) entry.destination = String(canonical.name)
  }
  const regrouped = new Map()
  for (const entry of resolved) {
    const list = regrouped.get(entry.destination) ?? []
    list.push(entry.row)
    regrouped.set(entry.destination, list)
  }

  for (const [turf, incoming] of regrouped) {
    const total = (existingByTurf.get(turf) ?? 0) + incoming.length
    if (total > MAX_PINS_PER_TURF) {
      for (const row of incoming) {
        blocked(row, `destination ~${turf} would exceed 6 pins`)
      }
      for (const entry of resolved.filter(r => sameTurf(r.destination, turf))) {
        resolved.splice(resolved.indexOf(entry), 1)
      }
    }
  }

  // deterministic promotion order: destination turf, then legacy position, id
  resolved.sort((a, b) =>
    a.destination.toLowerCase().localeCompare(b.destination.toLowerCase()) ||
    Number(a.row.legacyPosition) - Number(b.row.legacyPosition) ||
    Number(a.row.itemId) - Number(b.row.itemId))

  return {
    scanned: rows.length,
    candidates: candidates.map(row => ({
      itemId: String(row.itemId), pinId: String(row.pinId), memberships: (row.memberships ?? []).map(String)
    })),
    autoMapped: resolved.filter(({ row }) => (row.memberships ?? []).length === 1).length,
    resolved,
    staleDeleted: staleDeleted.map(row => String(row.itemId)),
    blockers
  }
}

// Apply mode: one transaction; preflight re-runs inside it and ANY blocker
// aborts before the first write. Check mode never writes.
export async function backfillTurfPins (models, { mapping = {}, apply = false } = {}) {
  if (!apply) return inspectLegacyTurfPins(models, mapping)

  return models.$transaction(async tx => {
    const report = await inspectLegacyTurfPins(tx, mapping)
    if (report.blockers.length > 0) {
      const reasons = report.blockers.map(b => `item ${b.itemId}: ${b.reason}`).join('; ')
      throw new Error(`backfill blocked: ${report.blockers.length} blocker(s): ${reasons}`)
    }

    let promoted = 0
    for (const { row, destination } of report.resolved) {
      const [{ n }] = await tx.$queryRaw`
        SELECT COUNT(*)::int AS n FROM "ItemSub"
        WHERE "subName" = ${destination} AND "pinPosition" IS NOT NULL`
      if (n >= MAX_PINS_PER_TURF) {
        throw new Error(`backfill blocked: destination ~${destination} would exceed 6 pins`)
      }
      await tx.itemSub.update({
        where: { itemId_subName: { itemId: Number(row.itemId), subName: destination } },
        data: { pinPosition: n + 1 }
      })
      await tx.item.update({ where: { id: Number(row.itemId) }, data: { pinId: null } })
      promoted += 1
    }

    // deleted legacy posts: drop the obsolete link, keep the Pin row
    let clearedDeleted = 0
    for (const itemId of report.staleDeleted) {
      await tx.item.update({ where: { id: Number(itemId) }, data: { pinId: null } })
      clearedDeleted += 1
    }

    const destinations = [...new Set(report.resolved.map(r => r.destination))]
    await normalizeTurfPins(tx, destinations)
    return { promoted, clearedDeleted, report }
  })
}

const isCli = process.argv[1] && process.argv[1].endsWith('backfill-turf-pins.js')

async function main () {
  const apply = process.argv.includes('--apply')
  const check = process.argv.includes('--check') || !apply
  const mappingIndex = process.argv.indexOf('--mapping')
  let mapping = {}
  if (mappingIndex !== -1) {
    const path = process.argv[mappingIndex + 1]
    if (!path) throw new Error('--mapping requires a file path')
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null ||
      !Object.values(parsed).every(value => typeof value === 'string')) {
      throw new Error('mapping file must be a JSON object of { itemId: turfName }')
    }
    mapping = parsed
  }
  if (!check && !apply) throw new Error('nothing to do')

  const models = new PrismaClient()
  try {
    const report = await inspectLegacyTurfPins(models, mapping)
    console.log(`scanned ${report.scanned} legacy pin row(s); ${report.candidates.length} turf-post candidate(s)`)
    console.log(`auto-mappable: ${report.autoMapped}; stale deleted: ${report.staleDeleted.length}`)
    for (const blocker of report.blockers) {
      console.log(`BLOCKED item ${blocker.itemId}: ${blocker.reason}`)
    }
    if (!apply) {
      console.log('check mode — no rows written (pass --apply to write)')
      return
    }
    if (report.blockers.length > 0) {
      throw new Error(`${report.blockers.length} blocker(s) must be resolved before apply`)
    }
    const result = await backfillTurfPins(models, { mapping, apply: true })
    console.log(`applied: promoted ${result.promoted}, cleared deleted links ${result.clearedDeleted}`)
  } finally {
    await models.$disconnect()
  }
}

if (isCli) {
  main().catch(err => {
    console.error(err.message || err)
    process.exit(1)
  })
}
