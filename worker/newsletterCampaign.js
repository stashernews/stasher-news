import { alert } from '@/lib/alert'
import { logInfo } from '@/lib/logger'
import { gatherNewsletterContent } from '@/lib/newsletterContent'
import { renderNewsletter } from '@/lib/newsletterTemplate'
import {
  checkNewsletterConfig, createBroadcastDraft, isNewsletterEnabled, sendBroadcast, sendTestEmail, updateBroadcastDraft
} from '@/lib/newsletter'

// Biweekly send, cron-owned by the weekly newsletterCampaign tick
// (0 16 * * 1 UTC, migration 20261008132506_newsletter). A 14-day watermark on
// NewsletterCampaign.sentAt enforces the cadence; the ISO-week periodKey is
// the idempotency key. A CAS claim (DRAFT -> SENDING) makes creation+send
// atomic across concurrent runs/retries/operator re-runs: unique periodKey
// alone does not protect the create-then-send sequence.
//
// Default flow: DRAFT + test email; the operator releases it with
// scripts/newsletter-send.js, or NEWSLETTER_AUTO_SEND=true sends directly.
// Broadcasts draw Resend's marketing quota — never the transactional 100/day
// shared by login codes and the digest.

const DAY_MS = 24 * 60 * 60 * 1000
const CADENCE_MS = 14 * DAY_MS

function isoWeek (date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

async function releaseClaim (models, id) {
  try { await models.newsletterCampaign.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'DRAFT' } }) } catch { /* next run retries */ }
}

export async function newsletterCampaign ({ models, now = new Date() }) {
  if (!isNewsletterEnabled()) { logInfo('newsletterCampaign: disabled via NEWSLETTER_ENABLED'); return }
  const missing = checkNewsletterConfig()
  if (missing.length) {
    alert('warn', 'newsletter campaign skipped', `missing ${missing.join(', ')}`, { dedupeKey: 'newsletter-env' })
    return
  }

  const last = await models.newsletterCampaign.findFirst({
    where: { sentAt: { not: null } }, orderBy: { sentAt: 'desc' }
  })
  if (last && now.getTime() - new Date(last.sentAt).getTime() < CADENCE_MS) {
    logInfo('newsletterCampaign: watermark not reached, skipping')
    return
  }

  const periodKey = isoWeek(now)
  let campaign = await models.newsletterCampaign.findUnique({ where: { periodKey } })
  if (campaign?.status === 'SENT') { logInfo('newsletterCampaign: period already sent'); return }

  const windowEnd = now
  const windowStart = new Date(last?.sentAt ? new Date(last.sentAt).getTime() : now.getTime() - CADENCE_MS)
  const sections = await gatherNewsletterContent({ models, from: windowStart, to: windowEnd })
  const rendered = renderNewsletter({ sections, windowStart, windowEnd })

  if (!campaign) {
    try {
      campaign = await models.newsletterCampaign.create({
        data: { periodKey, subject: rendered.subject, status: 'DRAFT' }
      })
    } catch (err) {
      // unique periodKey: a concurrent run created it first — it owns the issue
      logInfo('newsletterCampaign: issue already claimed by a concurrent run', { periodKey, code: err?.code })
      return
    }
  }

  // CAS claim: exactly one run may own DRAFT -> SENDING
  const claim = await models.newsletterCampaign.updateMany({
    where: { id: campaign.id, status: 'DRAFT' }, data: { status: 'SENDING' }
  })
  if (!claim.count) { logInfo('newsletterCampaign: issue already owned by another run', { periodKey }); return }
  logInfo('newsletterCampaign: issue prepared', { periodKey, campaignId: campaign.id })

  if (process.env.NEWSLETTER_DRY_RUN === 'true') {
    logInfo('newsletterCampaign: NEWSLETTER_DRY_RUN — stopping before any Resend call')
    await releaseClaim(models, campaign.id)
    return
  }

  if (campaign.resendBroadcastId) {
    // re-run for a period that already has a provider draft: update it in place
    // so the draft that will send matches the test email the operator approves
    const updated = await updateBroadcastDraft(campaign.resendBroadcastId, {
      name: `newsletter ${periodKey}`, subject: rendered.subject, html: rendered.html, text: rendered.text
    })
    if (!updated.ok) {
      alert('critical', 'newsletter: broadcast draft update failed', `status ${updated.status}`, { dedupeKey: 'newsletter-campaign' })
      await releaseClaim(models, campaign.id)
      return
    }
  } else {
    const draft = await createBroadcastDraft({
      name: `newsletter ${periodKey}`, subject: rendered.subject, html: rendered.html, text: rendered.text
    })
    if (!draft.ok || !draft.id) {
      alert('critical', 'newsletter: broadcast draft creation failed', `status ${draft.status}`, { dedupeKey: 'newsletter-campaign' })
      await releaseClaim(models, campaign.id)
      return
    }
    campaign = await models.newsletterCampaign.update({
      where: { id: campaign.id }, data: { resendBroadcastId: draft.id }
    })
  }

  if (process.env.NEWSLETTER_TEST_TO) {
    const test = await sendTestEmail({ to: process.env.NEWSLETTER_TEST_TO, subject: rendered.subject, html: rendered.html, text: rendered.text })
    if (!test.ok) {
      // advisory only: surface it, but do not block the real send
      alert('warn', 'newsletter: test email failed', `status ${test.status}`, { dedupeKey: 'newsletter-campaign' })
    }
  }

  if (process.env.NEWSLETTER_AUTO_SEND !== 'true') {
    logInfo('newsletterCampaign: draft awaiting operator approval', { broadcastId: campaign.resendBroadcastId })
    await releaseClaim(models, campaign.id)
    return
  }

  const sent = await sendBroadcast(campaign.resendBroadcastId)
  if (!sent.ok) {
    alert('critical', 'newsletter: broadcast send failed', `status ${sent.status}`, { dedupeKey: 'newsletter-campaign' })
    await releaseClaim(models, campaign.id)
    return
  }
  await models.newsletterCampaign.update({
    where: { id: campaign.id }, data: { status: 'SENT', sentAt: now }
  })
  await models.healthSnapshot.upsert({
    where: { id: 1 },
    update: { newsletterLastSentAt: now },
    create: { id: 1, newsletterLastSentAt: now }
  })
  logInfo('newsletterCampaign: SENT', { periodKey })
}
