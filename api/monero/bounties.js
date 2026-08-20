import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { lwsClient } from '@/api/monero/lwsClient'

// Bounty escrow signer (A-13, 2026-08-10 amendment). The ONLY component that
// holds the BOUNTY ESCROW wallet's spend key (separate standalone wallet — never
// the rewards wallet). Opens an in-memory monero-ts wallet from env, sends each
// QUEUED BountyPayment, records the tx hash, flips QUEUED -> SENT.
// Re-syncs the wallet's chain view once per dispatch before reading balances,
// so outputs that unlock after open are visible without a worker restart.
//
// Fund-safety mirrors api/monero/rewards.js: keys from env (never logged),
// insufficient-unlocked-balance = SKIP (retry next run) not FAILED, FAILED only
// on hard createTx errors (funds stay in escrow).

const RESTORE_HEIGHT_MARGIN = 1000

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

// Look up the mined block height of an escrow payout tx by hash via lws
// get_address_txs (view key only — never opens the spend-key signer wallet;
// the daemon's restricted RPC strips get_transactions, so a daemon lookup is
// impossible in prod). Returns null while the tx is unknown to lws or still
// unconfirmed (mempool txs carry no height). Exported for tests; the bounties
// worker uses it to backfill the height of SENT payouts whose height was
// unknown at relay time (2026-08-19 beta incident).
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

// Send QUEUED BountyPayments. `wallet` is injectable for tests. For each:
//  - AWARD/RECLAIM: send `piconeros` to the winner's registered address, then
//    send the fee straight to the cold/ops wallet (REWARDS_COLD_STORAGE_ADDRESS,
//    fallback PLATFORM_REWARDS_ADDRESS; physical move — the ledger already
//    booked BOUNTY_FEE at funding confirmation).
//  - ROLLOVER: send `piconeros` (bounty + fee = full escrow balance) to
//    PLATFORM_REWARDS_ADDRESS and book the pool inflow directly
//    (FeeObservation('BOUNTY_ROLLOVER'), born CONFIRMED — the pool can only
//    distribute money physically present in the rewards wallet).
export async function sendBountyPayments (payouts, { models, wallet } = {}) {
  const queued = (payouts || []).filter(p => p.state === 'QUEUED')
  const pendingFees = (payouts || []).filter(p => p.feePendingAt)
  if (queued.length === 0 && pendingFees.length === 0) {
    return { sent: 0, failed: 0, skipped: 0, settled: 0 }
  }
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
      if (unlocked < payout.feePiconeros) { skipped += 1; continue }
      let feeTxHash = null
      try {
        const feeTx = await w.createTx({
          accountIndex: 0,
          address: feeAddress,
          amount: payout.feePiconeros,
          relay: true
        })
        feeTxHash = toTxHash(feeTx.getHash())
        unlocked -= payout.feePiconeros
      } catch (err) {
        if (isBalanceError(err)) { skipped += 1; continue }
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
        await models.bountyPayment.update({ where: { id: payout.id }, data: { feeTxHash, feePendingAt: null } })
        settled += 1
        logInfo({ payoutId: payout.id, feeTxHash }, 'sendBountyPayments: deferred fee settlement relayed')
      } catch (err) {
        await models.bountyPayment.update({ where: { id: payout.id }, data: { feePendingAt: null } }).catch(() => {})
        logError({ payoutId: payout.id, txHash: feeTxHash, err }, 'sendBountyPayments: CRITICAL — fee relayed but DB persist failed; manual reconciliation required')
        alert('critical', 'fee-relayed-but-unpersisted',
          `bounty payout ${payout.id} fee tx ${feeTxHash} relayed but DB persist failed; manual reconciliation required`,
          { dedupeKey: `fee-relay-unpersisted-${feeTxHash}` })
      }
      continue
    }

    const needs = payout.piconeros + (payout.kind === 'ROLLOVER' ? 0n : payout.feePiconeros)
    if (unlocked < needs) { skipped += 1; continue }

    const recipient = payout.recipientAddress
    const amount = payout.piconeros
    let tx
    try {
      tx = await w.createTx({ accountIndex: 0, address: recipient, amount, relay: true })
    } catch (err) {
      if (isBalanceError(err)) { skipped += 1; continue }
      logError({ payoutId: payout.id, err }, 'sendBountyPayments: payout FAILED (funds stayed in escrow)')
      await models.bountyPayment.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
      failed += 1
      continue
    }
    unlocked -= amount
    const txHash = toTxHash(tx.getHash())
    logInfo({ payoutId: payout.id, txHash, kind: payout.kind }, 'sendBountyPayments: payout relayed')

    // Fee settlement (AWARD/RECLAIM): move the platform fee escrow -> cold/ops
    // wallet directly (REWARDS_COLD_STORAGE_ADDRESS; fallback
    // PLATFORM_REWARDS_ADDRESS for stacks without cold storage) — the ops funds
    // are swept from the hot rewards wallet anyway, so skipping the hop avoids a
    // second tx fee. The pool ledger is unaffected: BOUNTY_FEE rows are 100%
    // ops (recipientMajor/minor 0). ROLLOVER sends the whole escrow balance in
    // the payout tx above (the bounty portion is 100% pool, which physically
    // lives in the rewards wallet).
    let feeTxHash = null
    let feePendingAt = null
    if (payout.kind !== 'ROLLOVER' && payout.feePiconeros > 0n) {
      try {
        const feeTx = await w.createTx({
          accountIndex: 0,
          address: feeAddress,
          amount: payout.feePiconeros,
          relay: true
        })
        feeTxHash = toTxHash(feeTx.getHash())
        unlocked -= payout.feePiconeros
        logInfo({ payoutId: payout.id, feeTxHash }, 'sendBountyPayments: fee settlement relayed')
      } catch (err) {
        if (isBalanceError(err)) {
          // The payout's change output is locked until the payout tx confirms,
          // so the fee cannot leave yet. Defer: mark the fee pending and a
          // later tick retries it once the unlocked balance covers it.
          feePendingAt = new Date()
          logInfo({ payoutId: payout.id }, 'sendBountyPayments: fee settlement deferred (change locked); will retry on a later tick')
        } else {
          // Fee stays in escrow; the payout is still valid — log and continue.
          logError({ payoutId: payout.id, err }, 'sendBountyPayments: fee settlement FAILED (fee stays in escrow; reconcile manually)')
        }
      }
    }

    // ROLLOVER: book the BOUNTY PORTION to the pool (100% rewards via the
    // BOUNTY_ROLLOVER ledger source). The fee was already booked at funding
    // confirmation (BOUNTY_FEE, 100% ops) and physically rides along unbooked
    // in this payout tx — so the pool ledger books exactly what the rewards
    // wallet receives (bounty) and the ops ledger exactly what funding booked
    // (fee): ledger-vs-wallet exact by construction.
    if (payout.kind === 'ROLLOVER') {
      // The bounty portion = the item's booked bountyPiconeros, NOT the relayed
      // amount (bounty + fee). Booking `amount` would double-count the fee
      // against the pool ledger (BOUNTY_FEE is already booked 100% ops at
      // funding confirmation).
      const item = await models.item.findUnique({ where: { id: payout.itemId } })
      if (!item) {
        logError({ payoutId: payout.id, itemId: payout.itemId, txHash }, 'sendBountyPayments: CRITICAL — rollover relayed and the bounty portion physically arrived at the rewards wallet, but the bounty item was not found; pool booking skipped; manual reconciliation required')
      } else {
        try {
          await models.$queryRaw`
            INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","state","detectedAt","confirmedAt")
            VALUES (${txHash}, NULL, 'BOUNTY_ROLLOVER'::"FeeType", ${payout.itemId}, NULL, 0, 0, ${item.bountyPiconeros}, NULL, 'CONFIRMED'::"ObservedState", NOW(), NOW())
            ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING`
        } catch (err) {
          logError({ payoutId: payout.id, txHash, err }, 'sendBountyPayments: CRITICAL — rollover relayed but pool booking failed; manual reconciliation required')
        }
      }
    }

    // Best-effort block height for maturity: the bounties worker flips
    // SENT -> CONFIRMED once the tx is REQUIRED_CONFIRMATIONS deep. Unavailable
    // height just defers maturity to a later run (the worker backfills it from
    // lws by tx hash — never a correctness issue).
    let height = null
    try { height = await w.getTx(txHash).then(t => t.getHeight()).catch(() => null) } catch { /* ignore */ }

    try {
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash, height, sentAt: new Date(), feeTxHash, feePendingAt }
      })
      sent += 1
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
