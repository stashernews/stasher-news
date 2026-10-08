// Render the next newsletter to HTML + text WITHOUT sending, creating a
// Broadcast, or touching Resend — a pure local preview using the SAME content
// gatherer and template the worker uses, so what you see is what would send.
//
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//     scripts/newsletter-preview.js
//   ... --days 14 --site https://stasher.news --out /tmp/newsletter-preview.html
//
// VPS: use the loader-wrapped compose-run form from docs/ops/newsletter-runbook.md.
// Reads no secrets (no decryption, no Resend call) and prints no addresses.

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { gatherNewsletterContent } from '@/lib/newsletterContent'
import { renderNewsletter } from '@/lib/newsletterTemplate'

const prisma = new PrismaClient()

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main () {
  const days = Number(arg('days', '14'))
  const siteUrl = arg('site', process.env.NEXT_PUBLIC_URL || 'https://stasher.news')
  const out = resolve(arg('out', 'newsletter-preview.html'))
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const sections = await gatherNewsletterContent({ models: prisma, from, to })
  const rendered = renderNewsletter({ sections, windowStart: from, windowEnd: to, siteUrl })

  const textOut = out.replace(/\.html?$/, '') + '.txt'
  await writeFile(out, rendered.html)
  await writeFile(textOut, rendered.text)

  console.log(`preview written: ${out} (+ ${textOut})`)
  console.log(`subject: ${rendered.subject}`)
  console.log(`sections: topPosts ${sections.topPosts.length}, mostDiscussed ${sections.mostDiscussed.length}, turfMovement ${sections.territoryMovement.length}, editorial ${sections.editorial ? 'yes' : 'no'}`)
  console.log('--- text part ---')
  console.log(rendered.text)

  await prisma.$disconnect()
}

main().catch((err) => { console.error('preview failed:', err?.code ?? err?.message ?? err); process.exit(1) })
