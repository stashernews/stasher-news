import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { lwsClient } from '@/api/monero/lwsClient'
import { readBountySettlement, readFeeSettlement } from '@/api/monero/bountySettlement'
import {
  prepareEscrowTransaction,
  relayEscrowTransaction,
  reconcileEscrowTransactions
} from '@/api/monero/escrowTransactions'
import { errorLabel } from '@/api/monero/rewardsTransactions'

// Bounty escrow signer (A-13, 2026-08-10 amendment). The ONLY component that
// holds the BOUNTY ESCROW wallet's spend key (separate standalone wallet — never
// the rewards wallet). Opens an in-memory monero-ts wallet from env, sends each
// QUEUED BountyPayment through the capture barrier, records the tx hash, flips
// QUEUED -> SENT.
// Each payout is ONE tx: prize + platform fee as destinations with the network
// fee subtracted from the last one (the ops cut, or the payout destination for
// ROLLOVER / fee-waived refunds), so the winner/refund receives the exact
// booked amount and the escrow consumes exactly prize + fee (2026-09-18 fix:
// exact-funded awards used to strand a network fee short).
// Every dispatch follows the same capture boundary (Finding #1): build
// relay:false -> snapshot the ACTUAL built-tx settlement (real network fee,
// real net received amounts) BEFORE anything commits -> freeze the fee
// destination -> prepare the durable journal+proof pair (ESCROW owner role) ->
// authenticate the pair -> CAS the single relay attempt -> relayTx the SAME
// object once, outside any transaction -> persist through the existing guarded
// paths. A relay timeout or a post-relay persistence failure can never cause a
// second broadcast: the durable dispatch withholds its exact
// (bountyPaymentId, leg) on every later drive, and reconciliation recovers
// settlement facts DB-only. An ambiguous settlement or a changed frozen
// contract stops BEFORE relay. The fee destination is frozen BEFORE dispatch
// (once, when NULL) — never derived from today's environment after the fact.
// Relay writes NO hot-wallet receipt: escrow cash is recognized later from
// confirmed hot-wallet receipts only (rewards accounting repair §4).
// Re-syncs the wallet's chain view once per dispatch before reading balances,
// so outputs that unlock after open are visible without a worker restart.
//
// Fund-safety mirrors api/monero/rewards.js: keys from env (never logged),
// insufficient-unlocked-balance = SKIP (retry next run) not FAILED, FAILED only
// on hard pre-relay errors (funds stay in escrow). Logs and alerts on touched
// send paths carry fixed error labels only — never exception text, envelope,
// key or session material.

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

// The wallet is the accounting authority for the escrow scope: derive the
// network/address from the wallet itself (never from environment text) so
// reconciliation and preparation always bind to the wallet that will sign.
// Installed monero-ts network enum values, mirrored from rewardsTransactions.
const NETWORK_NAMES = { 0: 'MAINNET', 2: 'STAGENET' }

async function escrowWalletScope (wallet) {
  const networkType = typeof wallet?.getNetworkType === 'function' ? await wallet.getNetworkType() : undefined
  const network = typeof networkType === 'number' ? NETWORK_NAMES[networkType] : undefined
  const walletAddress = typeof wallet?.getPrimaryAddress === 'function' ? await wallet.getPrimaryAddress() : undefined
  if (network === undefined || typeof walletAddress !== 'string' || walletAddress.trim() === '') {
    throw new Error('bounty escrow signer: the escrow wallet cannot prove its network/address scope')
  }
  return { network, walletAddress }
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
export async function sendBountyPayments (payouts, { models, wallet, keyProvider } = {}) {
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

  // Durable dispatches resolve BEFORE any fresh candidate filtering or build.
  // The wallet is the scope authority; attempted/unattempted/RELAYED dispatches
  // withhold their exact (bountyPaymentId, leg) on every later drive and durable
  // RELAYED dispatches recover settlement facts DB-only (no re-send), so a
  // relay timeout or a post-relay persistence failure can never cause a second
  // broadcast. A failed safety read refuses fresh sends (fail-closed).
  const scope = await escrowWalletScope(w)
  let safety
  try {
    safety = await reconcileEscrowTransactions({ models, wallet: w, scope, keyProvider })
  } catch (err) {
    logError({ errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — escrow dispatch safety unavailable; refusing fresh sends (fail-closed)')
    return { sent: 0, failed: 0, skipped: queued.length + pendingFees.length, settled: 0 }
  }
  const withheldDisposition = new Set(safety.withheldDispositionIds)
  const withheldFee = new Set(safety.withheldFeeIds)
  const liveQueued = queued.filter(p => !withheldDisposition.has(p.id))
  const livePendingFees = pendingFees.filter(p => !withheldFee.has(p.id))
  if (withheldDisposition.size > 0 || withheldFee.size > 0) {
    logInfo({
      withheldDispositionIds: safety.withheldDispositionIds,
      withheldFeeIds: safety.withheldFeeIds,
      recoveredIds: safety.recoveredIds,
      accountingUnpersisted: safety.accountingUnpersisted
    }, 'sendBountyPayments: durable escrow dispatches withheld this run (never rebuilt, never re-relayed)')
  }
  if (liveQueued.length === 0 && livePendingFees.length === 0) {
    return { sent: 0, failed: 0, skipped: 0, settled: 0 }
  }

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
      logError({ payoutId: payout.id, errorClass: errorLabel(err) }, 'sendBountyPayments: fee destination persist failed before dispatch; payout left QUEUED (no funds moved)')
      return null
    }
    return feeAddress
  }

  for (const payout of [...liveQueued, ...livePendingFees]) {
    if (payout.feePendingAt) {
      // Fee-settlement retry for a payout whose fee was deferred on a prior
      // tick (the payout's change output was locked until the payout tx
      // confirmed). The payout itself is already SENT/CONFIRMED and must NOT
      // be re-sent — only the fee is relayed, once the unlocked balance covers
      // it, through the same capture barrier as every other dispatch. Works for
      // SENT and CONFIRMED payouts alike: the change can unlock after the
      // payout matures, so the retry must not stop at CONFIRMED or the fee
      // strands in escrow forever.
      if (payout.kind === 'ROLLOVER' || payout.feePiconeros <= 0n || payout.feeTxHash) continue
      if (unlocked < payout.feePiconeros) {
        bumpSkipStreak(payout, unlocked, payout.feePiconeros)
        skipped += 1
        continue
      }
      const feeRecipientAddress = await resolveFeeDestination(payout)
      if (!feeRecipientAddress) continue

      // Build relay:false so the ACTUAL settlement can be extracted before
      // anything commits; the legacy full-fee destination rides with NO
      // subtraction and its own extra miner cost (contract unchanged).
      let feeTx
      try {
        feeTx = await w.createTx({
          accountIndex: 0,
          address: feeRecipientAddress,
          amount: payout.feePiconeros,
          relay: false
        })
      } catch (err) {
        if (isBalanceError(err)) {
          bumpSkipStreak(payout, unlocked, payout.feePiconeros)
          skipped += 1
          continue
        }
        clearSkipStreak(payout.id)
        // Hard error: stop auto-retrying and leave it for manual reconciliation.
        await models.bountyPayment.update({ where: { id: payout.id }, data: { feePendingAt: null } })
        logError({ payoutId: payout.id, errorClass: errorLabel(err) }, 'sendBountyPayments: fee settlement FAILED (fee stays in escrow; reconcile manually)')
        continue
      }
      unlocked -= payout.feePiconeros
      clearSkipStreak(payout.id)

      // The BUILT fee tx must settle to the frozen fee destination before the
      // durable pair commits: an unattributable fee tx is never relayed.
      let feeSettlement
      try {
        feeSettlement = await readFeeSettlement(feeTx, { feeRecipientAddress })
      } catch (err) {
        logError({ payoutId: payout.id, txHash: toTxHash(feeTx.getHash()), errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — separate fee settlement not attributable; stopping before relay (fee stays in escrow)')
        alert('critical', 'separate fee settlement not attributable',
          `bounty payout ${payout.id}: the built separate fee transaction cannot be attributed to its frozen fee destination; nothing was relayed and the fee stays in escrow for a later retry or manual review`,
          { dedupeKey: `bounty-fee-settlement-unattributable-${payout.id}` })
        continue
      }

      // Durable pair + barrier: prepare (ESCROW owner role, separate fee leg)
      // -> authenticate -> claim the single attempt -> relay the SAME object
      // once -> persist through the existing guarded path. Every thrown or
      // uncertain outcome leaves the fee leg withheld through the durable
      // dispatch — never rebuilt, never blindly re-relayed.
      let journal
      try {
        journal = await prepareEscrowTransaction({
          models,
          wallet: w,
          tx: feeTx,
          payout: { ...payout, feeRecipientAddress },
          leg: 'LEGACY_SEPARATE_FEE',
          settlement: feeSettlement,
          scope,
          keyProvider
        })
      } catch (err) {
        logError({ payoutId: payout.id, txHash: toTxHash(feeTx.getHash()), errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — separate fee dispatch preparation failed or is unresolved; fee stays in escrow (nothing relayed)')
        alert('critical', 'separate fee dispatch withheld',
          `bounty payout ${payout.id}: its durable separate-fee dispatch could not be prepared or its outcome is unresolved (${errorLabel(err)}); nothing was relayed and the fee leg stays withheld from rebuilding until the dispatch outcome is resolved`,
          { dedupeKey: `bounty-fee-dispatch-withheld-${payout.id}` })
        skipped += 1
        continue
      }
      let relay
      try {
        relay = await relayEscrowTransaction({ models, wallet: w, journal, tx: feeTx, keyProvider })
      } catch (err) {
        logError({ payoutId: payout.id, txHash: journal.txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — separate fee relay claim failed or is unresolved; fee leg stays withheld (nothing relayed)')
        alert('critical', 'separate fee relay withheld',
          `bounty payout ${payout.id}: its separate-fee relay could not be authorized or the attempt outcome is unresolved (${errorLabel(err)}); the durable dispatch withholds the fee leg and it is never rebuilt or blindly re-relayed`,
          { dedupeKey: `bounty-fee-relay-withheld-${payout.id}` })
        skipped += 1
        continue
      }
      if (!relay.relayed) {
        // Relay outcome UNCERTAIN: the fee may have left escrow. The durable
        // attempted dispatch withholds this exact leg from every later drive
        // (no second broadcast); a fresh confirmed verification or the durable
        // RELAYED recovery resolves it.
        logError({ payoutId: payout.id, txHash: relay.txHash }, 'sendBountyPayments: CRITICAL — separate fee relay outcome uncertain; the durable dispatch withholds the fee leg (do not re-send)')
        alert('critical', 'separate fee relay outcome uncertain',
          `bounty payout ${payout.id} fee tx ${relay.txHash} may have been relayed but the outcome is unconfirmed; do not re-send — the durable dispatch withholds the fee leg until a fresh confirmed verification or reconciliation resolves it`,
          { dedupeKey: `bounty-fee-relay-uncertain-${relay.txHash}` })
        continue
      }
      // Relay proven: persist the extracted settlement facts. A persist failure
      // leaves feePendingAt SET so the next drive's reconciliation recovers the
      // facts DB-only from the durable RELAYED dispatch (which also withholds
      // the leg, so the fee can never be relayed twice).
      try {
        await models.bountyPayment.update({
          where: { id: payout.id },
          data: {
            feeTxHash: relay.txHash,
            feePendingAt: null,
            feeSettlementNetworkFeePiconeros: feeSettlement.networkFeePiconeros,
            feeReceivedPiconeros: feeSettlement.feeReceivedPiconeros
          }
        })
        settled += 1
        logInfo({ payoutId: payout.id, feeTxHash: relay.txHash }, 'sendBountyPayments: deferred fee settlement relayed')
      } catch (err) {
        logError({ payoutId: payout.id, txHash: relay.txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — fee relayed but DB persist failed; reconciliation recovers it (do not re-send)')
        alert('critical', 'fee-relayed-but-unpersisted',
          `bounty payout ${payout.id} fee tx ${relay.txHash} relayed but DB persist failed; manual reconciliation required`,
          { dedupeKey: `fee-relay-unpersisted-${relay.txHash}` })
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
        relay: false
      })
    } catch (err) {
      if (isBalanceError(err)) {
        bumpSkipStreak(payout, unlocked, needs)
        skipped += 1
        continue
      }
      clearSkipStreak(payout.id)
      logError({ payoutId: payout.id, errorClass: errorLabel(err) }, 'sendBountyPayments: payout FAILED (funds stayed in escrow)')
      await models.bountyPayment.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
      failed += 1
      continue
    }
    unlocked -= needs
    clearSkipStreak(payout.id)
    const txHash = toTxHash(tx.getHash())

    // Extract the ACTUAL settlement of the BUILT tx BEFORE the pair commits: an
    // ambiguous or unreadable settlement is never relayed (the payout is FAILED
    // with nothing moved; the pre-barrier code relayed first and alerted after).
    let settlement
    try {
      settlement = await readBountySettlement(tx, { payout, feeRecipientAddress: fee > 0n ? feeRecipientAddress : null })
    } catch (err) {
      logError({ payoutId: payout.id, txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — payout settlement not attributable; stopping before relay')
      alert('critical', 'payout settlement not attributable',
        `bounty payout ${payout.id} (kind ${payout.kind}) built a transaction whose settlement cannot be attributed to its frozen terms; nothing was relayed and the funds stayed in escrow`,
        { dedupeKey: `bounty-settlement-unattributable-${payout.id}` })
      await models.bountyPayment.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
      failed += 1
      continue
    }

    // Durable pair + barrier: prepare (ESCROW owner role, disposition leg) ->
    // authenticate -> claim the single attempt -> relay the SAME object once ->
    // persist the pre-relay settlement through the existing guarded path. Every
    // thrown or uncertain outcome leaves the leg withheld through the durable
    // dispatch — never rebuilt, never blindly re-relayed.
    const frozenPayout = { ...payout, feeRecipientAddress: fee > 0n ? feeRecipientAddress : null }
    let journal
    try {
      journal = await prepareEscrowTransaction({
        models,
        wallet: w,
        tx,
        payout: frozenPayout,
        leg: 'DISPOSITION',
        settlement,
        scope,
        keyProvider
      })
    } catch (err) {
      logError({ payoutId: payout.id, txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — escrow dispatch preparation failed or is unresolved; payout stays QUEUED (nothing relayed)')
      alert('critical', 'bounty escrow dispatch withheld',
        `bounty payout ${payout.id} (kind ${payout.kind}) could not prepare its durable escrow dispatch or its outcome is unresolved (${errorLabel(err)}); nothing was relayed and the payout leg stays withheld from rebuilding until the dispatch outcome is resolved`,
        { dedupeKey: `escrow-dispatch-withheld-${payout.id}` })
      skipped += 1
      continue
    }
    let relay
    try {
      relay = await relayEscrowTransaction({ models, wallet: w, journal, tx, keyProvider })
    } catch (err) {
      logError({ payoutId: payout.id, txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — escrow relay claim failed or is unresolved; payout stays QUEUED (nothing relayed)')
      alert('critical', 'bounty escrow relay withheld',
        `bounty payout ${payout.id}: its escrow relay could not be authorized or the attempt outcome is unresolved (${errorLabel(err)}); the durable dispatch withholds the payout leg and it is never rebuilt or blindly re-relayed`,
        { dedupeKey: `escrow-relay-withheld-${payout.id}` })
      skipped += 1
      continue
    }
    if (!relay.relayed) {
      // Relay outcome UNCERTAIN: the payout may have left escrow. The durable
      // attempted dispatch withholds this exact leg from every later drive (no
      // second broadcast); a fresh confirmed verification or the durable
      // RELAYED recovery resolves it.
      logError({ payoutId: payout.id, txHash: relay.txHash }, 'sendBountyPayments: CRITICAL — payout relay outcome uncertain; the durable dispatch withholds this leg (do not re-send)')
      alert('critical', 'bounty payout relay outcome uncertain',
        `bounty payout ${payout.id} tx ${relay.txHash} may have been relayed but the outcome is unconfirmed; do not re-send — the durable dispatch withholds the leg until a fresh confirmed verification or reconciliation resolves it`,
        { dedupeKey: `bounty-relay-uncertain-${relay.txHash}` })
      continue
    }

    // Best-effort block height for maturity: the bounties worker flips
    // SENT -> CONFIRMED once the tx is REQUIRED_CONFIRMATIONS deep. Unavailable
    // height just defers maturity to a later run (the worker backfills it from
    // lws by tx hash — never a correctness issue).
    let height = null
    try { height = await w.getTx(relay.txHash).then(t => t.getHeight()).catch(() => null) } catch { /* ignore */ }

    try {
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: {
          state: 'SENT',
          txHash: relay.txHash,
          height,
          sentAt: new Date(),
          networkFeePiconeros: settlement.networkFeePiconeros,
          recipientReceivedPiconeros: settlement.recipientReceivedPiconeros,
          feeReceivedPiconeros: settlement.feeReceivedPiconeros
        }
      })
      sent += 1
      logInfo({ payoutId: payout.id, txHash: relay.txHash, kind: payout.kind }, 'sendBountyPayments: payout relayed')
    } catch (err) {
      logError({ payoutId: payout.id, txHash: relay.txHash, errorClass: errorLabel(err) }, 'sendBountyPayments: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      alert('critical', 'relayed-but-unpersisted bounty payout',
        `bounty payout ${payout.id} tx ${relay.txHash} relayed but DB persist failed; manual reconciliation required`,
        { dedupeKey: `bounty-relay-unpersisted-${relay.txHash}` })
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
