import models from '@/api/models'
import { hashEmail } from '@/lib/crypto'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { verifyResendWebhook } from '@/lib/newsletter'

// Reverse sync from Resend: unsubscribes (the native broadcast preference
// page) and bounces/complaints/suppressions land here and are mirrored into
// local flags so the Settings toggle and the daily reconcile stay truthful.
//
// The signature is verified over the RAW body (svix signs the exact bytes), so
// bodyParser is disabled and we buffer the stream ourselves. Address-bearing
// payloads are matched through hashEmail — an address is never logged.

export const config = { api: { bodyParser: false } }

async function readRawBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function handleResendWebhook (req, res, modelsArg) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) { logWarn('resendWebhook: RESEND_WEBHOOK_SECRET unset'); res.status(400).end(); return }

  const rawBody = typeof req.body === 'string' ? req.body : await readRawBody(req)
  const { valid, event, reason } = verifyResendWebhook({
    rawBody, headers: req.headers, secret
  })
  if (!valid) {
    logWarn('resendWebhook: rejected', { reason })
    res.status(400).end()
    return
  }

  try {
    await applyEvent(event, modelsArg)
  } catch (err) {
    logError('resendWebhook: apply failed', { type: event?.type, code: err?.code })
    // 500 makes svix retry — the desired behavior for transient DB errors
    res.status(500).end()
    return
  }
  logInfo('resendWebhook: applied', { type: event?.type })
  res.status(200).json({ received: true })
}

async function applyEvent (event, models) {
  const type = event?.type
  const data = event?.data ?? {}
  if (type === 'contact.updated' && data.unsubscribed === true && data.email) {
    await models.user.update({
      where: { emailHash: hashEmail({ email: String(data.email) }) },
      data: { newsletterOptIn: false }
    })
    return
  }
  if (type === 'email.bounced' || type === 'email.complained' || type === 'suppression.added') {
    const address = data.to?.[0] ?? data.email
    if (!address) return
    await models.user.update({
      where: { emailHash: hashEmail({ email: String(address) }) },
      data: { newsletterSuppressed: true }
    })
    if (type !== 'email.bounced') {
      alert('critical', 'newsletter: complaint/suppression received', `event ${type}; user flagged locally`, { dedupeKey: 'newsletter-complaint' })
    }
  }
  // unknown event types: acknowledge so svix does not retry forever
}

export default async function handler (req, res) {
  return await handleResendWebhook(req, res, models)
}
