import crypto from 'node:crypto'
import { maskEmail } from './crypto.js'
import { logInfo, logError } from './logger.js'

// Thin, dependency-free wrapper over the Resend Marketing APIs (Contacts +
// Broadcasts) used by the newsletter. Plain fetch, like lib/alert.js.
//
// LOGGING RULE: never log an email address. Callers pass addresses in; we log
// op + HTTP status + Resend ids only, and scrub any address-like token out of
// error text before it reaches the logger (Resend error bodies quote the
// recipient).
//
// API shapes verified against Resend's current docs (segments model, Nov 2025
// onward): POST /contacts takes `segments` as an ARRAY OF OBJECTS ([{id}] —
// bare string ids 422); PATCH /contacts/{email} flips the unsubscribed flag;
// broadcasts target segment_id and are created as drafts (send:false) because
// API-created broadcasts can only be edited/sent via API (Resend's
// location-of-creation rule).

const RESEND_API = 'https://api.resend.com'
const REQUEST_TIMEOUT_MS = 15_000
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000

export const redactAddresses = s => String(s ?? '').replace(/[^\s<>,;:"]+@[^\s<>,;:"]+/g, m => maskEmail({ email: m }))

export function isNewsletterEnabled (env = process.env) {
  return env.NEWSLETTER_ENABLED !== 'false'
}

// Names of required-but-missing vars. [] = fully configured.
export function checkNewsletterConfig (env = process.env) {
  return ['RESEND_API_KEY', 'NEWSLETTER_SEGMENT_ID', 'NEWSLETTER_FROM']
    .filter(k => !env[k])
}

async function resendFetch (op, method, path, body) {
  try {
    const res = await fetch(RESEND_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    let json = null
    try { json = await res.json() } catch { /* status is enough */ }
    const contactId = json?.id ?? json?.data?.id
    logInfo(`newsletter: ${op}`, { status: res.status, contactId })
    return { ok: res.ok, status: res.status, contactId, json }
  } catch (err) {
    logError(`newsletter: ${op} failed`, { message: redactAddresses(err?.message ?? err) })
    return { ok: false, status: 0 }
  }
}

// Upsert: POST creates (Resend dedupes by email); a 409/422 "already exists"
// falls back to PATCH to re-subscribe. Suppressed/bounced contacts are never
// routed through here by callers (the sync skips them by design).
export async function enrollContact ({ email }) {
  const created = await resendFetch('enroll', 'POST', '/contacts', {
    email, unsubscribed: false, segments: [{ id: process.env.NEWSLETTER_SEGMENT_ID }]
  })
  if (created.ok) return { ok: true, status: created.status, contactId: created.contactId }
  if (created.status === 409 || created.status === 422) {
    const patched = await resendFetch('enroll-existing', 'PATCH',
      `/contacts/${encodeURIComponent(email)}`, { unsubscribed: false })
    return { ok: patched.ok, status: patched.status, contactId: patched.contactId }
  }
  return { ok: false, status: created.status }
}

export async function unsubscribeContact ({ email }) {
  const r = await resendFetch('unsubscribe', 'PATCH',
    `/contacts/${encodeURIComponent(email)}`, { unsubscribed: true })
  return { ok: r.ok, status: r.status }
}

// Broadcasts: create as DRAFT (send:false) so the operator can review before
// scripts/newsletter-send.js releases it.
export async function createBroadcastDraft ({ name, subject, html, text }) {
  const r = await resendFetch('broadcast-draft', 'POST', '/broadcasts', {
    segment_id: process.env.NEWSLETTER_SEGMENT_ID,
    from: process.env.NEWSLETTER_FROM,
    reply_to: process.env.NEWSLETTER_REPLY_TO || undefined,
    name,
    subject,
    html,
    text
  })
  return { ok: r.ok, status: r.status, id: r.json?.id }
}

export async function sendBroadcast (id) {
  const r = await resendFetch('broadcast-send', 'POST', `/broadcasts/${id}/send`, {})
  return { ok: r.ok, status: r.status }
}

// Re-render an existing draft in place. Used when a campaign job re-runs for a
// period that already has a provider draft: the stored draft must match the
// test email the operator approves (otherwise they approve one issue and a
// different one sends).
export async function updateBroadcastDraft (id, { name, subject, html, text }) {
  const r = await resendFetch('broadcast-update', 'PATCH', `/broadcasts/${id}`, {
    segment_id: process.env.NEWSLETTER_SEGMENT_ID,
    from: process.env.NEWSLETTER_FROM,
    reply_to: process.env.NEWSLETTER_REPLY_TO || undefined,
    name,
    subject,
    html,
    text
  })
  return { ok: r.ok, status: r.status, id: r.json?.id ?? id }
}

// Preview shot to the operator's inbox. Uses the transactional emails API —
// one email, well inside the 100/day transactional quota.
export async function sendTestEmail ({ to, subject, html, text }) {
  const r = await resendFetch('test-email', 'POST', '/emails', {
    from: process.env.NEWSLETTER_FROM, to: [to], subject, html, text
  })
  return { ok: r.ok, status: r.status }
}

// svix-style verification (Resend webhooks): HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${rawBody}` keyed by the base64 part of the
// whsec_ secret; the header may carry multiple space-delimited `v1,<b64>`
// signatures; reject timestamps outside the tolerance window (replay guard).
export function verifyResendWebhook ({ rawBody, headers, secret, nowMs = Date.now() }) {
  const id = headers['svix-id']
  const ts = Number(headers['svix-timestamp'])
  const sigHeader = headers['svix-signature']
  if (!id || !Number.isFinite(ts) || !sigHeader || !secret) {
    return { valid: false, reason: 'missing-headers' }
  }
  if (Math.abs(nowMs - ts * 1000) > WEBHOOK_TOLERANCE_MS) {
    return { valid: false, reason: 'stale-timestamp' }
  }
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest()
  const provided = String(sigHeader).split(' ')
    .filter(s => s.startsWith('v1,'))
    .map(s => Buffer.from(s.slice(3), 'base64'))
  const match = provided.some(b => b.length === expected.length && crypto.timingSafeEqual(b, expected))
  if (!match) return { valid: false, reason: 'bad-signature' }
  try {
    return { valid: true, event: JSON.parse(rawBody) }
  } catch {
    return { valid: false, reason: 'bad-json' }
  }
}
