import nodemailer from 'nodemailer'
import { alert } from '@/lib/alert'
import { maskEmail } from '@/lib/crypto'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { decryptEmail, createUnsubscribeToken } from '@/lib/emailCrypto'
import { gatherDigest, getDigestCandidates, getCommunityHighlights, isEmailDigestEnabled } from '@/lib/emailDigest'
import { renderDigest } from '@/lib/emailDigestTemplate'

// Daily drip for the weekly email digest, cron-owned via the pgboss.schedule
// row created in the email_digest migration (0 15 * * * UTC). Never
// self-requeues: a failed run is retried by pgboss and, if permanently failed,
// self-heals at the next daily tick.
//
// Each run sends at most EMAIL_DIGEST_DAILY_BUDGET emails (default 60) from the
// candidate set (watermark NULL or 7+ days old, oldest first). The rest of
// Resend's free-tier 100/day quota is reserved for magic-code login email.
// Personal sections use each user's watermark window; community highlights use
// the same fixed 7-day window and are filtered by each recipient's user and
// territory mutes, so they are fetched per send, not once per run.

const CANDIDATE_LIMIT = 500
const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 2000
const FAILURE_ALERT_MIN = 5
const FAILURE_ALERT_RATIO = 0.1
const CONSECUTIVE_FAILURE_ABORT = 5
const DEFAULT_DAILY_BUDGET = 60
const MAX_DAILY_BUDGET = 95
const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const CANDIDATE_STALE_MS = 7 * DAY_MS

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// SMTP errors can quote the recipient; mask any address-like token before
// it reaches the logger (userId-only logging is the rule).
const redactAddresses = s => String(s ?? '').replace(/[^\s<>,;:"]+@[^\s<>,;:"]+/g, m => maskEmail({ email: m }))

function dailyBudget () {
  const raw = process.env.EMAIL_DIGEST_DAILY_BUDGET
  if (raw === undefined || raw === '') return DEFAULT_DAILY_BUDGET
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    logWarn(`emailDigest: invalid EMAIL_DIGEST_DAILY_BUDGET "${raw}"; using ${DEFAULT_DAILY_BUDGET}. Set EMAIL_DIGEST_ENABLED=false to pause sends.`)
    return DEFAULT_DAILY_BUDGET
  }
  if (value > MAX_DAILY_BUDGET) {
    logWarn(`emailDigest: EMAIL_DIGEST_DAILY_BUDGET ${value} exceeds the safe max ${MAX_DAILY_BUDGET}; clamping`)
    return MAX_DAILY_BUDGET
  }
  return value
}

// Resend free-tier quota rejections surface as 429 / daily_quota_exceeded /
// monthly_quota_exceeded; over SMTP nodemailer wraps the server text in the
// error.
function isQuotaError (err) {
  if (!err) return false
  if (err.responseCode === 429) return true
  return /quota|rate limit|too many/i.test(String(err.message ?? err))
}

export async function runEmailDigest ({ models, transport, now = new Date() }) {
  const siteUrl = process.env.NEXT_PUBLIC_URL
  const digestFrom = process.env.DIGEST_EMAIL_FROM
  const from = digestFrom || process.env.LOGIN_EMAIL_FROM
  if (!digestFrom) {
    logWarn('emailDigest: DIGEST_EMAIL_FROM unset; falling back to LOGIN_EMAIL_FROM')
  }
  const replyTo = process.env.DIGEST_EMAIL_REPLY_TO || undefined
  const budget = dailyBudget()

  const stats = { considered: 0, sent: 0, skipped: 0, failed: 0, aborted: false }
  const candidates = await getDigestCandidates({
    models,
    staleBefore: new Date(now.getTime() - CANDIDATE_STALE_MS),
    take: CANDIDATE_LIMIT
  })

  let consecutiveFailures = 0
  for (const user of candidates) {
    if (stats.sent >= budget) break
    stats.considered += 1
    try {
      const sections = await gatherDigest({
        models, user, now, defaultWindowDays: DEFAULT_WINDOW_DAYS, maxWindowDays: MAX_WINDOW_DAYS
      })
      if (!sections.hasPersonalActivity) {
        await models.user.update({ where: { id: user.id }, data: { emailDigestSentAt: now } })
        stats.skipped += 1
        consecutiveFailures = 0
        continue
      }

      // Defense-in-depth against address/hint drift (e.g. a dev tool or manual
      // edit overwriting users.email before the ciphertext backfill): refuse to
      // mail an address the user would not recognize in settings. Same
      // skip-empty semantics — advance the watermark; re-linking rewrites
      // ciphertext and hint together, making the user eligible again.
      const to = decryptEmail(user.emailCiphertext)
      if (user.emailHint && maskEmail({ email: to }) !== user.emailHint) {
        logWarn(`emailDigest: user ${user.id} skipped: decrypted address does not match emailHint`)
        await models.user.update({ where: { id: user.id }, data: { emailDigestSentAt: now } })
        stats.skipped += 1
        consecutiveFailures = 0
        continue
      }

      const unsubscribeUrl = `${siteUrl}/api/email/unsubscribe?u=${user.id}&t=${createUnsubscribeToken(user.id)}`
      const highlights = await getCommunityHighlights({
        models,
        from: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS),
        to: now,
        user
      })
      const rendered = renderDigest({
        name: user.name,
        sections: { ...sections, highlights },
        windowStart: sections.windowStart,
        windowEnd: sections.windowEnd,
        unsubscribeUrl,
        siteUrl
      })

      await transport.sendMail({
        to,
        from,
        replyTo,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })

      await models.user.update({ where: { id: user.id }, data: { emailDigestSentAt: now } })
      stats.sent += 1
      consecutiveFailures = 0
      if (stats.sent % BATCH_SIZE === 0) await sleep(BATCH_PAUSE_MS)
    } catch (err) {
      stats.failed += 1
      consecutiveFailures += 1
      // Log the user id only — never the address or envelope.
      logError(`emailDigest: user ${user.id} failed`, {
        code: err?.code,
        responseCode: err?.responseCode,
        message: redactAddresses(err?.message ?? err)
      })

      if (isQuotaError(err)) {
        stats.aborted = true
        alert('critical', 'emailDigest: quota exceeded', `sent ${stats.sent} before abort`, { dedupeKey: 'email-digest-quota' })
        break
      }

      // Advance the watermark even on failure: permanently-failing users keep a
      // NULL watermark forever, and the nulls-first candidate ordering would
      // otherwise cluster >=5 of them at the head of every run, tripping the
      // consecutive-failure abort before any healthy user is reached. Cost of a
      // dead address is one budget slot per week; transient failures retry after
      // the normal staleness window. Quota failures still leave it untouched.
      try {
        await models.user.update({ where: { id: user.id }, data: { emailDigestSentAt: now } })
      } catch (updateErr) {
        logError(`emailDigest: user ${user.id} watermark advance failed`, {
          code: updateErr?.code,
          message: redactAddresses(updateErr?.message ?? updateErr)
        })
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_ABORT) {
        stats.aborted = true
        alert('critical', 'emailDigest: aborting after consecutive failures', `failed ${stats.failed}/${stats.considered}`, { dedupeKey: 'email-digest-failures' })
        break
      }
    }
  }

  if (!stats.aborted && stats.failed > FAILURE_ALERT_MIN && stats.failed / stats.considered > FAILURE_ALERT_RATIO) {
    alert('critical', 'emailDigest: high failure rate', `failed ${stats.failed}/${stats.considered}`, { dedupeKey: 'email-digest-failures' })
  }

  return stats
}

export async function emailDigest ({ models }) {
  if (!isEmailDigestEnabled()) {
    logInfo('emailDigest: disabled via EMAIL_DIGEST_ENABLED')
    return
  }
  if (!process.env.EMAIL_MASTER_KEY || !process.env.LOGIN_EMAIL_SERVER) {
    logError('emailDigest: EMAIL_MASTER_KEY or LOGIN_EMAIL_SERVER unset; skipping run')
    alert('warn', 'emailDigest skipped', 'missing EMAIL_MASTER_KEY or LOGIN_EMAIL_SERVER', { dedupeKey: 'email-digest-env' })
    return
  }
  const transport = nodemailer.createTransport(process.env.LOGIN_EMAIL_SERVER)
  const stats = await runEmailDigest({ models, transport })
  logInfo('emailDigest: done', stats)
}
