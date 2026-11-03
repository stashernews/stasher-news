import { randomBytes, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { alert } from '@/lib/alert'
import { clearSiteSettingsCache } from '@/lib/siteSettings'
import { clearFeeConfigCache } from '@/api/monero/postingFee'
import { clearGateCache, issueGateToken, gateTokenHash } from '@/lib/invite-gate'
import { AdminError, validateApplyRequest, validateChanges } from './validate'
import { parseFieldValue, formatFieldValue } from './units'
import { readAdminState } from './state'
import { writeMaintenance } from './maintenance'

async function serializable (models, operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await models.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 })
    } catch (error) {
      const conflict = error.code === 'P2034' || error.meta?.code === '40001' || error.meta?.code === '40P01'
      if (!conflict || attempt >= 2) throw error
    }
  }
}

function assertExpected (changes, state) {
  const stale = changes.filter(change => {
    try {
      const expected = formatFieldValue(change.field, parseFieldValue(change.field, change.expected))
      return expected !== formatFieldValue(change.field, state[change.key])
    } catch { throw new AdminError('VALIDATION_ERROR', `invalid expected value for ${change.key}`, [change.key]) }
  }).map(change => change.key)
  if (stale.length) throw new AdminError('STALE_VALUE', 'settings changed; reload before applying', stale)
}

async function validateUserIds (models, changes) {
  const ids = changes.find(change => change.key === 'distributionExcludedCuratorIds')?.value
  if (!ids?.length) return
  const found = await models.user.count({ where: { id: { in: ids } } })
  if (found !== ids.length) throw new AdminError('VALIDATION_ERROR', 'each excluded curator must be an existing user', ['distributionExcludedCuratorIds'])
}

async function writeSettings (models, changes, snlId) {
  for (const store of ['platformFeeConfig', 'siteSettings', 'snl']) {
    const data = Object.fromEntries(changes.filter(change => change.field.store === store).map(change => [change.field.column ?? change.key, change.value]))
    if (!Object.keys(data).length) continue
    if (store === 'snl' && !snlId) await models.snl.create({ data: { id: 1, ...data } })
    else await models[store].update({ where: { id: store === 'snl' ? snlId : 1 }, data })
  }
}

function auditData (change, state, applyId, reason) {
  return {
    applyId,
    reason,
    actor: 'ssh-tunnel',
    store: change.field.store,
    field: change.key,
    oldValue: formatFieldValue(change.field, state[change.key]),
    newValue: formatFieldValue(change.field, change.value)
  }
}

async function persistApply (models, request, maintenanceDirectory) {
  const result = await serializable(models, async tx => {
    const { state, snlId } = await readAdminState(tx, { lock: true, maintenanceDirectory })
    const { changes } = validateChanges({ changes: request.changes, state })
    assertExpected(changes, state)
    await validateUserIds(tx, changes)
    await writeSettings(tx, changes, snlId)
    const rows = changes.map(change => auditData(change, state, request.applyId, request.reason))
    await tx.adminConfigChange.createMany({ data: rows })
    return { ...request, changes, rows, applied: true }
  })
  return applyMaintenance(models, result, maintenanceDirectory)
}

async function applyMaintenance (models, result, directory) {
  const change = result.changes.find(change => change.key === 'maintenance')
  if (!change) return result
  try { await writeMaintenance(change.value, result.reason, directory) } catch {
    await models.adminConfigChange.updateMany({ where: { applyId: result.applyId, field: 'maintenance' }, data: { applied: false } })
    return { ...result, applied: false, error: 'maintenance flag could not be updated' }
  }
  return result
}

async function finishApply (result) {
  clearSiteSettingsCache()
  clearFeeConfigCache()
  clearGateCache()
  const warning = result.changes?.some(change => ['fees', 'trust', 'rewards'].includes(change.field.section) || change.key === 'maintenance')
  const body = [...result.rows.map(row => `${row.field}: ${row.oldValue} → ${row.newValue}`), `Reason: ${result.reason}`, ...(result.error ? [`NOT APPLIED: ${result.error}`] : [])].join('\n')
  const alertDelivered = await alert(warning ? 'warn' : 'info', 'Admin configuration change', body, { dedupeKey: result.applyId })
  return { applyId: result.applyId, applied: result.applied, error: result.error ?? null, alertDelivered: alertDelivered === true }
}

export async function adminApply ({ changes, reason, models, maintenanceDirectory }) {
  validateApplyRequest({ changes, reason })
  const request = { changes, reason, applyId: randomUUID() }
  const persist = () => persistApply(models, request, maintenanceDirectory)
  // Hold a cross-process coordination lock beyond the inner DB commit so two
  // maintenance applies cannot compare or write the flag out of order.
  const result = changes.some(change => change.key === 'maintenance')
    ? await coordinateMaintenance(models, persist)
    : await persist()
  return finishApply(result)
}

async function coordinateMaintenance (models, persist) {
  let pending
  try {
    return await models.$transaction(async coordinator => {
      await coordinator.$executeRaw`SET LOCAL lock_timeout = '5s'`
      await coordinator.$executeRaw`SELECT pg_advisory_xact_lock(1735289201, 1)`
      pending = persist()
      return pending
    }, { timeout: 90000 })
  } catch (error) {
    // The coordinator owns only a lock, not the writes. Its late failure must
    // not suppress the alert for a separately committed inner transaction.
    if (!pending) throw error
    return pending
  }
}

function validateInviteRequest (reason) {
  validateApplyRequest({ reason, changes: [{ key: 'inviteCode' }] })
}

export async function adminCreateInviteCode ({ models, label, reason }) {
  validateInviteRequest(reason)
  if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new AdminError('VALIDATION_ERROR', 'label must contain 1–100 characters')
  const code = randomBytes(24).toString('base64url')
  const tokenHash = gateTokenHash(issueGateToken(code))
  const applyId = randomUUID()
  const result = await serializable(models, async tx => {
    await tx.$queryRaw`SELECT id FROM "SiteSettings" WHERE id = 1 FOR UPDATE`
    const row = await tx.inviteGateCode.create({ data: { label: label.trim(), tokenHash } })
    const audit = { applyId, reason, actor: 'ssh-tunnel', store: 'inviteGateCode', field: 'inviteCode', targetId: String(row.id), oldValue: 'absent', newValue: 'active' }
    await tx.adminConfigChange.create({ data: audit })
    return { id: row.id, rows: [audit], applyId, reason, applied: true }
  })
  return { ...await finishApply(result), id: result.id, code }
}

export async function adminRevokeInviteCode ({ models, id, reason }) {
  validateInviteRequest(reason)
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new AdminError('VALIDATION_ERROR', 'invalid invite code id')
  const applyId = randomUUID()
  const result = await serializable(models, async tx => {
    await tx.$queryRaw`SELECT id FROM "SiteSettings" WHERE id = 1 FOR UPDATE`
    const row = await tx.inviteGateCode.findUnique({ where: { id } })
    if (!row || row.revokedAt) throw new AdminError('STALE_VALUE', 'invite code is missing or already revoked', [String(id)])
    await tx.inviteGateCode.update({ where: { id }, data: { revokedAt: new Date() } })
    const audit = { applyId, reason, actor: 'ssh-tunnel', store: 'inviteGateCode', field: 'inviteCode', targetId: String(id), oldValue: 'active', newValue: 'revoked' }
    await tx.adminConfigChange.create({ data: audit })
    return { rows: [audit], applyId, reason, applied: true }
  })
  return finishApply(result)
}
