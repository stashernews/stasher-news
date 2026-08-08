import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'

// Rewards hot-wallet signer (Phase 4 Task 9 / design spec §5.6, §6.2).
//
// The ONLY component in the running stack that holds the platform rewards
// wallet's SPEND key. It opens a full (spend-capable) MoneroWalletWasm from the
// view+spend keys in env (kept in memory for the worker process lifetime), then
// sends each QUEUED RewardPayout as a real on-chain Monero tx, records the tx
// hash, and flips the payout QUEUED -> SENT (confirmFinalizer later matures
// SENT -> CONFIRMED at N confirmations).
//
// Fund-safety rules (see task-9 brief + design spec):
//   - keys are read from env and NEVER logged / serialized;
//   - sending requires UNLOCKED funds — recently-received outputs are locked
//     ~10 blocks, so an insufficient unlocked balance is a SKIP (payout stays
//     QUEUED, retried next run), NOT a FAILED (FAILED is for hard errors only);
//   - a hard createTx error marks the payout FAILED, but the funds stay in the
//     wallet — a FAILED payout's share rolls into next week's pool (no loss).
//
// Daemon = monerod (MONEROD_URL), NOT lws: signing needs real ringCT decoys
// which the light wallet scanner cannot serve.

const RESTORE_HEIGHT_MARGIN = 1000

// Dust floor for the weekly ops sweep to cold storage: sweep only leaves the
// hot wallet with at least this much unlocked, and only fires if the target
// clears it. 0.001 XMR default (spec §6.4 / task B3).
const REWARDS_OPS_SWEEP_MIN_PICONEROS = BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')

let walletPromise = null

// Singleton: opens + syncs the wallet once, memoizing the promise so every
// sendPayouts call reuses the same in-memory wallet. A cached rejection is
// cleared so a later call can retry instead of failing forever.
export async function getRewardsWallet () {
  if (!walletPromise) {
    walletPromise = openRewardsWallet().catch(err => {
      walletPromise = null
      throw err
    })
  }
  return walletPromise
}

async function openRewardsWallet () {
  const primaryAddress = process.env.PLATFORM_REWARDS_ADDRESS
  const privateSpendKey = process.env.PLATFORM_REWARDS_SPEND_KEY
  const privateViewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  if (!primaryAddress || !privateSpendKey || !privateViewKey) {
    throw new Error('rewards signer: PLATFORM_REWARDS_ADDRESS, PLATFORM_REWARDS_SPEND_KEY, and PLATFORM_REWARDS_VIEW_KEY must be configured')
  }

  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = resolveNetworkType(api, process.env.MONERO_NETWORK)
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'

  // Scan from near the chain tip (height - 1000) to keep the restored-wallet
  // sync fast, mirroring phase3-tipping-posting-fees-stagenet's RESTORE_HEIGHT_MARGIN.
  // REWARDS_SCAN_FROM_HEIGHT overrides for an operator who knows the exact height.
  let restoreHeight = Number(process.env.REWARDS_SCAN_FROM_HEIGHT) || 0
  if (!restoreHeight) {
    try { restoreHeight = Math.max(0, await daemonClient.getHeight() - RESTORE_HEIGHT_MARGIN) } catch { /* daemon down -> from-genesis scan; send fails loudly anyway */ }
  }

  // In-memory wallet (no `path`): reopened from keys each worker boot, so there
  // is no on-disk wallet file to conflict on restart.
  // password is a required-but-meaningless placeholder for an in-memory wallet
  // (no `path`, so nothing is persisted/encrypted to decrypt) — NOT a secret.
  const wallet = await api.createWalletFull({
    password: 'platform-rewards-signer',
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

function resolveNetworkType (api, env) {
  const n = String(env || 'stagenet').toLowerCase()
  if (n === 'mainnet') return api.MoneroNetworkType.MAINNET
  if (n === 'testnet') return api.MoneroNetworkType.TESTNET
  return api.MoneroNetworkType.STAGENET
}

// Send a batch of RewardPayout rows. For each QUEUED payout: check unlocked
// balance, createTx({ relay: true }), record the hash + flip SENT; on a hard
// error flip FAILED (funds stay in-wallet). `wallet` is injectable so the logic
// is unit-testable without the real keys/wallet; production leaves it unset and
// uses the getRewardsWallet() singleton.
//
// Returns { sent, failed, skipped }.
export async function sendPayouts (payouts, { models, wallet } = {}) {
  const queued = (payouts || []).filter(p => p.state === 'QUEUED')
  if (queued.length === 0) return { sent: 0, failed: 0, skipped: 0 }

  const w = wallet || await getRewardsWallet()
  // Coarse pre-filter: if the whole wallet's unlocked balance can't cover this
  // payout, skip it (likely locked funds). The running balance is decremented
  // after each relayed tx so it stays accurate mid-batch; any residual
  // exhaustion (fees, races) still surfaces as a balance error from createTx
  // and is treated as a skip (see below).
  let unlocked = BigInt(await w.getUnlockedBalance(0))

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const payout of queued) {
    if (unlocked < payout.piconeros) {
      skipped += 1
      continue
    }
    // Relay (broadcast) is split from persist so a relayed tx hash is NEVER lost.
    // createTx({ relay: true }) moves funds on-chain; if the DB write then throws,
    // the catch below still has the hash (logged the instant relay succeeded) and
    // never marks the payout FAILED — FAILED implies funds stayed in the wallet.
    let tx
    try {
      tx = await w.createTx({
        accountIndex: 0,
        address: payout.recipientAddress,
        amount: payout.piconeros,
        relay: true
      })
    } catch (err) {
      // PRE-relay failure: funds never left the wallet.
      if (isBalanceError(err)) {
        // not enough unlocked money -> retryable, do not abandon as FAILED
        skipped += 1
        continue
      }
      logError({ payoutId: payout.id, recipient: payout.recipientAddress.slice(0, 12), err }, 'sendPayouts: payout FAILED (funds stayed in wallet)')
      await models.rewardPayout.update({
        where: { id: payout.id },
        data: { state: 'FAILED' }
      })
      failed += 1
      continue
    }
    // Relay succeeded — funds are on-chain. Deduct from the running pre-filter
    // so the next iteration sees the reduced unlocked balance, then persist the
    // hash BEFORE anything else and log it the instant relay succeeds so it is
    // never silently lost.
    unlocked -= payout.piconeros
    const txHash = toTxHash(tx.getHash())
    logInfo({ payoutId: payout.id, txHash }, 'sendPayouts: payout relayed')
    try {
      await models.rewardPayout.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash }
      })
      sent += 1
    } catch (err) {
      // The tx IS sent (funds left). Retry once; on failure do NOT mark FAILED —
      // a CRITICAL log is the reconciliation signal for a manual fix.
      logError({ payoutId: payout.id, txHash, err }, 'sendPayouts: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      try {
        await models.rewardPayout.update({
          where: { id: payout.id },
          data: { state: 'SENT', txHash }
        })
        sent += 1
      } catch (err2) {
        logError({ payoutId: payout.id, txHash, err: err2 }, 'sendPayouts: CRITICAL — DB-update retry also failed')
        alert('critical', 'relayed-but-unpersisted payout',
          `payout ${payout.id} tx ${txHash} relayed but DB persist failed (retry also failed); manual reconciliation required`,
          { dedupeKey: `relay-unpersisted-${txHash}` })
      }
    }
  }

  return { sent, failed, skipped }
}

// Sweep the weekly ops earmark from the hot rewards wallet to offline cold
// storage (spec §6.4 / task B3). Runs as ONE more sequential createTx on the
// SAME singleton wallet, strictly AFTER sendPayouts returns (task B4 wires the
// call site) — never concurrent, never a second wallet, so no same-output
// double-spend (monero-ts marks an input spent in-memory the instant a tx
// relays). The target is capped by the FRESH unlocked balance minus the dust
// floor so the hot wallet is never drained to zero (locked change can still
// defer it; the remainder rolls into next week's opsRolledOver).
//
// Relay-before-persist mirrors sendPayouts: a relayed tx hash is captured the
// instant createTx succeeds and logged before any DB write, so it is never
// silently lost; a persist failure retries once then logs CRITICAL (manual
// reconciliation) rather than flipping FAILED — FAILED means funds STAYED in
// the wallet, which a post-relay persist blip does not satisfy.
//
// `wallet` is injectable for unit tests; production leaves it unset and reuses
// the getRewardsWallet() singleton.
export async function sweepOpsEarmark ({ distribution, models, wallet } = {}) {
  if (distribution?.opsSweepState === 'SWEPT') {
    return { state: 'SWEPT', txHash: distribution.opsSweepTxHash, swept: distribution.opsSweptPiconeros }
  }

  const coldAddress = process.env.REWARDS_COLD_STORAGE_ADDRESS
  const sweepEnabled = String(process.env.REWARDS_OPS_SWEEP_ENABLED ?? 'true') !== 'false'
  if (!sweepEnabled || !coldAddress) {
    return { state: 'DISABLED' }
  }

  const w = wallet || await getRewardsWallet()
  const unlocked = BigInt(await w.getUnlockedBalance(0))
  const opsAvailable = BigInt(distribution.opsAvailablePiconeros)
  const target = opsAvailable < unlocked - REWARDS_OPS_SWEEP_MIN_PICONEROS
    ? opsAvailable
    : unlocked - REWARDS_OPS_SWEEP_MIN_PICONEROS

  if (target <= REWARDS_OPS_SWEEP_MIN_PICONEROS) {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SKIPPED_LOCKED' }
    })
    return { state: 'SKIPPED_LOCKED' }
  }

  let tx
  try {
    tx = await w.createTx({
      accountIndex: 0,
      address: coldAddress,
      amount: target,
      relay: true
    })
  } catch (err) {
    if (isBalanceError(err)) {
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { opsSweepState: 'SKIPPED_LOCKED' }
      })
      return { state: 'SKIPPED_LOCKED' }
    }
    logError({ distributionId: distribution.id, err }, 'sweepOpsEarmark: sweep FAILED')
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'FAILED' }
    })
    return { state: 'FAILED' }
  }

  const txHash = toTxHash(tx.getHash())
  logInfo({ distributionId: distribution.id, txHash, swept: target.toString() }, 'sweepOpsEarmark: ops sweep relayed')
  try {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SWEPT', opsSweptPiconeros: target, opsSweepTxHash: txHash }
    })
  } catch (err) {
    logError({ distributionId: distribution.id, txHash, err }, 'sweepOpsEarmark: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
    try {
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { opsSweepState: 'SWEPT', opsSweptPiconeros: target, opsSweepTxHash: txHash }
      })
    } catch (err2) {
      logError({ distributionId: distribution.id, txHash, err: err2 }, 'sweepOpsEarmark: CRITICAL — DB-update retry also failed')
      alert('critical', 'relayed-but-unpersisted ops sweep',
        `distribution ${distribution.id} sweep tx ${txHash} relayed but DB persist failed (retry also failed); manual reconciliation required`,
        { dedupeKey: `relay-unpersisted-${txHash}` })
    }
  }

  return { state: 'SWEPT', txHash, swept: target }
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
