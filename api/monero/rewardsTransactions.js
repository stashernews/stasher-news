import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { isUniqueViolation } from '@/lib/error'
import { money } from '@/lib/rewardsAccounting'

// Durable per-transaction journal for rewards hot-wallet sends (rewards
// accounting repair §3.3 / send-time journal boundary).
//
// Every payout batch, ops sweep and consolidation follows the same boundary:
//
//   build(relay:false) -> prepare PREPARED row -> CAS the attempt ->
//   relayTx(the SAME object) -> persist RELAYED
//
// The journal is the accounting authority for network fees and for the
// principal/metadata needed to classify a send; RewardPayout /
// RewardDistribution remain the authority for reward and sweep principal (this
// journal is not a second payout eligibility engine). A PREPARED fee is not an
// incurred expense; only a proven RELAYED fee is. A transport exception is
// never proof of non-relay: the row stays PREPARED+attempted (accounting
// uncertainty) and is resolved only from the wallet's own outgoing history by
// exact hash with an explicit relayed/confirmed flag. A built-but-unrelayed
// transaction cached in history is not evidence of relay.
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

// DB-only idempotent preparation may retry a concurrent serialization/unique
// conflict; relay is NEVER wrapped in a database retry (a blind re-relay after
// an uncertain outcome is a real double pay).
const PREPARE_CONFLICT_RETRIES = 5

// One persist retry for a proven relay (spec: post-relay persistence failure is
// an accounting failure, never a reason to forget the relay).
const RELAYED_PERSIST_ATTEMPTS = 2

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

// Stable fingerprint for immutability comparison: object keys sorted
// recursively, values exact (BigInts already normalized to strings).
function canonicalJson (value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

const metadataFingerprint = metadata => JSON.stringify(canonicalJson(metadata))

function assertImmutableMatch (existing, candidate) {
  const same = existing.kind === candidate.kind &&
    existing.accountIndex === candidate.accountIndex &&
    (existing.distributionId ?? null) === (candidate.distributionId ?? null) &&
    money(existing.principalPiconeros) === candidate.principalPiconeros &&
    money(existing.networkFeePiconeros) === candidate.networkFeePiconeros &&
    metadataFingerprint(existing.metadata) === metadataFingerprint(candidate.metadata)
  if (!same) {
    throw new Error(`conflict: immutable rewards wallet journal facts differ for transaction ${candidate.txHash}`)
  }
}

// DB-only idempotent preparation may retry a concurrent unique/serialization
// conflict (Prisma P2002/P2034, raw 23505/40001). Relay is never retried here.
const isRetryablePreparationConflict = err =>
  isUniqueViolation(err) ||
  err?.code === 'P2034' ||
  err?.cause?.code === 'P2034' ||
  /could not serialize access/i.test(String(err?.message || ''))

// --- preparation -------------------------------------------------------------

// Persist the immutable PREPARED row for a built-but-UNRELAYED transaction.
// The transaction's hash and real fee are read first so an unreadable or
// invalid fee/hash never reaches the journal (and therefore never relays).
// Re-preparing the same (network, walletAddress, txHash) with identical facts
// returns the existing row; any differing immutable fact throws. A never-
// attempted PREPARED row may later be abandoned by operators without expense.
export async function prepareWalletTransaction ({
  models,
  scope,
  tx,
  kind,
  accountIndex,
  distributionId = null,
  principalPiconeros,
  metadata
}) {
  const journalModel = models?.rewardsWalletTransaction
  if (!journalModel || typeof models.$transaction !== 'function') {
    throw new Error('prepareWalletTransaction: a transactional models client is required')
  }
  const scoped = normalizeScope(scope)
  if (!JOURNAL_KINDS.has(kind)) throw new Error('invalid rewards wallet transaction kind')
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) throw new Error('invalid journal account index')
  if (distributionId != null && (!Number.isSafeInteger(distributionId) || distributionId <= 0)) {
    throw new Error('invalid journal distribution id')
  }
  const principal = money(principalPiconeros)
  if (principal < 0n) throw new Error('negative journal principal')

  const rawHash = tx && typeof tx.getHash === 'function' ? await tx.getHash() : null
  const txHash = rawHash == null ? '' : String(rawHash).toLowerCase()
  if (!TX_HASH_RE.test(txHash)) throw new Error('invalid transaction hash')
  const networkFeePiconeros = money(tx && typeof tx.getFee === 'function' ? await tx.getFee() : null)
  if (networkFeePiconeros < 0n) throw new Error('negative transaction fee')

  const data = {
    network: scoped.network,
    walletAddress: scoped.walletAddress,
    txHash,
    kind,
    accountIndex,
    distributionId: distributionId == null ? null : distributionId,
    principalPiconeros: principal,
    networkFeePiconeros,
    metadata: validateMetadata({ kind, metadata, principalPiconeros: principal, scope: scoped })
  }
  const key = { network_walletAddress_txHash: { ...scoped, txHash } }

  for (let attempt = 1; ; attempt++) {
    try {
      return await models.$transaction(async client => {
        const existing = await client.rewardsWalletTransaction.findUnique({ where: key })
        if (existing) {
          assertImmutableMatch(existing, data)
          return existing
        }
        return client.rewardsWalletTransaction.create({ data })
      }, { isolationLevel: 'Serializable' })
    } catch (err) {
      if (attempt >= PREPARE_CONFLICT_RETRIES || !isRetryablePreparationConflict(err)) throw err
      logInfo({ txHash, attempt }, 'prepareWalletTransaction: retrying a DB-only preparation conflict')
    }
  }
}

// --- relay -------------------------------------------------------------------

async function persistRelayedState (journalModel, id, relayedAt) {
  for (let attempt = 1; attempt <= RELAYED_PERSIST_ATTEMPTS; attempt++) {
    try {
      const updated = await journalModel.updateMany({
        where: { id, state: 'PREPARED' },
        data: { state: 'RELAYED', relayedAt }
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

// Claim the single relay attempt with a CAS, then relay the SAME built object.
// A relay exception keeps PREPARED+attempt (never NOT_RELAYED, never a blind
// re-relay). A proven relay is marked RELAYED with one persist retry; if both
// writes fail the relay is still reported as relayed with accountingUnpersisted
// so the caller can persist proven recipient principal and stay resumable.
export async function relayWalletTransaction ({ models, wallet, journal, tx }) {
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

  const claimed = await journalModel.updateMany({
    where: { id: journal.id, state: 'PREPARED', relayAttemptedAt: null },
    data: { relayAttemptedAt: new Date() }
  })
  if (claimed.count !== 1) throw new Error('transaction already attempted or accounting uncertain')

  let relayedHash
  try {
    relayedHash = await wallet.relayTx(tx)
  } catch (err) {
    logError({ txHash, errorClass: errorLabel(err) }, 'relayWalletTransaction: relay outcome uncertain — journal stays PREPARED+attempted until wallet history resolves it')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }
  if (normalizeHash(relayedHash) !== txHash) {
    logError({ txHash, relayedHash: normalizeHash(relayedHash) }, 'relayWalletTransaction: relay returned a different hash — recording uncertainty instead of a false proof')
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: false, uncertain: true, accountingUnpersisted: 0 }
  }

  const persisted = await persistRelayedState(journalModel, journal.id, new Date())
  if (!persisted) {
    logError({ txHash }, 'relayWalletTransaction: CRITICAL — relay proven but the journal state was not persisted')
    alert('critical', 'Rewards wallet relay not journaled', `Transaction ${txHash} was relayed but its journal record could not be updated; costs and principal remain unpersisted until reconciliation recovers it.`)
    return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 1 }
  }
  logInfo({ txHash, networkFeePiconeros: String(journal.networkFeePiconeros) }, 'relayWalletTransaction: relayed and journaled')
  return { txHash, networkFeePiconeros: journal.networkFeePiconeros, relayed: true, uncertain: false, accountingUnpersisted: 0 }
}

// --- reconciliation -----------------------------------------------------------

function readBoolean (object, getter) {
  if (typeof object?.[getter] !== 'function') return false
  try {
    return object[getter]() === true
  } catch {
    return false
  }
}

// Index the wallet's own outgoing history by exact hash. Each history entry is
// kept as a separate observation so contradictory evidence for one hash (a
// second fee, a different recipient set) can never be merged away. Relay
// evidence is an explicit relayed/confirmed flag; a cached built tx with
// isRelayed=false is not evidence. Missing/erroring evidence read within an
// observation is recorded as unreadable and can never satisfy a claim.
function readDestination (destination) {
  if (!destination) return { address: null, amount: null }
  const address = typeof destination.getAddress === 'function' ? destination.getAddress() : null
  let amount = null
  if (typeof destination.getAmount === 'function') {
    try {
      const raw = destination.getAmount()
      if (raw != null) amount = money(raw)
    } catch { /* unreadable amount can never satisfy a principal claim */ }
  }
  return { address, amount }
}

function indexOutgoingHistory (outgoing) {
  const byHash = new Map()
  for (const transfer of Array.isArray(outgoing) ? outgoing : []) {
    const tx = typeof transfer?.getTx === 'function' ? transfer.getTx() : null
    if (!tx) continue
    const hash = normalizeHash(typeof tx.getHash === 'function' ? tx.getHash() : null)
    if (!hash) continue

    const observation = {
      relayed: readBoolean(tx, 'getIsRelayed') || readBoolean(tx, 'getIsConfirmed'),
      fee: null,
      feeUnreadable: true,
      destinations: null,
      destinationsUnreadable: true
    }
    if (typeof tx.getFee === 'function') {
      try {
        const raw = tx.getFee()
        if (raw != null) {
          observation.fee = money(raw)
          observation.feeUnreadable = false
        }
      } catch { /* stays unreadable */ }
    }
    if (typeof transfer.getDestinations === 'function') {
      try {
        observation.destinations = (transfer.getDestinations() || []).map(readDestination)
        observation.destinationsUnreadable = false
      } catch { /* stays unreadable */ }
    }

    const observations = byHash.get(hash) || []
    observations.push(observation)
    byHash.set(hash, observations)
  }
  return byHash
}

// EXACT agreement with the journal's immutable facts. Every observation for the
// exact hash must carry a readable fee equal to the stored fee and a readable
// destination set exactly matching the stored claim — no extra external
// recipient, none missing, no duplicate-observation contradiction. Anything
// less is retained uncertainty, never a RELAYED proof.
function historyAgrees (row, observations) {
  if (!Array.isArray(observations) || observations.length === 0) return false
  if (!observations.some(o => o.relayed)) return false
  const storedFee = money(row.networkFeePiconeros)
  for (const observation of observations) {
    if (observation.feeUnreadable || observation.fee !== storedFee) return false
    if (observation.destinationsUnreadable || observation.destinations === null) return false
    if (!destinationsAgree(row, observation.destinations)) return false
  }
  return true
}

function destinationsAgree (row, destinations) {
  if (row.kind === 'PAYOUT') return payoutDestinationsAgree(row, destinations)
  if (row.kind === 'OPS_SWEEP') return sweepDestinationsAgree(row, destinations)
  return consolidationDestinationsAgree(row, destinations)
}

// PAYOUT: the destination multiset equals the metadata members exactly
// (address + exact amount); an unclaimed extra recipient fails.
function payoutDestinationsAgree (row, destinations) {
  const members = row.metadata?.payouts
  if (!Array.isArray(members) || members.length === 0) return false
  if (destinations.length !== members.length) return false
  const remaining = destinations.slice()
  for (const member of members) {
    let amount
    try {
      amount = money(member.piconeros)
    } catch {
      return false
    }
    const index = remaining.findIndex(d => d.address === member.recipientAddress && d.amount === amount)
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return true
}

// OPS_SWEEP: one external recipient, exactly the stored destination + principal.
function sweepDestinationsAgree (row, destinations) {
  const destination = row.metadata?.destination
  if (typeof destination !== 'string' || destination === '') return false
  if (destinations.length !== 1) return false
  return destinations[0].address === destination && destinations[0].amount === money(row.principalPiconeros)
}

// CONSOLIDATION: every outgoing destination is the wallet's own primary address
// (a self transfer); the internal principal amount is not an external claim, but
// an external recipient must never be accepted as a consolidation.
function consolidationDestinationsAgree (row, destinations) {
  const destination = row.metadata?.destination
  if (typeof destination !== 'string' || destination === '') return false
  if (destinations.length === 0) return false
  return destinations.every(d => d.address === destination)
}

// --- durable RELAYED participant recovery ------------------------------------

// A RELAYED PAYOUT journal row is durable proof that its relay happened. The
// recipient-row persist may have failed after that relay, leaving members
// QUEUED (or otherwise live); a later drive must NEVER build a fresh
// transaction for them, even when the wallet-history read throws or returns
// nothing. This recovery is DB-only and includes this pass's history-proven
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
// journal rows. NEVER signs, sends or re-relays. The durable recovery (above)
// does not depend on wallet history. Attempted PREPARED rows are first
// resolved from the wallet's own scoped history, where rows whose relay is
// proven with agreeing fee/metadata are recovered to RELAYED idempotently and
// missing or erroring histories, conflicting facts and built-but-unrelayed
// cached txs all RETAIN uncertainty. Then the complete durable proof set,
// including every in-pass promotion, is validated before recovering payouts.
// Returns the payout IDs of everything still
// unsettled (so callers exclude them from new sends), the members RECOVERED to
// SENT from durable RELAYED proofs this call, whether any ops sweep or
// consolidation is unsettled (blocks sweeping), and how many proven relays,
// unresolved durable proofs or proven-but-unjournaled relays claim accounting
// uncertainty.
export async function reconcileWalletTransactions ({ models, wallet, scope }) {
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

    let outgoing
    try {
      outgoing = typeof wallet.getOutgoingTransfers === 'function' ? await wallet.getOutgoingTransfers() : null
    } catch (err) {
      logWarn({ errorClass: errorLabel(err) }, 'reconcileWalletTransactions: wallet history unavailable — retaining uncertainty')
      outgoing = null
    }
    if (!outgoing) {
      for (const row of uncertain) collect(row)
    } else {
      const history = indexOutgoingHistory(outgoing)
      for (const row of uncertain) {
        if (!historyAgrees(row, history.get(row.txHash))) {
          logError({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: wallet history does not prove the exact journal fact — retaining uncertainty')
          collect(row)
          continue
        }
        if (await persistRelayedState(journalModel, row.id, new Date())) {
          logInfo({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: recovered a proven relay into the journal')
        } else {
          // Proven relay, unsettled journal state: alert and never release it to a
          // new send until the journal records the proof.
          logError({ txHash: row.txHash, kind: row.kind }, 'reconcileWalletTransactions: CRITICAL — proven relay not journaled')
          alert('critical', 'Rewards wallet relay not journaled', `Proven transaction ${row.txHash} could not be recorded in the journal; costs and principal remain unpersisted until reconciliation recovers it.`)
          result.accountingUnpersisted += 1
          collect(row)
        }
      }
    }
  }

  // Recover only after all promotions so competing old/new proofs are rejected
  // before payout mutation. Throwing/empty history never erases durable proof;
  // a recovery read/write failure propagates and fresh sends fail closed.
  const durable = await recoverLiveRelayedPayouts({ models, journalModel, scope: scoped })
  for (const recovered of durable.recovered) result.recoveredPayoutIds.push(recovered)
  for (const id of durable.uncertainPayoutIds) payoutIds.add(id)

  result.uncertainPayoutIds = [...payoutIds].sort((a, b) => a - b)
  return result
}
