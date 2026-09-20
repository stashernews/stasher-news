// Preview the weekly digest for one user.
//
//   Dev (inside the app container):
//     docker exec -w /app app npx tsx --tsconfig jsconfig.json \
//       scripts/preview-digest.js <nym>
//
//   VPS prod mode (the SOPS loader supplies DATABASE_URL and the mail env):
//     NODE_ENV=production docker compose --env-file .env.development --env-file .env.local \
//       -f docker-compose.yml -f docker-compose.volumes.yml -f docker-compose.override.yml \
//       -f docker-compose.prodmode.yml run --rm --no-deps \
//       --entrypoint /etc/stashernews/scripts/load-secrets-local.sh app \
//       sh -c 'npx tsx --tsconfig jsconfig.json scripts/preview-digest.js <nym> --to you@example.com'
//
// Read-only: never writes to the database and always renders a fresh 7-day
// window (the real job uses each user's watermark). Prints the text version to
// stdout, writes the HTML next to the script, and with --to <address> emails
// the exact sample through the configured SMTP (Resend in prod — one
// transactional email against the shared quota; without --to nothing is sent).

import fs from 'node:fs'
import nodemailer from 'nodemailer'
import { PrismaClient } from '@prisma/client'
import { gatherDigest, getCommunityHighlights } from '@/lib/emailDigest'
import { renderDigest } from '@/lib/emailDigestTemplate'

const prisma = new PrismaClient()
const DAY_MS = 24 * 60 * 60 * 1000

function usage () {
  console.error('usage: scripts/preview-digest.js <nym> [--to <address>] [--html <path>]')
}

async function main () {
  const [nym, ...rest] = process.argv.slice(2)
  if (!nym || nym.startsWith('--')) {
    usage()
    process.exit(1)
  }

  const toIndex = rest.indexOf('--to')
  const to = toIndex >= 0 ? rest[toIndex + 1] : null
  const htmlIndex = rest.indexOf('--html')
  const htmlPath = htmlIndex >= 0 ? rest[htmlIndex + 1] : 'preview-digest.html'
  if ((toIndex >= 0 && !to) || (htmlIndex >= 0 && !htmlPath)) {
    usage()
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { name: nym } })
  if (!user) {
    console.error(`no user named ${nym}`)
    process.exit(1)
  }

  const siteUrl = process.env.NEXT_PUBLIC_URL ?? 'http://localhost:3000'
  const now = new Date()
  // Read-only preview: pretend the watermark is unset so the window is always
  // the default 7 days.
  const previewUser = { ...user, emailDigestSentAt: null }
  const sections = await gatherDigest({ models: prisma, user: previewUser, now })
  const highlights = await getCommunityHighlights({
    models: prisma,
    from: new Date(now.getTime() - 7 * DAY_MS),
    to: now,
    user: previewUser
  })
  // The real digest signs this URL with EMAIL_MASTER_KEY; the preview points at
  // settings so the sample needs no encryption key.
  const unsubscribeUrl = `${siteUrl}/settings`
  const rendered = renderDigest({
    name: user.name,
    sections: { ...sections, highlights },
    windowStart: sections.windowStart,
    windowEnd: sections.windowEnd,
    unsubscribeUrl,
    siteUrl
  })

  console.log(`subject: ${rendered.subject}`)
  console.log(`activity: ${sections.replies.length} replies, ${sections.mentions.length + sections.itemMentions.length} mentions, ${sections.subscriptions.length} subscriptions, ${highlights.length} highlights\n`)
  console.log(rendered.text)

  fs.writeFileSync(htmlPath, rendered.html)
  console.log(`\nhtml written to ${htmlPath}`)
  console.log('note: preview footer links to /settings; the real digest uses a signed one-click unsubscribe URL')

  if (to) {
    if (!process.env.LOGIN_EMAIL_SERVER) {
      console.error('LOGIN_EMAIL_SERVER is not set; cannot send (omit --to to render only)')
      process.exit(1)
    }
    const transport = nodemailer.createTransport(process.env.LOGIN_EMAIL_SERVER)
    const from = process.env.DIGEST_EMAIL_FROM || process.env.LOGIN_EMAIL_FROM
    if (!process.env.DIGEST_EMAIL_FROM) {
      console.warn('DIGEST_EMAIL_FROM unset; sending from LOGIN_EMAIL_FROM')
    }
    await transport.sendMail({
      to,
      from,
      replyTo: process.env.DIGEST_EMAIL_REPLY_TO || undefined,
      subject: `[preview] ${rendered.subject}`,
      text: rendered.text,
      html: rendered.html
    })
    console.log(`sent sample to ${to}`)
  }

  await prisma.$disconnect()
}

main().catch((err) => { console.error(err); process.exit(1) })
