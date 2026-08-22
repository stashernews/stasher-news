import { PrismaClient, Prisma } from '@prisma/client'
import { applyTipDetected } from '@/api/monero/ranking'
import { lwsClient } from '@/api/monero/lwsClient'
import { notifyNewStreak } from '@/lib/webPush'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { moneroWebhooksReceivedTotal } from '@/lib/metrics'
import { alert } from '@/lib/alert'
import { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros } from '@/api/monero/bountyFunding'
import { applyDownvotePenalty } from '@/api/monero/downvote'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { flipPendingToLive, applyBoostDetected } from '@/worker/rewardsWalletObserver'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { safeEqual } from '@/lib/domains/auth'

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
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})

  // monero-lws delivers the auth token in the JSON body ("token" field), not a
  // header; keep x-lws-token as a compat fallback. Fail closed when neither matches.
  const headerToken = req.headers && req.headers['x-lws-token']
  const expected = process.env.LWS_WEBHOOK_TOKEN
  if (!expected) {
    // Fail closed: an unconfigured token must never accept money-moving callbacks.
    // (Task 2's validator makes this unreachable in prod; this is the belt-and-suspenders.)
    if (process.env.NODE_ENV === 'production') return res.status(401).end()
    // dev convenience: no token configured -> open
  } else if (!safeEqual(headerToken, expected) && !safeEqual(body.token, expected)) {
    return res.status(401).end()
  }

  moneroWebhooksReceivedTotal.inc()

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
      await models.$transaction(async (tx) => {
        // Atomic conditional claim: only the first claimer (us or the confirmFinalizer
        // backstop, or a retried lws callback) wins. A retried callback for an already-
        // CONFIRMED tip loses the claim (state no longer DETECTED) and is a no-op, so
        // stackedPiconeros is never double-credited. Mirrors the PENDING->DETECTED guard.
        const claimed = await tx.$executeRaw`
          UPDATE "ObservedTip"
          SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
          WHERE id = ${tip.id} AND state = 'DETECTED'`
        if (claimed > 0 && tip.recipientAccount?.label !== 'platform_rewards' && tip.post?.userId != null) {
          await tx.user.update({
            where: { id: tip.post.userId },
            data: { stackedPiconeros: { increment: tip.piconeros } }
          })
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      // Verified-badge graduation check: a tip that crosses the reputation
      // threshold may newly qualify the author. No-op unless all conditions met.
      if (tip.recipientAccount?.label !== 'platform_rewards') {
        try {
          await maybeGrantVerifiedBadge(models, tip.post.userId)
        } catch (err) {
          console.error('verified badge check failed (webhook):', err)
        }
      }
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
  // mapped through the BountyPidMap). Unknown ids (no ObservedBounty row) are a
  // 200 no-op — lws retries would otherwise pile up for foreign payments.
  //
  // The pid-map liveness gate guards ONLY the PENDING -> DETECTED claim: only a
  // LIVE (unconsumed, unexpired) pid map can authorize the initial funding claim
  // (a consumed map = funding already detected; an expired map = 24h pid expiry,
  // the author may have re-minted). The pid map is consumed at DETECTED, so the
  // subsequent 1-conf .. N-conf callbacks that drive DETECTED -> CONFIRMED
  // (driveBountyFunding) and backfill height MUST NOT be gated on a live pid map
  // — otherwise the N-conf CONFIRMED callback is unreachable and the funding
  // stays stuck at DETECTED forever (the bug behind item 2808). Once DETECTED,
  // idempotency is handled by the CONFIRMED state guard (no-op) + the
  // FeeObservation ON CONFLICT, not by the pid map.
  const bounty = await models.observedBounty.findFirst({ where: { paymentId } })
  // A missing bounty row falls through to the downvote branch below (dv:
  // pids are never ObservedBounty rows); only an already-CONFIRMED bounty
  // short-circuits here.
  if (bounty?.state === 'CONFIRMED') return res.status(200).end()

  if (bounty?.state === 'PENDING') {
    // Only a LIVE pid map can claim a PENDING bounty (double-funding protection).
    const pidMap = await models.bountyPidMap.findFirst({
      where: { paymentId, consumedAt: null, expiresAt: { gt: new Date() } }
    })
    if (!pidMap) return res.status(200).end()

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
        // first funding receipt: seeds the cumulative total (idempotent)
        await recordBountyReceipt(tx, bounty, { txHash, piconeros, height })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return res.status(200).end()
  }

  if (bounty?.state === 'DETECTED' && confirmations >= REQUIRED_CONFIRMATIONS) {
    let funded = false
    await models.$transaction(async (tx) => {
      const cumulative = await recordBountyReceipt(tx, bounty, { txHash, piconeros: BigInt(amount || '0'), height })
      const expected = await bountyExpectedPiconeros(tx, bounty)
      if (cumulative >= expected) {
        funded = await driveBountyFunding(tx, bounty, { txHash, height, confirmations, piconeros: cumulative })
      } else {
        // short: keep DETECTED (top-up-able), just advance confirmations
        await tx.observedBounty.update({ where: { id: bounty.id }, data: { confirmations } })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (funded && bounty.webhookEventId) {
      try {
        await monero.deleteWebhook(bounty.webhookEventId)
      } catch (err) {
        console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
      }
    }
    return res.status(200).end()
  }

  if (bounty?.state === 'DETECTED') {
    await models.$transaction(async (tx) => {
      await recordBountyReceipt(tx, bounty, { txHash, piconeros: BigInt(amount || '0'), height })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(err =>
      console.warn(`webhook: bounty receipt record failed (best-effort): ${err && err.message}`))
    const data = { confirmations }
    if (height != null) data.height = height
    if (txHash) data.txHash = txHash
    await models.observedBounty.update({
      where: { id: bounty.id },
      data
    })
  }

  // A payment landed on an ABANDONED bounty's pid after the 7-day window: the
  // escrow holds it but the funding is dead. Record the receipt (ledger
  // visibility) and page the operators — manual reconciliation required.
  if (bounty?.state === 'EXPIRED') {
    const piconeros = BigInt(amount || '0')
    await models.$transaction(async (tx) => {
      await recordBountyReceipt(tx, bounty, { txHash, piconeros, height })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(err =>
      console.warn(`webhook: abandoned-bounty receipt record failed (best-effort): ${err && err.message}`))
    alert('critical', 'payment arrived after bounty abandonment',
      `bounty item ${bounty.postId}: ${piconeros} piconeros arrived after the underfunded bounty was abandoned; manual reconciliation required`,
      { dedupeKey: `bounty-late-payment-${bounty.postId}` })
    return res.status(200).end()
  }

  // Turf-owner fee branch ("fee:" namespace): owner-routed posting/comment
  // fees and boosts pay the OWNER's wallet at an integrated address whose
  // embedded pid is stored on the PayIn (unique reverse map). One receipt row
  // per tx (top-ups share the pid, not the txHash): @@unique(txHash, paymentId)
  // + ON CONFLICT DO NOTHING make replays and retried callbacks no-ops. The
  // cumulative gate mirrors the observer's subaddress gate: the gated Item
  // flips live only once receipts cover the URI's quoted amount.
  // Unknown pids: 200 no-op (lws retry hygiene).
  const feePayIn = await models.payIn.findUnique({ where: { moneroPaymentId: paymentId } })
  if (feePayIn) {
    const piconeros = BigInt(amount || '0')
    const rows = await models.$queryRaw`
      INSERT INTO "ObservedSubFee" ("tx_hash","payment_id","pay_in_id","subName","owner_user_id","piconeros","height","confirmations","state","detected_at")
      SELECT ${txHash}, ${paymentId}, ${feePayIn.id}, m."subName", m."owner_user_id", ${piconeros}, ${height ?? null}, ${confirmations}, 'DETECTED'::"ObservedState", NOW()
      FROM "SubFeePidMap" m WHERE m."payment_id" = ${paymentId}
      ON CONFLICT ("tx_hash","payment_id") DO NOTHING
      RETURNING id`
    const fresh = rows && rows.length > 0

    // Owner-routed boost: the ranking bump fires on a fresh receipt only
    // (a replayed txHash must not re-bump), mirroring the observer.
    if (fresh && feePayIn.payInType === 'BOOST') {
      try {
        await applyBoostDetected(models, feePayIn, piconeros)
      } catch (err) {
        console.error(`webhook: owner-fee boost bump failed for payIn ${feePayIn.id}:`, err?.message || err)
      }
    }

    // Cumulative amount gate (underpayment top-up support) — idempotent flip.
    const expected = feePayIn.moneroUri ? moneroUriAmountPiconeros(feePayIn.moneroUri) : null
    const agg = await models.observedSubFee.aggregate({
      _sum: { piconeros: true },
      where: { payInId: feePayIn.id }
    })
    const cumulative = agg._sum.piconeros ?? 0n
    if (expected === null || cumulative >= expected) {
      await flipPendingToLive(models, feePayIn, cumulative)
    }

    // N-conf maturity of THIS receipt (atomic conditional; replays no-op).
    if (confirmations >= REQUIRED_CONFIRMATIONS) {
      await models.$executeRaw`
        UPDATE "ObservedSubFee"
        SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmed_at" = NOW()
        WHERE "tx_hash" = ${txHash} AND "payment_id" = ${paymentId} AND state = 'DETECTED'`
    }
    return res.status(200).end()
  }

  // Downvote branch: dv:-namespace payment ids reverse-map through the
  // DownvotePidMap (downvotes pay the rewards PRIMARY address + payment id —
  // the same shape as a wallet-less tip). Unknown ids (no map, or a tip/bounty
  // matched above) are a 200 no-op, mirroring the bounty fall-through.
  const dvMap = await models.downvotePidMap.findUnique({ where: { paymentId } })
  if (!dvMap) return res.status(200).end()

  // Post-DETECTED flows are keyed on the ObservedDownvote row, NEVER on
  // pid-map liveness (the item-2808 lesson: the poll backstop may have
  // consumed the map, and gating the N-conf path on it strands the funding).
  const dv = await models.observedDownvote.findFirst({ where: { paymentId } })
  if (dv) {
    if (dv.state === 'CONFIRMED') return res.status(200).end()

    if (dv.state === 'DETECTED' && confirmations >= REQUIRED_CONFIRMATIONS) {
      // Atomic conditional claim: race-safe vs confirmFinalizer's flip — a
      // loser (either side) sees rowCount 0 and is a no-op.
      const claimed = await models.$executeRaw`
        UPDATE "ObservedDownvote"
        SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
        WHERE id = ${dv.id} AND state = 'DETECTED'`
      if (claimed > 0 && dvMap.webhookEventId) {
        try {
          await monero.deleteWebhook(dvMap.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (dv.state === 'DETECTED') {
      const data = { confirmations }
      if (height != null) data.height = height
      await models.observedDownvote.update({ where: { id: dv.id }, data })
    }
    return res.status(200).end()
  }

  // 0-conf detection (mempool — height NULL on the callback). Only a LIVE
  // (unconsumed, unexpired) pid map may claim; the atomic conditional consume
  // makes retried callbacks and a raced poll attribution no-ops.
  const claimedMap = await models.$executeRaw`
    UPDATE "DownvotePidMap"
    SET "consumedAt" = NOW()
    WHERE "paymentId" = ${paymentId} AND "consumedAt" IS NULL AND "expiresAt" > NOW()`
  if (claimedMap === 0) return res.status(200).end()

  const piconeros = BigInt(amount || '0')
  await models.$transaction(async (tx) => {
    // Idempotent vs the observer poll backstop: the unique (txHash, paymentId)
    // constraint + RETURNING mean the penalty fires exactly once regardless of
    // which side wins the race.
    const rows = await tx.$queryRaw`
      INSERT INTO "ObservedDownvote" ("txHash","postId","downvoterId","paymentId","piconeros","height","state","detectedAt")
      VALUES (${txHash}, ${dvMap.postId}, ${dvMap.userId}::INT, ${paymentId}, ${piconeros}, ${height ?? null}, 'DETECTED'::"ObservedState", NOW())
      ON CONFLICT ("txHash","paymentId") DO NOTHING
      RETURNING id`
    if (!rows || rows.length === 0) return
    const item = await tx.item.findUnique({ where: { id: dvMap.postId } })
    if (item) {
      try {
        await applyDownvotePenalty(tx, item, dvMap.userId, piconeros)
      } catch (err) {
        // Don't fail the callback on a ranking-CTE failure; the ObservedDownvote
        // row already records the downvote (same posture as the observer).
        console.error(`webhook: downvote penalty failed for post ${dvMap.postId}:`, err?.message || err)
      }
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

  return res.status(200).end()
}

// driveBountyFunding/recordBountyReceipt/bountyExpectedPiconeros live in
// api/monero/bountyFunding.js (shared with the confirmFinalizer backstop).
// Re-exported here so existing callers/tests that import from the webhook
// module keep working.
export { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros } from '@/api/monero/bountyFunding'

export default function handler (req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  handleWebhook(req, res)
}
