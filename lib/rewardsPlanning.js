// Serialization/deadlock errors must abort the outer Serializable snapshot,
// never degrade to a partial planning result.
export function isSerializationFailure (err) {
  if (!err) return false
  if (err.code === 'P2034') return true
  const code = String(err.meta?.code ?? err.code ?? '')
  return code === '40001' || code === '40P01'
}

// Static, code-owned SQL only. A failed read must not poison the surrounding
// ledger/projection transaction. The caller decides which errors may degrade.
export async function withSavepoint (tx, fn) {
  await tx.$executeRaw`SAVEPOINT curator_budget`
  try {
    const result = await fn()
    await tx.$executeRaw`RELEASE SAVEPOINT curator_budget`
    return result
  } catch (err) {
    try {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT curator_budget`
    } catch { /* the original error wins; the outer transaction aborts anyway */ }
    throw err
  }
}
