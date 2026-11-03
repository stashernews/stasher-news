const PICONEROS_PER_XMR = 1000000000000n

function decimalString (value, decimals, allowNegative) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('enter a plain decimal number')
  if (value.startsWith('-') && !allowNegative) throw new Error('negative values are not allowed')
  if ((value.split('.')[1]?.length ?? 0) > decimals) throw new Error(`at most ${decimals} decimal places`)
  return value
}

export function parseXmr (value, { allowNegative = false } = {}) {
  decimalString(value, 12, allowNegative)
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  let amount = 0n
  for (const digit of whole + fraction.padEnd(12, '0')) amount = amount * 10n + BigInt(digit)
  return negative ? -amount : amount
}

export function formatXmr (amount) {
  if (typeof amount !== 'bigint') throw new Error('piconeros must be BigInt')
  const sign = amount < 0n ? '-' : ''
  const absolute = amount < 0n ? -amount : amount
  const fraction = (absolute % PICONEROS_PER_XMR).toString().padStart(12, '0').replace(/0+$/, '')
  return `${sign}${absolute / PICONEROS_PER_XMR}${fraction ? `.${fraction}` : ''}`
}

export function parseFloatField (value, { allowNegative = false } = {}) {
  decimalString(value, 6, allowNegative)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('number must be finite')
  return number
}

export function parseIntField (value, { bigint = false, allowNegative = false } = {}) {
  decimalString(value, 0, allowNegative)
  if (bigint) return BigInt(value)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('enter a safe whole number')
  return number
}

export function parseIdList (value) {
  if (typeof value !== 'string') throw new Error('enter comma-separated user ids')
  if (value === '') return []
  const ids = value.split(',').map(id => parseIntField(id.trim()))
  if (ids.length > 100 || ids.some(id => id < 1 || id > 2147483647) || new Set(ids).size !== ids.length) throw new Error('enter at most 100 distinct positive user ids')
  return ids
}

export function parseFieldValue (field, value) {
  if (field.type === 'xmr') return parseXmr(value, { allowNegative: field.min?.startsWith('-') })
  if (['int', 'pct', 'bps'].includes(field.type)) return parseIntField(value, field)
  if (field.type === 'float') return parseFloatField(value, field)
  if (field.type === 'idList') return parseIdList(value)
  if (field.type === 'nullableBool' && value === 'null') return null
  if (['bool', 'nullableBool'].includes(field.type) && ['true', 'false'].includes(value)) return value === 'true'
  if (field.type === 'enum' && field.options.includes(value)) return value
  throw new Error('invalid field value')
}

export function formatFieldValue (field, value) {
  if (field.type === 'xmr') return formatXmr(value)
  if (field.type === 'idList') return value.join(',')
  return String(value)
}
