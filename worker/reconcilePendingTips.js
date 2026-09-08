import { Prisma } from '@prisma/client'
import { lwsClient } from '@/api/monero/lwsClient'
import { applyTipDetected } from '@/api/monero/ranking'
import { shouldExcludeTip, resolveItemSubName } from '@/api/monero/selfTip'
import { RECONCILE_PENDING_AGE_MS, PENDING_EXPIRY_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { moneroPendingTips, moneroTipsRecoveredTotal, moneroTipsExpiredTotal } from '@/lib/metrics'

// reconcilePendingTips — recover tips stranded in PENDING by a missed 0-conf webhook.
//
// A tip is PENDING from initiateTip until the lws 0-conf callback flips it DETECTED. If
// that callback is lost (app downtime, network), confirmFinalizer will NEVER mature it
// (it only scans DETECTED rows). This job, every 2 min (cron-owned —
// pgboss.schedule row reconcilePendingTips, */2 * * * *), finds PENDING tips
// older than RECONCILE_PENDING_AGE_MS, re-scans the author account via lws
// get_address_txs, and if the payment_id is on chain, performs the same PENDING->DETECTED
// transition the webhook receiver would have (atomic claim + applyTipDetected). Tips that
// were never paid are expired after PENDING_EXPIRY_MS so the table cannot grow unbounded.
//
// Race safety: a tip could be recovered here AND by a belated webhook at the same instant.
// The recovery uses an atomic conditional UPDATE (... WHERE state = 'PENDING') inside a
// Serializable transaction: exactly one flipper wins (rowCount > 0) and only it applies the
// ranking delta — so the tip is never double-counted. This is the same idempotency contract
// the webhook receiver relies on, made race-proof via the conditional claim.
//
// get_address_txs returns the full history when sinceBlockHash is null, so this re-scan is
// exhaustive for the account (the job is infrequent + state-filtered to PENDING, so the
// cost is bounded by the number of accounts with stranded tips, not all accounts).

// Alert tiers: recoveries ARE missed webhooks (unpaid checkouts can never be
// recovered — nothing on chain to find), so the operator page fires on the
// post-scan recovered count, never on the raw PENDING pool. Small batches are
// a blip (deploy window with exhausted lws retries); large batches mean a
// systemic webhook outage.
const RECONCILE_RECOVERED_WARN = Number(process.env.RECONCILE_RECOVERED_WARN) || 1
const RECONCILE_RECOVERED_CRITICAL = Number(process.env.RECONCILE_RECOVERED_CRITICAL) || 10

export async function runReconcilePendingTipsOnce ({
  models, lwsClient: client = lwsClient, apply = applyTipDetected
}) {
  const now = Date.now()
  const reconcileBefore = new Date(now - RECONCILE_PENDING_AGE_MS)
  const expireBefore = new Date(now - PENDING_EXPIRY_MS)

  const eligible = await models.observedTip.findMany({
    where: { state: 'PENDING', detectedAt: { lt: reconcileBefore } },
    include: { post: { select: { userId: true } } }
  })
  moneroPendingTips.set(eligible.length)
  if (eligible.length === 0) return { recovered: 0, expired: 0, excluded: 0 }

  // Group stranded tips by the author account whose address lws must scan.
  const byAccount = new Map()
  for (const tip of eligible) {
    if (!byAccount.has(tip.recipientAccountId)) byAccount.set(tip.recipientAccountId, [])
    byAccount.get(tip.recipientAccountId).push(tip)
  }
  const accounts = await models.moneroAccount.findMany({
    where: { id: { in: [...byAccount.keys()] } },
    include: { viewKey: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
  })

  let recovered = 0
  let expired = 0
  let excluded = 0
  for (const account of accounts) {
    const tips = byAccount.get(account.id) || []
    // Unregistered/soft-deleted accounts (view key wiped, status INACTIVE) can't be
    // scanned — walletLogin throws on a missing viewKey relation, which would abort
    // the entire run and strand every other account's tips. Skip the scan but still
    // expire this account's tips below (byPid stays empty, so each tip falls to expiry).
    const unscannable = !account.viewKey || account.status !== 'ACTIVE'
    const byPid = new Map()
    if (!unscannable) {
      const resp = await client.getAddressTxs(account, 0, null)
      for (const tx of (resp.transactions || [])) {
        if (tx.payment_id) byPid.set(String(tx.payment_id).toLowerCase(), tx)
      }
    }
    for (const tip of tips) {
      const tx = byPid.get(String(tip.paymentId).toLowerCase())
      if (tx) {
        const amount = tx.piconeros ?? tip.piconeros
        const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
        const isExcluded = shouldExcludeTip({
          tipperId: tip.tipperId,
          postUserId: tip.post?.userId,
          account,
          tx
        })
        await models.$transaction(async (txdb) => {
          if (isExcluded) {
            // Atomic conditional claim: only the first flipper (us or the
            // webhook) wins. EXCLUDED is terminal — no apply, no streaks.
            const claimed = await txdb.$executeRaw`
              UPDATE "ObservedTip"
              SET state = 'EXCLUDED', "exclusionReason" = ${direct ? 'DIRECT_SELF_TIP' : 'SELF_SEND'}::"TipExclusionReason",
                  "txHash" = ${tx.hash}, height = ${tx.height ?? null}, piconeros = ${amount}, confirmations = 0
              WHERE id = ${tip.id} AND state = 'PENDING'`
            if (claimed > 0) {
              const subName = await resolveItemSubName(tip.postId, txdb)
              await txdb.abuseSignal.create({
                data: {
                  kind: direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED',
                  subjectUserId: tip.post?.userId,
                  actorUserId: tip.tipperId ?? null,
                  tipId: tip.id,
                  postId: tip.postId,
                  subName,
                  piconeros: amount,
                  txHash: tx.hash,
                  paymentId: tip.paymentId,
                  details: direct
                    ? undefined
                    : { note: 'amount recorded as lws reported it (change-output inflation possible)' }
                }
              })
              excluded += 1
            }
            return
          }
          // Atomic conditional claim: only the first flipper (us or the webhook) wins.
          const claimed = await txdb.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'DETECTED', "txHash" = ${tx.hash},
                height = ${tx.height ?? null}, piconeros = ${amount}, confirmations = 0
            WHERE id = ${tip.id} AND state = 'PENDING'`
          if (claimed > 0) {
            const rankDelta = await apply(tip.postId, tip.tipperId, amount, txdb)
            await txdb.$executeRaw`
              UPDATE "ObservedTip" SET "rankPiconeros" = ${rankDelta}
              WHERE id = ${tip.id} AND state = 'DETECTED'`
            recovered += 1
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } else if (tip.detectedAt < expireBefore) {
        await models.observedTip.updateMany({
          where: { id: tip.id, state: 'PENDING' },
          data: { state: 'EXPIRED' }
        })
        expired += 1
      }
    }
  }
  moneroTipsRecoveredTotal.inc(recovered)
  moneroTipsExpiredTotal.inc(expired)
  if (recovered >= RECONCILE_RECOVERED_WARN) {
    const level = recovered >= RECONCILE_RECOVERED_CRITICAL ? 'critical' : 'warn'
    alert(level, 'missed tip webhooks',
      `${recovered} tips recovered by reconciliation scan — webhooks missed`,
      { dedupeKey: 'missed-tip-webhooks' })
  }
  return { recovered, expired, excluded }
}

export async function reconcilePendingTips ({ models }) {
  // Recurrence is cron-owned (pgboss.schedule row reconcilePendingTips); no
  // self-requeue.
  const out = await runReconcilePendingTipsOnce({ models })
  if (out.recovered || out.expired || out.excluded) {
    console.log(`reconcilePendingTips: recovered ${out.recovered}, expired ${out.expired}, excluded ${out.excluded}`)
  }
}
