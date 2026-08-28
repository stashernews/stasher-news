// One-time remediation for items whose stored text still embeds signed
// imgproxy preview URLs (prod item 35 et al): decode them back to the
// canonical source URLs via lib/url.js canonicalizeItemText, then enqueue the
// standard 'imgproxy' pgboss job so imgproxyUrls is rebuilt keyed by the
// canonical URL (internal uploads are pre-trusted; no forceFetch).
//
// Usage (dev) — --tsconfig is required: tsx only auto-detects tsconfig.json,
// so without it the `@/` alias does not resolve (same as `npm run worker`):
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/decode-imgproxy-text.js
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/decode-imgproxy-text.js --check
//
// Usage (VPS): run inside the app container under the SOPS secrets wrapper —
// the same wrapper as other one-off ops scripts
// (scripts/load-secrets.sh -> `sops exec-env /etc/stashernews/secrets.env`).
// A bare `docker exec … npx tsx` fails DB auth on the VPS because DATABASE_URL
// only exists in the decrypted process environment, not the container env.
//
// --check verifies without writing. Exits 0 only when no signed URLs remain
// in item text; otherwise lists the residue and exits 1.

import { PrismaClient } from '@prisma/client'
import { canonicalizeItemText } from '@/lib/url'

const prisma = new PrismaClient()

const imgProxyEnabled = process.env.NEXT_PUBLIC_IMGPROXY_URL && process.env.IMGPROXY_SALT && process.env.IMGPROXY_KEY
if (!imgProxyEnabled) {
  console.warn('IMGPROXY_* env vars must be set')
  process.exit(1)
}

const CHECK_ONLY = process.argv.includes('--check')
const BASE = process.env.NEXT_PUBLIC_IMGPROXY_URL

async function findCandidates () {
  return prisma.$queryRaw`
    SELECT id, text FROM "Item"
    WHERE text LIKE ${'%' + BASE + '%'}
    ORDER BY id ASC`
}

async function main () {
  const items = await findCandidates()
  let scanned = 0
  let updated = 0
  for (const { id, text } of items) {
    scanned++
    const next = canonicalizeItemText(text)
    if (next === text) continue
    // only print matches the hardened helper actually replaces (signed shape
    // BASE/<sig>/<options>/<b64>); bare-base mentions stay untouched
    const before = (text.match(new RegExp(`${BASE}[^\\s)]*`, 'g')) ?? [])
      .filter(url => canonicalizeItemText(url) !== url)
    console.log(`item ${id}:`)
    for (const url of before) console.log(`  ${url}\n  -> ${canonicalizeItemText(url)}`)
    if (CHECK_ONLY) continue
    await prisma.$executeRaw`UPDATE "Item" SET text = ${next} WHERE id = ${id}`
    await prisma.$executeRaw`
      INSERT INTO pgboss.job (name, data, retrylimit, retrybackoff, startafter, keepuntil)
      VALUES ('imgproxy', jsonb_build_object('id', ${id}::INTEGER), 21, true,
              now() + interval '5 seconds', now() + interval '1 day')`
    updated++
  }
  console.log(`scanned=${scanned} updated=${updated}${CHECK_ONLY ? ' (check-only)' : ''}`)
  // LIKE is only a prefilter; residue is what the hardened helper would
  // still rewrite, so innocent base mentions don't count as unfixable
  const residue = (await findCandidates()).filter(({ text }) => canonicalizeItemText(text) !== text)
  if (residue.length > 0) {
    console.error('signed urls remain in text of items:', residue.map(r => r.id).join(', '))
    process.exitCode = 1
  }
}

main().finally(() => prisma.$disconnect())
