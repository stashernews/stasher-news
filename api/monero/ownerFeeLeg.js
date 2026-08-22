import { randomUUID } from 'node:crypto'
import { generateSubFeePaymentId } from '@/api/monero/paymentId'
import { makeIntegratedAddress } from '@/api/monero/integratedAddress'
import { buildMoneroUri } from '@/api/monero/uri'
import { lwsClient } from '@/api/monero/lwsClient'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

// 7-day liveness for a fee leg: unpaid legs are swept by webhookCleanup after
// this window (the item itself rides the existing abandonFeeItems machinery).
export const FEE_PID_TTL_MS = 7 * 86_400_000

/**
 * Build an owner-routed fee leg: HMAC fee: payment id, integrated address
 * derived from the OWNER's registered primary, a monero: URI quoting the full
 * amount, an lws tx-confirmation webhook on (owner address, pid), and a
 * SubFeePidMap row for attribution + webhook cleanup. Called from payIn
 * getInitial (before the PayIn exists — the URI is only returned to the
 * client after begin() commits, so a payment can never precede the PayIn).
 */
export async function createOwnerFeeLeg (models, monero = lwsClient, { ownerAccount, subName, amountPiconeros, description }) {
  const paymentId = generateSubFeePaymentId(randomUUID(), Date.now())
  const { integratedAddress } = makeIntegratedAddress(ownerAccount.address, paymentId)
  const moneroUri = buildMoneroUri(
    [{ address: integratedAddress, amount: amountPiconeros }],
    { description }
  )

  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: ownerAccount.address,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

  await models.subFeePidMap.create({
    data: {
      paymentId,
      subName,
      ownerUserId: ownerAccount.ownerUserId,
      amountPiconeros,
      webhookEventId: webhook.event_id ?? null,
      expiresAt: new Date(Date.now() + FEE_PID_TTL_MS)
    }
  })

  return { paymentId, integratedAddress, moneroUri }
}
