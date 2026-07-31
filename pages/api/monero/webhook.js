import { PrismaClient } from '@prisma/client'
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
// Idempotency: the state machine is one-way, so a retried callback for an
// already-advanced state is a no-op.

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
      await tx.observedTip.update({
        where: { id: tip.id },
        data: { state: 'DETECTED', txHash, height: height ?? null, piconeros, confirmations }
      })
      await applyTipDetected(tip.postId, null, piconeros, tx)
    })
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
