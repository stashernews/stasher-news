import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { money } from '@/lib/rewardsAccounting'
import { daemonClient } from './daemonClient'
import { collectPaymentChainEvidence, commitPaymentPromotionAtBoundary, prepareRecordedPaymentAddresses, readPaymentAuditHashes } from './paymentChainEvidence'
import { verifyPaymentTransaction } from './paymentVerification'
import { normalizePaymentClaims, paymentClaimDigest } from './paymentClaims'
import {
  assertPreparedPayment,
  claimPaymentAttempt,
  preparePaymentDispatch
} from './paymentProofStore'
import { createPaymentProofKeyProvider } from './paymentProofKeys'
import { assertWalletScope, errorLabel } from './rewardsTransactions'

// Escrow dispatch boundary (Finding #1, Task 7). Every bounty escrow send —
// the combined disposition tx (AWARD/RECLAIM prize + platform fee, or the
// single net output for ROLLOVER / fee-waived refunds) and the legacy
// separate-fee retry — follows the same barrier as the hot wallet:
//
//   build(relay:false) -> read the ACTUAL settlement from the built object ->
//   prepare the durable journal+proof PAIR (ESCROW owner role) ->
//   authenticate the pair against the SAME built object -> CAS the attempt ->
//   relayTx(the SAME object) once, outside any transaction -> persist
//
// The pair commits atomically BEFORE any broadcast; the durable dispatch
// (attempted, unattempted, or RELAYED) withholds its exact
// (bountyPaymentId, leg) from every later drive, so a relay timeout or a
// post-relay persistence failure can never cause a second broadcast. One tx
// per escrow leg is enforced by the store's unique
// (network, walletAddress, bountyPaymentId, leg) constraint — a competing
// build can never gain a second hash for the same leg.
//
// Reconciliation never re-sends: attempted-but-unproven relays resolve ONLY
// through a fresh confirmed whole-payment verification from a dedicated
// genesis-restored audit session (never the signer singleton, never
// destination-shaped history); durable RELAYED dispatches recover settlement
// facts DB-only from their immutable captured claims into matching live payout
// rows via CAS. Escrow fees never contribute to the hot-wallet network-expense
// union and no hot-wallet receipt is ever written here.
//
// This module never signs anything, never re-signs, never reconstructs a
// signed blob, and never stores or logs keys, envelopes, signed transaction
// material or wallet credentials. Only fixed error labels / machine issue
// codes ever reach the logs. models/wallets are injected so importing this
// module is inert.

// Networks the escrow wallet is provisioned for (mirrors the rewards journal).
const ESCROW_NETWORKS = new Set(['STAGENET', 'MAINNET'])
const NETWORK_TYPES = { MAINNET: 0, STAGENET: 2 }
const TX_HASH_RE = /^[0-9a-f]{64}$/

// BountyPayment.kind values (the payout row's domain). The escrow journal's
// kind is DERIVED: a separate-fee retry is journaled as LEGACY_SEPARATE_FEE
// (matching its leg — the DB CHECK `kind_leg_consistent`), every other leg is
// journaled with the payout's own kind (a real BountyPayment can never carry
// LEGACY_SEPARATE_FEE).
const PAYOUT_KINDS = new Set(['AWARD', 'RECLAIM', 'ROLLOVER'])
const ESCROW_LEGS = new Set(['DISPOSITION', 'LEGACY_SEPARATE_FEE'])

// Relay provenance values (same closed set as the rewards journal).
const DIRECT_RELAY_PROVENANCE = 'direct-relay-observation'
const CHAIN_PROOF_PROVENANCE = 'chain-proof-observation'

// One persist retry for a proven relay (post-relay persistence failure is an
// accounting failure, never a reason to forget the relay).
const RELAYED_PERSIST_ATTEMPTS = 2

// monero-ts caches the daemon height for ~30 seconds; the audit scan absorbs
// that with a bounded resync before the strict coverage check.
const AUDIT_SCAN_RESYNC_ATTEMPTS = 3
// The prepared derivation domain covers the primary plus fee-account
// primaries 1..5 (final-review I2) — the same majors the fee-account
// infrastructure provisions.

// Lazily-built provider over the separate TX-proof registry (the production
// path). No view-key or other fallback exists: a missing/misconfigured
// registry fails sealing and the dispatch never relays.
const defaultKeyProvider = () => createPaymentProofKeyProvider(process.env)

function normalizeHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}

function normalizeScope (scope) {
  if (!scope || typeof scope !== 'object') throw new Error('invalid escrow wallet scope')
  if (!ESCROW_NETWORKS.has(scope.network)) throw new Error('invalid escrow wallet scope: unsupported network')
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress.trim() === '') {
    throw new Error('invalid escrow wallet scope: wallet address is not configured')
  }
  return { network: scope.network, walletAddress: scope.walletAddress }
}

const requireAddressText = (value, what) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`prepareEscrowTransaction: ${what} must be a frozen address`)
  }
  return value
}

// The frozen contract of one payout, derived from the payout row itself (the
// row is the authority) plus the fee destination the caller froze BEFORE the
// tx could move funds. ROLLOVER payouts carry no separate fee leg regardless
// of the column (frozen 0, matching readBountySettlement), so a rollover or
// fee-waived refund is a single net destination whose feePiconeros is 0 with
// a null fee recipient. A legacy separate-fee dispatch requires the prize
// already relayed, no fee relayed yet, a pending deferred fee, and a frozen
// fee destination — the exact preconditions the store re-validates inside its
// Serializable preparation transaction.
function frozenTermsFromPayout (payout, leg) {
  const recipientAddress = requireAddressText(payout.recipientAddress, 'the recipient address')
  const prizePiconeros = money(payout.piconeros)
  if (prizePiconeros < 0n) throw new Error('prepareEscrowTransaction: negative bounty payout prize')
  if (leg === 'LEGACY_SEPARATE_FEE') {
    const feePiconeros = money(payout.feePiconeros)
    if (feePiconeros <= 0n) throw new Error('prepareEscrowTransaction: a separate-fee dispatch requires a positive deferred fee')
    if (payout.txHash == null) throw new Error('prepareEscrowTransaction: the prize must be sent before a separate-fee dispatch')
    if (payout.feeTxHash != null) throw new Error('prepareEscrowTransaction: the deferred fee already relayed')
    if (payout.feePendingAt == null) throw new Error('prepareEscrowTransaction: no deferred fee is pending on the payout')
    const feeRecipientAddress = requireAddressText(payout.feeRecipientAddress, 'the fee destination')
    return {
      recipientAddress,
      prizePiconeros: prizePiconeros.toString(),
      feePiconeros: feePiconeros.toString(),
      feeRecipientAddress
    }
  }
  const feePiconeros = payout.kind === 'ROLLOVER' ? 0n : money(payout.feePiconeros)
  if (feePiconeros < 0n) throw new Error('prepareEscrowTransaction: negative bounty payout fee')
  if (feePiconeros === 0n) {
    return {
      recipientAddress,
      prizePiconeros: prizePiconeros.toString(),
      feePiconeros: '0',
      feeRecipientAddress: null
    }
  }
  const feeRecipientAddress = requireAddressText(payout.feeRecipientAddress, 'the fee destination')
  return {
    recipientAddress,
    prizePiconeros: prizePiconeros.toString(),
    feePiconeros: feePiconeros.toString(),
    feeRecipientAddress
  }
}

// Caller settlement expectation (a readBountySettlement/readFeeSettlement
// result) normalized into the store's closed settlement shape. The legacy fee
// settlement has no prize recipient, so its recipientReceivedPiconeros is an
// explicit zero — never an invented fact.
function settlementExpectation (settlement) {
  if (settlement == null) return null
  if (typeof settlement !== 'object' || Array.isArray(settlement)) {
    throw new Error('prepareEscrowTransaction: invalid settlement expectation')
  }
  const networkFeePiconeros = money(settlement.networkFeePiconeros)
  const recipientReceivedPiconeros = money(settlement.recipientReceivedPiconeros ?? 0n)
  const feeReceivedPiconeros = money(settlement.feeReceivedPiconeros ?? 0n)
  if (networkFeePiconeros < 0n || recipientReceivedPiconeros < 0n || feeReceivedPiconeros < 0n) {
    throw new Error('prepareEscrowTransaction: negative settlement expectation')
  }
  return {
    networkFeePiconeros: networkFeePiconeros.toString(),
    recipientReceivedPiconeros: recipientReceivedPiconeros.toString(),
    feeReceivedPiconeros: feeReceivedPiconeros.toString()
  }
}

/**
 * Durable atomic preparation of one escrow dispatch: derives the frozen
 * contract from the payout row, seals the journal+proof pair (ESCROW owner
 * role) through the atomic store, and returns the durable journal row. The
 * wallet is the scope authority: the caller's `scope` is only an expectation
 * checked against the wallet-proven scope of the landed pair.
 *
 * A THROWN result — including an unknown commit outcome — authorizes NO
 * relay and is never evidence that no journal exists; callers must keep the
 * dispatch withheld until a fresh pair read resolves the outcome.
 *
 * @param {{models: object, wallet: object, tx: object, payout: object,
 *   leg: 'DISPOSITION'|'LEGACY_SEPARATE_FEE', settlement: object|null,
 *   scope: {network: string, walletAddress: string}, keyProvider: object}} request
 * @returns {Promise<object>} the durable EscrowWalletTransaction journal row
 */
export async function prepareEscrowTransaction ({
  models,
  wallet,
  tx,
  payout,
  leg,
  settlement,
  scope,
  keyProvider
}) {
  if (!models || typeof models.$transaction !== 'function') {
    throw new Error('prepareEscrowTransaction: a transactional models client is required')
  }
  if (!wallet) throw new Error('prepareEscrowTransaction: a wallet that can prove the escrow scope is required')
  if (!payout || !Number.isSafeInteger(payout.id) || payout.id <= 0 ||
    !Number.isSafeInteger(payout.itemId) || payout.itemId <= 0) {
    throw new Error('prepareEscrowTransaction: a persisted bounty payout row is required')
  }
  if (!PAYOUT_KINDS.has(payout.kind)) throw new Error('prepareEscrowTransaction: invalid bounty payout kind')
  if (!ESCROW_LEGS.has(leg)) throw new Error('prepareEscrowTransaction: invalid escrow payment leg')
  const scoped = normalizeScope(scope)
  const frozenTerms = frozenTermsFromPayout(payout, leg)
  const journalKind = leg === 'LEGACY_SEPARATE_FEE' ? 'LEGACY_SEPARATE_FEE' : payout.kind
  const dispatched = await preparePaymentDispatch({
    models,
    wallet,
    tx,
    owner: {
      journalRole: 'ESCROW',
      kind: journalKind,
      leg,
      bountyPaymentId: payout.id,
      itemId: payout.itemId,
      frozenTerms,
      settlement: settlementExpectation(settlement)
    },
    keyProvider: keyProvider ?? defaultKeyProvider()
  })
  if (dispatched.journal.network !== scoped.network ||
    dispatched.journal.walletAddress !== scoped.walletAddress) {
    throw new Error('prepareEscrowTransaction: wallet scope does not match the requested escrow wallet scope')
  }
  return dispatched.journal
}

// --- relay --------------------------------------------------------------------

async function persistRelayedState (journalModel, id, relayedAt, relayProvenance) {
  for (let attempt = 1; attempt <= RELAYED_PERSIST_ATTEMPTS; attempt++) {
    try {
      const updated = await journalModel.updateMany({
        where: { id, state: 'PREPARED' },
        data: { state: 'RELAYED', relayedAt, relayProvenance }
      })
      if (updated.count === 1) return true
      // A concurrent writer may already have recorded the same proof.
      try {
        const current = await journalModel.findUnique({ where: { id }, select: { state: true } })
        if (current?.state === 'RELAYED') return true
      } catch { /* fall through to the retry */ }
    } catch (err) {
      logError({ journalId: String(id), attempt, errorClass: errorLabel(err) }, 'escrow dispatch journal: RELAYED state persist failed')
    }
  }
  return false
}

/**
 * Relay the SAME built object through the full capture barrier (ESCROW owner
 * role): fresh pair authentication (`assertPreparedPayment`), the locked
 * DB-only claim CAS (`claimPaymentAttempt`), then exactly one
 * outside-transaction `wallet.relayTx(tx)`. An ambiguous/unknown claim
 * acknowledgement prevents the broadcast and the dispatch stays withheld.
 * A relay exception keeps PREPARED+attempted (never NOT_RELAYED, never a
 * blind re-relay); a proven relay is marked RELAYED with
 * `direct-relay-observation` provenance and one persist retry.
 *
 * @returns {Promise<{txHash: string, networkFeePiconeros: BigInt, relayed: boolean,
 *   uncertain: boolean, accountingUnpersisted: number}>} same shape as
 *   relayWalletTransaction
 */
export async function relayEscrowTransaction ({ models, wallet, journal, tx, keyProvider }) {
  const journalModel = models?.escrowWalletTransaction
  if (!journalModel || typeof journalModel.updateMany !== 'function') {
    throw new Error('relayEscrowTransaction: escrow journal model is required')
  }
  if (!journal || journal.id == null) throw new Error('relayEscrowTransaction: journal row is required')
  const txHash = normalizeHash(journal.txHash)
  if (!txHash) throw new Error('relayEscrowTransaction: journal row has an invalid transaction hash')
  if (typeof wallet?.relayTx !== 'function') throw new Error('relayEscrowTransaction: a relay-capable wallet is required')
  await assertWalletScope(wallet, { network: journal.network, walletAddress: journal.walletAddress })

  // Only the journaled object may be relayed: a different built tx must never
  // burn this row's single attempt or masquerade as its hash.
  const builtHash = normalizeHash(tx && typeof tx.getHash === 'function' ? await tx.getHash() : null)
  if (builtHash !== txHash) throw new Error('relayEscrowTransaction: transaction does not match the journaled hash')

  // Fresh pair authentication immediately before the locked claim.
  const expectedProof = await assertPreparedPayment({
    models,
    wallet,
    tx,
    journalRole: 'ESCROW',
    journalId: journal.id,
    keyProvider: keyProvider ?? defaultKeyProvider()
  })
  // Locked DB-only claim: reloads + re-authenticates the pair inside the
  // transaction and CASes the single attempt. A thrown result here (including
  // an unknown commit outcome) leaves the dispatch withheld — no broadcast.
  await claimPaymentAttempt({
    models,
    wallet,
    tx,
    journalRole: 'ESCROW',
    journalId: journal.id,
    keyProvider: keyProvider ?? defaultKeyProvider(),
    expectedProof
  })

  let relayedHash
  try {
    relayedHash = await wallet.relayTx(tx)
  } catch (err) {
    logError({ txHash, errorClass: errorLabel(err) }, 'relayEscrowTransaction: relay outcome uncertain — dispatch stays PREPARED+attempted until a fresh confirmed verification resolves it')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }
  if (normalizeHash(relayedHash) !== txHash) {
    logError({ txHash, relayedHash: normalizeHash(relayedHash) }, 'relayEscrowTransaction: relay returned a different hash — recording uncertainty instead of a false proof')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }

  const persisted = await persistRelayedState(journalModel, journal.id, new Date(), DIRECT_RELAY_PROVENANCE)
  if (!persisted) {
    logError({ txHash }, 'relayEscrowTransaction: CRITICAL — relay proven but the dispatch state was not persisted')
    alert('critical', 'Escrow relay not journaled', `Escrow transaction ${txHash} was relayed but its dispatch record could not be updated; the durable dispatch withholds its payout leg and reconciliation recovers it.`)
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 1 }
  }
  logInfo({ txHash, networkFeePiconeros: String(journal.networkFeePiconeros) }, 'relayEscrowTransaction: relayed and journaled')
  return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 0 }
}

// --- reconciliation -------------------------------------------------------------

// Attempted-but-unproven escrow relays resolve ONLY by a fresh, trusted,
// CONFIRMED whole-payment verification from a DEDICATED GENESIS-RESTORED AUDIT
// SESSION built from the bounty escrow keys — never the signer singleton
// (whose cached restore height and in-memory state must never serve as an
// audit authority) and never from destination-shaped wallet history.

// The audit wallet is opened from the bounty escrow keys in env, restored from
// GENESIS (restore height 0 — no historical mixing), in-memory, and closed by
// the caller in `finally`. Never logs any key material.
async function openGenesisAuditWallet (scope) {
  const address = process.env.BOUNTY_ESCROW_ADDRESS
  const spendKey = process.env.BOUNTY_ESCROW_SPEND_KEY
  const viewKey = process.env.BOUNTY_ESCROW_VIEW_KEY
  if (!address || !spendKey || !viewKey) {
    throw new Error('escrow dispatch audit: the bounty escrow wallet keys are not configured')
  }
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = NETWORK_TYPES[scope.network]
  if (networkType === undefined) throw new Error('escrow dispatch audit: unsupported network')
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'
  // Dedicated in-memory audit wallet — deliberately NOT the signer singleton.
  return api.createWalletFull({
    password: 'bounty-escrow-audit',
    networkType,
    primaryAddress: address,
    privateSpendKey: spendKey,
    privateViewKey: viewKey,
    restoreHeight: 0,
    server: { uri: serverUri },
    proxyToWorker: false
  })
}

// The derivation domain for the audit scan: the scope primary address plus
// every account/subaddress the audit wallet actually exposes, so any
// SDK-discovered owned index is inside the domain (the collector refuses a
// narrowed domain). Read failures make the session unavailable — never a
// guessed domain.
async function auditDerivation (auditWallet, scope, models) {
  try {
    // Address cache so every derived entry carries its DECODED address (the
    // collector validates the prepared domain's position→address mapping).
    const addressCache = new Map()
    const addressAt = async (majorIndex, minorIndex) => {
      const key = `${majorIndex}:${minorIndex}`
      if (addressCache.has(key)) return addressCache.get(key)
      let address = null
      try {
        address = typeof auditWallet.getAddress === 'function'
          ? await auditWallet.getAddress(majorIndex, minorIndex)
          : null
      } catch { address = null }
      if ((address === null || address === undefined) && typeof auditWallet.getSubaddress === 'function') {
        try {
          const subaddress = await auditWallet.getSubaddress(majorIndex, minorIndex)
          address = typeof subaddress?.getAddress === 'function' ? subaddress.getAddress() : null
        } catch { address = null }
      }
      if (typeof address !== 'string' || address === '') return null
      addressCache.set(key, address)
      return address
    }
    const derived = []
    const push = async (majorIndex, minorIndex) => {
      const address = await addressAt(majorIndex, minorIndex)
      if (address === null) return false
      if (!derived.some(entry => entry.majorIndex === majorIndex && entry.minorIndex === minorIndex)) {
        derived.push({ majorIndex, minorIndex, address })
      }
      return true
    }

    // Escrow requires its primary plus every recorded position, not rewards
    // fee-account primaries. Recorded minors are prepared BEFORE scanning.
    const recorded = await prepareRecordedPaymentAddresses({ models, wallet: auditWallet, scope })
    for (const row of recorded) {
      if (!(await push(row.majorIndex, row.minorIndex))) return null
    }
    const accounts = typeof auditWallet.getAccounts === 'function'
      ? (await auditWallet.getAccounts()) || []
      : []
    const majors = new Set()
    for (const account of accounts) {
      const majorIndex = typeof account?.getIndex === 'function' ? account.getIndex() : null
      if (!Number.isSafeInteger(majorIndex) || majorIndex < 0) return null
      majors.add(majorIndex)
    }
    if (!(await push(0, 0))) return null
    for (const major of majors) {
      if (!(await push(major, 0))) return null
    }
    for (const major of [0, ...majors]) {
      if (typeof auditWallet.getSubaddresses !== 'function') continue
      const subaddresses = (await auditWallet.getSubaddresses(major)) || []
      for (let minorIndex = 0; minorIndex < subaddresses.length; minorIndex++) {
        if (!(await push(major, minorIndex))) return null
      }
    }
    return { complete: true, primaryAddress: scope.walletAddress, derived, mismatches: [] }
  } catch {
    return null
  }
}

// The daemon tip is the ONLY boundary authority: the highest EXISTING block
// index plus its block hash (mirrors the evidence collector).
async function auditBoundary (daemon) {
  try {
    if (typeof daemon?.getHeight !== 'function' || typeof daemon?.getBlockHashByHeight !== 'function') return null
    const chainLength = await daemon.getHeight()
    if (!Number.isSafeInteger(chainLength) || chainLength < 1) return null
    const height = chainLength - 1
    const blockHash = normalizeHash(await daemon.getBlockHashByHeight(height))
    return blockHash ? { height, blockHash } : null
  } catch {
    return null
  }
}

async function auditScannedHeight (auditWallet, minCount) {
  let scanned = null
  try {
    scanned = typeof auditWallet.getHeight === 'function' ? await auditWallet.getHeight() : null
  } catch { return null }
  for (let attempt = 0; (scanned === null || scanned < minCount) && attempt < AUDIT_SCAN_RESYNC_ATTEMPTS; attempt++) {
    try {
      if (typeof auditWallet.sync !== 'function') break
      await auditWallet.sync()
      scanned = await auditWallet.getHeight()
    } catch {
      return null
    }
  }
  return scanned
}

// Build ONE verification session from the dedicated audit wallet: identity is
// proven before any scan, the boundary is the live daemon tip, the wallet's
// scan must cover the boundary block, and the collector + receipt checker are
// bound to the audit wallet. Any failure yields null — attempted rows then
// stay unresolved (fail closed), never promoted.
async function buildAuditSession ({ auditWallet, daemon, scope, models }) {
  try {
    if (!auditWallet || typeof auditWallet.getOutputs !== 'function' ||
      typeof auditWallet.getPrimaryAddress !== 'function' ||
      typeof auditWallet.getNetworkType !== 'function' ||
      typeof auditWallet.checkTxKey !== 'function') return null
    await assertWalletScope(auditWallet, scope)
    const derivation = await auditDerivation(auditWallet, scope, models)
    if (derivation === null) return null
    const boundary = await auditBoundary(daemon)
    if (boundary === null) return null
    const scanned = await auditScannedHeight(auditWallet, boundary.height + 1)
    if (scanned === null || scanned < boundary.height + 1) return null
    const session = await collectPaymentChainEvidence({
      wallet: auditWallet,
      daemon,
      scope,
      derivation,
      boundary,
      journalRole: 'ESCROW',
      auditedHashes: await readPaymentAuditHashes({ models, scope, journalRole: 'ESCROW' })
    })
    // Bracket the collection against the tip (final-review I4): a chain that
    // moved during the session refuses (null → rows retain uncertainty and
    // the next bounded run reruns), never a mixed-boundary promotion.
    const tipAfter = await auditBoundary(daemon)
    if (tipAfter === null || tipAfter.height !== boundary.height ||
      tipAfter.blockHash !== boundary.blockHash) {
      return null
    }
    return { ...session, checkTxKey: (...args) => auditWallet.checkTxKey(...args) }
  } catch {
    return null
  }
}

// Verify ONE attempted PREPARED dispatch through the fresh audit session.
// Returns the safe PaymentVerificationV1 only when the verification is
// COMPLETE; missing sessions, missing/lost proof keys, chain-evidence
// failures, non-complete results and throwing loads all resolve to null so
// the row RETAINS uncertainty (never NOT_RELAYED, never a promotion). Only
// fixed labels and machine issue codes ever reach the logs.
async function verifyAttemptedDispatch ({ models, row, session, keyProvider }) {
  if (!session) return null
  try {
    const result = await verifyPaymentTransaction({
      models,
      journalRole: 'ESCROW',
      journalId: row.id,
      session,
      keyProvider,
      observedAt: new Date().toISOString()
    })
    if (!result || result.status !== 'complete') {
      logWarn({ txHash: row.txHash, kind: row.kind, leg: row.leg, issues: result?.issues ?? null }, 'reconcileEscrowTransactions: fresh verification is not complete — retaining uncertainty')
      return null
    }
    return result
  } catch (err) {
    logError({ txHash: row.txHash, kind: row.kind, leg: row.leg, errorClass: errorLabel(err) }, 'reconcileEscrowTransactions: fresh verification unavailable — retaining uncertainty')
    return null
  }
}

// The expected member multiset of one captured escrow dispatch, derived from
// its own authenticated frozen claims (mirrors the store's claims derivation):
//   DISPOSITION with a fee: the exact prize to the recipient plus the
//     fee-minus-network-fee remainder to the fee recipient;
//   DISPOSITION without a fee: one net member of prize minus network fee;
//   LEGACY_SEPARATE_FEE: the full frozen fee to the frozen fee recipient.
// Exported for the reverse recorded-outflow coverage and its fixtures: the
// repair audit binds covering verifications to THIS exact frozen membership.
export function expectedEscrowMembers (claims) {
  const id = String(claims.bountyPaymentId)
  const terms = claims.frozenTerms
  const prize = BigInt(terms.prizePiconeros)
  const fee = BigInt(terms.feePiconeros)
  const networkFee = BigInt(claims.networkFeePiconeros)
  const sort = members => members.sort((a, b) => {
    const aId = BigInt(a.id)
    const bId = BigInt(b.id)
    if (aId !== bId) return aId < bId ? -1 : 1
    return a.leg < b.leg ? -1 : a.leg > b.leg ? 1 : 0
  })
  if (claims.kind === 'LEGACY_SEPARATE_FEE') {
    return [{ id, leg: 'LEGACY_SEPARATE_FEE', address: terms.feeRecipientAddress, actual: fee }]
  }
  if (fee === 0n) {
    return [{ id, leg: 'PRINCIPAL', address: terms.recipientAddress, actual: prize - networkFee }]
  }
  return sort([
    { id, leg: 'PRINCIPAL', address: terms.recipientAddress, actual: prize },
    { id, leg: 'FEE', address: terms.feeRecipientAddress, actual: fee - networkFee }
  ])
}

// Exact agreement between a COMPLETE verification and the dispatch row's own
// immutable facts: scope, hash, journal identity, capture binding, source
// account, network fee, kind/leg coherence, and the exact member multiset
// derived from the row's frozen claims. Any unreadable or contradicting fact
// fails — the row keeps its uncertainty.
function verificationMatchesDispatch (result, row) {
  try {
    if (!result || result.status !== 'complete' || result.captureMode !== 'CAPTURE_V1') return false
    if (result.journalRole !== 'ESCROW' || String(result.journalId) !== String(row.id)) return false
    if (!result.scope || result.scope.network !== row.network ||
      result.scope.walletAddress !== row.walletAddress) return false
    if (result.txHash !== row.txHash) return false
    if (typeof result.claimDigest === 'string' && row.claimDigest != null &&
      result.claimDigest !== row.claimDigest) return false
    if (!Array.isArray(result.sourceAccounts) || !result.sourceAccounts.includes(String(row.accountIndex))) return false
    if (result.totals?.F == null || BigInt(result.totals.F) !== money(row.networkFeePiconeros)) return false
    const claims = normalizePaymentClaims(row.paymentClaims)
    if (paymentClaimDigest(claims) !== row.claimDigest) return false
    if (claims.kind !== row.kind) return false
    if ((row.kind === 'LEGACY_SEPARATE_FEE') !== (row.leg === 'LEGACY_SEPARATE_FEE')) return false
    const actual = [...(Array.isArray(result.members) ? result.members : [])].map(member => ({
      id: String(member?.id),
      leg: member?.leg,
      address: member?.address,
      actual: BigInt(member?.actualPiconeros)
    })).sort((a, b) => {
      const aId = BigInt(a.id)
      const bId = BigInt(b.id)
      if (aId !== bId) return aId < bId ? -1 : 1
      return a.leg < b.leg ? -1 : a.leg > b.leg ? 1 : 0
    })
    const expected = expectedEscrowMembers(claims)
    if (actual.length !== expected.length) return false
    for (let index = 0; index < expected.length; index++) {
      const e = expected[index]
      const a = actual[index]
      if (a.id !== e.id || a.leg !== e.leg || a.address !== e.address || a.actual !== e.actual) return false
    }
    return true
  } catch {
    return false
  }
}

// Read the stored claims of a RELAYED dispatch and authenticate them against
// the row's immutable digest (DB-only: no proof key, no chain). Returns null
// (and flags accounting uncertainty) for any unreadable or tampered capture —
// a corrupt pair can never authorize a payout-row write.
async function authenticatedRelayedClaims (models, row) {
  let claims = null
  try {
    claims = normalizePaymentClaims(row.paymentClaims)
    if (paymentClaimDigest(claims) !== row.claimDigest) return null
  } catch {
    return null
  }
  return claims
}

// Derive the settlement facts of a RELAYED disposition dispatch from its
// captured claims. Returns null for any shape that does not conserve exactly.
function dispositionSettlementFromClaims (claims) {
  try {
    const terms = claims.frozenTerms
    const prize = BigInt(terms.prizePiconeros)
    const fee = BigInt(terms.feePiconeros)
    const networkFee = BigInt(claims.networkFeePiconeros)
    if (fee === 0n) {
      if (claims.members.length !== 1 || claims.members[0].leg !== 'PRINCIPAL' ||
        claims.members[0].address !== terms.recipientAddress) return null
      const recipientReceived = BigInt(claims.members[0].actualPiconeros)
      if (recipientReceived + networkFee !== prize) return null
      return { networkFee, recipientReceived, feeReceived: 0n }
    }
    if (claims.members.length !== 2) return null
    const prizeMember = claims.members.find(member => member.leg === 'PRINCIPAL')
    const feeMember = claims.members.find(member => member.leg === 'FEE')
    if (!prizeMember || !feeMember) return null
    if (prizeMember.address !== terms.recipientAddress || feeMember.address !== terms.feeRecipientAddress) return null
    const recipientReceived = BigInt(prizeMember.actualPiconeros)
    const feeReceived = BigInt(feeMember.actualPiconeros)
    if (recipientReceived !== prize) return null
    if (feeReceived <= 0n || recipientReceived + feeReceived + networkFee !== prize + fee) return null
    return { networkFee, recipientReceived, feeReceived }
  } catch {
    return null
  }
}

function legacyFeeSettlementFromClaims (claims) {
  try {
    const terms = claims.frozenTerms
    const fee = BigInt(terms.feePiconeros)
    const networkFee = BigInt(claims.networkFeePiconeros)
    if (fee <= 0n) return null
    if (claims.members.length !== 1 || claims.members[0].leg !== 'LEGACY_SEPARATE_FEE' ||
      claims.members[0].address !== terms.feeRecipientAddress) return null
    const feeReceived = BigInt(claims.members[0].actualPiconeros)
    if (feeReceived !== fee) return null // the legacy fee rides with NO subtraction
    return { networkFee, feeReceived }
  } catch {
    return null
  }
}

// Durable RELAYED recovery of settlement facts (DB-only: no chain read, no
// proof key, never a re-send). A RELAYED dispatch is durable proof its relay
// happened; the payout-row persist may have failed after that relay, leaving
// the row QUEUED (disposition) or feePendingAt set (legacy fee). Recovery
// compare-writes the captured settlement facts ONLY into a live row that
// still matches the frozen contract AND has no recorded hash of its own
// (or already carries this exact hash):
//   - a matching QUEUED row is recovered to SENT exactly once via CAS;
//   - an already-recorded MISMATCHING hash, a FAILED row, or a row whose
//     frozen identity changed is withheld and alerted — never rewritten;
//   - a corrupt/unreadable capture withholds and flags accounting
//     uncertainty instead of authorizing any write.
async function recoverRelayedDispatch ({ models, row, claims, result }) {
  const txHash = normalizeHash(row.txHash)
  const flag = reason => {
    logError({ txHash: row.txHash, bountyPaymentId: row.bountyPaymentId, leg: row.leg, reason }, 'reconcileEscrowTransactions: CRITICAL — durable RELAYED escrow dispatch does not match its live payout row; withholding (no rewrite, no re-send)')
    alert('critical', 'bounty escrow settlement recovery withheld',
      `durable relayed escrow dispatch ${row.txHash} (payout ${row.bountyPaymentId}, leg ${row.leg}) cannot be recovered onto its live payout row (${reason}); the payout stays withheld from every fresh send and nothing is rewritten until reviewed`,
      { dedupeKey: `escrow-recovery-withheld-${row.id}` })
    result.accountingUnpersisted += 1
  }
  if (!txHash) return flag('unreadable transaction hash')
  if (!claims) return flag('capture claims unreadable or tampered')

  if (row.leg === 'DISPOSITION') {
    const settlement = dispositionSettlementFromClaims(claims)
    if (!settlement) return flag('captured settlement does not conserve the frozen terms')
    const prize = BigInt(claims.frozenTerms.prizePiconeros)
    const frozenFee = BigInt(claims.frozenTerms.feePiconeros)
    // Material live contract facts in the compare-write predicate (final-review
    // I11): the live disposition KIND, the frozen ITEM attribution and the
    // frozen fee terms/destination — a live row whose material terms diverged
    // is withheld, never filled with captured settlement facts. Rollover
    // payouts freeze fee 0/null regardless of the live column (matching the
    // capture-time frozen-terms derivation), so only non-rollover kinds
    // constrain the fee columns here.
    const updated = await models.bountyPayment.updateMany({
      where: {
        id: row.bountyPaymentId,
        kind: claims.kind,
        itemId: row.itemId,
        state: 'QUEUED',
        recipientAddress: claims.frozenTerms.recipientAddress,
        piconeros: prize,
        ...(claims.kind === 'ROLLOVER'
          ? {}
          : {
              feePiconeros: frozenFee,
              feeRecipientAddress: claims.frozenTerms.feeRecipientAddress
            }),
        OR: [{ txHash: null }, { txHash }]
      },
      data: {
        state: 'SENT',
        txHash,
        sentAt: row.relayedAt ?? new Date(),
        networkFeePiconeros: settlement.networkFee,
        recipientReceivedPiconeros: settlement.recipientReceived,
        feeReceivedPiconeros: settlement.feeReceived
      }
    })
    if (updated.count === 1) {
      result.recoveredIds.push(row.bountyPaymentId)
      logInfo({ txHash, bountyPaymentId: row.bountyPaymentId }, 'reconcileEscrowTransactions: recovered a durable RELAYED disposition onto its payout row (no re-send)')
      return
    }
    const live = await models.bountyPayment.findUnique({
      where: { id: row.bountyPaymentId },
      select: {
        id: true,
        state: true,
        txHash: true,
        recipientAddress: true,
        piconeros: true,
        kind: true,
        itemId: true,
        feePiconeros: true,
        feeRecipientAddress: true
      }
    })
    if (!live) return // not a live candidate: nothing to recover onto
    const recordedHash = live.txHash == null ? null : normalizeHash(live.txHash)
    const feeTermsMatch = claims.kind === 'ROLLOVER' ||
      (money(live.feePiconeros) === frozenFee &&
        (live.feeRecipientAddress ?? null) === claims.frozenTerms.feeRecipientAddress)
    if ((live.state === 'SENT' || live.state === 'CONFIRMED') &&
      recordedHash === txHash && live.recipientAddress === claims.frozenTerms.recipientAddress &&
      money(live.piconeros) === prize && live.kind === claims.kind && live.itemId === row.itemId &&
      feeTermsMatch) {
      return // already recorded by a prior persist/recovery — nothing to do
    }
    return flag(live.state === 'FAILED'
      ? 'relayed proof contradicts a FAILED row'
      : recordedHash != null && recordedHash !== txHash
        ? 'recorded transaction hash mismatch'
        : live.kind !== claims.kind || live.itemId !== row.itemId || !feeTermsMatch
          ? 'live payout row material terms diverged from the capture'
          : 'live payout row changed incompatibly during recovery')
  }

  // LEGACY_SEPARATE_FEE: the fee leg of a payout whose prize is already SENT.
  const settlement = legacyFeeSettlementFromClaims(claims)
  if (!settlement) return flag('captured fee settlement does not match the frozen fee')
  const fee = BigInt(claims.frozenTerms.feePiconeros)
  const updated = await models.bountyPayment.updateMany({
    where: {
      id: row.bountyPaymentId,
      itemId: row.itemId,
      state: { in: ['SENT', 'CONFIRMED'] },
      recipientAddress: claims.frozenTerms.recipientAddress,
      piconeros: BigInt(claims.frozenTerms.prizePiconeros),
      feePendingAt: { not: null },
      feeTxHash: null,
      feeRecipientAddress: claims.frozenTerms.feeRecipientAddress,
      feePiconeros: fee
    },
    data: {
      feeTxHash: txHash,
      feePendingAt: null,
      feeSettlementNetworkFeePiconeros: settlement.networkFee,
      feeReceivedPiconeros: settlement.feeReceived
    }
  })
  if (updated.count === 1) {
    result.recoveredIds.push(row.bountyPaymentId)
    logInfo({ txHash, bountyPaymentId: row.bountyPaymentId }, 'reconcileEscrowTransactions: recovered a durable RELAYED separate fee onto its payout row (no re-send)')
    return
  }
  const live = await models.bountyPayment.findUnique({
    where: { id: row.bountyPaymentId },
    select: {
      id: true,
      state: true,
      feeTxHash: true,
      feePendingAt: true,
      feeRecipientAddress: true,
      feePiconeros: true,
      itemId: true,
      recipientAddress: true,
      piconeros: true
    }
  })
  if (!live) return
  const recordedFeeHash = live.feeTxHash == null ? null : normalizeHash(live.feeTxHash)
  if (recordedFeeHash === txHash && live.feePendingAt == null &&
    live.feeRecipientAddress === claims.frozenTerms.feeRecipientAddress && money(live.feePiconeros) === fee &&
    live.itemId === row.itemId && live.recipientAddress === claims.frozenTerms.recipientAddress &&
    money(live.piconeros) === BigInt(claims.frozenTerms.prizePiconeros)) {
    return // already recorded by a prior persist/recovery
  }
  return flag(recordedFeeHash != null && recordedFeeHash !== txHash
    ? 'recorded fee transaction hash mismatch'
    : live.itemId !== row.itemId || live.recipientAddress !== claims.frozenTerms.recipientAddress ||
      money(live.piconeros) !== BigInt(claims.frozenTerms.prizePiconeros)
      ? 'live payout row material terms diverged from the capture'
      : live.feePendingAt == null
        ? 'no deferred fee is pending on the live row'
        : 'live payout row changed incompatibly during recovery')
}

/**
 * Resolve durable escrow dispatches BEFORE any fresh candidate filtering.
 * NEVER signs, sends or re-relays. Two layers:
 *
 *   1. attempted-but-unproven PREPARED dispatches resolve ONLY by a fresh
 *      CONFIRMED whole-payment verification from a dedicated genesis-restored
 *      audit session (built from the bounty escrow keys, never the signer
 *      singleton); a COMPLETE result that exactly matches the row promotes it
 *      to RELAYED with the observation time and `chain-proof-observation`
 *      provenance. Everything else RETAINS uncertainty.
 *   2. every durable dispatch — attempted, durable-but-unattempted, or
 *      RELAYED — withholds its exact (bountyPaymentId, leg): disposition legs
 *      land in `withheldDispositionIds`, fee legs in `withheldFeeIds`.
 *      Durable-but-unattempted pairs additionally reserve their leg with a
 *      CRITICAL operator alert (provably unbroadcast; resolution is explicit
 *      operator handling via a verified pair teardown — never an automatic
 *      resend, never an automatic deletion). Then the durable RELAYED set,
 *      including every in-pass promotion, recovers settlement facts into
 *      matching live payout rows via CAS.
 *
 * `daemon` (default the shared restricted daemon client) and `keyProvider`
 * (default the lazily-built separate TX-proof registry) are injectable so
 * callers and tests can pass fakes; `auditWallet` (additive, like the
 * evidence collector's injected audit wallets) bypasses the env-key wallet
 * open for tests. When the audit session cannot be built, attempted rows stay
 * unresolved (fail closed) while the DB-only withholding and recovery still
 * run. Escrow fees never contribute to the hot-wallet network-expense union
 * and no hot-wallet receipt is ever written.
 *
 * @returns {Promise<{withheldDispositionIds: number[], withheldFeeIds: number[],
 *   recoveredIds: number[], accountingUnpersisted: number}>}
 */
export async function reconcileEscrowTransactions ({
  models,
  wallet,
  scope,
  daemon = daemonClient,
  keyProvider,
  auditWallet = null
}) {
  const journalModel = models?.escrowWalletTransaction
  if (!journalModel || typeof journalModel.findMany !== 'function') {
    throw new Error('reconcileEscrowTransactions: escrow journal model is required')
  }
  const scoped = normalizeScope(scope)
  const result = { withheldDispositionIds: [], withheldFeeIds: [], recoveredIds: [], accountingUnpersisted: 0 }

  // 1. Attempted-but-unproven relays: fresh verified confirmation only.
  const uncertain = await journalModel.findMany({
    where: {
      network: scoped.network,
      walletAddress: scoped.walletAddress,
      state: 'PREPARED',
      relayAttemptedAt: { not: null }
    },
    orderBy: { id: 'asc' }
  })
  if (uncertain.length > 0) {
    // The signer wallet must still prove it is the accounting authority for
    // this scope before any resolution runs (identity gate).
    await assertWalletScope(wallet, scoped)

    // ONE dedicated audit session for the whole pass, built lazily (only when
    // uncertainty exists) and closed in `finally`. An unavailable session —
    // unconfigured keys, scan failure, daemon trouble — retains uncertainty
    // for every attempted dispatch instead of ever guessing.
    let session = null
    let openedAuditWallet = null
    try {
      if (auditWallet) {
        session = await buildAuditSession({ auditWallet, daemon, scope: scoped, models })
      } else {
        try {
          openedAuditWallet = await openGenesisAuditWallet(scoped)
        } catch (err) {
          logWarn({ errorClass: errorLabel(err) }, 'reconcileEscrowTransactions: the dedicated escrow audit wallet is unavailable — retaining uncertainty')
        }
        if (openedAuditWallet) {
          session = await buildAuditSession({ auditWallet: openedAuditWallet, daemon, scope: scoped, models })
        }
      }
      if (!session) {
        logWarn('reconcileEscrowTransactions: no fresh audit session — attempted escrow relays stay unresolved')
      }

      for (const row of uncertain) {
        const verification = await verifyAttemptedDispatch({ models, row, session, keyProvider: keyProvider ?? defaultKeyProvider() })
        if (!verificationMatchesDispatch(verification, row)) {
          if (verification) {
            logError({ txHash: row.txHash, kind: row.kind, leg: row.leg }, 'reconcileEscrowTransactions: fresh verification does not exactly match the dispatch row — retaining uncertainty')
          }
          result.accountingUnpersisted += 1
          continue
        }
        // The fresh confirmed observation PROVES the relay; `relayedAt`
        // records when that proof was observed, never a historical
        // submission time.
        if (await commitPaymentPromotionAtBoundary({
          models,
          daemon,
          boundary: session.boundary,
          promote: client => persistRelayedState(client.escrowWalletTransaction, row.id, new Date(verification.observedAt), CHAIN_PROOF_PROVENANCE)
        })) {
          logInfo({ txHash: row.txHash, kind: row.kind, leg: row.leg }, 'reconcileEscrowTransactions: fresh confirmed verification recovered a proven escrow relay into the journal')
        } else {
          logError({ txHash: row.txHash, kind: row.kind, leg: row.leg }, 'reconcileEscrowTransactions: CRITICAL — proven relay not journaled')
          alert('critical', 'Escrow relay not journaled', `Proven escrow transaction ${row.txHash} could not be recorded in the dispatch journal; its payout leg stays withheld until reconciliation recovers it.`)
          result.accountingUnpersisted += 1
        }
      }
    } finally {
      if (openedAuditWallet) {
        try {
          await openedAuditWallet.close()
        } catch { /* closing an audit wallet must never mask the result */ }
      }
    }
  }

  // 2. Every durable dispatch withholds its exact leg from fresh candidate
  // filtering/builds: attempted or unattempted PREPARED (an unknown attempt
  // may have broadcast) and RELAYED (durable proof of the broadcast). A
  // durable-but-unattempted pair is additionally provably unbroadcast and
  // reserved for explicit operator handling.
  const durable = await journalModel.findMany({
    where: {
      network: scoped.network,
      walletAddress: scoped.walletAddress,
      state: { in: ['PREPARED', 'RELAYED'] }
    },
    orderBy: { id: 'asc' }
  })
  const relayed = []
  for (const row of durable) {
    if (row.leg === 'LEGACY_SEPARATE_FEE') {
      if (!result.withheldFeeIds.includes(row.bountyPaymentId)) result.withheldFeeIds.push(row.bountyPaymentId)
    } else if (!result.withheldDispositionIds.includes(row.bountyPaymentId)) {
      result.withheldDispositionIds.push(row.bountyPaymentId)
    }
    if (row.state === 'PREPARED' && row.relayAttemptedAt == null) {
      logError({ txHash: row.txHash, kind: row.kind, leg: row.leg }, 'reconcileEscrowTransactions: CRITICAL — durable-but-unattempted captured pair reserves its payout leg until explicit operator handling resolves it')
      alert('critical', 'bounty escrow pair reserved (durable but unattempted)',
        `Captured escrow pair ${row.txHash} (payout ${row.bountyPaymentId}, leg ${row.leg}) is durable but was never attempted — it is provably unbroadcast. The payout leg stays reserved from rebuilding; resolve it by explicit operator handling (a verified teardown of the pair). It is never automatically re-sent and never automatically deleted.`,
        { dedupeKey: `escrow-pair-unattempted-${row.txHash}` })
    }
    if (row.state === 'RELAYED') relayed.push(row)
  }
  result.withheldDispositionIds.sort((a, b) => a - b)
  result.withheldFeeIds.sort((a, b) => a - b)

  // 3. Durable RELAYED settlement-facts recovery (DB-only), after all
  // promotions so in-pass promotions are included and competing facts are
  // rejected before any payout write.
  if (relayed.length > 0 && typeof models?.bountyPayment?.updateMany === 'function') {
    for (const row of relayed) {
      const claims = await authenticatedRelayedClaims(models, row)
      await recoverRelayedDispatch({ models, row, claims, result })
    }
  } else if (relayed.length > 0) {
    result.accountingUnpersisted += relayed.length
    logError({ count: relayed.length }, 'reconcileEscrowTransactions: bountyPayment model unavailable — durable RELAYED escrow dispatches cannot be recovered; their legs stay withheld (fail-closed)')
  }

  result.recoveredIds = [...new Set(result.recoveredIds)].sort((a, b) => a - b)
  return result
}
