// Extend a positional query without interpolating its filter values into SQL.
export function sqlValueBinder (offset = 0) {
  const values = []
  return {
    values,
    bind (value) {
      values.push(value)
      return `$${offset + values.length}::BIGINT`
    }
  }
}
