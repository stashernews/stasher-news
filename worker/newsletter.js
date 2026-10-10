import { alert } from '@/lib/alert'
import { maskEmail } from '@/lib/crypto'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { decryptEmail } from '@/lib/emailCrypto'
import { enrollContact, isNewsletterEnabled, checkNewsletterConfig } from '@/lib/newsletter'
import { syncNewsletterContacts } from '@/lib/newsletterSync'

// newsletterEnroll: one-shot job enqueued at email signup (the NextAuth
// adapter's createUser raw-INSERTs it). Decrypts the address in memory,
// upserts the Resend contact, stores resendContactId. Guards make it safe to
// re-run and safe for users who opted out between enqueue and run. A Resend
// rejection alerts (deduped) and completes — the daily newsletterSync
// reconcile is the backstop, so a failed single enrollment self-heals within
// a day even without job retries.
export async function newsletterEnroll ({ models, data }) {
  const userId = Number(data?.userId)
  if (!Number.isInteger(userId)) return
  if (!isNewsletterEnabled()) return
  if (checkNewsletterConfig().length) {
    // unconfigured: the daily newsletterSync alerts (deduped) about this; a
    // per-signup call here would just 401 noisily — skip and let the
    // reconcile backfill the contact once the env lands
    logWarn(`newsletterEnroll: user ${userId} skipped: newsletter unconfigured`)
    return
  }
  const user = await models.user.findUnique({ where: { id: userId } })
  if (!user || !user.emailVerified || !user.emailCiphertext) return
  if (!user.newsletterOptIn || user.newsletterSuppressed) return
  const email = decryptEmail(user.emailCiphertext)
  if (user.emailHint && maskEmail({ email }) !== user.emailHint) {
    logWarn(`newsletterEnroll: user ${userId} skipped: decrypted address does not match emailHint`)
    return
  }
  const r = await enrollContact({ email })
  if (!r.ok) {
    alert('critical', 'newsletter: enrollment failed', `user ${userId}, status ${r.status}, reconcile will retry`, { dedupeKey: 'newsletter-enroll' })
    return
  }
  if (r.contactId) {
    try {
      await models.user.update({ where: { id: userId }, data: { resendContactId: r.contactId } })
    } catch (err) {
      logError(`newsletterEnroll: user ${userId} contactId save failed`, { code: err?.code })
    }
  }
  logInfo(`newsletterEnroll: user ${userId} enrolled`, { status: r.status })
}

// newsletterSync: daily reconcile (cron-owned, 0 16 * * * UTC). See
// lib/newsletterSync.js for the mechanics shared with the import script.
export async function newsletterSync ({ models }) {
  if (!isNewsletterEnabled()) { logInfo('newsletterSync: disabled via NEWSLETTER_ENABLED'); return }
  const missing = checkNewsletterConfig()
  if (missing.length) {
    logWarn('newsletterSync: skipped — unset env', { missing })
    alert('warn', 'newsletter sync skipped', `missing ${missing.join(', ')}`, { dedupeKey: 'newsletter-env' })
    return
  }
  const stats = await syncNewsletterContacts({ models, apply: true })
  logInfo('newsletterSync: done', stats)
}
