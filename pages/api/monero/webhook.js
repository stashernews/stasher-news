import { PrismaClient, Prisma } from '@prisma/client'
import { applyTipDetected } from '@/api/monero/ranking'
import { lwsClient } from '@/api/monero/lwsClient'
import { notifyNewStreak } from '@/lib/webPush'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { moneroWebhooksReceivedTotal } from '@/lib/metrics'
import { alert } from '@/lib/alert'
import { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros } from '@/api/monero/bountyFunding'
import { applyDownvotePenalty } from '@/api/monero/downvote'
import { shouldExcludeTip, resolveItemSubName, lookupTipTx, recheckDetectedTip } from '@/api/monero/selfTip'
import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'
import { parsePiconeros, verifyReceiptAmount, ReceiptLookupError } from '@/api/monero/receiptVerification'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { safeEqual } from '@/lib/domains/auth'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

// lws tx-confirmation webhook receiver (spec §4.4).
//
// lws pushes callbacks at 0-conf (detection) and at each subsequent
// confirmation up to the requested ceiling. The receiver drives the
// ObservedTip state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx, bump Item.msats)
//   DETECTED -> CONFIRMED (N-conf callback: bump User.stackedPiconeros)
//
// Self-tip exclusion (spec §2.3) runs at the 0-conf claim AND is re-run once
// the tx is mined: lws cannot report spent_outputs for a mempool tx, so the
// 0-conf self-send check can fail open. recheckDetectedTip re-runs it at the
// first callback carrying a block height and at the N-conf claim (before any
// author credit) — reversing the provisional ranking delta when a wash tip is
// caught late. The same re-check binds the STORED amount/txHash to the chain
// tx (CHAIN_MISMATCH), closing the credit path for DETECTED rows forged
// through the pre-verification webhook.
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

  // Returns the verdict on success, or null after responding (503 retry for a
  // transient lookup failure, 200 no-op for an unverifiable/mismatched receipt).
  async function verifyOrReject ({ account, paymentId, piconeros, txHash, tx = null, context }) {
    let verdict
    try {
      verdict = await verifyReceiptAmount({ models, monero, account, paymentId, piconeros, txHash, tx })
    } catch (err) {
      if (err instanceof ReceiptLookupError) {
        res.status(503).end()
        return null
      }
      throw err
    }
    if (!verdict.ok) {
      alert('warn', 'webhook receipt rejected',
        `${context}: ${verdict.reason} for paymentId ${paymentId} (callback ${piconeros})`,
        { dedupeKey: `webhook-reject-${paymentId}-${verdict.reason}` })
      res.status(200).end()
      return null
    }
    return verdict
  }

  const { payment_id: paymentId, confirmations = 0, tx_info: txInfo = {} } = body
  const { tx_hash: txHash, block: height, amount } = txInfo

  if (!paymentId) return res.status(200).end()

  const tip = await models.observedTip.findFirst({
    where: { paymentId },
    include: {
      post: { select: { userId: true } },
      recipientAccount: {
        // id is required by lookupTipTx's cursor advance (WHERE id = ...);
        // viewKey/status gate the scan, subaddresses feed isSelfSend.
        select: { id: true, label: true, ownerUserId: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    }
  })
  if (tip) {
    if (tip.state === 'CONFIRMED') return res.status(200).end()

    if (tip.state === 'EXCLUDED') {
      // Retried lws callbacks for an excluded tip: terminal state, nothing to do.
      if (tip.webhookEventId) {
        try {
          await monero.deleteWebhook(tip.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (tip.state === 'REORGED') {
      // Terminal: the reverseStaleDetections sweep reversed this tip (double-spend
      // or mempool eviction). Retried/late callbacks are no-ops; best-effort
      // webhook delete (the sweep already tried once).
      if (tip.webhookEventId) {
        try {
          await monero.deleteWebhook(tip.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (tip.state === 'PENDING') {
      const piconeros = parsePiconeros(amount)
      if (piconeros == null) {
        alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
        return res.status(200).end()
      }
      // Self-tip exclusion (spec §2.3): direct self-tip is a free check from
      // data in hand; the self-send check scans the recipient account via lws
      // (tip callbacks are low-frequency). Fail closed on lws errors: a non-200
      // makes lws retry, and reconcilePendingTips is the backstop.
      const direct = tip.tipperId != null && tip.tipperId === tip.post.userId
      let selfSend = false
      let selfSendTx = null
      if (!direct && tip.recipientAccount?.viewKey && tip.recipientAccount?.status === 'ACTIVE') {
        // Incremental scan via the account's lastTxId cursor + full-scan
        // fallback — see lookupTipTx (api/monero/selfTip.js). A mempool tx
        // carries no spent_outputs yet, so this 0-conf check can fail open;
        // recheckDetectedTip re-runs it once the tx is mined.
        const account = tip.recipientAccount
        const tx = await lookupTipTx(models, monero, account, paymentId)
        selfSendTx = tx
        selfSend = shouldExcludeTip({ tipperId: tip.tipperId, postUserId: tip.post.userId, account, tx })
      }
      if (direct || selfSend) {
        const exclusionReason = direct ? 'DIRECT_SELF_TIP' : 'SELF_SEND'
        await models.$transaction(async (tx) => {
          const claimed = await tx.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'EXCLUDED', "exclusionReason" = ${exclusionReason}::"TipExclusionReason",
                "txHash" = ${txHash}, height = ${height ?? null},
                piconeros = ${piconeros}, confirmations = ${confirmations}
            WHERE id = ${tip.id} AND state = 'PENDING'`
          if (claimed > 0) {
            const subName = await resolveItemSubName(tip.postId, tx)
            await tx.abuseSignal.create({
              data: {
                kind: direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED',
                subjectUserId: tip.post.userId,
                actorUserId: tip.tipperId ?? null,
                tipId: tip.id,
                postId: tip.postId,
                subName,
                piconeros,
                txHash: txHash ?? 'unknown',
                paymentId,
                details: direct ? undefined : { note: 'amount recorded as lws reported it (change-output inflation possible)' }
              }
            })
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        if (tip.webhookEventId) {
          try {
            await monero.deleteWebhook(tip.webhookEventId)
          } catch (err) {
            console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
          }
        }
        return res.status(200).end()
      }
      // Chain verification before the DETECTED claim (C4): bind the callback
      // amount/txHash to the lws-reported tx. Reuses the self-send scan's tx
      // when the scan ran, so a scannable account costs one lws lookup per
      // callback. A mempool tx_not_found here is a 200 no-op (detection is
      // deferred to the next callback / reconcilePendingTips backstop) — a
      // real payment is never credited while unverified and never lost.
      const verdict = await verifyOrReject({
        account: tip.recipientAccount,
        paymentId,
        piconeros,
        txHash,
        tx: selfSendTx,
        context: `tip ${tip.id} detection`
      })
      if (!verdict) return
      await models.$transaction(async (tx) => {
        const claimed = await tx.$executeRaw`
          UPDATE "ObservedTip"
          SET state = 'DETECTED', "txHash" = ${txHash},
              height = ${height ?? null}, piconeros = ${piconeros}, confirmations = ${confirmations}
          WHERE id = ${tip.id} AND state = 'PENDING'`
        if (claimed > 0) {
          const rankDelta = await applyTipDetected(tip.postId, tip.tipperId, piconeros, tx)
          // Persist the applied rank delta for exact reorg reversal (spec §4.3).
          await tx.$executeRaw`
            UPDATE "ObservedTip" SET "rankPiconeros" = ${rankDelta}
            WHERE id = ${tip.id} AND state = 'DETECTED'`
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
      const piconeros = parsePiconeros(amount)
      if (piconeros == null) {
        alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
        return res.status(200).end()
      }
      // Chain verification before the credit (C4): re-bind the callback to the
      // lws-reported tx. The verified tx is threaded into the confirm-time
      // re-check so the branch costs one lws lookup per callback. The credit
      // below uses the STORED tip.piconeros — callback-vs-chain binding alone
      // does NOT vouch for it (a legacy DETECTED row forged through the
      // pre-verification webhook carries a stored amount no callback ever
      // reported), so recheckDetectedTip additionally binds the STORED
      // amount/txHash to the same chain tx and excludes on mismatch.
      const verdict = await verifyOrReject({
        account: tip.recipientAccount,
        paymentId,
        piconeros,
        txHash,
        context: `tip ${tip.id} confirmation`
      })
      if (!verdict) return
      // Confirm-time re-check before the credit: the self-send 0-conf scan
      // could not see spent_outputs for the mempool tx (fail-open), but the
      // tx is mined now, so the evidence exists; the same check binds the
      // stored amount/hash (CHAIN_MISMATCH). This is the last gate —
      // confirmFinalizer races us for this claim and runs the same check, so
      // whichever claims first, a wash or forged tip is never credited.
      // Unscannable accounts still fail open.
      const excluded = await recheckDetectedTip({ models, monero, tip, confirmations, prefetchedTx: verdict.tx ?? null })
      if (excluded) {
        if (tip.webhookEventId) {
          try {
            await monero.deleteWebhook(tip.webhookEventId)
          } catch (err) {
            console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
          }
        }
        return res.status(200).end()
      }
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
      // First mined sighting: the row still carries no height, so no callback
      // has re-run the self-send check since the 0-conf scan failed open. Run
      // it now (the tx is mined — spent_outputs exist) to cut the provisional
      // wash-credit window from ~REQUIRED_CONFIRMATIONS blocks to ~1. Later
      // intermediate callbacks (height already on the row) skip the rescan;
      // the N-conf branch re-checks regardless as the final gate.
      if (tip.height == null && height != null) {
        const excluded = await recheckDetectedTip({ models, monero, tip, confirmations, height })
        if (excluded) {
          if (tip.webhookEventId) {
            try {
              await monero.deleteWebhook(tip.webhookEventId)
            } catch (err) {
              console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
            }
          }
          return res.status(200).end()
        }
      }
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
  const bounty = await models.observedBounty.findFirst({
    where: { paymentId },
    include: {
      recipientAccount: {
        // C5 receipt verification: viewKey/status gate the scan, lastTxId +
        // subaddresses feed lookupTipTx's cursor advance and pid matching;
        // label gates lookupTipTx's rewards-account advance skip.
        select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    }
  })
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

    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the PENDING -> DETECTED claim (C5): bind the
    // callback amount/txHash to the lws-reported tx on the ESCROW account —
    // a token-holding replay with a fabricated amount must never seed a
    // receipt nor consume the pid map. Unscannable accounts skip (fail-open).
    if (!(await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`
    }))) return
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
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the cumulative funding transaction (C5): the
    // top-up sum gates the FUNDED flip, so every receipt feeding it must be
    // bound to the lws-reported tx — same fail-open skip for unscannable
    // escrow accounts, same 503/reject semantics as the tip branch (C4).
    if (!(await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`
    }))) return
    let funded = false
    await models.$transaction(async (tx) => {
      const cumulative = await recordBountyReceipt(tx, bounty, { txHash, piconeros, height })
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
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the sub-conf receipt (C5.1): these callbacks
    // feed the same cumulative sum that gates the FUNDED flip, so a replayed
    // callback with a fabricated amount must never seed a receipt nor
    // overwrite the row's txHash/height/confirmations.
    if (!(await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`
    }))) return
    await models.$transaction(async (tx) => {
      await recordBountyReceipt(tx, bounty, { txHash, piconeros, height })
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
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the abandoned-bounty receipt (C5): even a
    // ledger-visibility row must carry a chain-verified amount, or a replayed
    // callback could fabricate escrow balances for manual reconciliation.
    if (!(await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`
    }))) return
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
  // embedded pid is stored on the PayIn (unique reverse map). Receipt insert,
  // boost bump, cumulative amount gate, and N-conf maturity live in the
  // shared applier (api/monero/subFeeObservation.js) — idempotent by
  // construction (one receipt row per tx via @@unique(txHash, paymentId) +
  // ON CONFLICT DO NOTHING). Unknown pids: 200 no-op (lws retry hygiene).
  const feePayIn = await models.payIn.findUnique({ where: { moneroPaymentId: paymentId } })
  // Owner attribution for both fee paths below: the pid map is created for
  // every owner-routed leg (api/monero/ownerFeeLeg.js), so its ownerUserId is
  // the only way to resolve the account whose view key can verify the receipt.
  // Fetched once here and shared — no duplicate lookup in the abandoned path.
  const feeMapRow = await models.subFeePidMap.findUnique({ where: { paymentId } })
  if (feePayIn) {
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the receipt insert (C6): bind the callback
    // amount/txHash to the lws-reported tx on the OWNER's account — a
    // token-holding replay with a fabricated amount must never seed a receipt
    // nor open the cumulative live-flip gate. No map row / no ACTIVE account
    // -> unscannable -> skip (fail-open), same posture as C4/C5.
    const ownerAccount = feeMapRow
      ? await models.moneroAccount.findFirst({
        where: { ownerUserId: feeMapRow.ownerUserId, status: 'ACTIVE' },
        include: { viewKey: true }
      })
      : null
    if (!(await verifyOrReject({ account: ownerAccount, paymentId, piconeros, txHash, context: `fee ${feePayIn.id}` }))) return
    await applySubFeeReceipt(models, { feePayIn, paymentId, txHash, piconeros, height, confirmations })
    return res.status(200).end()
  }

  // Money landed on a fee pid with NO PayIn: the leg was abandoned
  // (underpaid past the window — abandonFeeItems deleted the PayIn) but the
  // SubFeePidMap row persists for attribution. Record the receipt (ledger
  // visibility; the owner keeps the XMR) and page operators for manual
  // reconciliation — bounty-branch parity (see the EXPIRED bounty case
  // above). No map row: fall through to the downvote dispatch below, so
  // unknown pids keep their 200 no-op (lws retry hygiene).
  if (feeMapRow) {
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      return res.status(200).end()
    }
    // Chain verification before the abandoned-leg receipt (C6): even a
    // ledger-visibility row must carry a chain-verified amount, or a replayed
    // callback could fabricate balances for manual reconciliation. Same owner
    // account as the live-fee path, same fail-open skip for unscannable
    // owners.
    const ownerAccount = await models.moneroAccount.findFirst({
      where: { ownerUserId: feeMapRow.ownerUserId, status: 'ACTIVE' },
      include: { viewKey: true }
    })
    if (!(await verifyOrReject({ account: ownerAccount, paymentId, piconeros, txHash, context: `abandoned fee ${paymentId}` }))) return
    try {
      await applySubFeeReceipt(models, { feePayIn: null, paymentId, txHash, piconeros, height, confirmations })
    } catch (err) {
      console.warn(`webhook: abandoned-fee receipt record failed (best-effort): ${err && err.message}`)
    }
    alert('critical', 'payment arrived after fee abandonment',
      `turf ${feeMapRow.subName}: ${piconeros} piconeros arrived on abandoned fee leg ${paymentId}; manual reconciliation required`,
      { dedupeKey: `subfee-late-payment-${paymentId}` })
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

  // Reject an untrusted amount BEFORE claiming the pid map: a rejected
  // callback must not consume the map (the poll backstop or a corrected
  // re-delivery still needs it to attribute the downvote).
  const piconeros = parsePiconeros(amount)
  if (piconeros == null) {
    alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
    return res.status(200).end()
  }

  // Chain verification BEFORE the map claim (C6): a rejected callback must
  // not consume the DownvotePidMap, or the downvote is lost (the poll
  // backstop keys attribution on the map). Downvotes pay the rewards PRIMARY
  // address, so the verification account is the platform rewards wallet —
  // resolved deterministically viewKey-gated, same shape as the observer's
  // findRewardsAccount. No registered account -> unscannable -> skip
  // (fail-open), matching C4/C5.
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const rewardsAccount = await models.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network, viewKey: { isNot: null } },
    include: { viewKey: true },
    orderBy: { id: 'asc' }
  })
  if (!(await verifyOrReject({ account: rewardsAccount, paymentId, piconeros, txHash, context: 'downvote detection' }))) return

  // 0-conf detection (mempool — height NULL on the callback). Only a LIVE
  // (unconsumed, unexpired) pid map may claim; the atomic conditional consume
  // makes retried callbacks and a raced poll attribution no-ops.
  const claimedMap = await models.$executeRaw`
    UPDATE "DownvotePidMap"
    SET "consumedAt" = NOW()
    WHERE "paymentId" = ${paymentId} AND "consumedAt" IS NULL AND "expiresAt" > NOW()`
  if (claimedMap === 0) return res.status(200).end()

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
  const rl = rateLimit({
    key: `lws-webhook:${clientIp(req.headers, req.socket?.remoteAddress)}`,
    limit: 600,
    windowMs: 60_000
  })
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000))
    res.status(429).end()
    return
  }
  handleWebhook(req, res)
}
