/* eslint-env jest */

import { encryptViewKey, decryptViewKey } from '@/api/monero/viewkey'
import { runRotateViewKeysOnce } from '@/worker/rotateViewKeys'

// Real crypto needs a valid 32-byte master key. Set before any encryptViewKey
// call; getMasterKey() lazily caches it (mirrors test/worker/moneroIndexer.test.js).
process.env.VIEWKEY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

function fakeModels (rows) {
  return {
    moneroViewKey: {
      findMany: async () => rows.map(r => ({ ...r })),
      update: async ({ where, data }) => ({ id: where.id, ...data })
    }
  }
}

test('rotation re-wraps every row with a fresh DEK and round-trips to the original plaintext', async () => {
  const a = 'a'.repeat(64); const b = 'b'.repeat(64)
  const rows = [
    { id: 1, accountId: 10, ...encryptViewKey(a) },
    { id: 2, accountId: 20, ...encryptViewKey(b) }
  ]
  const updated = []
  const models = {
    moneroViewKey: {
      findMany: async () => rows.map(r => ({ ...r })),
      update: async ({ where, data }) => { updated.push({ id: where.id, ...data }); return {} }
    }
  }
  const out = await runRotateViewKeysOnce({ models })
  expect(out.rotated).toBe(2)
  expect(updated).toHaveLength(2)
  // Fresh DEK → the ciphertext bytes MUST differ from the original.
  const new1 = updated.find(u => u.id === 1)
  expect(new1.ciphertext.equals(rows[0].ciphertext)).toBe(false)
  // …yet decrypt straight back to the original plaintext (same master key).
  expect(decryptViewKey(new1)).toBe(a)
  expect(decryptViewKey(updated.find(u => u.id === 2))).toBe(b)
})

test('rotation stamps rotatedAt', async () => {
  const rows = [{ id: 1, accountId: 10, ...encryptViewKey('x'.repeat(64)) }]
  const models = fakeModels(rows)
  // Re-wrap the fakeModels capture by overriding update here is fiddly; instead
  // assert via a dedicated capture:
  let stamped = null
  models.moneroViewKey.update = async ({ where, data }) => { stamped = data.rotatedAt; return {} }
  await runRotateViewKeysOnce({ models })
  expect(stamped).toBeInstanceOf(Date)
})

test('rotation is best-effort per row — a mid-row throw propagates after earlier rows committed', async () => {
  const rows = [
    { id: 1, accountId: 10, ...encryptViewKey('1'.repeat(64)) },
    { id: 2, accountId: 20, ...encryptViewKey('2'.repeat(64)) }
  ]
  const models = {
    moneroViewKey: {
      findMany: async () => rows.map(r => ({ ...r })),
      update: async ({ where }) => { if (where.id === 2) throw new Error('boom'); return {} }
    }
  }
  await expect(runRotateViewKeysOnce({ models })).rejects.toThrow('boom')
})
