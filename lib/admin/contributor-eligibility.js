import { createHash, randomUUID } from 'node:crypto'
import { AdminError, validateApplyRequest } from './validate'
import { alert } from '@/lib/alert'

const REASONS = ['PLAGIARISM', 'AI_GENERATED', 'RULES', 'OTHER']
const FLAG_FIELDS = ['contributorDisqualifiedAt', 'contributorDisqualifiedReason', 'contributorDisqualifiedNote', 'contributorDisqualifiedNotifyAt']
const SELECT = Object.fromEntries(['id', 'title', 'userId', 'parentId', 'bio', 'deletedAt', 'contributorModerationRevision', ...FLAG_FIELDS].map(key => [key, true]))
const value = v => v instanceof Date ? v.toISOString() : v ?? null
const invalid = message => { throw new AdminError('VALIDATION_ERROR', message) }

export function validateContributorId (id) {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) invalid('invalid post or run id')
}

export function contributorPostVersion (row) {
  const fields = ['id', 'userId', 'parentId', 'bio', 'deletedAt', 'contributorModerationRevision', ...FLAG_FIELDS]
  return createHash('sha256').update(JSON.stringify(fields.map(key => value(row[key])))).digest('hex')
}

export async function readContributorPost (models, id) {
  validateContributorId(id)
  const row = await models.item.findUnique({ where: { id }, select: { ...SELECT, user: { select: { name: true } } } })
  if (!row) return null
  if (row.parentId || row.bio) invalid('only top-level non-bio posts can be reviewed')
  return {
    id,
    title: row.title,
    authorId: row.userId,
    authorName: row.user?.name ?? null,
    deleted: row.deletedAt != null,
    disqualifiedAt: value(row.contributorDisqualifiedAt),
    disqualificationReason: row.contributorDisqualifiedReason,
    note: row.contributorDisqualifiedNote,
    notifyAt: value(row.contributorDisqualifiedNotifyAt),
    version: contributorPostVersion(row)
  }
}

const LIST_PAGE = 20
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_(\d+)$/

// Posts that currently carry a disqualification flag, newest flag first.
// Keyset cursor `<flaggedAt ISO>_<id>`, so a flag cleared between pages
// cannot shift or repeat rows.
export async function readDisqualifiedContributorPosts (models, { after = null } = {}) {
  let older = {}
  if (after != null) {
    const m = CURSOR.exec(after)
    const at = m && new Date(m[1])
    if (!m || isNaN(at)) invalid('invalid page cursor')
    validateContributorId(Number(m[2]))
    older = { OR: [{ contributorDisqualifiedAt: { lt: at } }, { contributorDisqualifiedAt: at, id: { lt: Number(m[2]) } }] }
  }
  const flagged = { contributorDisqualifiedAt: { not: null }, parentId: null, bio: false }
  const [rows, total] = await Promise.all([
    models.item.findMany({
      where: { ...flagged, ...older },
      orderBy: [{ contributorDisqualifiedAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE + 1,
      select: { id: true, title: true, userId: true, deletedAt: true, ...Object.fromEntries(FLAG_FIELDS.map(key => [key, true])), user: { select: { name: true } } }
    }),
    models.item.count({ where: flagged })
  ])
  const page = rows.slice(0, LIST_PAGE)
  const last = page[page.length - 1]
  return {
    total,
    rows: page.map(row => ({
      id: row.id,
      title: row.title,
      authorId: row.userId,
      authorName: row.user?.name ?? null,
      deleted: row.deletedAt != null,
      disqualifiedAt: value(row.contributorDisqualifiedAt),
      disqualificationReason: row.contributorDisqualifiedReason,
      note: row.contributorDisqualifiedNote,
      notifyAt: value(row.contributorDisqualifiedNotifyAt)
    })),
    nextCursor: rows.length > LIST_PAGE ? `${value(last.contributorDisqualifiedAt)}_${last.id}` : null
  }
}

function validateRequest (r) {
  validateContributorId(r.id)
  validateApplyRequest({ reason: r.reason, changes: [{ key: 'contributorEligibility' }] })
  if (typeof r.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(r.expectedVersion)) invalid('invalid expected post version')
  if (typeof r.disqualified !== 'boolean' || typeof r.notifyAuthor !== 'boolean') invalid('invalid eligibility or notification choice')
  if (!r.disqualified && r.notifyAuthor) invalid('restoring eligibility cannot notify the author')
  if (r.disqualified && !REASONS.includes(r.disqualificationReason)) invalid('select a disqualification reason')
  if (r.note != null && (typeof r.note !== 'string' || r.note.length > 2000)) invalid('private note must contain at most 2000 characters')
}

function flagData (row, r) {
  const now = new Date()
  return {
    contributorDisqualifiedAt: r.disqualified ? row.contributorDisqualifiedAt ?? now : null,
    contributorDisqualifiedReason: r.disqualified ? r.disqualificationReason : null,
    contributorDisqualifiedNote: r.disqualified ? r.note?.trim() || null : null,
    contributorDisqualifiedNotifyAt: !r.disqualified ? null : r.notifyAuthor ? now : row.contributorDisqualifiedAt ? row.contributorDisqualifiedNotifyAt : null
  }
}

async function persistEligibility (tx, r, applyId) {
  await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${r.id} FOR UPDATE`
  const row = await tx.item.findUnique({ where: { id: r.id }, select: SELECT })
  if (!row) invalid('post not found')
  if (row.parentId || row.bio) invalid('only top-level non-bio posts can be reviewed')
  if (contributorPostVersion(row) !== r.expectedVersion) throw new AdminError('STALE_VALUE', 'post eligibility changed; reload before applying', [String(r.id)])
  if (row.deletedAt && r.disqualified) invalid('deleted posts can only have their flag cleared')
  const data = flagData(row, r)
  const changed = FLAG_FIELDS.filter(key => value(row[key]) !== value(data[key]))
  if (!changed.length && !r.notifyAuthor) invalid('no eligibility changes to apply')
  const audit = { applyId, actor: 'ssh-tunnel', store: 'item', targetId: String(r.id), reason: r.reason.trim() }
  await tx.item.update({ where: { id: r.id }, data: { ...data, contributorModerationRevision: { increment: 1 } } })
  await tx.adminConfigChange.createMany({
    data: [
      ...changed.map(field => ({ ...audit, field, oldValue: String(value(row[field]) ?? 'null'), newValue: String(value(data[field]) ?? 'null') })),
      { ...audit, field: 'notifyAuthor', oldValue: 'not requested', newValue: String(r.notifyAuthor) }
    ]
  })
}

export async function setContributorEligibility ({ notifyAuthor = false, ...request }) {
  const r = { ...request, notifyAuthor }
  validateRequest(r)
  const applyId = randomUUID()
  for (let attempt = 0; ; attempt++) {
    try {
      await r.models.$transaction(tx => persistEligibility(tx, r, applyId), { isolationLevel: 'Serializable', timeout: 10000 })
      break
    } catch (error) {
      if (attempt >= 2 || !(error.code === 'P2034' || ['40001', '40P01'].includes(error.meta?.code))) throw error
    }
  }
  let alertDelivered = false
  try {
    alertDelivered = await alert('warn', 'Contributor eligibility changed',
      `Post ${r.id}: ${r.disqualified ? `disqualified (${r.disqualificationReason})` : 'flag cleared'}. Author notification: ${r.notifyAuthor ? 'Yes' : 'No'}. Audit: ${applyId}`, { dedupeKey: applyId }) === true
  } catch {}
  return { applyId, applied: true, alertDelivered, error: null }
}
