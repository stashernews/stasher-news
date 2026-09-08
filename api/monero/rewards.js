import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { moneroRewardsWalletBalancePiconeros } from '@/lib/metrics'

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
//   - a hard createTx error marks the batch FAILED, but the funds stay in the
//     wallet (no loss of principal); a CRITICAL alert + manual reconciliation
//     re-enters them into a future pool (FAILED payouts are counted in
//     distributedPiconeros, so they do not auto-roll into next week's pool).
//
// Daemon = monerod (MONEROD_URL), NOT lws: signing needs real ringCT decoys
// which the light wallet scanner cannot serve.

const RESTORE_HEIGHT_MARGIN = 1000

// Accounts on the rewards wallet the signer can spend from: 0 = primary
// (downvote payment-ID inflow + consolidated funds), 1..5 = fee-pool majors
// (api/monero/feePool.js REWARDS_*_MAJOR: 1 posting, 2 territory, 3 donate,
// 4 tip-unwalleted, 5 boost). Local const, not an import from feePool.js —
// that module creates a Prisma client at import time and this module is
// unit-tested without one.
const SIGNER_ACCOUNTS = [0, 1, 2, 3, 4, 5]

// Dust floor for the weekly ops sweep to cold storage: sweep only leaves the
// hot wallet with at least this much unlocked, and only fires if the target
// clears it. 0.001 XMR default (spec §6.4 / task B3).
const REWARDS_OPS_SWEEP_MIN_PICONEROS = BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')

// Consolidate only funded fee accounts above this dust floor — sweeping a
// near-empty account just burns a tx fee (or throws on dust), and the throw
// fired a spurious per-account CRITICAL. Fixed 0.0001 XMR (audit #4).
const CONSOLIDATION_MIN_PICONEROS = 100_000_000n

// Per-tx fee headroom for signer sends: the ops sweep retries a full-balance
// send at amount minus this step when the real fee pushes it over, and payout
// packing reserves this much per account so packed buckets leave fee room.
// 0.001 XMR default comfortably covers default-priority Monero fees.
const TX_FEE_HEADROOM_PICONEROS = BigInt(process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS || '1000000000')

let walletPromise = null

// Singleton: opens + syncs the wallet once, memoizing the promise so every
// sendPayouts call reuses the same in-memory wallet. A cached rejection is
// cleared so a later call can retry instead of failing forever.
export async function getRewardsWallet (models) {
  if (!walletPromise) {
    walletPromise = openRewardsWallet(models).catch(err => {
      walletPromise = null
      throw err
    })
  }
  return walletPromise
}

// A wallet restored from keys only scans subaddresses it has explicitly
// derived, so before the first sync the signer mirrors the fee-pool shape:
// accounts 1..5 plus each major's subaddresses up to the pool's max minor
// (SubaddressIndex rows for platform_rewards). Derivation is deterministic
// (same keys), so this only makes the wallet SEE its own funds — it moves
// nothing. Exported for tests. No-ops with a warning when models is
// unavailable (send paths then behave account-0-only, like before this fix).
export async function ensureFeeAccounts (wallet, models) {
  if (!models?.$queryRaw) {
    logWarn('rewards signer: models unavailable at wallet open — skipping fee-account mirroring (account-0-only)')
    return
  }
  const maxMajor = Math.max(...SIGNER_ACCOUNTS)
  const accounts = await wallet.getAccounts()
  for (let i = accounts.length; i <= maxMajor; i++) {
    await wallet.createAccount()
  }
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const rows = await models.$queryRaw`
    SELECT si."majorIndex" AS major, COALESCE(MAX(si."minorIndex"), 0)::int AS "maxMinor"
    FROM "SubaddressIndex" si
    JOIN "MoneroAccount" ma ON si."accountId" = ma.id
    WHERE ma.label = 'platform_rewards' AND ma.network::text = ${network} AND si.state <> 'AVAILABLE'
    GROUP BY si."majorIndex"`
  for (const r of rows) {
    const major = Number(r.major)
    if (major < 1 || major > maxMajor) continue
    const subs = await wallet.getSubaddresses(major)
    for (let minor = subs.length; minor <= r.maxMinor; minor++) {
      await wallet.createSubaddress(major)
    }
  }
}

async function openRewardsWallet (models) {
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

  // Restore height (mirrors resolveBountyEscrowRestoreHeight in
  // api/monero/bounties.js): REWARDS_SCAN_FROM_HEIGHT wins; otherwise derive
  // one that covers the earliest recorded inflow (FeeObservation covers the
  // fee-pool accounts, ObservedDownvote covers account 0 — the wallet must see
  // its inflow, or payout batches skip forever with a silent ~0 unlocked
  // balance). Any fallback is a loud CRITICAL so ops notices. When the env var
  // is set the env path is untouched: no DB/daemon calls, no alert.
  const envHeight = Number(process.env.REWARDS_SCAN_FROM_HEIGHT) || 0
  let earliestInflowHeight = null
  let daemonHeight = null
  if (!envHeight) {
    if (models?.feeObservation) {
      try {
        const [feeAgg, downvoteAgg] = await Promise.all([
          models.feeObservation.aggregate({ _min: { height: true } }),
          models.observedDownvote.aggregate({ _min: { height: true } })
        ])
        const heights = [feeAgg._min.height, downvoteAgg._min.height].filter(h => h != null)
        if (heights.length > 0) earliestInflowHeight = Math.min(...heights)
      } catch { /* DB down — fall through to the daemon-margin fallback */ }
    }
    try { daemonHeight = await daemonClient.getHeight() } catch { /* daemon down — genesis scan */ }
  }
  const { restoreHeight, source } = resolveRewardsRestoreHeight({ envHeight, earliestInflowHeight, daemonHeight })
  if (source !== 'env') {
    alert('critical', 'rewards signer scan-from-height fallback',
      `REWARDS_SCAN_FROM_HEIGHT is 0/unset; opening the rewards wallet from height ${restoreHeight} (${source}). Set REWARDS_SCAN_FROM_HEIGHT below the earliest inflow to avoid invisible-funds payout skips.`,
      { dedupeKey: 'rewards-scan-height-fallback' })
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
  await ensureFeeAccounts(wallet, models)
  await wallet.sync()
  return wallet
}

// Resolve the rewards signer wallet's restore height. REWARDS_SCAN_FROM_HEIGHT
// wins when set; otherwise derive a height covering the earliest recorded
// inflow (the signer must always see its fees, or payout batches skip forever
// with a silent ~0 unlocked balance), falling back to a daemon-height margin
// and finally genesis. Exported for tests; the wallet opener alerts loudly on
// any non-env source.
export function resolveRewardsRestoreHeight ({ envHeight, earliestInflowHeight, daemonHeight }) {
  if (envHeight > 0) return { restoreHeight: envHeight, source: 'env' }
  if (earliestInflowHeight != null) {
    return { restoreHeight: Math.max(0, earliestInflowHeight - RESTORE_HEIGHT_MARGIN), source: 'earliest-inflow' }
  }
  if (daemonHeight != null) {
    return { restoreHeight: Math.max(0, daemonHeight - RESTORE_HEIGHT_MARGIN), source: 'daemon-margin' }
  }
  return { restoreHeight: 0, source: 'genesis' }
}

function resolveNetworkType (api, env) {
  const n = String(env || 'stagenet').toLowerCase()
  if (n === 'mainnet') return api.MoneroNetworkType.MAINNET
  if (n === 'testnet') return api.MoneroNetworkType.TESTNET
  return api.MoneroNetworkType.STAGENET
}

// Send a batch of RewardPayout rows split across the wallet's signer accounts:
// unlocked balances are aggregated over accounts 0 + fee pools 1-5, payouts are
// packed whole onto the accounts that cover them, and each account's slice goes
// out as ONE multi-output on-chain tx (fee-allocation v2: batching cuts per-tx
// fee overhead ~10x at top-N curator counts) — when no single account can host a
// payout, the fee accounts are consolidated into the primary and the run ends
// skipped/resumable. `wallet` is injectable so the logic is unit-testable
// without the real keys/wallet; production leaves it unset and uses the
// getRewardsWallet() singleton.
//
// Each account's batch is built create-then-relay: createTx({ relay: false })
// constructs + validates the tx (including its fee) WITHOUT moving funds, and
// the SAME tx object is then relayTx'd. When the fee pushes a bucket over the
// account's unlocked balance, the smallest payout is dropped and the bucket is
// rebuilt until it fits — dropped payouts stay QUEUED (resumable) rather than
// skipping the whole bucket (which cost full weekly cycles + a spurious
// CRITICAL). A payout is never split across txs.
//
// Fund-safety (unchanged from the per-payout design): a hard createTx error
// marks every QUEUED payout FAILED, but the funds stay in the wallet (no loss
// of principal); a CRITICAL alert + manual reconciliation re-enters them into
// a future pool. Insufficient
// unlocked balance (likely locked ~10-block outputs) is a SKIP for the whole
// batch: rows stay QUEUED and are retried next run.
//
// Returns { sent, failed, skipped, unpersisted } — `unpersisted` counts relayed
// payouts whose DB persist failed twice (money moved, no record: the driver
// must keep the distribution resumable, never COMPLETE), including rows the
// wallet-history reconciliation matched but could not persist; `skipped` also
// counts reconciliation rows excluded because their recorded-hash lookup threw
// (safety unprovable — fail closed, retried next run).
export async function sendPayouts (payouts, { models, wallet } = {}) {
  const queued = (payouts || []).filter(p => p.state === 'QUEUED')
  if (queued.length === 0) return { sent: 0, failed: 0, skipped: 0, unpersisted: 0 }

  const w = wallet || await getRewardsWallet(models)
  // Incremental sync: the singleton rewards wallet syncs once at open; without a
  // refresh here the unlocked-balance read below sees the stale cached view, and
  // a stale LOW balance skips the ENTIRE weekly batch (same root cause as the
  // bounties fee-retry stall, 2026-08-19/20). sync() is incremental from the
  // wallet's last processed height, and this only runs in the weekly
  // rewardsDistributor cron — never a web hot path. A sync error propagates to
  // finalizeDistribution (FAILED + CRITICAL, resumable next run) exactly like
  // the balance read.
  await w.sync()
  // Reconcile relayed-but-unpersisted rows from wallet history BEFORE sending:
  // a row whose tx already left the wallet must be flipped SENT, never re-sent,
  // and a row whose safety cannot be proven (DB read failed) is skipped this
  // run — a blind re-send of an already-relayed tx is a real double pay.
  const recon = await reconcileUnpersistedPayouts(w, models, queued)
  const live = queued.filter(p => !recon.excluded.includes(p))
  if (live.length === 0) {
    return { sent: recon.reconciled.length, failed: 0, skipped: recon.skipped, unpersisted: recon.unpersisted }
  }
  // Aggregate unlocked balance across ALL signer accounts (0 + fee pools 1-5):
  // the weekly pool physically sits in the fee-pool accounts, so an
  // account-0-only read can never cover the batch (the 2026-08-24
  // never-sends bug).
  const unlockedByAccount = {}
  let totalUnlocked = 0n
  for (const idx of SIGNER_ACCOUNTS) {
    const bal = BigInt(await w.getUnlockedBalance(idx))
    unlockedByAccount[idx] = bal
    totalUnlocked += bal
  }
  // Coarse pre-filter: if the WHOLE wallet's unlocked balance can't cover the
  // batch sum, skip it (likely locked funds) — nothing to consolidate either.
  const total = live.reduce((acc, p) => acc + p.piconeros, 0n)
  if (totalUnlocked < total) {
    return { sent: recon.reconciled.length, failed: 0, skipped: live.length + recon.skipped, unpersisted: recon.unpersisted }
  }

  // Pack payouts onto accounts (a payout is never split across txs), reserving
  // per-account fee headroom FIRST so packed buckets leave room for the tx fee
  // — exact-fit packing meant the fee pushed buckets over, the smallest payout
  // was dropped, and the distribution FAILED on a weekly cycle whenever pool ≈
  // wallet balance (audit #3). When the reserve makes packing impossible (a
  // payout only fits an account unreserved), fall back to exact packing —
  // relayBucketTx's drop-smallest backstop still guards fee overflows there.
  // Only when NO packing exists do we consolidate the fee accounts into
  // account 0 and end this run skipped — resumable; the next run sends from
  // account 0 once the sweep unlocks.
  const plan = planAccountSends(live, unlockedByAccount, TX_FEE_HEADROOM_PICONEROS) ||
    planAccountSends(live, unlockedByAccount, 0n)
  if (!plan) {
    await consolidateFeeAccounts(w)
    return { sent: recon.reconciled.length, failed: 0, skipped: live.length + recon.skipped, unpersisted: recon.unpersisted }
  }

  let sent = 0
  let failed = 0
  let skipped = 0
  let unpersisted = 0
  let sentPiconeros = 0n
  for (const bucket of plan) {
    const r = await relayBucketTx(w, models, bucket.accountIndex, bucket.payouts)
    sent += r.sent.length
    failed += r.failed
    skipped += r.skipped.length
    unpersisted += r.unpersisted
    sentPiconeros += r.sent.reduce((acc, p) => acc + p.piconeros, 0n)
  }

  if (skipped > 0) {
    // Some payout(s) did not fit (fee) or failed to relay. Consolidate the
    // remaining funds into account 0 so the resumable next run sends from there.
    await consolidateFeeAccounts(w)
  }

  sent += recon.reconciled.length
  skipped += recon.skipped
  unpersisted += recon.unpersisted
  sentPiconeros += recon.reconciled.reduce((acc, p) => acc + p.piconeros, 0n)
  setBalanceGauge(models, totalUnlocked - sentPiconeros)
  return { sent, failed, skipped, unpersisted }
}

// A payout can be relayed on-chain yet fail BOTH DB persists: the row stays
// QUEUED while the money moved, so a blind re-drive would DOUBLE PAY. Before
// sending, reconcile each QUEUED payout against the wallet's own outgoing
// history: an outgoing tx with a destination matching (recipientAddress,
// exact piconeros) whose hash is NOT recorded on any SENT/CONFIRMED payout
// row must be this payout's lost relay — flip it SENT with that hash instead
// of re-sending. The recorded-hash exclusion keeps prior weeks' payouts to
// the same curator (same address, coincidentally equal amount) from
// false-matching.
//
// Three mutually exclusive outcomes per row:
//   - reconciled: an outgoing match WAS found — money already moved in a
//     prior run — so the row counts as sent and is never re-sent. When the
//     persist STILL fails, `persistSentPayouts` returns 1 and the row is
//     additionally counted in `unpersisted` so the distribution goes
//     FAILED-resumable, never COMPLETE with an unrecorded relay.
//   - skipped: the recorded-hash lookup itself threw (DB unreadable, safety
//     unprovable) — fail CLOSED: excluded from this run's sends (a re-send of
//     an already-relayed tx is a real double pay); the next run with a
//     healthy DB reconciles it.
//   - otherwise: no match and a healthy lookup — the row stays live and sends
//     normally.
//
// Returns { reconciled, excluded, unpersisted, skipped }: `reconciled` is the
// array of matched rows (counted as sent by the caller), `excluded` carries
// every row that must NOT be sent this run (matched + unprovable, filtered by
// identity), and `unpersisted`/`skipped` are counts threaded into the send
// summary's resumability guard.
async function reconcileUnpersistedPayouts (w, models, queued) {
  const empty = { reconciled: [], excluded: [], unpersisted: 0, skipped: 0 }
  if (typeof w.getOutgoingTransfers !== 'function' ||
    typeof models.rewardPayout?.findMany !== 'function') return empty
  let outgoing = []
  try {
    outgoing = (await w.getOutgoingTransfers()) || []
  } catch (err) {
    logWarn({ err }, 'sendPayouts: outgoing-history query failed — skipping reconciliation')
    return empty
  }
  if (outgoing.length === 0) return empty
  const reconciled = []
  const excluded = []
  let unpersisted = 0
  let skipped = 0
  for (const payout of queued) {
    let recorded
    try {
      recorded = await models.rewardPayout.findMany({
        where: {
          recipientAddress: payout.recipientAddress,
          piconeros: payout.piconeros,
          state: { in: ['SENT', 'CONFIRMED'] }
        },
        select: { txHash: true }
      })
    } catch {
      // Cannot prove safety — fail CLOSED: never re-send this run; the next
      // run (healthy DB) reconciles it. Counted `skipped` so the distribution
      // goes FAILED-resumable.
      skipped += 1
      excluded.push(payout)
      continue
    }
    const recordedHashes = new Set((recorded || []).map(r => r.txHash).filter(Boolean))
    const match = outgoing.find(t => {
      const hash = toTxHash(t.getTx()?.getHash?.())
      if (!hash || recordedHashes.has(hash)) return false
      return (t.getDestinations() || []).some(
        d => d.getAddress() === payout.recipientAddress && BigInt(d.getAmount()) === payout.piconeros)
    })
    if (match) {
      const txHash = toTxHash(match.getTx().getHash())
      logInfo({ payoutId: payout.id, txHash }, 'sendPayouts: reconciled relayed-but-unpersisted payout from wallet history (no re-send)')
      unpersisted += await persistSentPayouts([payout], txHash, models)
      reconciled.push(payout)
      excluded.push(payout)
    }
  }
  return { reconciled, excluded, unpersisted, skipped }
}

// Build + relay a batch tx from ONE account, resolving the Monero tx fee from
// the wallet's real createTx (which constructs and validates the tx including
// its fee when relay is false). When the fee pushes a bucket over the
// account's unlocked balance, drop the smallest payout and rebuild until it
// fits — the dropped payout(s) stay QUEUED (resumable) instead of skipping
// the whole bucket (which cost full weekly cycles + a spurious CRITICAL).
// Returns the split so sendPayouts can tally: a payout is never split across
// txs — it is sent whole or skipped whole.
async function relayBucketTx (w, models, accountIndex, payouts) {
  if (payouts.length === 0) return { txHash: null, sent: [], skipped: [], failed: 0, unpersisted: 0 }
  const remaining = [...payouts]
  const skipped = []
  let tx = null

  while (remaining.length > 0) {
    try {
      tx = await w.createTx({
        accountIndex,
        destinations: remaining.map(p => ({ address: p.recipientAddress, amount: p.piconeros })),
        relay: false
      })
      break // fits including the fee
    } catch (err) {
      if (!isBalanceError(err)) {
        // Hard error: funds stayed in the wallet.
        logError({ accountIndex, payoutCount: remaining.length, err }, 'sendPayouts: account batch FAILED (funds stayed in wallet)')
        for (const payout of remaining) {
          await models.rewardPayout.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
        }
        return { txHash: null, sent: [], skipped, failed: remaining.length, unpersisted: 0 }
      }
      if (remaining.length === 1) {
        skipped.push(remaining[0])
        return { txHash: null, sent: [], skipped, failed: 0, unpersisted: 0 }
      }
      // Drop the smallest payout (larger curator shares are the priority) and retry.
      const minIdx = remaining.reduce((mi, p, i, arr) => (p.piconeros < arr[mi].piconeros ? i : mi), 0)
      skipped.push(remaining.splice(minIdx, 1)[0])
    }
  }

  const txHash = toTxHash(tx.getHash())
  logInfo({ accountIndex, payoutCount: remaining.length, txHash }, 'sendPayouts: batch created (pre-relay)')
  let relayed = false
  try {
    await w.relayTx(tx)
    relayed = true
  } catch (err) {
    // Nothing was broadcast — funds stayed in the wallet; the whole bucket is
    // resumable (stay QUEUED), never a silent loss.
    logError({ accountIndex, txHash, err }, 'sendPayouts: relay failed (funds stayed)')
  }
  if (!relayed) {
    return { txHash: null, sent: [], skipped: remaining.concat(skipped), failed: 0, unpersisted: 0 }
  }
  const unpersisted = await persistSentPayouts(remaining, txHash, models)
  return { txHash, sent: remaining, skipped, failed: 0, unpersisted }
}

// Persist the shared tx hash on every payout row of a relayed batch (SENT)
// with one retry, then a CRITICAL alert for manual reconciliation — a persist
// blip never flips a payout FAILED (the funds already left the wallet).
// Returns how many payouts remain UNPERSISTED after the retry: the caller
// counts them in the summary's `unpersisted` so the distribution can never
// COMPLETE with an unrecorded relay.
async function persistSentPayouts (payouts, txHash, models) {
  let unpersisted = 0
  for (const payout of payouts) {
    try {
      await models.rewardPayout.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash }
      })
    } catch (err) {
      logError({ payoutId: payout.id, txHash, err }, 'sendPayouts: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      try {
        await models.rewardPayout.update({
          where: { id: payout.id },
          data: { state: 'SENT', txHash }
        })
      } catch (err2) {
        logError({ payoutId: payout.id, txHash, err: err2 }, 'sendPayouts: CRITICAL — DB-update retry also failed')
        alert('critical', 'relayed-but-unpersisted payout',
          `payout ${payout.id} tx ${txHash} relayed but DB persist failed (retry also failed); the next run reconciles it from wallet history — do NOT manually re-send`,
          { dedupeKey: `relay-unpersisted-${txHash}` })
        unpersisted += 1
      }
    }
  }
  return unpersisted
}

// Greedy first-fit-decreasing packing: sort payouts by amount desc, then
// assign each payout whole to the first account that fits, accounts ordered
// by unlocked desc (ties by lowest index) so the largest account absorbs the
// largest payouts and the fewest accounts/txs are used. createTx spends from
// ONE account per tx, and a payout must never be split. `feeReserve`
// (default 0n) subtracts per-account fee headroom from each capacity —
// floored at zero — so packed buckets leave room for the tx fee. Returns one
// bucket per used account, or null when no assignment exists. Exported for
// tests.
export function planAccountSends (payouts, unlockedByAccount, feeReserve = 0n) {
  const accounts = Object.entries(unlockedByAccount)
    .map(([idx, unlocked]) => ({
      accountIndex: Number(idx),
      remaining: BigInt(unlocked) > feeReserve ? BigInt(unlocked) - BigInt(feeReserve) : 0n
    }))
    .sort((a, b) => (a.remaining > b.remaining ? -1 : a.remaining < b.remaining ? 1 : a.accountIndex - b.accountIndex))
  const ordered = [...payouts].sort((a, b) => (a.piconeros < b.piconeros ? 1 : a.piconeros > b.piconeros ? -1 : a.id - b.id))
  const buckets = new Map()
  for (const p of ordered) {
    const acc = accounts.find(a => a.remaining >= p.piconeros)
    if (!acc) return null
    acc.remaining -= p.piconeros
    let bucket = buckets.get(acc.accountIndex)
    if (!bucket) {
      bucket = { accountIndex: acc.accountIndex, payouts: [] }
      buckets.set(acc.accountIndex, bucket)
    }
    bucket.payouts.push(p)
  }
  return [...buckets.values()]
}

// Sweep every funded fee-pool account (1-5) into the primary address: real
// on-chain self-transfers used as the recovery path when packing cannot cover
// the batch from single accounts. The DB ledger is unaffected (the
// transparency resolver derives balances from the DB, never on-chain
// sent-side data). Errors are alerted CRITICAL but not thrown — the callers
// end the run skipped/FAILED-resumable either way.
async function consolidateFeeAccounts (w) {
  const primaryAddress = process.env.PLATFORM_REWARDS_ADDRESS
  for (const idx of SIGNER_ACCOUNTS) {
    if (idx === 0) continue
    try {
      const bal = BigInt(await w.getUnlockedBalance(idx))
      if (bal < CONSOLIDATION_MIN_PICONEROS) continue
      const txs = await w.sweepUnlocked({ accountIndex: idx, address: primaryAddress, relay: true })
      for (const tx of txs || []) {
        logInfo({ accountIndex: idx, txHash: toTxHash(tx.getHash()) }, 'sendPayouts: consolidated fee account to primary')
      }
    } catch (err) {
      logError({ accountIndex: idx, err }, 'sendPayouts: CRITICAL — fee-account consolidation sweep failed')
      alert('critical', 'rewards fee-account consolidation failed',
        `consolidation sweep of rewards wallet account ${idx} failed: ${err?.message || err}; distribution stays resumable-FAILED`,
        { dedupeKey: `rewards-consolidate-${idx}` })
    }
  }
}

function setBalanceGauge (models, unlocked) {
  try { moneroRewardsWalletBalancePiconeros.set(Number(unlocked)) } catch { /* NaN/overflow — skip */ }
  // HealthSnapshot bridge leg: fire-and-forget the balance into row id=1 so the
  // app process can serve monero_rewards_wallet_balance_piconeros from
  // /api/metrics (the prom-client gauge is process-local to this worker). The
  // call sites are un-awaited and a persist failure must never throw into the
  // payout/sweep flow — catch + logWarn, best-effort by contract.
  try {
    models?.healthSnapshot?.upsert({
      where: { id: 1 },
      create: { id: 1, balancePiconeros: unlocked, balanceUpdatedAt: new Date() },
      update: { balancePiconeros: unlocked, balanceUpdatedAt: new Date() }
    }).catch(err => logWarn('rewards signer: HealthSnapshot balance persist failed', err))
  } catch (err) {
    logWarn('rewards signer: HealthSnapshot balance persist failed', err)
  }
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
// Each account's sweep is built with createTx({relay: false}) so the tx is
// constructed + validated INCLUDING its fee before anything moves, then the
// same tx object is relayTx'd — the same create-then-relay split as
// sendPayouts. Relay-before-persist: a relayed tx hash is captured the
// instant the relay succeeds and logged before any DB write, so it is never
// silently lost; a persist failure retries once then logs CRITICAL (manual
// reconciliation) rather than flipping FAILED — FAILED means funds STAYED in
// the wallet, which a post-relay persist blip does not satisfy.
//
// `wallet` is injectable for unit tests; production leaves it unset and reuses
// the getRewardsWallet() singleton.

// Build one account's ops-sweep tx create-then-relay: createTx({relay:false})
// constructs + validates the tx INCLUDING its fee without moving funds, then
// the same tx object is relayTx'd. When the fee pushes the desired amount
// over the account's unlocked balance (a full-balance sweep), decrement by
// the fee headroom and rebuild — sending slightly less is correct (the
// remainder rolls into next week's opsRolledOver). Balance errors on every
// attempt return null (funds effectively locked); hard errors propagate to
// the caller's FAILED path.
async function relayAccountSweep (w, accountIndex, address, amount) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tryAmount = amount - BigInt(attempt) * TX_FEE_HEADROOM_PICONEROS
    if (tryAmount <= 0n) return null
    let tx
    try {
      tx = await w.createTx({ accountIndex, address, amount: tryAmount, relay: false })
    } catch (err) {
      if (isBalanceError(err)) continue // fee margin bit — decrement and rebuild
      throw err
    }
    const txHash = toTxHash(tx.getHash())
    await w.relayTx(tx) // relay failure propagates: nothing was broadcast
    return { txHash, amount: tryAmount }
  }
  return null
}

export async function sweepOpsEarmark ({ distribution, models, wallet } = {}) {
  if (distribution?.opsSweepState === 'SWEPT') {
    return { state: 'SWEPT', txHash: distribution.opsSweepTxHash, swept: distribution.opsSweptPiconeros }
  }

  const coldAddress = process.env.REWARDS_COLD_STORAGE_ADDRESS
  const sweepEnabled = String(process.env.REWARDS_OPS_SWEEP_ENABLED ?? 'true') !== 'false'
  if (!sweepEnabled || !coldAddress) {
    return { state: 'DISABLED' }
  }

  const w = wallet || await getRewardsWallet(models)
  // Same stale-cached-view fix as sendPayouts: refresh before reading balances.
  await w.sync()
  // Aggregate unlocked across all signer accounts, then sweep greedily
  // per-account (createTx spends from ONE account per tx).
  const unlockedByAccount = {}
  let totalUnlocked = 0n
  for (const idx of SIGNER_ACCOUNTS) {
    const bal = BigInt(await w.getUnlockedBalance(idx))
    unlockedByAccount[idx] = bal
    totalUnlocked += bal
  }
  let target = BigInt(distribution.opsAvailablePiconeros)
  const cap = totalUnlocked - REWARDS_OPS_SWEEP_MIN_PICONEROS
  if (target > cap) target = cap

  if (target <= REWARDS_OPS_SWEEP_MIN_PICONEROS) {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SKIPPED_LOCKED' }
    })
    return { state: 'SKIPPED_LOCKED' }
  }

  let swept = 0n
  const hashes = []
  const accounts = Object.entries(unlockedByAccount)
    .map(([idx, bal]) => ({ accountIndex: Number(idx), unlocked: BigInt(bal) }))
    .sort((a, b) => (a.unlocked < b.unlocked ? 1 : a.unlocked > b.unlocked ? -1 : a.accountIndex - b.accountIndex))
  for (const acc of accounts) {
    if (target <= 0n) break
    if (acc.unlocked <= 0n) continue
    const amount = acc.unlocked < target ? acc.unlocked : target
    try {
      const r = await relayAccountSweep(w, acc.accountIndex, coldAddress, amount)
      if (r) {
        hashes.push(r.txHash)
        swept += r.amount
        target -= r.amount
        logInfo({ distributionId: distribution.id, accountIndex: acc.accountIndex, txHash: r.txHash, swept: r.amount.toString() }, 'sweepOpsEarmark: account sweep relayed')
      }
    } catch (err) {
      logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, err }, 'sweepOpsEarmark: sweep FAILED')
      const data = { opsSweepState: 'FAILED' }
      if (hashes.length > 0) {
        data.opsSweptPiconeros = swept
        data.opsSweepTxHash = hashes.join(',')
        alert('critical', 'partial ops sweep relayed then failed',
          `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); account ${acc.accountIndex} sweep FAILED. Partial sweep persisted; manual reconciliation required.`,
          { dedupeKey: `dist-${distribution.id}-partial-sweep-failed` })
      }
      await models.rewardDistribution.update({ where: { id: distribution.id }, data })
      return { state: 'FAILED' }
    }
  }

  if (hashes.length === 0) {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SKIPPED_LOCKED' }
    })
    return { state: 'SKIPPED_LOCKED' }
  }

  const txHash = hashes.join(',')
  logInfo({ distributionId: distribution.id, txHash, swept: swept.toString() }, 'sweepOpsEarmark: ops sweep relayed')
  setBalanceGauge(models, totalUnlocked - swept)
  try {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SWEPT', opsSweptPiconeros: swept, opsSweepTxHash: txHash }
    })
  } catch (err) {
    logError({ distributionId: distribution.id, txHash, err }, 'sweepOpsEarmark: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
    try {
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { opsSweepState: 'SWEPT', opsSweptPiconeros: swept, opsSweepTxHash: txHash }
      })
    } catch (err2) {
      logError({ distributionId: distribution.id, txHash, err: err2 }, 'sweepOpsEarmark: CRITICAL — DB-update retry also failed')
      alert('critical', 'relayed-but-unpersisted ops sweep',
        `distribution ${distribution.id} sweep tx ${txHash} relayed but DB persist failed (retry also failed); manual reconciliation required`,
        { dedupeKey: `relay-unpersisted-${txHash}` })
    }
  }

  return { state: 'SWEPT', txHash, swept }
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
