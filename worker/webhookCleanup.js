import { lwsClient } from '@/api/monero/lwsClient'

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
//
// Downvote webhooks are swept off the DownvotePidMap, not an Observed* table: the event id
// is registered at downvote ISSUANCE (Task 3), before any ObservedDownvote row exists (the
// row is only created at 0-conf detection). The id leaks permanently on lws in three paths:
//   (1) a never-paid downvote — the map expires after 24h but the webhook stays registered;
//   (2) the receiver's best-effort deleteWebhook at CONFIRMED fails;
//   (3) confirmFinalizer flips DETECTED -> CONFIRMED and never deletes the webhook at all.
// A map is sweepable when its expiresAt is in the past (covers (1), no observation ever) OR
// its paymentId has a CONFIRMED ObservedDownvote (covers (2)+(3), regardless of map age).
// Live pending downvotes (unexpired + not CONFIRMED) are never touched. The sweep nulls
// webhookEventId on success (idempotent: re-runs skip nulled rows) but KEEPS the id on a
// deleteWebhook failure so the next hourly run retries — and never deletes the map row
// itself, since the observer-poll backstop may still reference it.

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

  // Downvote pid-map sweep (see the comment block above for the leak paths).
  const dvMaps = await models.downvotePidMap.findMany({
    where: { webhookEventId: { not: null } }
  })
  let confirmedDvPids = new Set()
  if (dvMaps.length > 0) {
    const confirmed = await models.observedDownvote.findMany({
      where: { paymentId: { in: dvMaps.map(m => m.paymentId) }, state: 'CONFIRMED' },
      select: { paymentId: true }
    })
    confirmedDvPids = new Set(confirmed.map(o => o.paymentId))
  }
  const now = new Date()
  for (const map of dvMaps) {
    // Defensive re-check mirroring the tip sweep: skip a row that lost its
    // webhookEventId between query and processing so we never call
    // deleteWebhook(null).
    if (!map.webhookEventId) continue
    const expired = map.expiresAt < now
    if (!expired && !confirmedDvPids.has(map.paymentId)) continue
    try {
      await monero.deleteWebhook(map.webhookEventId)
    } catch (err) {
      // Best-effort but RETRYABLE (unlike tips): keep the id so the next hourly
      // run re-attempts the lws delete. The map row itself is never deleted.
      console.warn(`webhookCleanup: downvote deleteWebhook(${map.webhookEventId}) failed (will retry next run): ${err && err.message}`)
      continue
    }
    await models.downvotePidMap.update({
      where: { paymentId: map.paymentId },
      data: { webhookEventId: null }
    })
    cleaned += 1
  }
  return { cleaned }
}

export async function webhookCleanup ({ models }) {
  // Recurrence is cron-owned (pgboss.schedule row webhookCleanup); no
  // self-requeue.
  const out = await runWebhookCleanupOnce({ models })
  if (out.cleaned) console.log(`webhookCleanup: removed ${out.cleaned} stale webhook(s)`)
}
