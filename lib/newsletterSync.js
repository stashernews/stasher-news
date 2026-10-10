import { maskEmail } from './crypto.js'
import { logWarn } from './logger.js'
import { decryptEmail } from './emailCrypto.js'
import { checkNewsletterConfig, enrollContact, unsubscribeContact } from './newsletter.js'

// Single reconcile used by BOTH the daily newsletterSync worker and the
// one-time import script (scripts/newsletter-sync.js). Idempotent: upserts the
// eligible set as subscribed contacts, unsubscribes opted-out contacts, and
// NEVER touches suppressed users (they bounced or complained — re-subscribing
// them at Resend would be both rude and reputation-damaging). Reports counts
// only; addresses never leave this module except inside Resend API calls, and
// never reach the logger.
//
// Both populations are cursor-paginated by id: a single `take` would revisit
// the same earliest rows every run and permanently starve everyone past the
// batch, which breaks even the free tier's 1,000-contact ceiling.

const DEFAULT_BATCH_SIZE = 200

export async function syncNewsletterContacts ({ models, apply = true, now = new Date(), batchSize = DEFAULT_BATCH_SIZE }) {
  const stats = { eligible: 0, enrolled: 0, failed: 0, hintSkipped: 0, suppressed: 0, toUnsubscribe: 0, unsubscribed: 0 }
  const missing = checkNewsletterConfig()
  if (missing.length) {
    logWarn('newsletterSync: unset env — nothing to do', { missing })
    return stats
  }

  const eligibleWhere = {
    newsletterOptIn: true,
    emailVerified: { not: null },
    emailCiphertext: { not: null },
    newsletterSuppressed: false
  }
  let lastId = 0
  for (;;) {
    const rows = await models.user.findMany({
      where: { ...eligibleWhere, id: { gt: lastId } },
      orderBy: { id: 'asc' },
      take: batchSize
    })
    if (!rows.length) break
    for (const u of rows) {
      // defense-in-depth vs the where clause: a suppressed row must never be
      // re-subscribed, and an address the user would not recognize must never
      // be mailed (same hint guard as the digest send boundary)
      if (u.newsletterSuppressed) { stats.suppressed += 1; continue }
      stats.eligible += 1
      const email = decryptEmail(u.emailCiphertext)
      if (u.emailHint && maskEmail({ email }) !== u.emailHint) {
        stats.hintSkipped += 1
        continue
      }
      if (!apply) continue
      const r = await enrollContact({ email })
      if (r.ok) {
        stats.enrolled += 1
        if (r.contactId && r.contactId !== u.resendContactId) {
          try { await models.user.update({ where: { id: u.id }, data: { resendContactId: r.contactId } }) } catch { /* next sync retries */ }
        }
      } else {
        stats.failed += 1
      }
    }
    lastId = rows[rows.length - 1].id
    if (rows.length < batchSize) break
  }

  // Opt-outs are reconciled by ADDRESS, not by stored contact id: a Settings
  // push whose contactId write failed (or was never persisted) must still be
  // unsubscribable, or the advertised backstop would fail exactly after a
  // partial success.
  const optOutWhere = {
    newsletterOptIn: false,
    emailVerified: { not: null },
    emailCiphertext: { not: null }
  }
  let lastOutId = 0
  for (;;) {
    const optOuts = await models.user.findMany({
      where: { ...optOutWhere, id: { gt: lastOutId } },
      orderBy: { id: 'asc' },
      take: batchSize
    })
    if (!optOuts.length) break
    for (const u of optOuts) {
      stats.toUnsubscribe += 1
      if (!apply) continue
      const email = decryptEmail(u.emailCiphertext)
      if (u.emailHint && maskEmail({ email }) !== u.emailHint) continue
      const r = await unsubscribeContact({ email })
      if (r.ok) stats.unsubscribed += 1
    }
    lastOutId = optOuts[optOuts.length - 1].id
    if (optOuts.length < batchSize) break
  }

  if (apply) {
    const lastCampaign = await models.newsletterCampaign.findFirst({ where: { sentAt: { not: null } }, orderBy: { sentAt: 'desc' } })
    await models.healthSnapshot.upsert({
      where: { id: 1 },
      update: {
        newsletterConfigured: true,
        newsletterContactsActive: stats.enrolled,
        newsletterSyncedAt: now,
        ...(lastCampaign?.sentAt ? { newsletterLastSentAt: lastCampaign.sentAt } : {})
      },
      create: { id: 1, newsletterConfigured: true, newsletterContactsActive: stats.enrolled, newsletterSyncedAt: now }
    })
  }
  return stats
}
