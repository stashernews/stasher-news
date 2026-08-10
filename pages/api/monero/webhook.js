import { PrismaClient, Prisma } from '@prisma/client'
import { applyTipDetected } from '@/api/monero/ranking'
import { lwsClient } from '@/api/monero/lwsClient'
import { notifyNewStreak } from '@/lib/webPush'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { bountyFeePiconeros } from '@/api/monero/bounties'
import { moneroWebhooksReceivedTotal } from '@/lib/metrics'

// lws tx-confirmation webhook receiver (spec §4.4).
//
// lws pushes callbacks at 0-conf (detection) and at each subsequent
// confirmation up to the requested ceiling. The receiver drives the
// ObservedTip state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx, bump Item.msats)
//   DETECTED -> CONFIRMED (N-conf callback: bump User.stackedPiconeros)
//
// Payment IDs that match no tip ("bn:" bounty namespace) fall through to the
// bounty branch, which drives the ObservedBounty state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx/height/actual piconeros,
//                          consume the BountyPidMap)
//   DETECTED -> CONFIRMED (N-conf callback: flip Item to FUNDED with the
//                          actual on-chain amount, book the BOUNTY_FEE ledger
//                          row — see driveBountyFunding)
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

  moneroWebhooksReceivedTotal.inc()

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
  const { payment_id: paymentId, confirmations = 0, tx_info: txInfo = {} } = body
  const { tx_hash: txHash, block: height, amount } = txInfo

  if (!paymentId) return res.status(200).end()

  const tip = await models.observedTip.findFirst({
    where: { paymentId },
    include: { post: { select: { userId: true } }, recipientAccount: { select: { label: true, ownerUserId: true } } }
  })
  if (tip) {
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
            const [coin] = await tx.$queryRaw`
              INSERT INTO "Streak" ("userId", "startedAt", "type", created_at, updated_at)
              SELECT ${tip.tipperId}::int, NOW(), 'COIN'::"StreakType", now_utc(), now_utc()
              WHERE NOT EXISTS (
                SELECT 1 FROM "Streak"
                WHERE "userId" = ${tip.tipperId}::int AND type = 'COIN' AND "endedAt" IS NULL
              )
              RETURNING "Streak".*`
            if (coin) notifyNewStreak(tip.tipperId, coin).catch(console.error)
          }
          const recipientUserId = tip.recipientAccount?.ownerUserId
          if (recipientUserId != null) {
            await tx.$executeRaw`
              INSERT INTO pgboss.job (id, name, data)
              VALUES (gen_random_uuid(), 'checkStreak', jsonb_build_object('id', ${recipientUserId}, 'type', 'FLAME'))`
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
        // Skip the author lifetime-received denorm when the tip went to the
        // rewards pool (wallet-less author) — nobody was paid, so there is no
        // recipient to credit. The ranking bump (Item.piconeros) already ran at
        // DETECTION and is unaffected.
        if (tip.recipientAccount?.label !== 'platform_rewards') {
          await tx.user.update({
            where: { id: tip.post.userId },
            data: { stackedPiconeros: { increment: tip.piconeros } }
          })
        }
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

  // Bounty funding branch (A-13): no tip matched the payment id, so this may
  // be a funding into the bounty ESCROW wallet ("bn:" namespace, reverse
  // mapped through the BountyPidMap). Unknown ids (tip or bounty) are a 200
  // no-op — lws retries would otherwise pile up for foreign payments.
  const pidMap = await models.bountyPidMap.findUnique({ where: { paymentId } })
  if (!pidMap) return res.status(200).end()

  const bounty = await models.observedBounty.findFirst({ where: { paymentId } })
  if (!bounty || bounty.state === 'CONFIRMED') return res.status(200).end()

  if (bounty.state === 'PENDING') {
    const piconeros = BigInt(amount || '0')
    await models.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "ObservedBounty"
        SET state = 'DETECTED', "txHash" = ${txHash},
            height = ${height ?? null}, piconeros = ${piconeros}, confirmations = ${confirmations}
        WHERE id = ${bounty.id} AND state = 'PENDING'`
      if (claimed > 0) {
        // Consume the pid map at DETECTED: the funding is on chain, so the
        // payment id can never fund a second bounty. A retried callback loses
        // the claim (state is no longer PENDING) and stays a no-op.
        await tx.bountyPidMap.update({
          where: { paymentId },
          data: { consumedAt: new Date() }
        })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return res.status(200).end()
  }

  if (bounty.state === 'DETECTED' && confirmations >= REQUIRED_CONFIRMATIONS) {
    await models.$transaction(async (tx) => {
      await driveBountyFunding(tx, bounty, { txHash, height, confirmations, piconeros: BigInt(amount || '0') })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (bounty.webhookEventId) {
      try {
        await monero.deleteWebhook(bounty.webhookEventId)
      } catch (err) {
        console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
      }
    }
    return res.status(200).end()
  }

  if (bounty.state === 'DETECTED') {
    const data = { confirmations }
    if (height != null) data.height = height
    if (txHash) data.txHash = txHash
    await models.observedBounty.update({
      where: { id: bounty.id },
      data
    })
  }

  return res.status(200).end()
}

// Bounty funding CONFIRMED path (A-13). Runs inside the caller's Serializable
// transaction so the three writes commit together:
//   1. ObservedBounty -> CONFIRMED (confirmedAt, height, confirmations)
//   2. Item -> FUNDED with bountyPiconeros = observed − fee (the payer may have
//      sent more or less than expected; the fee piconeros stay in escrow until
//      disposition, so the signer can always zero the escrow exactly) +
//      bountyConfirmedAt
//   3. FeeObservation('BOUNTY_FEE') born CONFIRMED at the funding height,
//      computed via bountyFeePiconeros from the observed amount — the fee is
//      100% ops and books into the rewards pool ledger at funding time.
// The ON CONFLICT (txHash, recipientMajor, recipientMinor) makes a retried
// callback idempotent even if the row-level state guard was somehow bypassed.
// Exported for tests (drive the CONFIRMED branch without fabricating an lws
// callback).
export async function driveBountyFunding (tx, bounty, { txHash, height, confirmations, piconeros }) {
  const data = { state: 'CONFIRMED', confirmations, confirmedAt: new Date(), height }
  if (txHash) data.txHash = txHash
  await tx.observedBounty.update({
    where: { id: bounty.id },
    data
  })
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  const feePiconeros = bountyFeePiconeros(piconeros, config)
  await tx.item.update({
    where: { id: bounty.postId },
    data: { bountyStatus: 'FUNDED', bountyPiconeros: piconeros - feePiconeros, bountyConfirmedAt: new Date() }
  })
  await tx.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","state","detectedAt","confirmedAt")
    VALUES (${txHash || bounty.txHash}, NULL, 'BOUNTY_FEE'::"FeeType", ${bounty.postId}, NULL, 0, 0, ${feePiconeros}, ${height}, 'CONFIRMED'::"ObservedState", NOW(), NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING`
}

export default function handler (req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  handleWebhook(req, res)
}
