// test-restore-check.js — companion to scripts/test-restore.sh (Phase 6 Task E5).
//
// Reads MoneroViewKey envelopes on stdin (one row per line, pipe-delimited:
// id|dekVersion|ciphertext|iv|tag|wrappedDek, with every bytea field hex-encoded
// by the surrounding COPY) and asserts the REAL decryptViewKey
// (api/monero/viewkey.js) succeeds on every row using VIEWKEY_MASTER_KEY from
// the environment.
//
// This is the "re-supply the master key after restore" check: it proves the
// at-rest envelopes are recoverable from a restored DB, complementing the
// failure-path unit test (test/api/monero/viewkey.test.js:111-115) which proves
// losing the master key bricks decryption.
//
// Invoked by scripts/test-restore.sh inside the `app` container (which holds
// VIEWKEY_MASTER_KEY), via tsx so the @/ path alias resolves:
//   ... | docker exec -i -w /app app npx tsx --tsconfig jsconfig.json \
//         scripts/test-restore-check.js
import readline from 'node:readline'
import { decryptViewKey } from '@/api/monero/viewkey'

if (!process.env.VIEWKEY_MASTER_KEY) {
  console.error('restore-check: VIEWKEY_MASTER_KEY is not set in the environment')
  console.error('restore-check: re-supply the escrowed master key to prove decryption')
  process.exit(1)
}

const rl = readline.createInterface({ input: process.stdin })
const failures = []
let total = 0
let ok = 0

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  total += 1
  const [id, dekVersion, ciphertext, iv, tag, wrappedDek] = trimmed.split('|')
  try {
    const plaintext = decryptViewKey({
      ciphertext: Buffer.from(ciphertext, 'hex'),
      iv: Buffer.from(iv, 'hex'),
      tag: Buffer.from(tag, 'hex'),
      wrappedDek: Buffer.from(wrappedDek, 'hex'),
      dekVersion: Number(dekVersion)
    })
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('decryptViewKey returned an empty plaintext')
    }
    ok += 1
  } catch (err) {
    failures.push({ id, message: err.message })
  }
})

rl.on('close', () => {
  if (total === 0) {
    console.warn('restore-check: WARNING — 0 MoneroViewKey rows; decryption path was not exercised')
    console.log('restore-check: vacuous pass (0/0)')
    process.exit(0)
  }
  console.log(`restore-check: ${ok}/${total} MoneroViewKey row(s) decrypted with the supplied VIEWKEY_MASTER_KEY`)
  for (const f of failures) {
    console.error(`restore-check: FAIL row id=${f.id}: ${f.message}`)
  }
  process.exit(failures.length === 0 ? 0 : 1)
})
