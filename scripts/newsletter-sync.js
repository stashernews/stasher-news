// One-time (and re-runnable) import of the existing verified-email population
// into the Resend newsletter segment. Runs the SAME reconcile as the daily
// newsletterSync worker, from inside the app container so emailCiphertext can
// be decrypted in memory under EMAIL_MASTER_KEY.
//
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/newsletter-sync.js            # dry run (default) — counts only
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/newsletter-sync.js --apply
//
// VPS: use the loader-wrapped compose-run form from docs/ops/newsletter-runbook.md
// (bare docker exec does not inherit the SOPS loader's exported secrets).
//
// Addresses are never printed. Output is counts only. Idempotent: re-running
// re-upserts the same contacts.

import { PrismaClient } from '@prisma/client'
import { syncNewsletterContacts } from '@/lib/newsletterSync'

const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')

async function main () {
  console.log(apply ? 'APPLY mode — contacts will be written at Resend' : 'dry run — nothing will be written (pass --apply to write)')
  const stats = await syncNewsletterContacts({ models: prisma, apply })
  console.log(`newsletter sync: eligible ${stats.eligible}, enrolled ${stats.enrolled}, failed ${stats.failed}, hintSkipped ${stats.hintSkipped}, suppressed ${stats.suppressed}, toUnsubscribe ${stats.toUnsubscribe}, unsubscribed ${stats.unsubscribed}`)
  await prisma.$disconnect()
}

main().catch((err) => { console.error(err?.code ?? err?.message ?? err); process.exit(1) })
