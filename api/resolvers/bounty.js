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

async function assertBountyStatus (models, itemId, expected, label) {
  const item = await models.item.findUnique({ where: { id: Number(itemId) } })
  if (!item) throw new GqlInputError('item not found')
  if (item.bountyStatus !== expected) {
    throw new GqlInputError(`bounty must be ${label} (current: ${item.bountyStatus})`)
  }
  return item
}

export default {
  Mutation: {
    fundBounty: async (parent, { postId }, { me, models, monero }) => {
      return initiateBountyFundingCore({ postId, models, monero, me })
    },

    // Award the bounty to the author of a descendant comment. The winner MUST
    // have a registered wallet (on-chain payout). Status flips to AWARDED at
    // queue time so a concurrent second award can't double-queue.
    payBounty: async (parent, { id, winnerCommentId }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const item = await assertBountyStatus(models, id, 'FUNDED', 'funded')
      if (item.userId !== me.id) throw new GqlInputError('only the bounty author can award it')
      const winner = await models.item.findUnique({ where: { id: Number(winnerCommentId) } })
      if (!winner || winner.rootId !== item.rootId || winner.id === item.id) {
        throw new GqlInputError('award target must be a comment on this bounty post')
      }
      const winnerAccount = await models.moneroAccount.findFirst({ where: { ownerUserId: winner.userId } })
      if (!winnerAccount) throw new GqlInputError('the winner must attach a wallet to receive the bounty')

      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)

      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'AWARDED'
          WHERE id = ${item.id}::int AND "bountyStatus" = 'FUNDED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) {
          throw new GqlInputError('bounty is no longer available to award')
        }
        return tx.bountyPayment.create({
          data: {
            itemId: item.id,
            winnerUserId: winner.userId,
            piconeros: item.bountyPiconeros,
            kind: 'AWARD',
            state: 'QUEUED',
            recipientAddress: winnerAccount.address,
            feePiconeros
          }
        })
      })
    },

    // Reclaim (expired only): escrow -> author.
    reclaimBounty: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const item = await assertBountyStatus(models, id, 'EXPIRED', 'expired')
      if (item.userId !== me.id) throw new GqlInputError('only the bounty author can reclaim')
      const authorAccount = await models.moneroAccount.findFirst({ where: { ownerUserId: me.id } })
      if (!authorAccount) throw new GqlInputError('attach a wallet to reclaim the bounty')
      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'REFUNDED'
          WHERE id = ${item.id}::int AND "bountyStatus" = 'EXPIRED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) throw new GqlInputError('bounty is no longer reclaimable')
        return tx.bountyPayment.create({
          data: {
            itemId: item.id,
            winnerUserId: me.id,
            piconeros: item.bountyPiconeros,
            kind: 'RECLAIM',
            state: 'QUEUED',
            recipientAddress: authorAccount.address,
            feePiconeros
          }
        })
      })
    },

    // Rollover (expired only): full escrow balance -> rewards pool.
    rolloverBounty: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const item = await assertBountyStatus(models, id, 'EXPIRED', 'expired')
      if (item.userId !== me.id) throw new GqlInputError('only the bounty author can roll over')
      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'ROLLED_OVER'
          WHERE id = ${item.id}::int AND "bountyStatus" = 'EXPIRED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) throw new GqlInputError('bounty is no longer available to roll over')
        return tx.bountyPayment.create({
          data: {
            itemId: item.id,
            winnerUserId: me.id,
            piconeros: item.bountyPiconeros + feePiconeros,
            kind: 'ROLLOVER',
            state: 'QUEUED',
            recipientAddress: process.env.PLATFORM_REWARDS_ADDRESS,
            feePiconeros: 0n
          }
        })
      })
    }
  }
}
