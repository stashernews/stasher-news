import { FIELDS, getFieldState } from '@/lib/admin/fields'
import { SECTIONS } from '@/lib/admin/sections'
import { readAdminState } from '@/lib/admin/state'
import { formatFieldValue } from '@/lib/admin/units'
import { effectiveFlag, ENV_FLAG_PARSERS } from '@/lib/siteSettings'
import { getGateCodes } from '@/lib/invite-gate'
import { adminApply, adminCreateInviteCode, adminRevokeInviteCode } from '@/lib/admin/apply'
import { AdminError } from '@/lib/admin/validate'
import { adminEnvironment } from '@/lib/admin/environment'
import { adminAccess } from '@/lib/admin/access'

export { adminEnvironment }

function fieldView (field, state) {
  const status = getFieldState(field, state)
  const stored = state[field.key]
  const env = field.env ? effectiveFlag(stored, field.env, ENV_FLAG_PARSERS[field.key]) : null
  return {
    ...field,
    ...status,
    value: formatFieldValue(field, stored),
    effectiveValue: formatFieldValue(field, env?.value ?? status.effectiveValue),
    source: env?.source ?? (field.store === 'maintenance' ? 'file' : 'db'),
    rolloutMode: !!field.rolloutMode,
    experimental: !!field.experimental
  }
}

export default {
  Query: {
    adminSections: async (_, args, { models }) => {
      const { state } = await readAdminState(models)
      const fields = FIELDS.map(field => fieldView(field, state))
      return SECTIONS.map(section => ({ ...section, fields: fields.filter(field => field.section === section.id) }))
        .filter(section => section.kind !== 'settings' || section.fields.length > 0)
    },
    adminEnvironment: () => adminEnvironment(),
    adminAccess: (_, args, { models }) => adminAccess(models),
    adminInviteCodes: async (_, args, { models }) => {
      const rows = await models.inviteGateCode.findMany({ orderBy: { id: 'desc' }, select: { id: true, label: true, createdAt: true, revokedAt: true } })
      return [...rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null, source: 'db' })),
        ...getGateCodes().map((_, index) => ({ id: null, label: `Environment code ${index + 1}`, source: 'env' }))]
    },
    adminAudit: async (_, { cursor }, { models }) => {
      if (cursor !== undefined && cursor !== null && !/^[1-9]\d{0,18}$/.test(cursor)) throw new AdminError('VALIDATION_ERROR', 'invalid audit cursor')
      const rows = await models.adminConfigChange.findMany({ where: cursor ? { id: { lt: BigInt(cursor) } } : {}, orderBy: { id: 'desc' }, take: 51 })
      return { rows: rows.slice(0, 50).map(row => ({ ...row, id: String(row.id), createdAt: row.createdAt.toISOString() })), nextCursor: rows.length > 50 ? String(rows[49].id) : null }
    }
  },
  Mutation: {
    adminApply: (_, args, { models }) => adminApply({ ...args, models }),
    adminCreateInviteCode: (_, args, { models }) => adminCreateInviteCode({ ...args, models }),
    adminRevokeInviteCode: (_, args, { models }) => adminRevokeInviteCode({ ...args, models })
  }
}
