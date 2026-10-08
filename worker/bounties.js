import { daemonClient } from '@/api/monero/daemonClient'
import { sendBountyPayments as defaultSendBountyPayments, bountyFeePiconeros, getBountyEscrowTxHeight } from '@/api/monero/bounties'
import { errorLabel } from '@/api/monero/rewardsTransactions'
import { REQUIRED_CONFIRMATIONS, BOUNTY_UNDERPAY_ABANDON_DAYS } from '@/lib/constants'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'

// bounties — bounty lifecycle worker (A-13 Phase B). Runs every 60s via the
// pgboss.schedule cron row `bounties` (cron-owned, retryLimit 0):
//   1. EXPIRY: FUNDED bounties past bountyExpiryDays (from bountyConfirmedAt)
//      flip to EXPIRED (author can then reclaim or roll over).
//   2. SEND: QUEUED BountyPayments are sent by the escrow signer through the
//      capture barrier (relay:false build -> durable journal+proof pair ->
//      CAS-claimed single relay attempt -> relay -> persist; FAILED rows are
//      resumable by a later run only via a re-queue — FAILED funds stay in
//      escrow). SENT and CONFIRMED payouts with a deferred fee (feePendingAt
//      set) are re-offered to the signer for fee settlement (the change can
//      unlock after the prize matures).
//   3. MATURITY: SENT payouts flip to CONFIRMED at REQUIRED_CONFIRMATIONS
//      (daemon height fetched once per run). A payout whose height was unknown
//      at relay time (NULL) has it backfilled from lws by tx hash.

export async function runBountiesOnce ({ models, sendBountyPayments = defaultSendBountyPayments, getHeight = () => daemonClient.getHeight(), getTxHeight = (txHash) => getBountyEscrowTxHeight(txHash, { models }) } = {}) {
  // 1. Expire
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expiryMs = Number(config?.bountyExpiryDays ?? 30) * 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - expiryMs)
  await models.item.updateMany({
    where: { bountyStatus: 'FUNDED', bountyConfirmedAt: { lt: cutoff } },
    data: { bountyStatus: 'EXPIRED' }
  })

  // 1.5 Abandon underfunded funding attempts: a DETECTED bounty whose
  // count-eligible (height-verified) receipts never covered declared + fee
  // within the top-up window flips to EXPIRED with bountyPiconeros rewritten to
  // the COUNT-ELIGIBLE received total and bountyFeePiconeros frozen to 0n — so
  // the author's reclaimBounty is a fee-waived refund of what was verified on
  // chain (rollover pays received + 0 too). No cash row is created: the funding
  // was escrow-internal and never reached the hot wallet. A provisional
  // daemon-level claim is display-only: it neither holds the abandonment open
  // nor sets the refund.
  const abandonCutoff = new Date(Date.now() - BOUNTY_UNDERPAY_ABANDON_DAYS * 24 * 60 * 60 * 1000)
  const staleUnderfunded = await models.observedBounty.findMany({
    where: { state: 'DETECTED', detectedAt: { lt: abandonCutoff } },
    include: { post: { select: { bountyPiconeros: true } } }
  })
  for (const bounty of staleUnderfunded) {
    const fee = bountyFeePiconeros(bounty.post.bountyPiconeros, config)
    const expected = bounty.post.bountyPiconeros + fee
    // Count-eligible receipts only: the display fold may include provisional
    // (height-null) daemon claims, which must never hold the abandonment open
    // (a 7-day-old provisional funding will never confirm) nor set the refund
    // total (an unverified amount must never move value out of escrow).
    const countedAgg = await models.observedBountyReceipt.aggregate({
      _sum: { piconeros: true },
      where: { bountyId: bounty.id, height: { not: null } }
    })
    if ((countedAgg._sum.piconeros ?? 0n) >= expected) continue // fully received — confirmFinalizer will fund it
    // TOCTOU guard: the reads above raced a possible top-up receipt + webhook
    // funding. Re-validate inside the transaction — the state must still be
    // DETECTED and the count-eligible receipts must still be short — else skip
    // silently (a funded bounty belongs to the webhook/finalizer path).
    let abandoned = null // { received, expected } once the flip commits
    await models.$transaction(async (tx) => {
      const fresh = await tx.observedBounty.findUnique({
        where: { id: bounty.id },
        include: { post: { select: { bountyPiconeros: true } } }
      })
      if (!fresh || fresh.state !== 'DETECTED') return
      const agg = await tx.observedBountyReceipt.aggregate({
        _sum: { piconeros: true },
        where: { bountyId: bounty.id, height: { not: null } }
      })
      const received = agg._sum.piconeros ?? 0n
      const freshExpected = fresh.post.bountyPiconeros + bountyFeePiconeros(fresh.post.bountyPiconeros, config)
      if (received >= freshExpected) return
      abandoned = { received, expected: freshExpected }
      await tx.observedBounty.update({ where: { id: bounty.id }, data: { state: 'EXPIRED' } })
      await tx.item.update({
        where: { id: bounty.postId },
        data: { bountyStatus: 'EXPIRED', bountyPiconeros: received, bountyFeePiconeros: 0n }
      })
    })
    if (!abandoned) continue
    alert('warn', 'bounty funding abandoned (underpaid)',
      `bounty item ${bounty.postId}: received ${abandoned.received} of ${abandoned.expected} piconeros (count-eligible) within ${BOUNTY_UNDERPAY_ABANDON_DAYS} days; flipped to EXPIRED — the author can now reclaim what they sent (fee waived)`,
      { dedupeKey: `bounty-abandoned-${bounty.postId}` })
  }

  // 2. Send queued payouts + retry deferred fees. A fee deferred on a prior
  // tick (payout change output locked until the payout tx confirms) is
  // retried here once the unlocked balance covers it; feeTxHash stays NULL
  // until the fee actually relays, so it can never double-send. Retried for
  // SENT and CONFIRMED payouts alike — the change can unlock after the payout
  // matures, so stopping at CONFIRMED would strand the fee in escrow forever.
  const queued = await models.bountyPayment.findMany({ where: { state: 'QUEUED' } })
  const pendingFees = await models.bountyPayment.findMany({ where: { feePendingAt: { not: null }, state: { in: ['SENT', 'CONFIRMED'] } } })
  const payouts = [...queued, ...pendingFees]
  if (payouts.length > 0) {
    const result = await sendBountyPayments(payouts, { models })
    logInfo(result, 'bounties: payout dispatch complete')
  }

  // 3. Mature sent payouts
  let chainHeight
  try { chainHeight = await getHeight() } catch { return }
  const sent = await models.bountyPayment.findMany({ where: { state: 'SENT' } })
  for (const payout of sent) {
    let height = payout.height
    if (height == null) {
      // A payout whose height was unknown at relay time (the tx was not yet
      // mined in the ~1s relay window) can never mature via its stored height.
      // Backfill it from lws by tx hash; if the tx is still unmined,
      // retry on a later tick.
      if (!payout.txHash) continue
      try { height = await getTxHeight(payout.txHash) } catch { continue }
      if (height == null) continue
      await models.bountyPayment.update({ where: { id: payout.id }, data: { height } })
    }
    if (chainHeight - height + 1 >= REQUIRED_CONFIRMATIONS) {
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: { state: 'CONFIRMED', confirmations: chainHeight - height + 1, confirmedAt: new Date() }
      })
    }
  }
}

export async function bounties ({ boss, models }) {
  // Run errors stay swallowed (and logged above) so a single failed sweep does
  // not abort the job run; recurrence is cron-owned, so the next tick re-runs
  // the sweep regardless (payout dispatch stays retry-free — see below).
  try {
    await runBountiesOnce({ models })
  } catch (err) {
    // Fixed classification labels only (final-review M6): raw error objects
    // and messages can carry transport detail, so the log record carries a
    // machine label, never the error itself.
    logError({ errorClass: errorLabel(err) }, 'bounties: run failed')
  }
  // Recurrence is cron-owned (pgboss.schedule row bounties, retryLimit 0).
  // Deliberately still NO retry: sendBountyPayments now commits the durable
  // journal+proof pair and CAS-claims the single relay attempt before any
  // broadcast (relay:false build -> prepare -> claim -> relay -> persist), so a
  // mid-dispatch interruption leaves the leg withheld for reconciliation
  // instead of double-sending. An immediate job retry would only re-scan the
  // same sweep, so the next cron tick re-runs it with fresh state.
}
