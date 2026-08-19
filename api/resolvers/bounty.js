import { generateBountyPaymentId } from '../monero/paymentId'
import { makeIntegratedAddress } from '../monero/integratedAddress'
import { buildMoneroUri } from '../monero/uri'
import { bountyFeePiconeros } from '../monero/bounties'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
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
  return models.moneroAccount.findFirst({ where: { label: 'bounty_escrow', network: net }, orderBy: { id: 'asc' } })
}

// Core funding logic (testable without GraphQL context). The payer MUST have a
// registered wallet: reclaim attribution (Task 4) repays the funding to the
// wallet owner, so an unattributed funding could not be reclaimed.
export async function initiateBountyFundingCore ({ postId, models, monero, me }) {
  const id = Number(postId)
  const item = await models.item.findUnique({ where: { id } })
  if (!item) throw new GqlInputError('post not found')
  // Only the bounty author may fund it: the payment lands in escrow and every
  // disposition pays the AUTHOR, so a stranger's funding could never be
  // recovered — and a second funder's CONFIRMED would overwrite
  // bountyPiconeros, orphaning the first payment in escrow.
  if (me && item.userId !== me.id) throw new GqlInputError('only the bounty author can fund it')
  if (item.bountyStatus !== 'UNFUNDED' && item.bountyStatus !== 'PENDING_FUNDING') {
    throw new GqlInputError('bounty is already funded or being funded')
  }
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

  // Re-entry: the user closed the funding view before paying and is coming back
  // via the post page. Two payment-resume cases, both returning the SAME
  // integrated address / payment id / URI the first mint produced (a fresh pid
  // would strand the first webhook on a payment id nobody will ever fund). No
  // new pid map, ObservedBounty, or webhook is created in either case.
  //   1. A LIVE (unconsumed, unexpired) BountyPidMap for this post + payer —
  //      the payment has not been observed yet, so the webhook registered at
  //      the first mint still watches this payment id. A PENDING ObservedBounty
  //      always coexists with an unconsumed pid map, so this lookup covers
  //      every PENDING resume — a PENDING row left behind an EXPIRED map (the
  //      webhook's expiresAt guard rejects late arrivals) carries a stale pid
  //      that can never be resumed and must not block a fresh mint.
  //   2. A DETECTED ObservedBounty for this post + payer — the pid map was
  //      CONSUMED at webhook DETECTED, so the payment already landed and is
  //      awaiting REQUIRED_CONFIRMATIONS. Re-minting here would let the author
  //      pay twice for one bounty (escrow overfunded, bountyPiconeros
  //      overwritten by the later confirm).
  // Only when neither a live pid map nor a DETECTED observation exists (truly
  // stale: 24h pid expiry with no payment) does the branch fall through to the
  // fresh-initiation path below; the item stays PENDING_FUNDING either way.
  // Quotes the funding URI. When a partial payment is already in flight
  // (receivedPiconeros > 0), quote only the REMAINDER so a top-up completes
  // the funding instead of overfunding the escrow. Also reports
  // received/expected so the client can render the underpayment hint.
  const buildFundingInfo = (paymentId, receivedPiconeros = 0n) => {
    const { integratedAddress } = makeIntegratedAddress(escrow.address, paymentId)
    const feePiconeros = bountyFeePiconeros(item.bountyPiconeros, config)
    const expectedPiconeros = item.bountyPiconeros + feePiconeros
    const remaining = expectedPiconeros - receivedPiconeros
    const amount = remaining > 0n ? remaining : expectedPiconeros
    const uri = buildMoneroUri(
      [{ address: integratedAddress, amount }],
      { description: `bounty on "${item.title ?? ''}" via StasherNews` }
    )
    return { integratedAddress, paymentId, uri, feePiconeros, receivedPiconeros, expectedPiconeros }
  }
  if (item.bountyStatus === 'PENDING_FUNDING') {
    const live = await models.bountyPidMap.findFirst({
      where: { postId: id, userId: me.id, consumedAt: null, expiresAt: { gt: new Date() } }
    })
    if (live) return buildFundingInfo(live.paymentId)

    const inflight = await models.observedBounty.findFirst({
      where: { postId: id, payerId: me.id, state: 'DETECTED' },
      orderBy: { id: 'desc' }
    })
    if (inflight) return buildFundingInfo(inflight.paymentId, inflight.piconeros)
  }

  const nonce = Date.now()
  const paymentId = generateBountyPaymentId(id, nonce)

  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: escrow.address,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

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

  return buildFundingInfo(paymentId)
}

async function assertBountyStatus (models, itemId, expected, label) {
  const item = await models.item.findUnique({ where: { id: Number(itemId) } })
  if (!item) throw new GqlInputError('item not found')
  if (item.bountyStatus !== expected) {
    throw new GqlInputError(`bounty must be ${label} (current: ${item.bountyStatus})`)
  }
  return item
}

// Disposition fee = the fee BOOKED at funding confirmation (the BOUNTY_FEE
// FeeObservation driveBountyFunding created), not a recomputation on the
// already-fee-deducted bounty: f(booked) is a fee on a fee and never equals the
// booked fee, so it leaves a residual orphaned in escrow (e.g. 5227: booked fee
// 0.0024 but f(0.0096) = 0.00192 → 0.00048 stuck). Settling the booked fee
// makes payout total = escrow received, so the signer zeroes the escrow exactly
// for every funded bounty. Falls back to the formula (status quo) when the
// ledger row is missing (hand-seeded items) and flags it for reconciliation.
async function bookedBountyFeePiconeros (models, itemId, bookedPiconeros, config) {
  const row = await models.feeObservation.findFirst({
    where: { postId: itemId, feeType: 'BOUNTY_FEE' },
    orderBy: { id: 'asc' }
  })
  if (row) return row.piconeros
  logError({ itemId }, 'bookedBountyFeePiconeros: BOUNTY_FEE ledger row missing — fell back to formula fee; escrow may not zero exactly')
  alert('critical', 'missing BOUNTY_FEE ledger row',
    `bounty item ${itemId} has no BOUNTY_FEE FeeObservation at disposition; formula fee used, escrow may not zero exactly; manual reconciliation required`,
    { dedupeKey: `bounty-missing-fee-row-${itemId}` })
  return bountyFeePiconeros(bookedPiconeros, config)
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
      if (!winner || winner.id === item.id || winner.rootId !== (item.rootId ?? item.id)) {
        throw new GqlInputError('award target must be a comment on this bounty post')
      }
      // No self-awards and no awards on deleted comments (upstream precedent:
      // 'cannot pay bounty to yourself' + 'item is deleted').
      if (winner.userId === me.id) throw new GqlInputError('you cannot award your own comment')
      if (winner.deletedAt) throw new GqlInputError('award target comment was deleted')
      const winnerAccount = await models.moneroAccount.findFirst({ where: { ownerUserId: winner.userId } })
      if (!winnerAccount) throw new GqlInputError('the winner must attach a wallet to receive the bounty')

      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })

      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'AWARDED', "bountyWinnerCommentId" = ${winner.id}::int
          WHERE id = ${item.id}::int AND "bountyStatus" = 'FUNDED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) {
          throw new GqlInputError('bounty is no longer available to award')
        }
        const feePiconeros = await bookedBountyFeePiconeros(tx, item.id, item.bountyPiconeros, config)
        await tx.item.update({
          where: { id: winner.id },
          data: { bountyAwardedAt: new Date() }
        })
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
      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'REFUNDED'
          WHERE id = ${item.id}::int AND "bountyStatus" = 'EXPIRED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) throw new GqlInputError('bounty is no longer reclaimable')
        const feePiconeros = await bookedBountyFeePiconeros(tx, item.id, item.bountyPiconeros, config)
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
      return await models.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw`
          UPDATE "Item" SET "bountyStatus" = 'ROLLED_OVER'
          WHERE id = ${item.id}::int AND "bountyStatus" = 'EXPIRED'
          RETURNING id::int AS id`
        if (!claimed || claimed.length === 0) throw new GqlInputError('bounty is no longer available to roll over')
        // Full escrow balance = booked bounty + booked fee (= the funding
        // observed amount), so the escrow zeroes exactly.
        const feePiconeros = await bookedBountyFeePiconeros(tx, item.id, item.bountyPiconeros, config)
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
  },
  Item: {
    // A-13 award indication: one join per bounty post (post pages only —
    // the fragment places this field on the post, never on feed items).
    bountyWinnerName: async (item, args, { models }) => {
      if (!item.bountyWinnerCommentId) return null
      const winner = await models.item.findUnique({
        where: { id: item.bountyWinnerCommentId },
        include: { user: { select: { name: true } } }
      })
      return winner?.user?.name ?? null
    }
  }
}
