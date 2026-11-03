import { parseFieldValue } from '@/lib/admin/units'
import { needsJumpConfirmation, validateChanges } from '@/lib/admin/validate'
import { FIELD_BY_KEY } from '@/lib/admin/fields'

export function fieldError (field, value) {
  try {
    const parsed = parseFieldValue(field, value)
    if (field.min !== null && field.min !== undefined && parsed < parseFieldValue(field, field.min)) return `Minimum: ${field.min}`
    if (field.max !== null && field.max !== undefined && parsed > parseFieldValue(field, field.max)) return `Maximum: ${field.max}`
    return null
  } catch (error) { return error.message }
}

export function pendingChanges (fields, drafts) {
  const changes = fields.filter(field => drafts[field.key]).map(field => {
    const draft = drafts[field.key]
    const error = fieldError(field, draft.value)
    const numeric = ['xmr', 'int', 'float', 'pct', 'bps'].includes(field.type)
    let jump = false
    if (!error && numeric) jump = needsJumpConfirmation(parseFieldValue(field, draft.expected), parseFieldValue(field, draft.value))
    return { ...draft, field, error, jump }
  })
  if (!changes.length || changes.some(change => change.error)) return changes
  try {
    const state = Object.fromEntries(fields.map(field => [field.key, parseFieldValue(field, field.value)]))
    // The server repeats these checks in its locked transaction. This is only
    // form feedback; retyping confirmation is still required in the dialog.
    const registry = fields.map(({ min, max, ...field }) => ({ ...field, ...(min == null ? {} : { min }), ...(max == null ? {} : { max }), validate: FIELD_BY_KEY.get(field.key)?.validate }))
    validateChanges({ state, changes: changes.map(change => ({ key: change.field.key, value: change.value, confirmedJump: true })), fields: registry })
  } catch (error) {
    return changes.map(change => ({ ...change, error: error.message }))
  }
  return changes
}

export function reconcileDrafts (drafts, staleKeys) {
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => !staleKeys.includes(key)))
}
