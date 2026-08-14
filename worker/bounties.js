import { daemonClient } from '@/api/monero/daemonClient'
import { sendBountyPayments as defaultSendBountyPayments } from '@/api/monero/bounties'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { logInfo, logError } from '@/lib/logger'

// bounties — bounty lifecycle worker (A-13 Phase B). Self-requeues every 60s:
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
  // Run errors stay swallowed (retryLimit 0 — see TODO below — means a rethrow
  // would permanently kill the 60s scan chain until a worker restart; the
  // swallow+resend IS the chain-survival mechanism, and the run error is
  // already logged above).
  try {
    await runBountiesOnce({ models })
  } catch (err) {
    logError({ err }, 'bounties: run failed')
  }
  // TODO: deliberately NO BOSS_RETRY here — the payout dispatch
  // (sendBountyPayments) is relay-before-persist with no claim/CAS, so a
  // mid-dispatch retry could double-send an on-chain payout. The chain is
  // bootstrapped by the index.js seed guard on every restart.
  try {
    await boss.send('bounties', {}, { startAfter: 60 })
  } catch (e) {
    logError('bounties requeue send failed', e)
    alert('critical', 'bounties requeue failed', String(e), { dedupeKey: 'bounties-requeue' })
    throw e // rethrow so the permanent-failure alert fires and the boot seed restarts the chain
  }
}
