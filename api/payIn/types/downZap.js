import { randomInt } from 'node:crypto'
import { PAID_ACTION_PAYMENT_METHODS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'
import { getItemResult } from '../lib/item'
import { makeDownvoteAddress } from '@/api/monero/downvote'
import { buildMoneroUri } from '@/api/monero/uri'
import { lwsClient } from '@/api/monero/lwsClient'

// StasherNews rewards-funded downvote (spec §3.3).
//
// A downvote pays a fee-sized amount of Monero to the platform rewards wallet
// via an *integrated address* (primary rewards address + an 8-byte payment_id
// that encodes (postId, nonce)). The payment_id reverse map (DownvotePidMap) is
// recorded here so the rewardsWalletObserver (Task 4) can attribute the on-chain
// payment and apply the ranking penalty when it lands.
//
// piconeros is deliberately 0n: StasherNews downvotes are NOT paid in custodial
// sats. The on-chain Monero amount is observed externally by the rewardsWalletObserver
// and recorded in ObservedDownvote.piconeros (Task 4). With piconeros=0n and no
// payOuts, the PayIn engine resolves this to payInState=PAID at creation time,
// so the monero: URI is returned straight to the client — no invoice, no throw
// (see api/payIn/lib/payInCreate.js getPayInState).

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.OPTIMISTIC,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { id, piconeros }, { me, monero = lwsClient }) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')

  const amount = BigInt(piconeros)
  if (!(amount >= config.downvoteMinPiconeros)) {
    throw new GqlInputError(`downvote below minimum (${config.downvoteMinPiconeros} piconeros)`)
  }

  const item = await models.item.findUnique({ where: { id: parseInt(id) } })
  if (!item) throw new GqlInputError('item not found')

  // DownvotePidMap.nonce is an Int4 column, so the nonce must fit in 31 bits.
  // A crypto-random 31-bit value makes (postId, nonce) — and thus the derived
  // payment_id — effectively unique per downvote; a same-post collision would
  // hit the payment_id PK and the user retries. (Date.now() overflows Int4.)
  const nonce = randomInt(0, 0x7fffffff)
  const { integratedAddress, paymentId } = makeDownvoteAddress(parseInt(id), nonce)

  // Register the lws tx-confirmation webhook BEFORE the pid-map row (spec,
  // Error handling): a webhook matching no pid map is a 200 no-op, but a pid
  // map without a webhook silently degrades to the slower poll backstop.
  // Identical to the wallet-less tip registration (api/resolvers/monero.js).
  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: process.env.PLATFORM_REWARDS_ADDRESS,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

  // Recorded outside the PayIn transaction (mirrors how itemCreate reserves a
  // fee subaddress in getInitial): an orphaned row on a later PayIn failure is
  // harmless — it expires in 24h, never consumed.
  await models.downvotePidMap.create({
    data: {
      paymentId,
      postId: parseInt(id),
      nonce,
      userId: me.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      consumedAt: null,
      webhookEventId: webhook.event_id || null
    }
  })

  const moneroUri = buildMoneroUri(
    [{ address: integratedAddress, amount }],
    { description: 'StasherNews downvote' }
  )

  return {
    payInType: 'DOWNVOTE',
    userId: me.id,
    piconeros: 0n,
    moneroUri,
    paymentId,
    itemPayIn: { itemId: parseInt(id) }
  }
}

export async function onRetry (tx, oldPayInId) {
  const { itemId, payIn } = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  const item = await getItemResult(tx, { id: itemId })
  return { id: item.id, path: item.path, piconeros: payIn.piconeros, act: 'DONT_LIKE_THIS' }
}

export async function onBegin (tx, payInId, payInArgs) {
  const item = await getItemResult(tx, { id: payInArgs.id })
  return { id: item.id, path: item.path, piconeros: BigInt(payInArgs.piconeros), act: 'DONT_LIKE_THIS' }
}

// Intentionally a no-op. With piconeros=0n the PayIn is PAID at creation time, so
// onPaid fires immediately during begin(). Applying the ranking penalty here
// would penalise the item BEFORE the downvote is actually paid on-chain. The
// real penalty is applied by the rewardsWalletObserver (Task 4) when it observes the
// payment as an ObservedDownvote.
export async function onPaid (tx, payInId) {
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { itemPayIn: true } })
  return `SN: downvote #${payIn.itemPayIn.itemId}`
}
