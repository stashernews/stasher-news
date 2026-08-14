import { lwsClient } from '@/api/monero/lwsClient'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'

// webhookCleanup — sweep orphaned lws tx-confirmation webhooks (Phase 5).
//
// Each initiateTip registers a lws webhook. The receiver deletes it at CONFIRMED, but
// (a) that deleteWebhook is best-effort, and (b) confirmFinalizer's safety-net CONFIRMED
// path does NOT delete the webhook at all. Never-paid tips leave their webhook registered
// forever. This hourly job finds ObservedTips whose webhook is no longer needed — state
// CONFIRMED or EXPIRED — calls lws deleteWebhook(eventId), and nulls webhookEventId so the
// row is never reprocessed. deleteWebhook failures are swallowed (best-effort): the row is
// nullled regardless so a permanently-bad event id doesn't block the cron.
//
// State-driven (not listWebhooks-driven): we know exactly which event ids we registered and
// when they're done, so we drive cleanup from our own table rather than parsing lws's
// webhook_list response shape.

const CLEANUP_INTERVAL_SECONDS = 60 * 60 // hourly

export async function runWebhookCleanupOnce ({ models, monero = lwsClient }) {
  const tips = await models.observedTip.findMany({
    where: { webhookEventId: { not: null }, state: { in: ['CONFIRMED', 'EXPIRED'] } }
  })
  let cleaned = 0
  for (const tip of tips) {
    // Defensive re-check of the WHERE clause: a row that lost its webhookEventId, or
    // flipped out of CONFIRMED/EXPIRED between query and processing, is skipped so we
    // never call deleteWebhook(null) or yank a webhook a still-DETECTED tip needs.
    if (!tip.webhookEventId) continue
    if (tip.state !== 'CONFIRMED' && tip.state !== 'EXPIRED') continue
    try {
      await monero.deleteWebhook(tip.webhookEventId)
    } catch (err) {
      console.warn(`webhookCleanup: deleteWebhook(${tip.webhookEventId}) failed (best-effort): ${err && err.message}`)
    }
    await models.observedTip.update({
      where: { id: tip.id },
      data: { webhookEventId: null }
    })
    cleaned += 1
  }
  return { cleaned }
}

export async function webhookCleanup ({ boss, models }) {
  // Run first, requeue only on success: a requeue sent from a FAILED run
  // forks the chain (pg-boss retries this same job, whose success sends
  // another requeue). On a run error just rethrow — the retry re-executes
  // the whole handler, which re-sends on eventual success.
  const out = await runWebhookCleanupOnce({ models })
  if (out.cleaned) console.log(`webhookCleanup: removed ${out.cleaned} stale webhook(s)`)
  try {
    await boss.send('webhookCleanup', {}, { startAfter: CLEANUP_INTERVAL_SECONDS })
  } catch (e) {
    logError('webhookCleanup requeue send failed', e)
    alert('critical', 'webhookCleanup requeue failed', String(e), { dedupeKey: 'webhookCleanup-requeue' })
    throw e // rethrow so pg-boss retries THIS run and the chain survives
  }
}
