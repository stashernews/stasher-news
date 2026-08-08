import { decryptViewKey, encryptViewKey } from '@/api/monero/viewkey'

// rotateViewKeys — DEK-hygiene rotation (spec Q3 / Phase 5).
//
// Every ROTATE_INTERVAL the job re-wraps each MoneroViewKey row: decrypt under the
// current master key, re-encrypt with a FRESH random DEK (+ fresh IV) under the SAME
// master key, persist, stamp rotatedAt. This bounds the lifetime of any single DEK
// (limiting blast radius of a memory dump) WITHOUT touching the master key.
//
// This is DISTINCT from a master-key rotation (Task C2's api/monero/viewkey.js
// rotateMasterKey, wired via `sndev monero rotate-master-key`): that one mints a
// new master-key version and re-wraps every row under it, retaining old versions.
// Master-key rotation is a deliberate, operator-initiated, announced operation;
// THIS job is the automatic, quarterly, same-key DEK freshness sweep.
//
// Exports the testable per-run core (no pg-boss) + the self-requeuing pg-boss handler.

// Quarterly. Long enough to be cheap, short enough to bound DEK lifetime.
const ROTATE_INTERVAL_SECONDS = 90 * 24 * 60 * 60

export async function runRotateViewKeysOnce ({ models }) {
  const rows = await models.moneroViewKey.findMany()
  let rotated = 0
  for (const row of rows) {
    const plaintext = decryptViewKey(row) // row carries {ciphertext, iv, tag, wrappedDek, dekVersion}
    const fresh = encryptViewKey(plaintext) // fresh DEK + IV under the same master key
    await models.moneroViewKey.update({
      where: { id: row.id },
      data: {
        ciphertext: fresh.ciphertext,
        iv: fresh.iv,
        tag: fresh.tag,
        wrappedDek: fresh.wrappedDek,
        dekVersion: fresh.dekVersion,
        rotatedAt: new Date()
      }
    })
    rotated += 1
  }
  return { rotated }
}

export async function rotateViewKeys ({ boss, models }) {
  const out = await runRotateViewKeysOnce({ models })
  console.log(`rotateViewKeys: re-wrapped ${out.rotated} view-key row(s)`)
  await boss.send('rotateViewKeys', {}, { startAfter: ROTATE_INTERVAL_SECONDS })
}
