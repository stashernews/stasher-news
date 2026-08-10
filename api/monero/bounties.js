import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'

// Bounty escrow signer (A-13, 2026-08-10 amendment). The ONLY component that
// holds the BOUNTY ESCROW wallet's spend key (separate standalone wallet — never
// the rewards wallet). Opens an in-memory monero-ts wallet from env, sends each
// QUEUED BountyPayment, records the tx hash, flips QUEUED -> SENT.
//
// Fund-safety mirrors api/monero/rewards.js: keys from env (never logged),
// insufficient-unlocked-balance = SKIP (retry next run) not FAILED, FAILED only
// on hard createTx errors (funds stay in escrow).

const RESTORE_HEIGHT_MARGIN = 1000

let walletPromise = null

export async function getBountyEscrowWallet () {
  if (!walletPromise) {
    walletPromise = openBountyEscrowWallet().catch(err => {
      walletPromise = null
      throw err
    })
  }
  return walletPromise
}

async function openBountyEscrowWallet () {
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
  let restoreHeight = Number(process.env.BOUNTY_ESCROW_SCAN_FROM_HEIGHT) || 0
  if (!restoreHeight) {
    try { restoreHeight = Math.max(0, await daemonClient.getHeight() - RESTORE_HEIGHT_MARGIN) } catch { /* scan from genesis; send fails loudly */ }
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

// Pure helper: platform bounty fee = max(min, pct% of bounty). Exported for
// tests + reuse by the funding flow and the signer's fee settlement.
export function bountyFeePiconeros (bountyPiconeros, { bountyFeeMinPiconeros, bountyFeePct }) {
  const pct = BigInt(bountyPiconeros) * BigInt(bountyFeePct) / 100n
  return pct > BigInt(bountyFeeMinPiconeros) ? pct : BigInt(bountyFeeMinPiconeros)
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
  if (queued.length === 0) return { sent: 0, failed: 0, skipped: 0 }
  const w = wallet || await getBountyEscrowWallet()
  let unlocked = BigInt(await w.getUnlockedBalance(0))
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const payout of queued) {
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
    if (payout.kind !== 'ROLLOVER' && payout.feePiconeros > 0n) {
      try {
        const feeTx = await w.createTx({
          accountIndex: 0,
          address: process.env.REWARDS_COLD_STORAGE_ADDRESS || process.env.PLATFORM_REWARDS_ADDRESS,
          amount: payout.feePiconeros,
          relay: true
        })
        feeTxHash = toTxHash(feeTx.getHash())
        unlocked -= payout.feePiconeros
        logInfo({ payoutId: payout.id, feeTxHash }, 'sendBountyPayments: fee settlement relayed')
      } catch (err) {
        // Fee stays in escrow; the payout is still valid — log and continue.
        logError({ payoutId: payout.id, err }, 'sendBountyPayments: fee settlement FAILED (fee stays in escrow; reconcile manually)')
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
    // height just defers maturity to a later run (never a correctness issue).
    let height = null
    try { height = await w.getTx(txHash).then(t => t.getHeight()).catch(() => null) } catch { /* ignore */ }

    try {
      await models.bountyPayment.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash, height, sentAt: new Date(), feeTxHash }
      })
      sent += 1
    } catch (err) {
      logError({ payoutId: payout.id, txHash, err }, 'sendBountyPayments: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      alert('critical', 'relayed-but-unpersisted bounty payout',
        `bounty payout ${payout.id} tx ${txHash} relayed but DB persist failed; manual reconciliation required`,
        { dedupeKey: `bounty-relay-unpersisted-${txHash}` })
    }
  }
  return { sent, failed, skipped }
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
