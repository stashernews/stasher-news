// Operator-initiated view-key master-key rotation (Phase 6 Task C2).
//
//   sndev monero rotate-master-key
//
// Non-destructive: registers the new key as the next version, re-wraps every
// MoneroViewKey row whose dekVersion lags behind it, and RETAINS all prior
// versions so old envelopes and DB backups keep decrypting. Old keys must also
// be escrowed (scripts/backup-master-key.sh) — see docs/ops/master-key-escrow.md.
//
// SAFE WORKFLOW (the script enforces the durable-first ordering below):
//   1. Generate a 32-byte key: NEW=$(openssl rand -base64 32)
//   2. Persist it as the next version in .env.local, e.g.
//        VIEWKEY_MASTER_KEYS_V2=$NEW
//        VIEWKEY_MASTER_KEY_CURRENT_VERSION=2
//      (keep VIEWKEY_MASTER_KEYS_V1 / the legacy VIEWKEY_MASTER_KEY so v1
//      envelopes keep decrypting — rotation is non-destructive only while the
//      old key stays registered).
//   3. Restart app + worker so the long-lived processes load the new key:
//        docker restart app worker
//   4. Run this script with the SAME key in VIEWKEY_NEW_MASTER_KEY. It verifies
//      the key matches the now-active one BEFORE touching any row, then re-wraps
//      the lagging rows. Idempotent + resumable: a crash mid-rotation leaves a
//      consistent v1/v2 mix; re-running finishes the stragglers.
//   5. Escrow the new key: scripts/backup-master-key.sh
//
// Refuses to run if VIEWKEY_NEW_MASTER_KEY is not already the active key — that
// means step 2/3 was skipped, and re-wrapping under an in-process-only key
// would make every row undecryptable after the next restart.
//
// .js (not .mjs) entry run via `tsx --tsconfig jsconfig.json`, mirroring
// run-rewards-distribution.js: the viewkey module imports the `@/` alias, which
// strict-ESM can't resolve. tsx + a .js entry resolves `@/` correctly.
import { PrismaClient } from '@prisma/client'
import { getCurrentVersion, getMasterKey } from '@/api/monero/masterkey'
import { rotateMasterKey } from '@/api/monero/viewkey'

const prisma = new PrismaClient()

async function main () {
  const newKeyB64 = process.env.VIEWKEY_NEW_MASTER_KEY
  if (!newKeyB64) {
    console.error('VIEWKEY_NEW_MASTER_KEY is required (base64, 32 bytes).')
    console.error('Persist it to .env.local as the next VIEWKEY_MASTER_KEYS_V<n>,')
    console.error('bump VIEWKEY_MASTER_KEY_CURRENT_VERSION, and restart app+worker first.')
    process.exit(1)
  }

  const newKey = Buffer.from(newKeyB64, 'base64')
  if (newKey.length !== 32) {
    console.error(`VIEWKEY_NEW_MASTER_KEY must decode to 32 bytes (got ${newKey.length}).`)
    process.exit(1)
  }

  const version = getCurrentVersion()
  const active = getMasterKey(version)
  if (!active.equals(newKey)) {
    console.error(`VIEWKEY_NEW_MASTER_KEY is not the currently active master key (v${version}).`)
    console.error('Persist the new key to .env.local (VIEWKEY_MASTER_KEYS_V<n>), set')
    console.error('VIEWKEY_MASTER_KEY_CURRENT_VERSION, and `docker restart app worker` BEFORE')
    console.error('re-wrapping rows — otherwise they become undecryptable after restart.')
    process.exit(1)
  }

  const out = await rotateMasterKey({ newKeyB64, models: prisma })
  console.log(`master-key rotation complete: current version v${out.version}, re-wrapped ${out.rotated} row(s).`)
  if (out.rotated === 0) {
    console.log('All rows were already at the current version (nothing to do).')
  }
  console.log('Next: escrow the new key — scripts/backup-master-key.sh')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
