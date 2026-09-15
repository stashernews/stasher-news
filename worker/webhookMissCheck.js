import { alert } from '@/lib/alert'
import { WEBHOOK_MISS_CHECK_DELAY_SECONDS } from '@/lib/constants'

// Delayed half of the webhook receipt alert split (2026-09-15). The receiver's
// early lookup for a tip callback can miss a mempool tx lws has just announced
// (the benign 0-conf race): verifyReceiptAmount returns tx_not_found, the
// receiver logs it, and every observed case self-resolves within minutes (the
// next confirmation callback or reconcilePendingTips). Alerting on that first
// miss is pure noise, so the receiver schedules this one-shot instead
// (startafter = WEBHOOK_MISS_CHECK_DELAY_SECONDS, singletonKey per paymentId).
// By then a genuine miss is unambiguous: every recovery path — lws's per-block
// callbacks, the 2-min reconcile scan, and its raw-decrypt pid fallback — has
// run. Only a still-PENDING ObservedTip pages.
export async function runWebhookMissCheckOnce ({ models, data }) {
  const { paymentId, piconeros, context } = data || {}
  if (!paymentId) {
    // Malformed job payload (never produced by the receiver): never page on a
    // guessed row — Prisma would otherwise drop the undefined filter and
    // query an arbitrary ObservedTip.
    return { state: 'missing', alerted: false }
  }
  const tip = await models.observedTip.findFirst({
    where: { paymentId },
    select: { id: true, state: true }
  })
  if (!tip || tip.state !== 'PENDING') {
    // DETECTED/CONFIRMED: the race resolved (the normal case). EXPIRED: the
    // intent expired before the payment. EXCLUDED/REORGED: the payment landed
    // but was excluded or reversed. No row: not a tip pid (only tip callers
    // schedule this job). None of these is a miss.
    return { state: tip?.state ?? 'missing', alerted: false }
  }
  alert('warn', 'tip payment never landed after webhook',
    `${context}: paymentId ${paymentId} (${piconeros} piconeros) is still PENDING ${WEBHOOK_MISS_CHECK_DELAY_SECONDS / 60} min after the lws tx-confirmation webhook — no DETECTED/CONFIRMED ObservedTip; the payment never landed`,
    { dedupeKey: `webhook-miss-${paymentId}` })
  return { state: 'PENDING', alerted: true }
}

export async function webhookMissCheck ({ models, data }) {
  await runWebhookMissCheckOnce({ models, data })
}
