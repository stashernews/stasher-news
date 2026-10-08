// One-time backfill of users.emailCiphertext for the weekly digest.
//
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/backfill-email-ciphertext.js            # dry run (default)
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/backfill-email-ciphertext.js --apply
//
// Pass 1: legacy plaintext `users.email` rows -> encrypt. ONLY hash-verified
// rows are touched: a stale/absent emailHash means users.email has drifted
// from what the user actually verified (e.g. a dev login tool overwrote it) —
// encrypting such a row would promote the drifted address into the digest
// pipeline, and the send-boundary emailHint guard (maskEmail: first char +
// domain) cannot disambiguate same-domain siblings. Stale rows are SKIPPED
// entirely and reported; hash-verified plaintext is nulled after encryption
// (login keeps working via the hash). Addresses are never printed; only
// counts and user ids.
//
// Before --apply on the VPS: confirm EMAIL_MASTER_KEY from the SOPS loader is the
// intended persistent key, take a DB snapshot first, and never rotate
// EMAIL_MASTER_KEY while emailCiphertext rows exist — rotating it would make
// every stored address undecryptable.

import { PrismaClient } from '@prisma/client'
import { hashEmail } from '@/lib/crypto'
import { encryptEmail, decryptEmail } from '@/lib/emailCrypto'

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')

// Same-process sanity gate: never null a plaintext address we cannot
// decrypt back under the active key. (A wrong-but-consistent key still
// passes this check — the ops runbook covers key verification; this
// catches envelope-level failures before the destructive update.)
function encryptChecked (email, userId) {
  const envelope = encryptEmail(email)
  if (decryptEmail(envelope) !== email) {
    throw new Error(`encryption self-check failed for user ${userId}; aborting (no rows written)`)
  }
  return envelope
}

async function backfillPlaintext () {
  const rows = await prisma.user.findMany({
    where: { email: { not: null }, emailCiphertext: null, emailVerified: { not: null } },
    select: { id: true, email: true, emailHash: true }
  })
  let encrypted = 0
  let plaintextNulled = 0
  const skippedStaleHash = []
  const skippedNoHash = []
  for (const row of rows) {
    // Hash-verified only. A stale/absent emailHash means the stored plaintext
    // may have drifted from what the user verified — the digest would mail a
    // wrong address and the send-boundary emailHint guard (maskEmail: first
    // char + domain) cannot catch same-domain siblings. Skip and report.
    if (row.emailHash == null) { skippedNoHash.push(row.id); continue }
    if (hashEmail({ email: row.email }) !== row.emailHash) { skippedStaleHash.push(row.id); continue }
    const envelope = encryptChecked(row.email, row.id)
    if (!apply) { encrypted += 1; plaintextNulled += 1; continue }
    await prisma.user.update({
      where: { id: row.id },
      data: {
        emailCiphertext: envelope,
        email: null
      }
    })
    encrypted += 1
    plaintextNulled += 1
  }
  return { scanned: rows.length, encrypted, plaintextNulled, skippedStaleHash, skippedNoHash }
}

async function main () {
  console.log(apply ? 'APPLY mode — rows will be written' : 'dry run — no rows will be written (pass --apply to write)')

  const plaintext = await backfillPlaintext()
  console.log(`pass 1 (legacy plaintext): scanned ${plaintext.scanned}, encrypt ${plaintext.encrypted}, null plaintext ${plaintext.plaintextNulled}`)
  if (plaintext.skippedStaleHash.length) {
    console.log(`pass 1: ${plaintext.skippedStaleHash.length} row(s) SKIPPED (stale emailHash — stored email does not match what the user verified; kept as plaintext, NOT encrypted): users ${plaintext.skippedStaleHash.join(', ')}`)
  }
  if (plaintext.skippedNoHash.length) {
    console.log(`pass 1: ${plaintext.skippedNoHash.length} row(s) SKIPPED (no emailHash): users ${plaintext.skippedNoHash.join(', ')}`)
  }

  await prisma.$disconnect()
}

main().catch((err) => { console.error(err); process.exit(1) })
