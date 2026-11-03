import { FIELDS, getFieldState } from './fields'
import { parseFieldValue, parseXmr } from './units'

export class AdminError extends Error {
  constructor (code, message, keys = []) {
    super(message)
    this.name = 'AdminError'
    this.code = code
    this.keys = keys
  }
}

export function needsJumpConfirmation (oldValue, newValue) {
  const exact = value => typeof value === 'bigint' ? value * 1000000000000n : parseXmr(String(value), { allowNegative: true })
  const old = exact(oldValue)
  const next = exact(newValue)
  if (old === next) return false
  if (old === 0n || next === 0n || (old < 0n) !== (next < 0n)) return true
  const a = old < 0n ? -old : old
  const b = next < 0n ? -next : next
  return a > b * 10n || b > a * 10n
}

function parseChange (field, change, state) {
  if (getFieldState(field, state).locked) throw new AdminError('FIELD_LOCKED', field.lockedWhen.reason, [field.key])
  let value
  try {
    value = parseFieldValue(field, change.value)
    if (field.min !== undefined && value < parseFieldValue(field, field.min)) throw new Error(`minimum is ${field.min}`)
    if (field.max !== undefined && value > parseFieldValue(field, field.max)) throw new Error(`maximum is ${field.max}`)
  } catch (error) { throw new AdminError('VALIDATION_ERROR', `${field.key}: ${error.message}`, [field.key]) }
  const numeric = ['xmr', 'int', 'float', 'pct', 'bps'].includes(field.type)
  if (numeric && needsJumpConfirmation(state[field.key], value) && change.confirmedJump !== true) {
    throw new AdminError('JUMP_CONFIRMATION_REQUIRED', `confirm the large change to ${field.key}`, [field.key])
  }
  return { ...change, field, value }
}

function validateCrossFields (state, fields) {
  const reject = message => { throw new AdminError('VALIDATION_ERROR', message) }
  if (state.downvoteMinPiconeros > state.defaultDownvotePiconeros) reject('minimum downvote exceeds default downvote')
  if (state.tipRankRampDays === 0 && state.tipRankFactorFloor !== 1) reject('zero ramp requires a factor floor of one')
  if (state.spamEscalationNumerator < state.spamEscalationDenominator || state.spamEscalationNumerator > 3 * state.spamEscalationDenominator) reject('spam escalation factor must be between 1 and 3')
  for (const validate of new Set(fields.map(field => field.validate).filter(Boolean))) {
    const result = validate(state)
    if (!result.ok) reject(`configuration invalid: ${result.errors.join(', ')}`)
  }
}

export function validateChanges ({ changes, state, fields = FIELDS }) {
  const byKey = new Map(fields.map(field => [field.key, field]))
  const parsed = changes.map(change => {
    const field = byKey.get(change.key)
    if (!field) throw new AdminError('VALIDATION_ERROR', 'unknown settings key', [change.key])
    return parseChange(field, change, state)
  })
  const postState = { ...state, ...Object.fromEntries(parsed.map(change => [change.key, change.value])) }
  validateCrossFields(postState, fields)
  return { changes: parsed, postState }
}

export function validateApplyRequest ({ changes, reason }) {
  if (!process.env.ALERT_WEBHOOK_URL?.trim()) throw new AdminError('ALERTS_NOT_CONFIGURED', 'alerts are not configured')
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new AdminError('VALIDATION_ERROR', 'reason must contain 1–500 characters')
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 50) throw new AdminError('VALIDATION_ERROR', 'apply requires 1–50 changes')
  if (changes.some(change => !change || typeof change.key !== 'string')) throw new AdminError('VALIDATION_ERROR', 'invalid settings change')
  if (new Set(changes.map(change => change.key)).size !== changes.length) throw new AdminError('VALIDATION_ERROR', 'duplicate settings keys')
}
