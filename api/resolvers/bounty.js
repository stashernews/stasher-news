import { generateBountyPaymentId } from '../monero/paymentId'
import { makeIntegratedAddress } from '../monero/integratedAddress'
import { buildMoneroUri } from '../monero/uri'
import { bountyFeePiconeros } from '../monero/bounties'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { REQUIRED_CONFIRMATIONS, BOUNTY_MIN_PICONEROS } from '@/lib/constants'

// Bounty funding (A-13 Task 3): `fundBounty(postId)` mints a per-bounty
// integrated address on the BOUNTY ESCROW wallet carrying a "bn:" payment id,
// registers the lws tx-confirmation webhook, records the BountyPidMap + a
// PENDING ObservedBounty, and returns a monero: URI paying bounty + fee in one
// transaction. The webhook (pages/api/monero/webhook.js) drives
// PENDING -> DETECTED -> CONFIRMED; on CONFIRMED the Item flips to FUNDED with
// the actual on-chain amount and the platform fee is booked as a BOUNTY_FEE
// FeeObservation (Task 4 settles the escrow and books the fee out).

// Resolve the bounty escrow MoneroAccount (label 'bounty_escrow').
async function getBountyEscrowAccount (models) {
  const net = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  return models.moneroAccount.findFirst({ where: { label: 'bounty_escrow', network: net } })
}

// Core funding logic (testable without GraphQL context). The payer MUST have a
// registered wallet: reclaim attribution (Task 4) repays the funding to the
// wallet owner, so an unattributed funding could not be reclaimed.
export async function initiateBountyFundingCore ({ postId, models, monero, me }) {
  const id = Number(postId)
  const item = await models.item.findUnique({ where: { id } })
  if (!item) throw new GqlInputError('post not found')
  if (item.bountyStatus !== 'UNFUNDED') throw new GqlInputError('bounty is already funded or being funded')
  if (!me) throw new GqlAuthenticationError()

  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')
  if (item.bountyPiconeros < BOUNTY_MIN_PICONEROS) {
    throw new GqlInputError(`bounty below minimum (${BOUNTY_MIN_PICONEROS} piconeros)`)
  }

  const escrow = await getBountyEscrowAccount(models)
  if (!escrow) throw new GqlInputError('bounty escrow wallet not registered')

  const payer = await models.moneroAccount.findFirst({ where: { ownerUserId: me.id } })
  if (!payer) throw new GqlInputError('you must attach a wallet to fund a bounty')

  const nonce = Date.now()
  const paymentId = generateBountyPaymentId(id, nonce)
  const { integratedAddress } = makeIntegratedAddress(escrow.address, paymentId)

  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: escrow.address,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

  const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
  await models.$transaction(async (tx) => {
    await tx.bountyPidMap.create({
      data: { paymentId, postId: id, nonce, userId: me.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
    })
    await tx.observedBounty.create({
      data: {
        txHash: 'pending-' + paymentId,
        postId: id,
        payerId: me.id,
        recipientAccountId: escrow.id,
        paymentId,
        piconeros: item.bountyPiconeros,
        height: null,
        state: 'PENDING',
        webhookEventId: webhook.event_id || null
      }
    })
    await tx.item.update({
      where: { id },
      data: { bountyStatus: 'PENDING_FUNDING' }
    })
  })

  const uri = buildMoneroUri(
    [{ address: integratedAddress, amount: item.bountyPiconeros + feePiconeros }],
    { description: `bounty on "${item.title ?? ''}" via StasherNews`, paymentId }
  )
  return { integratedAddress, paymentId, uri, feePiconeros }
}

export default {
  Mutation: {
    fundBounty: async (parent, { postId }, { me, models, monero }) => {
      return initiateBountyFundingCore({ postId, models, monero, me })
    }
  }
}
