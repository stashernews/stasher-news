import { daemonClient } from '@/api/monero/daemonClient'
import { sendBountyPayments as defaultSendBountyPayments, bountyFeePiconeros } from '@/api/monero/bounties'
import { REQUIRED_CONFIRMATIONS, BOUNTY_UNDERPAY_ABANDON_DAYS } from '@/lib/constants'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'

// bounties — bounty lifecycle worker (A-13 Phase B). Runs every 60s via the
// pgboss.schedule cron row `bounties` (cron-owned, retryLimit 0):
//   1. EXPIRY: FUNDED bounties past bountyExpiryDays (from bountyConfirmedAt)
//      flip to EXPIRED (author can then reclaim or roll over).
//   2. SEND: QUEUED BountyPayments are sent by the escrow signer
//      (relay-before-persist; FAILED rows are resumable by a later run only via
//      a re-queue — FAILED funds stay in escrow).
//   3. MATURITY: SENT payouts with a height flip to CONFIRMED at
//      REQUIRED_CONFIRMATIONS (daemon height fetched once per run).

export async function runBountiesOnce ({ models, sendBountyPayments = defaultSendBountyPayments, getHeight = () => daemonClient.getHeight() } = {}) {
  // 1. Expire
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expiryMs = Number(config?.bountyExpiryDays ?? 30) * 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - expiryMs)
  await models.item.updateMany({
    where: { bountyStatus: 'FUNDED', bountyConfirmedAt: { lt: cutoff } },
    data: { bountyStatus: 'EXPIRED' }
  })

  // 1.5 Abandon underfunded funding attempts: a DETECTED bounty whose
  // cumulative receipts never covered declared + fee within the top-up window
  // flips to EXPIRED with bountyPiconeros rewritten to the RECEIVED total and
  // a zero-fee BOUNTY_FEE row — so the author's reclaimBounty is a fee-waived
  // 100% refund of what they actually sent (rollover pays received + 0 too).
  const abandonCutoff = new Date(Date.now() - BOUNTY_UNDERPAY_ABANDON_DAYS * 24 * 60 * 60 * 1000)
  const staleUnderfunded = await models.observedBounty.findMany({
    where: { state: 'DETECTED', detectedAt: { lt: abandonCutoff } },
    include: { post: { select: { bountyPiconeros: true } } }
  })
  for (const bounty of staleUnderfunded) {
    const fee = bountyFeePiconeros(bounty.post.bountyPiconeros, config)
    const expected = bounty.post.bountyPiconeros + fee
    if (bounty.piconeros >= expected) continue // fully received — confirmFinalizer will fund it
    // TOCTOU guard: the reads above raced a possible top-up receipt + webhook
    // funding. Re-validate inside the transaction — the state must still be
    // DETECTED and the cumulative receipts must still be short — else skip
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
        where: { bountyId: bounty.id }
      })
      const received = agg._sum.piconeros ?? fresh.piconeros
      const freshExpected = fresh.post.bountyPiconeros + bountyFeePiconeros(fresh.post.bountyPiconeros, config)
      if (received >= freshExpected) return
      abandoned = { received, expected: freshExpected }
      await tx.observedBounty.update({ where: { id: bounty.id }, data: { state: 'EXPIRED' } })
      await tx.item.update({
        where: { id: bounty.postId },
        data: { bountyStatus: 'EXPIRED', bountyPiconeros: received }
      })
      await tx.feeObservation.create({
        data: {
          txHash: 'abandoned-' + bounty.paymentId,
          payInId: null,
          feeType: 'BOUNTY_FEE',
          postId: bounty.postId,
          recipientMajor: 0,
          recipientMinor: 0,
          piconeros: 0n,
          state: 'CONFIRMED',
          confirmedAt: new Date()
        }
      })
    })
    if (!abandoned) continue
    alert('warn', 'bounty funding abandoned (underpaid)',
      `bounty item ${bounty.postId}: received ${abandoned.received} of ${abandoned.expected} piconeros within ${BOUNTY_UNDERPAY_ABANDON_DAYS} days; flipped to EXPIRED — the author can now reclaim what they sent (fee waived)`,
      { dedupeKey: `bounty-abandoned-${bounty.postId}` })
  }

  // 2. Send queued payouts
  const queued = await models.bountyPayment.findMany({ where: { state: 'QUEUED' } })
  if (queued.length > 0) {
    const result = await sendBountyPayments(queued, { models })
    logInfo(result, 'bounties: payout dispatch complete')
  }

  // 3. Mature sent payouts
  let chainHeight
  try { chainHeight = await getHeight() } catch { return }
  const sent = await models.bountyPayment.findMany({ where: { state: 'SENT', height: { not: null } } })
  for (const payout of sent) {
    if (chainHeight - payout.height + 1 >= REQUIRED_CONFIRMATIONS) {
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: { state: 'CONFIRMED', confirmations: chainHeight - payout.height + 1, confirmedAt: new Date() }
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
    logError({ err }, 'bounties: run failed')
  }
  // Recurrence is cron-owned (pgboss.schedule row bounties, retryLimit 0).
  // Deliberately still NO retry: the payout dispatch (sendBountyPayments) is
  // relay-before-persist with no claim/CAS, so a mid-dispatch retry could
  // double-send an on-chain payout. The next cron tick re-runs the sweep.
}
