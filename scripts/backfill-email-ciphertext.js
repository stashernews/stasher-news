// One-time backfill of users.emailCiphertext for the weekly digest.
//
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/backfill-email-ciphertext.js            # dry run (default)
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/backfill-email-ciphertext.js --apply
//
// Pass 1: legacy plaintext `users.email` rows -> encrypt. The plaintext column
// is nulled ONLY when the stored emailHash still matches the address (login
// keeps working via the hash); no-hash or stale-hash rows keep plaintext.
// Pass 2: ListMonk list-2 enabled subscribers -> hashEmail -> match emailHash.
// Addresses are never printed; only counts and user ids.
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
const PER_PAGE = 100
const CHUNK = 500

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

function chunk (arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function backfillPlaintext () {
  const rows = await prisma.user.findMany({
    where: { email: { not: null }, emailCiphertext: null, emailVerified: { not: null } },
    select: { id: true, email: true, emailHash: true }
  })
  let encrypted = 0
  let plaintextNulled = 0
  const keepPlaintext = []
  for (const row of rows) {
    const nullPlaintext = row.emailHash != null && hashEmail({ email: row.email }) === row.emailHash
    const envelope = encryptChecked(row.email, row.id)
    if (!apply) { encrypted += 1; if (nullPlaintext) plaintextNulled += 1; else keepPlaintext.push(row.id); continue }
    await prisma.user.update({
      where: { id: row.id },
      data: {
        emailCiphertext: envelope,
        ...(nullPlaintext ? { email: null } : {})
      }
    })
    encrypted += 1
    if (nullPlaintext) plaintextNulled += 1
    else keepPlaintext.push(row.id)
  }
  return { scanned: rows.length, encrypted, plaintextNulled, keepPlaintext }
}

async function fetchListMonkSubscribers () {
  const url = process.env.LIST_MONK_URL
  const auth = process.env.LIST_MONK_AUTH
  if (!url || !auth) return null
  const emails = []
  for (let page = 1; page <= 1000; page++) {
    const res = await fetch(`${url}/api/subscribers?list_id=2&status=enabled&page=${page}&per_page=${PER_PAGE}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') }
    })
    if (!res.ok) throw new Error(`listmonk HTTP ${res.status}`)
    const json = await res.json()
    const results = json?.data?.results ?? []
    for (const r of results) {
      if (r?.email) emails.push(String(r.email).toLowerCase())
    }
    if (results.length < PER_PAGE) break
  }
  return [...new Set(emails)]
}

async function backfillListMonk () {
  const emails = await fetchListMonkSubscribers()
  if (emails === null) return null

  const byHash = new Map()
  for (const email of emails) {
    byHash.set(hashEmail({ email }), email)
  }

  let matched = 0
  let encrypted = 0
  for (const hashes of chunk([...byHash.keys()], CHUNK)) {
    const users = await prisma.user.findMany({
      where: { emailHash: { in: hashes }, emailCiphertext: null, emailVerified: { not: null } },
      select: { id: true, emailHash: true }
    })
    for (const user of users) {
      matched += 1
      const email = byHash.get(user.emailHash)
      if (!email) continue
      const envelope = encryptChecked(email, user.id)
      if (!apply) { encrypted += 1; continue }
      await prisma.user.update({ where: { id: user.id }, data: { emailCiphertext: envelope } })
      encrypted += 1
    }
  }
  return { subscribers: emails.length, matched, encrypted }
}

async function main () {
  console.log(apply ? 'APPLY mode — rows will be written' : 'dry run — no rows will be written (pass --apply to write)')

  const plaintext = await backfillPlaintext()
  console.log(`pass 1 (legacy plaintext): scanned ${plaintext.scanned}, encrypt ${plaintext.encrypted}, null plaintext ${plaintext.plaintextNulled}`)
  if (plaintext.keepPlaintext.length) {
    console.log(`pass 1: ${plaintext.keepPlaintext.length} row(s) keep plaintext (no emailHash or hash mismatch; login fallback): users ${plaintext.keepPlaintext.join(', ')}`)
  }

  const listmonk = await backfillListMonk()
  if (listmonk === null) {
    console.log('pass 2 (listmonk): skipped — LIST_MONK_URL / LIST_MONK_AUTH unset')
  } else {
    console.log(`pass 2 (listmonk): ${listmonk.subscribers} enabled list-2 subscribers, ${listmonk.matched} matched a user, encrypt ${listmonk.encrypted}`)
  }

  await prisma.$disconnect()
}

main().catch((err) => { console.error(err); process.exit(1) })
