import { PrismaClient, Prisma } from '@prisma/client'
import { applyTipDetected } from '@/api/monero/ranking'
import { lwsClient } from '@/api/monero/lwsClient'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

// lws tx-confirmation webhook receiver (spec §4.4).
//
// lws pushes callbacks at 0-conf (detection) and at each subsequent
// confirmation up to the requested ceiling. The receiver drives the
// ObservedTip state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx, bump Item.msats)
//   DETECTED -> CONFIRMED (N-conf callback: bump User.stackedPiconeros)
//
// lws treats any non-200 as a delivery failure and retries, so every path
// returns 200 except auth failures (401) and non-POST requests (405).
// Idempotency: the PENDING->DETECTED transition uses an atomic conditional
// UPDATE (... WHERE state = 'PENDING') inside a Serializable transaction.
// reconcilePendingTips is a second concurrent claimer for the same PENDING
// tip (a missed 0-conf webhook); the conditional claim ensures exactly one
// claimer wins (rowCount > 0) and only it applies the ranking delta, so the
// tip is never double-counted. A retried callback for an already-advanced
// state loses the claim (state is no longer PENDING) and is a no-op.

const prisma = new PrismaClient()

export async function handleWebhook (req, res, models = prisma, monero = lwsClient) {
  const token = req.headers && req.headers['x-lws-token']
  const expected = process.env.LWS_WEBHOOK_TOKEN || ''
  if (expected && token !== expected) {
    return res.status(401).end()
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
  const { payment_id: paymentId, confirmations = 0, tx_info: txInfo = {} } = body
  const { tx_hash: txHash, block: height, amount } = txInfo

  if (!paymentId) return res.status(200).end()

  const tip = await models.observedTip.findFirst({
    where: { paymentId },
    include: { post: { select: { userId: true } } }
  })
  if (!tip) return res.status(200).end()

  if (tip.state === 'CONFIRMED') return res.status(200).end()

  if (tip.state === 'PENDING') {
    const piconeros = BigInt(amount || '0')
    await models.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "ObservedTip"
        SET state = 'DETECTED', "txHash" = ${txHash},
            height = ${height ?? null}, piconeros = ${piconeros}, confirmations = ${confirmations}
        WHERE id = ${tip.id} AND state = 'PENDING'`
      if (claimed > 0) {
        await applyTipDetected(tip.postId, tip.tipperId, piconeros, tx)
        if (tip.tipperId != null) {
          await tx.$executeRaw`
            INSERT INTO pgboss.job (id, name, data)
            VALUES (gen_random_uuid(), 'checkStreak', jsonb_build_object('id', ${tip.tipperId}, 'type', 'COWBOY_HAT'))`
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return res.status(200).end()
  }

  if (tip.state === 'DETECTED' && confirmations >= REQUIRED_CONFIRMATIONS) {
    const data = { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    if (height != null) data.height = height
    if (txHash) data.txHash = txHash
    await models.$transaction(async (tx) => {
      await tx.observedTip.update({
        where: { id: tip.id },
        data
      })
      await tx.user.update({
        where: { id: tip.post.userId },
        data: { stackedPiconeros: { increment: tip.piconeros } }
      })
    })
    if (tip.webhookEventId) {
      try {
        await monero.deleteWebhook(tip.webhookEventId)
      } catch (err) {
        console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
      }
    }
    return res.status(200).end()
  }

  if (tip.state === 'DETECTED') {
    const data = { confirmations }
    if (height != null) data.height = height
    if (txHash) data.txHash = txHash
    await models.observedTip.update({
      where: { id: tip.id },
      data
    })
  }

  return res.status(200).end()
}

export default function handler (req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  handleWebhook(req, res)
}
