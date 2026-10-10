// Operator approval for a drafted newsletter. API-created broadcasts can only
// be sent via API (Resend's location-of-creation rule), so release happens
// here — or automatically with NEWSLETTER_AUTO_SEND=true. Sends the latest
// DRAFT campaign, or a specific one with --id <broadcastId>.
//
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/newsletter-send.js
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/newsletter-send.js --id <broadcastId>
//   ... --force   # bypass the 14-day cadence guard for a deliberate extra send
//
// Guards mirror the worker: a CAS claim (DRAFT -> SENDING) makes the release
// atomic against a concurrent campaign job / second operator run, and the
// cadence check stops weeks of accumulated drafts being released back to back.
//
// VPS: use the loader-wrapped compose-run form from docs/ops/newsletter-runbook.md.

import { PrismaClient } from '@prisma/client'
import { sendBroadcast } from '@/lib/newsletter'

const DAY_MS = 24 * 60 * 60 * 1000
const CADENCE_MS = 14 * DAY_MS

const prisma = new PrismaClient()
const idArg = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : null
const force = process.argv.includes('--force')

async function main () {
  const campaign = idArg
    ? await prisma.newsletterCampaign.findFirst({ where: { resendBroadcastId: idArg } })
    : await prisma.newsletterCampaign.findFirst({ where: { status: 'DRAFT' }, orderBy: { createdAt: 'desc' } })
  if (!campaign?.resendBroadcastId) { console.log('no draft campaign to send'); process.exit(1) }
  if (campaign.status === 'SENT') { console.log(`campaign ${campaign.periodKey} already sent`); process.exit(0) }

  if (!force) {
    const lastSent = await prisma.newsletterCampaign.findFirst({ where: { sentAt: { not: null } }, orderBy: { sentAt: 'desc' } })
    if (lastSent && Date.now() - new Date(lastSent.sentAt).getTime() < CADENCE_MS) {
      console.log(`cadence guard: a campaign was sent < 14 days ago (${lastSent.periodKey}); pass --force to send anyway`)
      process.exit(1)
    }
  }

  const claim = await prisma.newsletterCampaign.updateMany({
    where: { id: campaign.id, status: 'DRAFT' }, data: { status: 'SENDING' }
  })
  if (!claim.count) { console.log('campaign is not a DRAFT (another run owns it, or it is sending/sent)'); process.exit(1) }

  const r = await sendBroadcast(campaign.resendBroadcastId)
  if (!r.ok) {
    // release the claim so the operator can retry after fixing the cause
    await prisma.newsletterCampaign.updateMany({ where: { id: campaign.id, status: 'SENDING' }, data: { status: 'DRAFT' } })
    console.error(`send failed with status ${r.status}; claim released, safe to retry`)
    process.exit(1)
  }
  await prisma.newsletterCampaign.update({
    where: { id: campaign.id }, data: { status: 'SENT', sentAt: new Date() }
  })
  console.log(`sent campaign ${campaign.periodKey} (broadcast ${campaign.resendBroadcastId})`)
  await prisma.$disconnect()
}

main().catch((err) => { console.error(err?.code ?? err?.message ?? err); process.exit(1) })
