import { alert } from '@/lib/alert'
import { WEBHOOK_MISS_CHECK_DELAY_SECONDS } from '@/lib/constants'

// Delayed half of the webhook receipt alert split (2026-09-15). A 0-conf
// tx_not_found now means BOTH sources missed: lws's REST API cannot see mempool
// txs (the structural cause of the early-callback miss — not a benign race),
// AND the daemon fallback (monerod raw-tx lookup, detection branches only) did
// not return the callback hash either — the tx is foreign, not yet relayed, or
// monerod is unreachable. That is no longer a routine lws-only miss: the
// receiver logs it and schedules this one-shot instead of alerting on the spot
// (startafter = WEBHOOK_MISS_CHECK_DELAY_SECONDS, singletonKey per paymentId),
// because most misses still self-resolve within minutes — the next confirmation
// callback brings the mined tx into lws, or reconcilePendingTips (including its
// raw-decrypt pid fallback) recovers it. By then a genuine miss is
// unambiguous. Only a still-PENDING ObservedTip pages.
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
    // DETECTED/CONFIRMED: detection landed (the normal case). EXPIRED: the
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
