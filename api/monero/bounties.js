import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { lwsClient } from '@/api/monero/lwsClient'
import { readBountySettlement, readFeeSettlement } from '@/api/monero/bountySettlement'

// Bounty escrow signer (A-13, 2026-08-10 amendment). The ONLY component that
// holds the BOUNTY ESCROW wallet's spend key (separate standalone wallet — never
// the rewards wallet). Opens an in-memory monero-ts wallet from env, sends each
// QUEUED BountyPayment, records the tx hash, flips QUEUED -> SENT.
// Each payout is ONE tx: prize + platform fee as destinations with the network
// fee subtracted from the last one (the ops cut, or the payout destination for
// ROLLOVER / fee-waived refunds), so the winner/refund receives the exact
// booked amount and the escrow consumes exactly prize + fee (2026-09-18 fix:
// exact-funded awards used to strand a network fee short).
// The ACTUAL signed-tx settlement (real network fee, real net received
// amounts) is snapshotted onto the payout after relay, and the fee destination
// is frozen BEFORE dispatch (once, when NULL) — never derived from today's
// environment after the fact. Relay writes NO hot-wallet receipt: escrow cash
// is recognized later from confirmed hot-wallet receipts only (rewards
// accounting repair §4).
// Re-syncs the wallet's chain view once per dispatch before reading balances,
// so outputs that unlock after open are visible without a worker restart.
//
// Fund-safety mirrors api/monero/rewards.js: keys from env (never logged),
// insufficient-unlocked-balance = SKIP (retry next run) not FAILED, FAILED only
// on hard createTx errors (funds stay in escrow). A post-relay settlement-read
// failure is never FAILED and never a re-send: the payout stays SENT with a
// critical alert, recovered later from read-only escrow history.

const RESTORE_HEIGHT_MARGIN = 1000

// Stuck-payout alerting: a balance-short skip is silent (funds are safe, so
// nothing FAILs), so a permanently short escrow would otherwise skip forever
// (2026-09-18 finding: exact-funded awards stranded a miner fee short). Track
// the consecutive 60s dispatcher runs each payout was skipped and page ops once
// at N. Process-lifetime state (like worker/healthProbe.js's stall tracker): a
// worker restart only delays the alert by N further ticks.
// BOUNTY_SKIP_ALERT_TICKS is read once at module load — restart to change it.
const skipStreaks = new Map()
const SKIP_ALERT_TICKS = Math.max(1, Number(process.env.BOUNTY_SKIP_ALERT_TICKS) || 5)

export function __resetSkipStreaks () {
  skipStreaks.clear()
}

let walletPromise = null

export async function getBountyEscrowWallet ({ models } = {}) {
  if (!walletPromise) {
    walletPromise = openBountyEscrowWallet({ models }).catch(err => {
      walletPromise = null
      throw err
    })
  }
  return walletPromise
}

async function openBountyEscrowWallet ({ models } = {}) {
  const primaryAddress = process.env.BOUNTY_ESCROW_ADDRESS
  const privateSpendKey = process.env.BOUNTY_ESCROW_SPEND_KEY
  const privateViewKey = process.env.BOUNTY_ESCROW_VIEW_KEY
  if (!primaryAddress || !privateSpendKey || !privateViewKey) {
    throw new Error('bounty escrow signer: BOUNTY_ESCROW_ADDRESS, BOUNTY_ESCROW_SPEND_KEY, and BOUNTY_ESCROW_VIEW_KEY must be configured')
  }
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = (process.env.MONERO_NETWORK || 'stagenet').toLowerCase() === 'mainnet'
    ? api.MoneroNetworkType.MAINNET
    : api.MoneroNetworkType.STAGENET
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'
  // Restore height: BOUNTY_ESCROW_SCAN_FROM_HEIGHT when set; otherwise derive
  // one that covers the earliest ObservedBounty funding (the escrow must see
  // its funding, or award payouts skip forever with a silent ~0 unlocked
  // balance). Any fallback is a loud CRITICAL so ops notices before payouts
  // pile up. When the env var is set the env path is untouched: no DB/daemon
  // calls, no alert.
  const envHeight = Number(process.env.BOUNTY_ESCROW_SCAN_FROM_HEIGHT) || 0
  let earliestFundingHeight = null
  let daemonHeight = null
  if (!envHeight) {
    if (models?.observedBounty) {
      try {
        const agg = await models.observedBounty.aggregate({ _min: { height: true } })
        earliestFundingHeight = agg._min.height
      } catch { /* DB down — fall through to the daemon-margin fallback */ }
    }
    try { daemonHeight = await daemonClient.getHeight() } catch { /* daemon down — genesis scan */ }
  }
  const { restoreHeight, source } = resolveBountyEscrowRestoreHeight({ envHeight, earliestFundingHeight, daemonHeight })
  if (source !== 'env') {
    alert('critical', 'bounty escrow scan-from-height fallback',
      `BOUNTY_ESCROW_SCAN_FROM_HEIGHT is 0/unset; opening the escrow wallet from height ${restoreHeight} (${source}). Set BOUNTY_ESCROW_SCAN_FROM_HEIGHT below the earliest funding to avoid invisible-funding payout skips.`,
      { dedupeKey: 'bounty-escrow-scan-height-fallback' })
  }
  const wallet = await api.createWalletFull({
    password: 'bounty-escrow-signer',
    networkType,
    primaryAddress,
    privateSpendKey,
    privateViewKey,
    restoreHeight,
    server: { uri: serverUri },
    proxyToWorker: false
  })
  await wallet.sync()
  return wallet
}

// Pure helper: platform bounty fee = max(min, pct% of bounty), capped at 20%
// of the bounty so tiny bounties never pay more than a fifth of their value.
// Exported for tests + reuse by the funding flow and the signer's fee settlement.
export function bountyFeePiconeros (bountyPiconeros, { bountyFeeMinPiconeros, bountyFeePct }) {
  const pct = BigInt(bountyPiconeros) * BigInt(bountyFeePct) / 100n
  const flat = pct > BigInt(bountyFeeMinPiconeros) ? pct : BigInt(bountyFeeMinPiconeros)
  const cap = BigInt(bountyPiconeros) * 20n / 100n
  return flat > cap ? cap : flat
}

// Resolve the escrow wallet's restore height. BOUNTY_ESCROW_SCAN_FROM_HEIGHT
// wins when set; otherwise derive a height that covers every ObservedBounty
// funding tx (the escrow must always see its funding, or award payouts skip
// forever with a silent ~0 unlocked balance — the 2026-08-19 beta incident),
// falling back to a daemon-height margin and finally genesis. Exported for
// tests; the wallet opener alerts loudly on any non-env source.
export function resolveBountyEscrowRestoreHeight ({ envHeight, earliestFundingHeight, daemonHeight }) {
  if (envHeight > 0) return { restoreHeight: envHeight, source: 'env' }
  if (earliestFundingHeight != null) {
    return { restoreHeight: Math.max(0, earliestFundingHeight - RESTORE_HEIGHT_MARGIN), source: 'earliest-funding' }
  }
  if (daemonHeight != null) {
    return { restoreHeight: Math.max(0, daemonHeight - RESTORE_HEIGHT_MARGIN), source: 'daemon-margin' }
  }
  return { restoreHeight: 0, source: 'genesis' }
}

// Count one balance-short skip for `payout` and alert exactly once when the
// streak reaches SKIP_ALERT_TICKS. `needs` is the payout's total requirement in
// piconeros (prize + platform fee, or the fee alone for a legacy retry).
function bumpSkipStreak (payout, unlocked, needs) {
  const streak = (skipStreaks.get(payout.id) || 0) + 1
  skipStreaks.set(payout.id, streak)
  if (streak !== SKIP_ALERT_TICKS) return
  alert('critical', 'bounty payout stuck — insufficient escrow balance',
    `payout ${payout.id} (item ${payout.itemId}, kind ${payout.kind}) skipped ${streak} consecutive dispatcher runs: escrow unlocked ${unlocked} < needed ${needs} piconeros for recipient ${payout.recipientAddress}; the funds are safe in escrow but the payout cannot dispatch`,
    { dedupeKey: `bounty-skip-stuck-${payout.id}` })
}

function clearSkipStreak (payoutId) {
  skipStreaks.delete(payoutId)
}

// Drop streak entries for payouts no longer offered to the dispatcher (sent,
// reconciled, deleted) so the map tracks only outstanding work.
function pruneSkipStreaks (payouts) {
  const offered = new Set(payouts.map(p => p.id))
  for (const id of skipStreaks.keys()) {
    if (!offered.has(id)) skipStreaks.delete(id)
  }
}

// Look up the mined block height of an escrow payout tx by hash via lws
// get_address_txs (view key only — never opens the spend-key signer wallet;
// the height is already in the account scan, so no daemon call is needed —
// monerod's restricted /get_transactions does serve single-hash lookups, it
// just caps batches at 100). Returns null while the tx is unknown to lws or
// still unconfirmed (mempool txs carry no height). Exported for tests; the
// bounties worker uses it to backfill the height of SENT payouts whose height
// was unknown at relay time (2026-08-19 beta incident).
export async function getBountyEscrowTxHeight (txHash, { models, lws = lwsClient }) {
  const net = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const account = await models.moneroAccount.findFirst({
    where: { label: 'bounty_escrow', network: net },
    include: { viewKey: true },
    orderBy: { id: 'asc' }
  })
  if (!account) return null
  const { transactions } = await lws.getAddressTxs(account)
  const wanted = String(txHash).toLowerCase()
  const tx = (transactions || []).find(t => String(t.hash).toLowerCase() === wanted)
  return tx && tx.height != null ? tx.height : null
}

// Send QUEUED BountyPayments. `wallet` is injectable for tests. Each payout is
// ONE tx. For each:
//  - AWARD/RECLAIM: destinations [winner `piconeros`, cold/ops
//    (REWARDS_COLD_STORAGE_ADDRESS, fallback PLATFORM_REWARDS_ADDRESS)
//    `feePiconeros`], subtractFeeFrom the last — the ops cut absorbs the
//    network fee, the winner receives the exact booked prize, and ops
//    physically receives the fee minus the network fee while the ledger stays
//    booked gross (the network-fee delta is the documented unbooked-ops
//    class, spec 2026-09-18).
//  - ROLLOVER and fee-waived payouts: one destination for the full amount,
//    subtractFeeFrom it, so the escrow still zeroes exactly.
// Relay writes NO hot-wallet FeeObservation: the old CONFIRMED-at-relay
// BOUNTY_ROLLOVER insert is gone because a signed tx is not proof of receipt
// (rewards accounting repair §4). Receipt attribution uses the actual
// confirmed hot-wallet receipt plus the settlement facts snapshotted here.
// Deferred-fee rows (feePendingAt) from before 2026-09-18 are still settled by
// the legacy retry branch below; new payouts never set it.
export async function sendBountyPayments (payouts, { models, wallet } = {}) {
  const queued = (payouts || []).filter(p => p.state === 'QUEUED')
  const pendingFees = (payouts || []).filter(p => p.feePendingAt)
  if (queued.length === 0 && pendingFees.length === 0) {
    return { sent: 0, failed: 0, skipped: 0, settled: 0 }
  }
  pruneSkipStreaks([...queued, ...pendingFees])
  const w = wallet || await getBountyEscrowWallet({ models })
  // The singleton escrow wallet syncs once at open; without a refresh here the
  // unlocked-balance read below sees the stale cached view (2026-08-19/20 beta
  // incident: a deferred fee's change unlocked after open, but every 60s retry
  // read the stale low balance and skipped until a worker restart). sync() is
  // incremental from the wallet's last processed height, and this only runs in
  // the bounties cron worker — never a web hot path. A sync error aborts the
  // run (cron retries next tick) exactly like the balance read already does.
  await w.sync()
  let unlocked = BigInt(await w.getUnlockedBalance(0))
  let sent = 0
  let failed = 0
  let skipped = 0
  let settled = 0
  const feeAddress = process.env.REWARDS_COLD_STORAGE_ADDRESS || process.env.PLATFORM_REWARDS_ADDRESS

  // Where an AWARD/RECLAIM fee (or a legacy fee retry) will land must be frozen
  // on the payout BEFORE createTx can move funds: a later env change must never
  // reclassify an old settlement, and an identity that cannot be persisted must
  // not dispatch. The stored value wins over today's environment forever after.
  const resolveFeeDestination = async (payout) => {
    if (payout.feeRecipientAddress) return payout.feeRecipientAddress
    if (!feeAddress) {
      logError({ payoutId: payout.id }, 'sendBountyPayments: no escrow fee destination configured; payout left QUEUED')
      return null
    }
    try {
      await models.bountyPayment.update({ where: { id: payout.id }, data: { feeRecipientAddress: feeAddress } })
    } catch (err) {
      logError({ payoutId: payout.id, err }, 'sendBountyPayments: fee destination persist failed before dispatch; payout left QUEUED (no funds moved)')
      return null
    }
    return feeAddress
  }

  for (const payout of [...queued, ...pendingFees]) {
    if (payout.feePendingAt) {
      // Fee-settlement retry for a payout whose fee was deferred on a prior
      // tick (the payout's change output was locked until the payout tx
      // confirmed). The payout itself is already SENT/CONFIRMED and must NOT
      // be re-sent — only the fee is relayed, once the unlocked balance covers
      // it. Works for SENT and CONFIRMED payouts alike: the change can unlock
      // after the payout matures, so the retry must not stop at CONFIRMED or
      // the fee strands in escrow forever.
      if (payout.kind === 'ROLLOVER' || payout.feePiconeros <= 0n || payout.feeTxHash) continue
      if (unlocked < payout.feePiconeros) {
        bumpSkipStreak(payout, unlocked, payout.feePiconeros)
        skipped += 1
        continue
      }
      const feeRecipientAddress = await resolveFeeDestination(payout)
      if (!feeRecipientAddress) continue
      let feeTxHash = null
      let feeSettlement = null
      let settlementError = null
      try {
        const feeTx = await w.createTx({
          accountIndex: 0,
          address: feeRecipientAddress,
          amount: payout.feePiconeros,
          relay: true
        })
        feeTxHash = toTxHash(feeTx.getHash())
        try {
          feeSettlement = await readFeeSettlement(feeTx, { feeRecipientAddress })
        } catch (err) {
          settlementError = err
        }
        unlocked -= payout.feePiconeros
      } catch (err) {
        if (isBalanceError(err)) {
          bumpSkipStreak(payout, unlocked, payout.feePiconeros)
          skipped += 1
          continue
        }
        clearSkipStreak(payout.id)
        // Hard error: stop auto-retrying and leave it for manual reconciliation.
        await models.bountyPayment.update({ where: { id: payout.id }, data: { feePendingAt: null } })
        logError({ payoutId: payout.id, err }, 'sendBountyPayments: fee settlement FAILED (fee stays in escrow; reconcile manually)')
        continue
      }
      // Relay-before-persist: if the persist fails after the fee relayed, the
      // fee has left escrow but is unrecorded. Clear feePendingAt best-effort
      // so the retry stops (never re-relay = no double-send) and alert loudly
      // so ops records the relayed feeTxHash manually.
      try {
        const data = { feeTxHash, feePendingAt: null }
        if (feeSettlement) {
          data.feeSettlementNetworkFeePiconeros = feeSettlement.networkFeePiconeros
          data.feeReceivedPiconeros = feeSettlement.feeReceivedPiconeros
        }
        await models.bountyPayment.update({ where: { id: payout.id }, data })
        clearSkipStreak(payout.id)
        settled += 1
        logInfo({ payoutId: payout.id, feeTxHash }, 'sendBountyPayments: deferred fee settlement relayed')
        if (settlementError) {
          // The fee moved; only its metadata is missing. Never FAILED, never a
          // re-send — a later read-only escrow-history recovery fills it in.
          logError({ payoutId: payout.id, txHash: feeTxHash, err: settlementError }, 'sendBountyPayments: CRITICAL — fee relayed but settlement metadata unavailable; recover from escrow history (do not re-send)')
          alert('critical', 'fee settlement metadata missing',
            `bounty payout ${payout.id} fee tx ${feeTxHash} relayed but its settlement facts could not be read (${settlementError.message}); do not re-send — recover from read-only escrow history`,
            { dedupeKey: `fee-settlement-missing-${payout.id}` })
        }
      } catch (err) {
        clearSkipStreak(payout.id)
        await models.bountyPayment.update({ where: { id: payout.id }, data: { feePendingAt: null } }).catch(() => {})
        logError({ payoutId: payout.id, txHash: feeTxHash, err }, 'sendBountyPayments: CRITICAL — fee relayed but DB persist failed; manual reconciliation required')
        alert('critical', 'fee-relayed-but-unpersisted',
          `bounty payout ${payout.id} fee tx ${feeTxHash} relayed but DB persist failed; manual reconciliation required`,
          { dedupeKey: `fee-relay-unpersisted-${feeTxHash}` })
      }
      continue
    }

    const needs = payout.piconeros + (payout.kind === 'ROLLOVER' ? 0n : payout.feePiconeros)
    if (unlocked < needs) {
      bumpSkipStreak(payout, unlocked, needs)
      skipped += 1
      continue
    }

    const recipient = payout.recipientAddress
    const amount = payout.piconeros
    const fee = payout.kind === 'ROLLOVER' ? 0n : payout.feePiconeros
    // Freeze the fee destination before the tx can move funds. Rollover and
    // fee-waived payouts have no separate fee leg, so there is nothing to
    // freeze (a rollover's recipientAddress is already frozen at queue time).
    let feeRecipientAddress = payout.feeRecipientAddress || null
    if (fee > 0n && !feeRecipientAddress) {
      feeRecipientAddress = await resolveFeeDestination(payout)
      if (!feeRecipientAddress) continue
    }
    // One tx settles both legs, with the miner fee subtracted from the LAST
    // destination (2026-09-18 fix): the ops cut for AWARD/RECLAIM, the payout
    // destination for ROLLOVER and fee-waived payouts. The winner/refund still
    // receives the exact booked amount and the escrow consumes exactly `needs`
    // (the fee rides inside the destination sum) — without a miner-fee reserve,
    // which an exactly funded escrow cannot carry. One network fee, not two.
    const destinations = fee > 0n
      ? [{ address: recipient, amount }, { address: feeRecipientAddress, amount: fee }]
      : [{ address: recipient, amount }]
    let tx
    try {
      tx = await w.createTx({
        accountIndex: 0,
        destinations,
        subtractFeeFrom: [destinations.length - 1],
        relay: true
      })
    } catch (err) {
      if (isBalanceError(err)) {
        bumpSkipStreak(payout, unlocked, needs)
        skipped += 1
        continue
      }
      clearSkipStreak(payout.id)
      logError({ payoutId: payout.id, err }, 'sendBountyPayments: payout FAILED (funds stayed in escrow)')
      await models.bountyPayment.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
      failed += 1
      continue
    }
    unlocked -= needs
    clearSkipStreak(payout.id)
    const txHash = toTxHash(tx.getHash())
    logInfo({ payoutId: payout.id, txHash, kind: payout.kind }, 'sendBountyPayments: payout relayed')

    // Snapshot the ACTUAL settlement of the signed tx — the real network fee
    // and the post-subtraction destination amounts — instead of trusting the
    // pre-subtraction request. A read failure must NOT fail or re-send an
    // already-relayed payout: it is alerted after the SENT persist and
    // recovered later from read-only escrow history.
    let settlement = null
    let settlementError = null
    try {
      settlement = await readBountySettlement(tx, { payout, feeRecipientAddress })
    } catch (err) {
      settlementError = err
    }

    // Best-effort block height for maturity: the bounties worker flips
    // SENT -> CONFIRMED once the tx is REQUIRED_CONFIRMATIONS deep. Unavailable
    // height just defers maturity to a later run (the worker backfills it from
    // lws by tx hash — never a correctness issue).
    let height = null
    try { height = await w.getTx(txHash).then(t => t.getHeight()).catch(() => null) } catch { /* ignore */ }

    try {
      const data = { state: 'SENT', txHash, height, sentAt: new Date() }
      if (settlement) {
        data.networkFeePiconeros = settlement.networkFeePiconeros
        data.recipientReceivedPiconeros = settlement.recipientReceivedPiconeros
        data.feeReceivedPiconeros = settlement.feeReceivedPiconeros
      }
      await models.bountyPayment.update({ where: { id: payout.id }, data })
      sent += 1
      if (settlementError) {
        logError({ payoutId: payout.id, txHash, err: settlementError }, 'sendBountyPayments: CRITICAL — payout relayed but settlement metadata unavailable; recover from escrow history (do not re-send)')
        alert('critical', 'payout settlement metadata missing',
          `bounty payout ${payout.id} tx ${txHash} relayed but its settlement facts could not be read (${settlementError.message}); do not re-send — recover from read-only escrow history`,
          { dedupeKey: `bounty-settlement-missing-${payout.id}` })
      }
    } catch (err) {
      logError({ payoutId: payout.id, txHash, err }, 'sendBountyPayments: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      alert('critical', 'relayed-but-unpersisted bounty payout',
        `bounty payout ${payout.id} tx ${txHash} relayed but DB persist failed; manual reconciliation required`,
        { dedupeKey: `bounty-relay-unpersisted-${txHash}` })
    }
  }
  return { sent, failed, skipped, settled }
}

// monero-ts getHash() returns a hex string (verified on stagenet), but defend
// against a Uint8Array / Buffer / byte-array shape so the stored txHash is
// always a lowercase hex string.
function toTxHash (hash) {
  if (hash == null) return null
  if (typeof hash === 'string') return hash.toLowerCase()
  if (typeof hash === 'object') {
    const arr = Array.isArray(hash) ? hash : (hash.data || Array.from(hash))
    if (arr && arr.length) return Array.from(arr).map(b => (b >>> 0).toString(16).padStart(2, '0')).join('')
  }
  return String(hash)
}

// Distinguish "not enough (unlocked) money" — a retryable balance/lock state —
// from a true hard error (bad address, daemon rejection). monero-wallet's
// messages include "not enough money" / "not enough unlocked money" /
// "failed to get unlocked balance".
function isBalanceError (err) {
  const msg = String((err && err.message) || err).toLowerCase()
  return /not enough.*(money|unlocked)|failed to get unlocked balance|insufficient.*(balance|fund)/.test(msg)
}
