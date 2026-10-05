import { daemonClient, MAX_TX_HASHES_PER_REQUEST } from '@/api/monero/daemonClient'
import { assertWalletScope } from '@/api/monero/rewardsTransactions'
import { ensureFeeAccounts } from '@/api/monero/rewards'
import { walletScope } from '@/lib/rewardsAccounting'

// Read-only scoped chain evidence for the rewards + escrow wallets (rewards
// accounting repair §8, Task 12).
//
// The audit that precedes an accounting repair needs COMPLETE, scoped chain
// facts at ONE fixed boundary: every incoming receipt (external and self), every
// outgoing transaction with its real fee and destinations, full and unlocked
// balances, the account/subaddress derivation actually compared against the DB,
// and the escrow wallet's funding/settlement history used to recover missing
// settlement metadata. This module COLLECTS those facts and normalizes them to
// explicit safe fields and decimal strings. It never signs, sends, sweeps,
// writes the DB or returns wallet objects / keys / signed blobs.
//
// Discipline, in order:
//   1. prove the audit wallet's identity (`assertWalletScope`) BEFORE any
//      authoritative read — chain evidence from the wrong wallet is worthless;
//   2. open a DEDICATED audit wallet from keys (never the signer singleton,
//      whose cached restore height can be insufficient), restored from genesis
//      by default. A restore above genesis requires explicit VERIFIED
//      first-wallet-activity evidence; the earliest DB inflow alone cannot rule
//      out unbooked earlier receipts;
//   3. derive primary + majors 1..5 + EVERY recorded SubaddressIndex minor
//      (including AVAILABLE rows, via ensureFeeAccounts' audit variant) and
//      compare every derived address against its DB address; derive the escrow
//      wallet's recorded receiving subaddresses the same way;
//   4. record the daemon tip height/hash BEFORE the scan and AFTER the
//      balances/history, and require the SAME boundary — a moving chain mixes
//      heights, so the collection reruns (bounded) instead of returning mixed
//      evidence. The wallet's scanned block COUNT must be >= boundary index + 1
//      so the boundary block itself is proven scanned;
//   5. read balances and both wallet histories; classify per-tx changes and
//      self transfers; split confirmed ledger facts from explicit bridge items
//      (mempool outgoing fees/principal and non-CONFIRMED incoming);
//   6. verify tx presence on the daemon with hashes batched at <= 50 via the
//      existing daemonClient (daemon data proves presence only — never a
//      RingCT recipient amount, which comes solely from the wallet's own scan).
//
// Callers assemble `{ evidence, ledger, decisions, config, reserve }` for
// `buildRewardsReconciliation` (api/monero/rewardsReconciliation.js).

const TX_HASH_RE = /^[0-9a-f]{64}$/
const REWARDS_NETWORKS = new Set(['STAGENET', 'MAINNET'])
const NETWORK_TYPES = { MAINNET: 0, STAGENET: 2 }

function normalizeScope (scope) {
  if (!scope || typeof scope !== 'object') throw new Error('invalid rewards wallet scope')
  if (!REWARDS_NETWORKS.has(scope.network)) throw new Error('invalid rewards wallet scope: unsupported network')
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress.trim() === '') {
    throw new Error('invalid rewards wallet scope: wallet address is not configured')
  }
  return { network: scope.network, walletAddress: scope.walletAddress }
}

function normalizeHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}

function asInt (value) {
  return Number.isSafeInteger(value) ? value : null
}

function asAmount (value) {
  if (value == null) return null
  try {
    const amount = BigInt(value)
    if (amount < 0n) return null
    return amount
  } catch {
    return null
  }
}

function requireModels (models) {
  if (typeof models?.moneroAccount?.findFirst !== 'function') {
    throw new Error('collectRewardsWalletEvidence: models.moneroAccount is required')
  }
  if (typeof models?.subaddressIndex?.findMany !== 'function') {
    throw new Error('collectRewardsWalletEvidence: models.subaddressIndex is required')
  }
  if (typeof models?.$queryRaw !== 'function') {
    throw new Error('collectRewardsWalletEvidence: models.$queryRaw is required for fee-account derivation')
  }
}

// The daemon tip is the ONLY boundary authority: the highest EXISTING block
// index plus its block hash, so a reorg during the scan is detectable.
// monerod's `get_info.height` is the chain LENGTH (block count), and
// `get_block_header_by_height` can only resolve indices 0..length-1 — asking
// for `height` itself requests the nonexistent next block.
async function daemonTip (daemon) {
  if (typeof daemon?.getHeight !== 'function' || typeof daemon?.getBlockHashByHeight !== 'function') {
    throw new Error('collectRewardsWalletEvidence: an injected daemon with getHeight/getBlockHashByHeight is required')
  }
  const chainLength = await daemon.getHeight()
  if (!Number.isSafeInteger(chainLength) || chainLength < 1) {
    throw new Error('collectRewardsWalletEvidence: daemon returned an invalid chain height')
  }
  const height = chainLength - 1
  const blockHash = normalizeHash(await daemon.getBlockHashByHeight(height))
  if (!blockHash) throw new Error('collectRewardsWalletEvidence: daemon returned an invalid tip block hash')
  return { height, blockHash }
}

function resolveRestoreHeight ({ restoreHeight, firstActivityEvidence }) {
  const height = Number(restoreHeight) || 0
  if (!Number.isInteger(height) || height < 0) throw new Error('collectRewardsWalletEvidence: invalid restore height')
  if (height === 0) return { restoreHeight: 0, restoreProvenance: 'genesis' }
  if (firstActivityEvidence?.verified !== true) {
    throw new Error('collectRewardsWalletEvidence: a restore above genesis requires explicit verified first-wallet-activity evidence (the earliest DB inflow alone is insufficient)')
  }
  const first = asInt(firstActivityEvidence.height)
  if (first == null || first < height) {
    throw new Error('collectRewardsWalletEvidence: the requested restore height is above the verified first wallet activity; refusing to mix balance evidence')
  }
  return { restoreHeight: height, restoreProvenance: 'verified-first-activity', firstActivityHeight: first }
}

async function loadAccount (models, label, scope, { optional = false } = {}) {
  const account = await models.moneroAccount.findFirst({
    where: { label, network: scope.network },
    orderBy: { id: 'asc' },
    select: { id: true, address: true, network: true }
  })
  if (!account) {
    if (optional) return null
    throw new Error(`collectRewardsWalletEvidence: no ${label} account is registered for ${scope.network}`)
  }
  return account
}

async function openAuditWallet ({ scope, restoreHeight, kind }) {
  const env = kind === 'rewards'
    ? {
        address: process.env.PLATFORM_REWARDS_ADDRESS,
        spend: process.env.PLATFORM_REWARDS_SPEND_KEY,
        view: process.env.PLATFORM_REWARDS_VIEW_KEY,
        password: 'rewards-wallet-audit'
      }
    : {
        address: process.env.BOUNTY_ESCROW_ADDRESS,
        spend: process.env.BOUNTY_ESCROW_SPEND_KEY,
        view: process.env.BOUNTY_ESCROW_VIEW_KEY,
        password: 'bounty-escrow-audit'
      }
  if (!env.address || !env.spend || !env.view) {
    throw new Error(`collectRewardsWalletEvidence: the ${kind} wallet keys are not configured`)
  }
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = NETWORK_TYPES[scope.network]
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'
  // Dedicated in-memory audit wallet — deliberately NOT the signer singleton.
  return api.createWalletFull({
    password: env.password,
    networkType,
    primaryAddress: env.address,
    privateSpendKey: env.spend,
    privateViewKey: env.view,
    restoreHeight,
    server: { uri: serverUri },
    proxyToWorker: false
  })
}

// Derive (create when missing) every recorded minor for every recorded major
// in `rows`, then compare each derived address against its DB address — the
// primary (0, 0) included, and every recorded major-0 minor (e.g. a rotating
// primary-chain subaddress) is derived and compared like any other row. No
// recorded row is skipped. The returned `derived` list is the wallet's FULL
// account/subaddress address set (including automatically derived account
// addresses absent from DB rows) so self-transfer classification can recognize
// every wallet-owned address.
async function verifyDerivedAddresses ({ wallet, rows, primaryAddress }) {
  const mismatches = []
  const accounts = await wallet.getAccounts()
  const maxMajor = rows.reduce((max, row) => Math.max(max, Number(row.majorIndex) || 0), 0)
  for (let i = accounts.length; i <= maxMajor; i++) await wallet.createAccount()

  const sorted = [...rows].sort((a, b) => a.majorIndex - b.majorIndex || a.minorIndex - b.minorIndex)
  // Derive every recorded minor before any comparison.
  for (const row of sorted) {
    const existing = await wallet.getSubaddresses(row.majorIndex)
    for (let minor = existing.length; minor <= row.minorIndex; minor++) {
      await wallet.createSubaddress(row.majorIndex)
    }
  }
  // Compare EVERY recorded row against its derived address.
  for (const row of sorted) {
    const subaddress = await wallet.getSubaddress(row.majorIndex, row.minorIndex)
    const address = typeof subaddress?.getAddress === 'function' ? subaddress.getAddress() : null
    if (address !== row.address) {
      mismatches.push({
        majorIndex: row.majorIndex,
        minorIndex: row.minorIndex,
        expectedAddress: row.address,
        derivedAddress: address
      })
    }
  }
  const primary = await wallet.getPrimaryAddress()
  if (primaryAddress != null && primary !== primaryAddress) {
    mismatches.push({ majorIndex: 0, minorIndex: 0, expectedAddress: primaryAddress, derivedAddress: primary })
  }

  const derived = []
  const finalAccounts = await wallet.getAccounts()
  for (let major = 0; major < finalAccounts.length; major++) {
    const subaddresses = await wallet.getSubaddresses(major)
    for (let minor = 0; minor < subaddresses.length; minor++) {
      const subaddress = subaddresses[minor]
      const address = typeof subaddress?.getAddress === 'function' ? subaddress.getAddress() : null
      const index = typeof subaddress?.getSubaddressIndex === 'function' ? subaddress.getSubaddressIndex() : minor
      derived.push({ majorIndex: major, minorIndex: index, address })
    }
  }
  return { complete: mismatches.length === 0, primaryAddress: primary, derived, mismatches }
}

async function assertAccountScope (wallet, account, network, label) {
  if (typeof wallet?.getPrimaryAddress !== 'function' || typeof wallet?.getNetworkType !== 'function') {
    throw new Error(`collectRewardsWalletEvidence: the ${label} wallet cannot prove its identity`)
  }
  const primary = await wallet.getPrimaryAddress()
  if (primary !== account.address) {
    throw new Error(`collectRewardsWalletEvidence: ${label} wallet scope mismatch — the wallet address does not match the registered account`)
  }
  const networkType = await wallet.getNetworkType()
  if (networkType !== NETWORK_TYPES[network]) {
    throw new Error(`collectRewardsWalletEvidence: ${label} wallet scope mismatch — the wallet network does not match the configured network`)
  }
}

async function readTxFacts (transfer) {
  const tx = typeof transfer?.getTx === 'function' ? transfer.getTx() : null
  if (!tx) throw new Error('collectRewardsWalletEvidence: wallet transfer has no transaction')
  const read = async (fn) => {
    if (typeof fn !== 'function') return null
    try {
      return await fn()
    } catch {
      return null
    }
  }
  const hash = normalizeHash(await read(() => tx.getHash()))
  if (!hash) throw new Error('collectRewardsWalletEvidence: wallet transfer has no valid transaction hash')
  const inTxPool = (await read(() => tx.getInTxPool())) === true
  const isConfirmed = (await read(() => tx.getIsConfirmed())) === true
  const height = asInt(await read(() => tx.getHeight()))
  const confirmations = asInt(await read(() => tx.getNumConfirmations())) ?? 0
  const isRelayed = (await read(() => tx.getIsRelayed())) === true
  return { hash, inTxPool, isConfirmed, height, confirmations, isRelayed }
}

function normalizeOutgoingTransfer (transfer, txFacts, ownedAddresses) {
  const destinations = (typeof transfer?.getDestinations === 'function' ? transfer.getDestinations() : null) || []
  const normalizedDestinations = []
  let destinationsReadable = true
  for (const destination of destinations) {
    const address = typeof destination?.getAddress === 'function' ? destination.getAddress() : null
    const amount = typeof destination?.getAmount === 'function' ? asAmount(destination.getAmount()) : null
    if (typeof address !== 'string' || address === '' || amount == null) destinationsReadable = false
    normalizedDestinations.push({ address, amountPiconeros: amount })
  }
  const selfTransfer = destinationsReadable && normalizedDestinations.length > 0 &&
    normalizedDestinations.every(destination => ownedAddresses.has(destination.address))
  return {
    txHash: txFacts.hash,
    accountIndex: asInt(transfer?.getAccountIndex?.()) ?? 0,
    feePiconeros: null,
    destinations: normalizedDestinations.map(destination => ({
      address: destination.address,
      amountPiconeros: destination.amountPiconeros == null ? null : destination.amountPiconeros.toString()
    })),
    destinationsReadable,
    height: txFacts.height,
    confirmations: txFacts.confirmations,
    inTxPool: txFacts.inTxPool,
    isConfirmed: txFacts.isConfirmed,
    isRelayed: txFacts.isRelayed,
    isSelfTransfer: selfTransfer,
    relayState: txFacts.isConfirmed ? 'confirmed' : txFacts.inTxPool ? 'pool' : 'unrelayed'
  }
}

function normalizeIncomingTransfer (transfer, txFacts) {
  const amount = asAmount(transfer?.getAmount?.())
  return {
    txHash: txFacts.hash,
    accountIndex: asInt(transfer?.getAccountIndex?.()) ?? 0,
    subaddressIndex: asInt(transfer?.getSubaddressIndex?.()) ?? 0,
    amountPiconeros: amount == null ? null : amount.toString(),
    height: txFacts.height,
    confirmations: txFacts.confirmations,
    inTxPool: txFacts.inTxPool,
    isConfirmed: txFacts.isConfirmed,
    fromOwnTransaction: false,
    isSelfTransfer: false
  }
}

async function readFee (transfer) {
  const tx = typeof transfer?.getTx === 'function' ? transfer.getTx() : null
  if (!tx || typeof tx.getFee !== 'function') return null
  try {
    return asAmount(await tx.getFee())
  } catch {
    return null
  }
}

const byHashThenIndex = (a, b) =>
  a.txHash.localeCompare(b.txHash) ||
  (a.accountIndex ?? 0) - (b.accountIndex ?? 0) ||
  (a.subaddressIndex ?? 0) - (b.subaddressIndex ?? 0)

async function collectWalletHistory ({ wallet, ownedAddresses }) {
  const rawIncoming = (await wallet.getIncomingTransfers()) || []
  const rawOutgoing = (await wallet.getOutgoingTransfers()) || []
  const outgoing = []
  const outgoingHashes = new Set()
  const selfTransferHashes = new Set()
  for (const transfer of rawOutgoing) {
    const txFacts = await readTxFacts(transfer)
    const entry = normalizeOutgoingTransfer(transfer, txFacts, ownedAddresses)
    entry.feePiconeros = (await readFee(transfer))?.toString() ?? null
    outgoing.push(entry)
    outgoingHashes.add(entry.txHash)
    if (entry.isSelfTransfer) selfTransferHashes.add(entry.txHash)
  }
  const incoming = []
  for (const transfer of rawIncoming) {
    const txFacts = await readTxFacts(transfer)
    const entry = normalizeIncomingTransfer(transfer, txFacts)
    entry.fromOwnTransaction = outgoingHashes.has(entry.txHash)
    entry.isSelfTransfer = selfTransferHashes.has(entry.txHash)
    incoming.push(entry)
  }
  const confirmedIncoming = incoming.filter(entry => entry.isConfirmed).sort(byHashThenIndex)
  const pendingIncoming = incoming.filter(entry => !entry.isConfirmed).sort(byHashThenIndex)
  const confirmedOutgoing = outgoing.filter(entry => entry.isConfirmed).sort(byHashThenIndex)
  const pendingOutgoing = outgoing.filter(entry => !entry.isConfirmed).sort(byHashThenIndex)
  return {
    confirmedIncoming,
    pendingIncoming,
    confirmedOutgoing,
    pendingOutgoing,
    outgoingHashes,
    selfTransferHashes
  }
}

async function collectBalances (wallet) {
  const total = asAmount(await wallet.getBalance())
  const unlocked = asAmount(await wallet.getUnlockedBalance())
  if (total == null || unlocked == null) {
    throw new Error('collectRewardsWalletEvidence: wallet balances are unreadable')
  }
  const accounts = await wallet.getAccounts()
  const byAccount = {}
  for (const account of accounts) {
    const index = typeof account?.getIndex === 'function' ? account.getIndex() : account?.index
    if (!Number.isSafeInteger(index)) continue
    const balance = asAmount(await wallet.getBalance(index))
    if (balance == null) throw new Error('collectRewardsWalletEvidence: a wallet account balance is unreadable')
    byAccount[index] = balance.toString()
  }
  return { totalPiconeros: total.toString(), unlockedPiconeros: unlocked.toString(), accounts: byAccount }
}

// Presence verification only: the daemon proves a hash exists (and the caller
// already fixed the boundary height/hash). Recipient amounts NEVER come from
// the daemon — only from the wallet's own decrypted scan.
async function verifyDaemonPresence (daemon, hashes) {
  const unique = [...new Set(hashes.filter(hash => TX_HASH_RE.test(hash)))].sort()
  const found = new Set()
  for (let i = 0; i < unique.length; i += MAX_TX_HASHES_PER_REQUEST) {
    const batch = unique.slice(i, i + MAX_TX_HASHES_PER_REQUEST)
    const txs = await daemon.getTransactions(batch)
    for (const tx of Array.isArray(txs) ? txs : []) {
      const hash = normalizeHash(tx?.hash)
      if (hash) found.add(hash)
    }
  }
  const missing = unique.filter(hash => !found.has(hash))
  if (missing.length > 0) {
    throw new Error(`collectRewardsWalletEvidence: wallet history contains transactions unknown to the daemon: ${missing.join(',')}`)
  }
  return { checkedHashes: unique.length, batches: Math.ceil(unique.length / MAX_TX_HASHES_PER_REQUEST) }
}

// Only broadcast history (confirmed or in the mempool) can be verified on the
// daemon. A built-but-unrelayed cached transaction is wallet state, not chain
// evidence, and must never fail presence verification.
function confirmedPresenceHashes (history) {
  return [
    ...history.confirmedIncoming,
    ...history.confirmedOutgoing,
    ...history.pendingIncoming,
    ...history.pendingOutgoing
  ].filter(entry => entry.isConfirmed || entry.inTxPool).map(entry => entry.txHash)
}

/**
 * Collect complete read-only rewards + escrow wallet evidence at one fixed
 * daemon boundary. No DB writes, no sends, no wallet mutation.
 *
 * @param {object} options
 * @param {object} options.models        Prisma client (read-only queries only).
 * @param {object} [options.scope]       Configured `{ network, walletAddress }` (default `walletScope()`).
 * @param {object} [options.wallet]      Injected rewards audit wallet (tests); otherwise opened from env.
 * @param {object} [options.escrowWallet] Injected escrow audit wallet (tests); otherwise opened when registered.
 * @param {object} [options.daemon]      monerod client (default the shared daemonClient singleton).
 * @param {number} [options.restoreHeight=0] Genesis by default; > 0 requires verified first-activity evidence.
 * @param {object} [options.firstActivityEvidence] `{ verified: true, height }` for a non-genesis restore.
 * @param {object} [options.requestedBoundary] Refused unless it equals the live tip (no historical balances).
 * @param {number} [options.maxBoundaryAttempts=3] Reruns when the chain boundary moves.
 * @returns {Promise<object>} normalized evidence (safe fields, decimal strings).
 */
export async function collectRewardsWalletEvidence (options = {}) {
  const {
    models,
    daemon = daemonClient,
    restoreHeight: requestedRestoreHeight = 0,
    firstActivityEvidence = null,
    requestedBoundary = null,
    maxBoundaryAttempts = 3
  } = options
  const scope = normalizeScope(options.scope ?? walletScope())
  requireModels(models)
  const restore = resolveRestoreHeight({ restoreHeight: requestedRestoreHeight, firstActivityEvidence })

  let rewardsWallet = options.wallet ?? null
  let escrowWallet = options.escrowWallet ?? null
  const openedWallets = []
  try {
    if (!rewardsWallet) {
      rewardsWallet = await openAuditWallet({ scope, restoreHeight: restore.restoreHeight, kind: 'rewards' })
      openedWallets.push(rewardsWallet)
    }
    // Scope is proven BEFORE any authoritative read (DB, daemon or wallet
    // history): chain evidence from the wrong wallet is worthless.
    await assertWalletScope(rewardsWallet, scope)
    const rewardsAccount = await loadAccount(models, 'platform_rewards', scope)
    if (rewardsAccount.address !== scope.walletAddress || rewardsAccount.network !== scope.network) {
      throw new Error('collectRewardsWalletEvidence: the registered platform_rewards account does not match the configured scope')
    }
    const escrowAccount = await loadAccount(models, 'bounty_escrow', scope, { optional: true })

    if (escrowAccount) {
      if (!escrowWallet) {
        escrowWallet = await openAuditWallet({ scope, restoreHeight: 0, kind: 'escrow' })
        openedWallets.push(escrowWallet)
      }
      await assertAccountScope(escrowWallet, escrowAccount, scope.network, 'escrow')
    } else if (escrowWallet) {
      throw new Error('collectRewardsWalletEvidence: an escrow wallet was supplied but no bounty_escrow account is registered')
    }

    // Derivation happens BEFORE the first sync: a key-restored wallet only
    // scans explicitly derived subaddresses, so every recorded minor (the audit
    // variant includes AVAILABLE rows) must exist first, then the derived
    // addresses are compared against the DB addresses.
    await ensureFeeAccounts(rewardsWallet, models, { includeAvailable: true })
    const rewardRows = await models.subaddressIndex.findMany({
      where: { accountId: rewardsAccount.id },
      select: { majorIndex: true, minorIndex: true, address: true, state: true }
    })
    const rewardsDerivation = await verifyDerivedAddresses({
      wallet: rewardsWallet,
      rows: rewardRows,
      primaryAddress: rewardsAccount.address
    })
    if (!rewardsDerivation.complete) {
      throw new Error('collectRewardsWalletEvidence: derived rewards addresses do not match the registered SubaddressIndex rows')
    }

    let escrowDerivation = null
    if (escrowWallet) {
      const escrowRows = await models.subaddressIndex.findMany({
        where: { accountId: escrowAccount.id },
        select: { majorIndex: true, minorIndex: true, address: true, state: true }
      })
      escrowDerivation = await verifyDerivedAddresses({
        wallet: escrowWallet,
        rows: escrowRows,
        primaryAddress: escrowAccount.address
      })
      if (!escrowDerivation.complete) {
        throw new Error('collectRewardsWalletEvidence: derived escrow addresses do not match the registered SubaddressIndex rows')
      }
    }

    const ownedAddresses = new Set([
      scope.walletAddress,
      ...rewardsDerivation.derived.map(entry => entry.address).filter(Boolean)
    ])

    let attempt = 0
    for (;;) {
      attempt += 1
      const tipBefore = await daemonTip(daemon)
      if (requestedBoundary && (
        asInt(requestedBoundary.height) !== tipBefore.height ||
        (requestedBoundary.blockHash != null && normalizeHash(requestedBoundary.blockHash) !== tipBefore.blockHash)
      )) {
        throw new Error('collectRewardsWalletEvidence: a historical boundary is not supported — the SDK cannot reconstruct a compatible balance for a height below the current tip')
      }

      await rewardsWallet.sync()
      // The wallet's height is a SCANNED BLOCK COUNT; the boundary is a block
      // INDEX. Proving the boundary block itself was scanned requires
      // count >= boundary index + 1.
      const rewardsScanned = asInt(await rewardsWallet.getHeight())
      if (rewardsScanned == null || rewardsScanned < tipBefore.height + 1) {
        throw new Error('collectRewardsWalletEvidence: the rewards wallet scan does not cover the boundary block')
      }
      const rewardsHistory = await collectWalletHistory({ wallet: rewardsWallet, ownedAddresses })
      const balances = await collectBalances(rewardsWallet)

      let escrow = null
      if (escrowWallet) {
        await escrowWallet.sync()
        const escrowScanned = asInt(await escrowWallet.getHeight())
        if (escrowScanned == null || escrowScanned < tipBefore.height + 1) {
          throw new Error('collectRewardsWalletEvidence: the escrow wallet scan does not cover the boundary block')
        }
        const escrowHistory = await collectWalletHistory({ wallet: escrowWallet, ownedAddresses: new Set(escrowDerivation.derived.map(entry => entry.address)) })
        escrow = {
          walletAddress: escrowAccount.address,
          derivation: escrowDerivation,
          balances: await collectBalances(escrowWallet),
          incoming: escrowHistory.confirmedIncoming,
          outgoing: escrowHistory.confirmedOutgoing,
          bridge: {
            pendingIncoming: escrowHistory.pendingIncoming,
            pendingOutgoing: escrowHistory.pendingOutgoing
          }
        }
      }

      const escrowPresence = escrow
        ? [
            ...escrow.incoming,
            ...escrow.outgoing,
            ...escrow.bridge.pendingIncoming,
            ...escrow.bridge.pendingOutgoing
          ].filter(entry => entry.isConfirmed || entry.inTxPool).map(entry => entry.txHash)
        : []
      const presenceHashes = [...confirmedPresenceHashes(rewardsHistory), ...escrowPresence]
      await verifyDaemonPresence(daemon, presenceHashes)

      const tipAfter = await daemonTip(daemon)
      const stable = tipBefore.height === tipAfter.height && tipBefore.blockHash === tipAfter.blockHash
      if (!stable) {
        if (attempt >= Math.max(1, Number(maxBoundaryAttempts) || 1)) {
          throw new Error('collectRewardsWalletEvidence: the chain boundary moved during the scan; rerun the audit when the chain is quiet')
        }
        continue
      }

      return {
        scope: { network: scope.network, walletAddress: scope.walletAddress },
        boundary: { height: tipBefore.height, blockHash: tipBefore.blockHash },
        daemon: { tipBefore, tipAfter },
        ...restore,
        walletHeight: rewardsScanned,
        derivation: rewardsDerivation,
        balances,
        incoming: rewardsHistory.confirmedIncoming,
        outgoing: rewardsHistory.confirmedOutgoing,
        bridge: {
          pendingIncoming: rewardsHistory.pendingIncoming,
          pendingOutgoing: rewardsHistory.pendingOutgoing
        },
        escrow
      }
    }
  } finally {
    for (const wallet of openedWallets) {
      try {
        await wallet.close()
      } catch { /* closing an audit wallet must never mask the collection result */ }
    }
  }
}
