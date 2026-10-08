import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { money } from '@/lib/rewardsAccounting'
import { daemonClient } from './daemonClient'
import { collectPaymentChainEvidence, commitPaymentPromotionAtBoundary, prepareRecordedPaymentAddresses, readPaymentAuditHashes } from './paymentChainEvidence'
import { verifyPaymentTransaction } from './paymentVerification'
import {
  assertPreparedPayment,
  claimPaymentAttempt,
  preparePaymentDispatch
} from './paymentProofStore'
import { createPaymentProofKeyProvider } from './paymentProofKeys'

// Durable per-transaction journal for rewards hot-wallet sends (rewards
// accounting repair §3.3 / send-time journal boundary).
//
// Every payout batch, ops sweep and consolidation follows the same boundary:
//
//   build(relay:false) -> prepare the durable journal+proof PAIR ->
//   authenticate the pair against the SAME built object -> CAS the attempt ->
//   relayTx(the SAME object) -> persist RELAYED
//
// The pair (journal row + encrypted payment proof) commits atomically BEFORE
// any broadcast; only a durable, authenticated pair authorizes the single
// relay attempt. The journal is the accounting authority for network fees and
// for the principal/metadata needed to classify a send; RewardPayout /
// RewardDistribution remain the authority for reward and sweep principal (this
// journal is not a second payout eligibility engine). A PREPARED fee is not an
// incurred expense; only a proven RELAYED fee is. A transport exception is
// never proof of non-relay: the row stays PREPARED+attempted (accounting
// uncertainty) and is resolved only by a FRESH CONFIRMED whole-payment
// verification from a dedicated audit session (never from destination-shaped
// wallet history). A built-but-unrelayed transaction cached in history is not
// evidence of relay.
//
// A thrown preparation/claim result is never read as "no journal exists": an
// unknown commit can contain a complete pair, so the dispatch stays withheld
// until a fresh DB/pair read resolves the outcome.
//
// This module never signs anything, never re-signs, never relays in
// reconciliation, and never stores keys, signed blobs or wallet credentials.
// models/wallets are injected so importing this module is inert.

// Networks the rewards wallet is provisioned for. TESTNET is deliberately
// excluded (walletScope fails closed before any send) and the DB enum cannot
// represent it.
const REWARDS_NETWORKS = new Set(['STAGENET', 'MAINNET'])

// Installed monero-ts constants (verified against MoneroNetworkType). TESTNET
// is deliberately absent: only a wallet that returns exactly one of these
// numeric enum values may act as an accounting authority.
const NETWORK_TYPES = { MAINNET: 0, STAGENET: 2 }

const TX_HASH_RE = /^[0-9a-f]{64}$/
const JOURNAL_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])

// One persist retry for a proven relay (spec: post-relay persistence failure is
// an accounting failure, never a reason to forget the relay).
const RELAYED_PERSIST_ATTEMPTS = 2

// Relay provenance values (closed set): a direct relay observation stamps the
// drive that performed the broadcast; a chain-proof observation stamps the
// fresh verified confirmation that PROVED the relay — it never claims the
// historical submission time.
const DIRECT_RELAY_PROVENANCE = 'direct-relay-observation'
const CHAIN_PROOF_PROVENANCE = 'chain-proof-observation'

function normalizeHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}

function normalizeScope (scope) {
  if (!scope || typeof scope !== 'object') throw new Error('invalid rewards wallet scope')
  if (!REWARDS_NETWORKS.has(scope.network)) throw new Error('invalid rewards wallet scope: unsupported network')
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress.trim() === '') {
    throw new Error('invalid rewards wallet scope: wallet address is not configured')
  }
  return { network: scope.network, walletAddress: scope.walletAddress }
}

// Fixed, code-defined diagnostic labels. An exception's name, code, message or
// properties are NEVER copied into a log — they can carry credentials or signed
// transaction material, and this repo's logger has no redaction. Only a label
// from the closed set returned by this function may be emitted, chosen by
// structural checks (instanceof + numeric errno/code) alone; anything else is
// the fixed generic `unknown`.
//
// Numeric markers used for structural classification (never exception strings):
// DOMException 20 = AbortError, 23 = TimeoutError; Node network errno values
// ETIMEDOUT 110 (Linux) / 60 (macOS/BSD), connection failures 32/100-107/
// 111-113 (Linux) and 50/51/53/54/61/64/65 (macOS/BSD).
const DOMEXCEPTION_TIMEOUT_CODES = new Set([20, 23])
const TIMEOUT_ERRNOS = new Set([110, 60])
const CONNECTION_ERRNOS = new Set([32, 100, 101, 102, 103, 104, 105, 106, 107, 111, 112, 113, 50, 51, 53, 54, 61, 64, 65])

// Exported so every wallet-error boundary sharing this process's send paths
// (api/monero/rewards.js, worker/rewardsDistributor.js) emits the SAME fixed
// label set instead of copying a credential-bearing exception into logs or
// alert transport.
export function errorLabel (err) {
  try {
    if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
      return DOMEXCEPTION_TIMEOUT_CODES.has(err.code) ? 'timeout' : 'unknown'
    }
    const errno = err?.errno
    if (typeof errno === 'number' && Number.isInteger(errno)) {
      if (TIMEOUT_ERRNOS.has(errno)) return 'timeout'
      if (CONNECTION_ERRNOS.has(errno)) return 'connection'
    }
    // Any numeric code on a wallet/daemon/database exception is an RPC-layer
    // code; the fixed label is emitted instead of the number's textual context.
    const code = err?.code
    if (typeof code === 'number' && Number.isInteger(code)) return 'rpc'
  } catch { /* unreadable exception: fall through to the fixed generic label */ }
  return 'unknown'
}

// Refuse to treat a wallet as an accounting authority unless it can prove it is
// the configured rewards wallet: same primary address and same network. A
// mismatched wallet's history could otherwise prove or disprove the wrong
// on-chain facts. The network must be exactly the numeric library enum — no
// coercion, so null/false/'' can never masquerade as MAINNET's 0. Never echoes
// configured values.
export async function assertWalletScope (wallet, scope) {
  const expectedNetwork = NETWORK_TYPES[scope?.network]
  if (expectedNetwork === undefined) throw new Error('wallet scope mismatch: unsupported network')
  if (typeof scope?.walletAddress !== 'string' || scope.walletAddress.trim() === '') {
    throw new Error('wallet scope mismatch: wallet address is not configured')
  }
  if (!wallet || typeof wallet.getPrimaryAddress !== 'function' || typeof wallet.getNetworkType !== 'function') {
    throw new Error('wallet scope mismatch: wallet cannot prove its identity')
  }
  const primaryAddress = await wallet.getPrimaryAddress()
  if (primaryAddress !== scope.walletAddress) {
    throw new Error('wallet scope mismatch: wallet primary address does not match the rewards wallet scope')
  }
  const networkType = await wallet.getNetworkType()
  if (typeof networkType !== 'number' || !Number.isInteger(networkType) || networkType !== expectedNetwork) {
    throw new Error('wallet scope mismatch: wallet network does not match the rewards wallet scope')
  }
  return true
}

// --- immutable metadata (closed union) --------------------------------------

const sortedKeys = value => Object.keys(value).sort().join(',')

function requireAddress (value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid journal metadata: ${label}`)
  return value
}

// Validate + canonicalize the closed metadata union for a kind. BigInt member
// amounts become exact decimal strings. PAYOUT members are sorted by payoutId
// so the same facts always produce the same immutable row; their sum must equal
// the journal principal. CONSOLIDATION is a self transfer to the wallet's own
// primary address with zero external principal; OPS_SWEEP stores its single
// external destination.
function validateMetadata ({ kind, metadata, principalPiconeros, scope }) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('invalid journal metadata')
  }

  if (kind === 'PAYOUT') {
    if (sortedKeys(metadata) !== 'payouts' || !Array.isArray(metadata.payouts) || metadata.payouts.length === 0) {
      throw new Error('invalid PAYOUT metadata: payouts is required')
    }
    const seen = new Set()
    let sum = 0n
    const members = metadata.payouts.map(member => {
      if (!member || typeof member !== 'object' || Array.isArray(member) ||
        sortedKeys(member) !== 'payoutId,piconeros,recipientAddress') {
        throw new Error('invalid PAYOUT metadata member')
      }
      const { payoutId, recipientAddress } = member
      if (!Number.isSafeInteger(payoutId) || payoutId <= 0) throw new Error('invalid payout id in journal metadata')
      if (seen.has(payoutId)) throw new Error('duplicate payout id in journal metadata')
      seen.add(payoutId)
      const piconeros = money(member.piconeros)
      if (piconeros < 0n) throw new Error('negative payout amount in journal metadata')
      sum += piconeros
      return { payoutId, recipientAddress: requireAddress(recipientAddress, 'recipient address'), piconeros: piconeros.toString() }
    })
    if (sum !== principalPiconeros) throw new Error('journal metadata principal mismatch')
    members.sort((a, b) => a.payoutId - b.payoutId)
    return { payouts: members }
  }

  if (kind === 'OPS_SWEEP') {
    if (sortedKeys(metadata) !== 'destination') throw new Error('invalid OPS_SWEEP metadata')
    return { destination: requireAddress(metadata.destination, 'destination') }
  }

  // CONSOLIDATION
  if (sortedKeys(metadata) !== 'destination,selfTransfer') throw new Error('invalid CONSOLIDATION metadata')
  if (metadata.selfTransfer !== true) throw new Error('invalid CONSOLIDATION metadata: selfTransfer must be true')
  if (principalPiconeros !== 0n) throw new Error('CONSOLIDATION principal must be zero')
  const destination = requireAddress(metadata.destination, 'destination')
  if (destination !== scope.walletAddress) {
    throw new Error('CONSOLIDATION destination must be the wallet primary address')
  }
  return { destination, selfTransfer: true }
}

// --- preparation -------------------------------------------------------------

// Lazily-built provider over the separate TX-proof registry (the production
// path). There is deliberately NO view-key or other fallback registry: a
// missing/misconfigured registry fails sealing and the dispatch never relays.
const defaultKeyProvider = () => createPaymentProofKeyProvider(process.env)

// Persist the durable journal+proof PAIR for a built-but-UNRELAYED transaction
// (Finding #1 capture barrier). Preparation is delegated to the atomic pair
// store: the claims derive from the built transaction's REAL fields (hash,
// fee, actual destinations, key bundle) plus the caller's owner expectations,
// and the journal row + encrypted proof land together in one Serializable
// transaction before anything may relay. The transaction's hash and real fee
// are read first so an unreadable or invalid fee/hash never reaches the
// journal. Re-preparing the same (network, walletAddress, txHash) with
// identical facts returns the existing pair unchanged; any differing immutable
// fact is a conflict.
//
// THROWN OUTCOMES ARE NOT "NO JOURNAL EXISTS": an unknown commit can contain a
// complete pair. Callers must resolve with a fresh DB/pair read before any
// broadcast and keep the dispatch withheld while the outcome is unresolved.
export async function prepareWalletTransaction ({
  models,
  wallet,
  scope,
  tx,
  kind,
  accountIndex,
  distributionId = null,
  principalPiconeros,
  metadata,
  keyProvider
}) {
  const journalModel = models?.rewardsWalletTransaction
  if (!journalModel || typeof models.$transaction !== 'function') {
    throw new Error('prepareWalletTransaction: a transactional models client is required')
  }
  if (!wallet) throw new Error('prepareWalletTransaction: a wallet that can prove the rewards scope is required')
  const scoped = normalizeScope(scope)
  if (!JOURNAL_KINDS.has(kind)) throw new Error('invalid rewards wallet transaction kind')
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) throw new Error('invalid journal account index')
  if (distributionId != null && (!Number.isSafeInteger(distributionId) || distributionId <= 0)) {
    throw new Error('invalid journal distribution id')
  }
  const principal = money(principalPiconeros)
  if (principal < 0n) throw new Error('negative journal principal')
  // Local closed-union pass preserves the exact historical error surface and
  // the caller-scope CONSOLIDATION destination rule; the store re-validates
  // everything from the wallet's own proven scope.
  const normalizedMetadata = validateMetadata({ kind, metadata, principalPiconeros: principal, scope: scoped })

  const dispatched = await preparePaymentDispatch({
    models,
    wallet,
    tx,
    owner: {
      journalRole: 'REWARDS',
      kind,
      accountIndex,
      distributionId: distributionId == null ? null : distributionId,
      principalPiconeros: principal,
      metadata: normalizedMetadata
    },
    keyProvider: keyProvider ?? defaultKeyProvider()
  })
  // The wallet is the scope authority: a drift between the caller's expected
  // scope and the wallet's proven scope must never journal the pair.
  if (dispatched.journal.network !== scoped.network ||
    dispatched.journal.walletAddress !== scoped.walletAddress) {
    throw new Error('prepareWalletTransaction: wallet scope does not match the requested rewards wallet scope')
  }
  return dispatched.journal
}

// --- relay -------------------------------------------------------------------

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
      logError({ journalId: String(id), attempt, errorClass: errorLabel(err) }, 'rewards wallet journal: RELAYED state persist failed')
    }
  }
  return false
}

// Relay the SAME built object through the full capture barrier:
//
//   1. `assertPreparedPayment` freshly loads + authenticates the durable
//      journal+proof pair against the built object (hash, fee, actual
//      destinations, exact key bundle) — only a durable authentic pair
//      authorizes an attempt;
//   2. `claimPaymentAttempt` performs the DB-only locked claim: inside ONE
//      Serializable transaction it re-locks and re-authenticates the pair,
//      compares `expectedProof` (id/revision/digest) so key rotation cannot
//      invalidate the authorization between validation and claim, and CASes
//      exactly `state='PREPARED' AND relayAttemptedAt IS NULL`;
//   3. only an ACKNOWLEDGED claim releases the OUTSIDE-transaction relay of
//      the same object, exactly once.
//
// An ambiguous/unknown acknowledgement of the claim prevents the broadcast and
// the dispatch stays withheld. A relay exception keeps PREPARED+attempt (never
// NOT_RELAYED, never a blind re-relay). A proven relay is marked RELAYED with
// `direct-relay-observation` provenance and one persist retry; if both writes
// fail the relay is still reported as relayed with accountingUnpersisted so
// the caller can persist proven recipient principal and stay resumable.
export async function relayWalletTransaction ({ models, wallet, journal, tx, keyProvider }) {
  const journalModel = models?.rewardsWalletTransaction
  if (!journalModel || typeof journalModel.updateMany !== 'function') {
    throw new Error('relayWalletTransaction: journal model is required')
  }
  if (!journal || journal.id == null) throw new Error('relayWalletTransaction: journal row is required')
  const txHash = normalizeHash(journal.txHash)
  if (!txHash) throw new Error('relayWalletTransaction: journal row has an invalid transaction hash')
  if (typeof wallet?.relayTx !== 'function') throw new Error('relayWalletTransaction: a relay-capable wallet is required')
  await assertWalletScope(wallet, { network: journal.network, walletAddress: journal.walletAddress })

  // Only the journaled object may be relayed: a different built tx must never
  // burn this row's single attempt or masquerade as its hash.
  const builtHash = normalizeHash(tx && typeof tx.getHash === 'function' ? await tx.getHash() : null)
  if (builtHash !== txHash) throw new Error('relayWalletTransaction: transaction does not match the journaled hash')

  // Fresh pair authentication immediately before the locked claim.
  const expectedProof = await assertPreparedPayment({
    models,
    wallet,
    tx,
    journalRole: 'REWARDS',
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
    journalRole: 'REWARDS',
    journalId: journal.id,
    keyProvider: keyProvider ?? defaultKeyProvider(),
    expectedProof
  })

  let relayedHash
  try {
    relayedHash = await wallet.relayTx(tx)
  } catch (err) {
    logError({ txHash, errorClass: errorLabel(err) }, 'relayWalletTransaction: relay outcome uncertain — journal stays PREPARED+attempted until a fresh confirmed verification resolves it')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }
  if (normalizeHash(relayedHash) !== txHash) {
    logError({ txHash, relayedHash: normalizeHash(relayedHash) }, 'relayWalletTransaction: relay returned a different hash — recording uncertainty instead of a false proof')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }

  const persisted = await persistRelayedState(journalModel, journal.id, new Date(), DIRECT_RELAY_PROVENANCE)
  if (!persisted) {
    logError({ txHash }, 'relayWalletTransaction: CRITICAL — relay proven but the journal state was not persisted')
    alert('critical', 'Rewards wallet relay not journaled', `Transaction ${txHash} was relayed but its journal record could not be updated; costs and principal remain unpersisted until reconciliation recovers it.`)
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 1 }
  }
  logInfo({ txHash, networkFeePiconeros: String(journal.networkFeePiconeros) }, 'relayWalletTransaction: relayed and journaled')
  return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 0 }
}

// --- reconciliation -----------------------------------------------------------

// Attempted-but-unproven relays are resolved ONLY by a fresh, trusted,
// CONFIRMED whole-payment verification from a DEDICATED GENESIS-RESTORED AUDIT
// SESSION — never the signer singleton (whose cached restore height and
// in-memory state must never serve as an audit authority), and never from
// destination-shaped wallet history (a built-but-unrelayed cached tx or an
// address/amount match can never prove a relay). The session is the Task 4
// chain-evidence collector over the audit wallet's unfiltered scan plus the
// audit wallet's own checkTxKey receipt checker; the Task 5 verifier gates the
// authenticated capture pair against the raw confirmed chain.

// The audit wallet is opened from the platform rewards keys in env, restored
// from GENESIS (restore height 0 — no historical mixing), in-memory, and
// closed by the caller in `finally`. Same conventions as the evidence
// collector's audit wallets. Never logs any key material.
async function openGenesisAuditWallet (scope) {
  const address = process.env.PLATFORM_REWARDS_ADDRESS
  const spendKey = process.env.PLATFORM_REWARDS_SPEND_KEY
  const viewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  if (!address || !spendKey || !viewKey) {
    throw new Error('rewards journal audit: the rewards wallet keys are not configured')
  }
  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = NETWORK_TYPES[scope.network]
  if (networkType === undefined) throw new Error('rewards journal audit: unsupported network')
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'
  // Dedicated in-memory audit wallet — deliberately NOT the signer singleton.
  return api.createWalletFull({
    password: 'rewards-journal-audit',
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

    // Prepare the domain BEFORE scanning (final-review I2): the primary plus
    // fee-account primaries 1..5 (created on the dedicated in-memory audit
    // wallet when missing — never on the signer) and every recorded minor
    // INCLUDING account-0 minors. Pre-listing the currently exposed accounts
    // alone never declares the derivation complete.
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
    for (let major = 1; major <= AUDIT_DERIVATION_MAJORS; major++) {
      if (!majors.has(major)) {
        if (typeof auditWallet.createAccount !== 'function') return null
        await auditWallet.createAccount()
      }
    }
    if (!(await push(0, 0))) return null
    for (let major = 1; major <= AUDIT_DERIVATION_MAJORS; major++) {
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

// monero-ts caches the daemon height for ~30 seconds; absorb that with a
// bounded resync before the strict count >= boundary index + 1 check, which is
// never weakened.
const AUDIT_SCAN_RESYNC_ATTEMPTS = 3
// The prepared derivation domain covers the primary plus fee-account
// primaries 1..5 (final-review I2) — the same majors the fee-account
// infrastructure provisions.
const AUDIT_DERIVATION_MAJORS = 5

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
      auditedHashes: await readPaymentAuditHashes({ models, scope, journalRole: 'REWARDS' })
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

// Verify ONE attempted PREPARED row through the fresh audit session. Returns
// the safe PaymentVerificationV1 only when the verification is COMPLETE;
// missing sessions, missing/lost proof keys, chain-evidence failures,
// non-complete results and throwing loads all resolve to null so the row
// RETAINS uncertainty (never NOT_RELAYED, never a promotion). Only fixed
// labels ever reach the logs — never SDK/daemon/session material.
async function verifyAttemptedRow ({ models, row, session, keyProvider }) {
  if (!session) return null
  try {
    const result = await verifyPaymentTransaction({
      models,
      journalRole: 'REWARDS',
      journalId: row.id,
      session,
      keyProvider,
      observedAt: new Date().toISOString()
    })
    if (!result || result.status !== 'complete') {
      logWarn({ txHash: row.txHash, kind: row.kind, issues: result?.issues ?? null }, 'reconcileWalletTransactions: fresh verification is not complete — retaining uncertainty')
      return null
    }
    return result
  } catch (err) {
    logError({ txHash: row.txHash, kind: row.kind, errorClass: errorLabel(err) }, 'reconcileWalletTransactions: fresh verification unavailable — retaining uncertainty')
    return null
  }
}

// Exact agreement between a COMPLETE verification and the journal row's own
// immutable facts: scope, hash, journal identity, capture binding, source
// account, network fee, and — per kind — the exact participant set and
// principal. The verifier already authenticated the capture pair against the
// row and gated the confirmed chain against it; this comparison is the explicit
// row-level gate before a promotion may write. Any unreadable fact fails.
function verificationMatchesRow (result, row) {
  try {
    if (!result || result.status !== 'complete' || result.captureMode !== 'CAPTURE_V1') return false
    if (result.journalRole !== 'REWARDS' || String(result.journalId) !== String(row.id)) return false
    if (!result.scope || result.scope.network !== row.network ||
      result.scope.walletAddress !== row.walletAddress) return false
    if (result.txHash !== row.txHash) return false
    if (typeof result.claimDigest === 'string' && row.claimDigest != null &&
      result.claimDigest !== row.claimDigest) return false
    if (!Array.isArray(result.sourceAccounts) || !result.sourceAccounts.includes(String(row.accountIndex))) return false
    if (result.totals?.F == null || BigInt(result.totals.F) !== money(row.networkFeePiconeros)) return false
    const principal = money(row.principalPiconeros)
    const members = Array.isArray(result.members) ? result.members : []
    if (row.kind === 'PAYOUT') {
      const expected = Array.isArray(row.metadata?.payouts) ? row.metadata.payouts : []
      if (expected.length === 0 || members.length !== expected.length) return false
      const remaining = members.map(member => ({
        id: String(member?.id),
        address: member?.address,
        actual: BigInt(member?.actualPiconeros)
      }))
      for (const payout of expected) {
        const amount = money(payout.piconeros)
        const index = remaining.findIndex(member =>
          member.id === String(payout.payoutId) &&
          member.address === payout.recipientAddress &&
          member.actual === amount)
        if (index === -1) return false
        remaining.splice(index, 1)
      }
      return true
    }
    if (row.kind === 'OPS_SWEEP') {
      return members.length === 1 &&
        String(members[0]?.id) === '1' &&
        members[0]?.address === row.metadata?.destination &&
        BigInt(members[0]?.actualPiconeros) === principal
    }
    // CONSOLIDATION: zero external participants, zero external principal — the
    // owned self transfer is proven by the verifier's owned-partition gates.
    return members.length === 0 && principal === 0n
  } catch {
    return false
  }
}

// --- durable RELAYED participant recovery ------------------------------------

// A RELAYED PAYOUT journal row is durable proof that its relay happened. The
// recipient-row persist may have failed after that relay, leaving members
// QUEUED (or otherwise live); a later drive must NEVER build a fresh
// transaction for them, even when no chain history or proof key is available.
// This recovery is DB-only and includes this pass's verification-proven
// promotions. All competing proofs are validated BEFORE any payout write:
//
//   - every live member (persisted payout row in QUEUED/FAILED) named by a
//     VALIDATED RELAYED journal fact is verified for exact identity
//     (payoutId + recipientAddress + exact piconeros);
//   - an exact QUEUED match is recovered to SENT with the journal's txHash,
//     idempotently and exactly once;
//   - a mismatch, an unreadable fact, or a FAILED row contradicting the proven
//     relay withholds the member and flags accounting uncertainty with an
//     alert (never a fresh send, never a silent FAILED rewrite);
//   - a journal query failure propagates so callers keep failing closed.
//
// Missing persisted payout rows are not live and are left to the ledger union
// (which counts a journal-proven relay as a real outflow); recovery does not
// manufacture uncertainty for an already-proven relay.
function payoutIdentityMatches (row, member) {
  try {
    return row?.recipientAddress === member.address && money(row.piconeros) === member.amount
  } catch {
    return false
  }
}

async function recoverLiveRelayedPayouts ({ models, journalModel, scope }) {
  const out = { recovered: [], uncertainPayoutIds: [] }
  const relayed = await journalModel.findMany({
    where: {
      network: scope.network,
      walletAddress: scope.walletAddress,
      kind: 'PAYOUT',
      state: 'RELAYED'
    },
    select: { id: true, txHash: true, principalPiconeros: true, metadata: true },
    orderBy: { id: 'asc' }
  })
  if (relayed.length === 0) return out

  const namedIds = new Set()
  const checks = []
  for (const row of relayed) {
    const memberList = Array.isArray(row.metadata?.payouts) ? row.metadata.payouts : null
    let rowValid = memberList != null && memberList.length > 0
    let sum = 0n
    let principal = null
    try {
      principal = row.principalPiconeros == null ? null : money(row.principalPiconeros)
    } catch { /* unreadable principal invalidates the row */ }
    if (principal == null || principal < 0n) rowValid = false
    const seen = new Set()
    const members = []
    for (const member of memberList ?? []) {
      const payoutId = Number.isSafeInteger(member?.payoutId) && member.payoutId > 0 ? member.payoutId : null
      const address = typeof member?.recipientAddress === 'string' && member.recipientAddress.trim() !== ''
        ? member.recipientAddress
        : null
      let amount = null
      try {
        amount = member?.piconeros == null ? null : money(member.piconeros)
      } catch { /* unreadable amount can never authorize a recovery */ }
      if (amount != null && amount < 0n) amount = null
      if (payoutId == null || address == null || amount == null || seen.has(payoutId)) rowValid = false
      if (payoutId != null) {
        seen.add(payoutId)
        namedIds.add(payoutId)
        if (address != null && amount != null) sum += amount
      }
      members.push({ payoutId, address, amount })
    }
    if (principal != null && sum !== principal) rowValid = false
    checks.push({ row, rowValid, members })
  }

  if (typeof models?.rewardPayout?.findMany !== 'function' || typeof models?.rewardPayout?.updateMany !== 'function') {
    // Cannot verify member identity: withhold every named member rather than
    // risk a re-send of durable proven money.
    const withheld = [...namedIds].sort((a, b) => a - b)
    if (withheld.length > 0) {
      logError({ payoutIds: withheld }, 'reconcileWalletTransactions: rewardPayout model unavailable — durable RELAYED payout proofs cannot be verified; withholding members (fail-closed)')
      out.uncertainPayoutIds = withheld
    }
    return out
  }

  const liveRows = namedIds.size === 0
    ? []
    : await models.rewardPayout.findMany({
      where: { id: { in: [...namedIds] }, state: { in: ['QUEUED', 'FAILED'] } },
      select: { id: true, state: true, txHash: true, recipientAddress: true, piconeros: true }
    })
  const liveById = new Map((liveRows || []).map(row => [row.id, row]))
  const withheld = new Set()
  const candidates = new Map()

  const withhold = ({ payoutId, txHash, reason }) => {
    withheld.add(payoutId)
    logError({ payoutId, txHash, reason }, 'reconcileWalletTransactions: CRITICAL — durable RELAYED payout proof does not match the live payout row; withholding it from every fresh send')
    alert('critical', 'rewards payout journal proof unresolved',
      `payout ${payoutId} is still live but duplicate-relay protection cannot validate its journal proof ${txHash} (${reason}); it will not be sent again until reviewed`,
      { dedupeKey: `payout-journal-unresolved-${payoutId}` })
  }

  for (const check of checks) {
    for (const member of check.members) {
      if (member.payoutId == null) continue
      const live = liveById.get(member.payoutId)
      if (!live) continue // not a fresh-send candidate: the ledger union owns completed/absent facts
      const txHash = normalizeHash(check.row.txHash)
      if (!check.rowValid || !txHash || member.address == null || member.amount == null) {
        withhold({ payoutId: member.payoutId, txHash: check.row.txHash, reason: 'unreadable journal proof' })
        continue
      }
      if (!payoutIdentityMatches(live, member)) {
        withhold({ payoutId: member.payoutId, txHash, reason: 'recipient/amount identity mismatch' })
        continue
      }
      if (live.txHash != null && normalizeHash(live.txHash) !== txHash) {
        withhold({ payoutId: member.payoutId, txHash, reason: 'recorded transaction hash mismatch' })
        continue
      }
      if (live.state === 'FAILED') {
        // FAILED means the caller recorded a provably-not-relayed attempt; the
        // durable RELAYED fact contradicts that and must not be re-sent.
        withhold({ payoutId: member.payoutId, txHash, reason: 'relayed proof contradicts a FAILED row' })
        continue
      }
      const prior = candidates.get(member.payoutId)
      if (prior && prior.txHash !== txHash) {
        withhold({ payoutId: member.payoutId, txHash, reason: 'conflicting journal transaction hashes' })
        continue
      }
      candidates.set(member.payoutId, { member, txHash })
    }
  }

  // Do not let an earlier matching proof mutate a payout before a later
  // contradictory proof is rejected (including rows promoted in this pass).
  for (const { member, txHash } of candidates.values()) {
    if (withheld.has(member.payoutId)) continue
    const updated = await models.rewardPayout.updateMany({
      where: {
        id: member.payoutId,
        state: 'QUEUED',
        recipientAddress: member.address,
        piconeros: member.amount,
        OR: [{ txHash: null }, { txHash }]
      },
      data: { state: 'SENT', txHash }
    })
    if (updated.count === 1) {
      out.recovered.push({ id: member.payoutId, txHash })
      logInfo({ payoutId: member.payoutId, txHash }, 'reconcileWalletTransactions: recovered a durable RELAYED journal member to SENT (no re-send)')
      continue
    }
    // Lost a race: accept only an already completed state with the same hash
    // AND recipient/amount identity, not merely a paid state for this ID.
    const fresh = (await models.rewardPayout.findMany({
      where: { id: member.payoutId },
      select: { id: true, state: true, txHash: true, recipientAddress: true, piconeros: true }
    }))[0]
    if (fresh && ['SENT', 'CONFIRMED'].includes(fresh.state) && normalizeHash(fresh.txHash) === txHash && payoutIdentityMatches(fresh, member)) {
      out.recovered.push({ id: member.payoutId, txHash })
    } else {
      withhold({ payoutId: member.payoutId, txHash, reason: 'live row changed incompatibly during recovery' })
    }
  }

  out.uncertainPayoutIds = [...withheld].sort((a, b) => a - b)
  return out
}

// Resolve durable RELAYED payout participants and attempted-but-unproven
// journal rows. NEVER signs, sends or re-relays. The durable recovery (below)
// is DB-only and does not depend on any chain read or proof key. Attempted
// PREPARED rows are resolved ONLY by a fresh CONFIRMED whole-payment
// verification from a dedicated genesis-restored audit session (never the
// signer singleton, never destination-shaped history): a COMPLETE result that
// exactly matches the row's scope/hash/kind/source/participants/principal/fee
// promotes the row to RELAYED with the verification's observation time
// ("relay proven by this observation" — never a claimed historical submission
// time) and `chain-proof-observation` provenance. Missing sessions, lost proof
// keys, non-complete results and exact-match failures all RETAIN uncertainty.
// Legacy attempted rows without a complete surviving proof stay unresolved (no
// destination-only promotion). Then the complete durable proof set, including
// every in-pass promotion, is validated before recovering payouts.
// Returns the payout IDs of everything still
// unsettled (so callers exclude them from new sends), the members RECOVERED to
// SENT from durable RELAYED proofs this call, whether any ops sweep or
// consolidation is unsettled (blocks sweeping), and how many proven relays,
// unresolved durable proofs or proven-but-unjournaled relays claim accounting
// uncertainty.
//
// `daemon` (default the shared restricted daemon client) and `keyProvider`
// (default the lazily-built separate TX-proof registry) are injectable so
// callers and tests can pass fakes; `auditWallet` (additive, like the evidence
// collector's injected audit wallets) bypasses the env-key wallet open for
// tests. When the audit session cannot be built, attempted rows stay
// unresolved (fail closed) while the durable DB-only recovery still runs.
export async function reconcileWalletTransactions ({
  models,
  wallet,
  scope,
  daemon = daemonClient,
  keyProvider,
  auditWallet = null
}) {
  const journalModel = models?.rewardsWalletTransaction
  if (!journalModel || typeof journalModel.findMany !== 'function') {
    throw new Error('reconcileWalletTransactions: journal model is required')
  }
  const scoped = normalizeScope(scope)
  const result = { uncertainPayoutIds: [], recoveredPayoutIds: [], uncertainSweep: false, accountingUnpersisted: 0 }
  const payoutIds = new Set()

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
    // this scope before any resolution runs (identity gate, unchanged).
    await assertWalletScope(wallet, scoped)

    const collect = row => {
      if (row.kind === 'PAYOUT') {
        const members = Array.isArray(row.metadata?.payouts) ? row.metadata.payouts : []
        if (members.length === 0) {
          logError({ txHash: row.txHash }, 'reconcileWalletTransactions: PAYOUT journal row has unreadable metadata')
        }
        for (const member of members) {
          if (Number.isSafeInteger(member?.payoutId)) payoutIds.add(member.payoutId)
        }
      } else {
        result.uncertainSweep = true
      }
    }

    // ONE dedicated audit session for the whole pass, built lazily (only when
    // uncertainty exists) and closed in `finally`. An unavailable session —
    // unconfigured keys, scan failure, daemon trouble — retains uncertainty
    // for every attempted row instead of ever guessing.
    let session = null
    let openedAuditWallet = null
    try {
      if (auditWallet) {
        session = await buildAuditSession({ auditWallet, daemon, scope: scoped, models })
      } else {
        try {
          openedAuditWallet = await openGenesisAuditWallet(scoped)
        } catch (err) {
          logWarn({ errorClass: errorLabel(err) }, 'reconcileWalletTransactions: the dedicated audit wallet is unavailable — retaining uncertainty')
        }
        if (openedAuditWallet) {
          session = await buildAuditSession({ auditWallet: openedAuditWallet, daemon, scope: scoped, models })
        }
      }
      if (!session) {
        logWarn('reconcileWalletTransactions: no fresh audit session — attempted relays stay unresolved')
      }

      for (const row of uncertain) {
        const verification = await verifyAttemptedRow({ models, row, session, keyProvider: keyProvider ?? defaultKeyProvider() })
        if (!verificationMatchesRow(verification, row)) {
          if (verification) {
            logError({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: fresh verification does not exactly match the journal row — retaining uncertainty')
          }
          collect(row)
          continue
        }
        // The fresh confirmed observation PROVES the relay; `relayedAt` records
        // when that proof was observed, never a historical submission time.
        if (await commitPaymentPromotionAtBoundary({
          models,
          daemon,
          boundary: session.boundary,
          promote: client => persistRelayedState(client.rewardsWalletTransaction, row.id, new Date(verification.observedAt), CHAIN_PROOF_PROVENANCE)
        })) {
          logInfo({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: fresh confirmed verification recovered a proven relay into the journal')
        } else {
          // Proven relay, unsettled journal state: alert and never release it to a
          // new send until the journal records the proof.
          logError({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: CRITICAL — proven relay not journaled')
          alert('critical', 'Rewards wallet relay not journaled', `Proven transaction ${row.txHash} could not be recorded in the journal; costs and principal remain unpersisted until reconciliation recovers it.`)
          result.accountingUnpersisted += 1
          collect(row)
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

  // Durable-but-unattempted captured pairs (a crash in the prepare→claim
  // window): provably unbroadcast — relay strictly requires the acknowledged
  // claim CAS — but their named payouts / sweep leg are RESERVED from
  // rebuilding under a new hash until explicit operator handling resolves the
  // pair (verified teardown). Reusing the existing uncertainty machinery, they
  // surface exactly where the brief mandates: PAYOUT members land in
  // `uncertainPayoutIds` (sendPayouts already excludes them from fresh
  // selection), OPS_SWEEP sets `uncertainSweep` (blocking further sweeps), and
  // CONSOLIDATION rows are surfaced without new blocking semantics (they are
  // recovery-only). One CRITICAL alert per stale pair with a stable per-hash
  // dedupeKey: never an automatic resend of the reserved members, never an
  // automatic deletion. Pairs created and claimed within a normal drive are
  // attempted (or RELAYED) by the time a LATER drive reconciles, so a
  // successful drive cannot trip this; the unattempted query only matches
  // genuinely interrupted dispatches.
  const stale = await journalModel.findMany({
    where: {
      network: scoped.network,
      walletAddress: scoped.walletAddress,
      state: 'PREPARED',
      relayAttemptedAt: null,
      dispatchId: { not: null }
    },
    orderBy: { id: 'asc' }
  })
  for (const row of stale) {
    let reserved
    if (row.kind === 'PAYOUT') {
      const members = Array.isArray(row.metadata?.payouts) ? row.metadata.payouts : []
      if (members.length === 0) {
        logError({ txHash: row.txHash }, 'reconcileWalletTransactions: stale PAYOUT pair has unreadable metadata')
      }
      for (const member of members) {
        if (Number.isSafeInteger(member?.payoutId)) payoutIds.add(member.payoutId)
      }
      reserved = 'its named payouts'
    } else if (row.kind === 'OPS_SWEEP') {
      result.uncertainSweep = true
      reserved = 'the sweep leg'
    } else {
      reserved = 'the consolidation leg'
    }
    logError({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: CRITICAL — durable-but-unattempted captured pair reserves its members from rebuilding until explicit operator handling resolves it')
    alert('critical', 'Rewards wallet pair reserved (durable but unattempted)',
      `Captured pair ${row.txHash} (${row.kind}) is durable but was never attempted — it is provably unbroadcast. ${reserved} it names stay reserved from rebuilding; resolve it by explicit operator handling (a verified teardown of the pair). The reserved members are never automatically re-sent and the pair is never automatically deleted.`,
      { dedupeKey: `rewards-pair-unattempted-${row.txHash}` })
  }

  // Recover only after all promotions so competing old/new proofs are rejected
  // before payout mutation. The durable recovery never reads chain history and
  // never needs a proof key; a recovery read/write failure propagates and
  // fresh sends fail closed.
  const durable = await recoverLiveRelayedPayouts({ models, journalModel, scope: scoped })
  for (const recovered of durable.recovered) result.recoveredPayoutIds.push(recovered)
  for (const id of durable.uncertainPayoutIds) payoutIds.add(id)

  result.uncertainPayoutIds = [...payoutIds].sort((a, b) => a - b)
  return result
}
