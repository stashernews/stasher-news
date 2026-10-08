import { createHash } from 'node:crypto'
import { allocateInflow, money, opsCarry, standingReserve } from '@/lib/rewardsAccounting'
import { summarizeRewardsLedger } from '@/api/monero/rewardsLedger'
import {
  isObservableMonetaryReceipt,
  readRewardsAuditReserve,
  readRewardsAuditSnapshot
} from '@/api/monero/rewardsAuditSnapshot'
import {
  ACCOUNTING_FINGERPRINT_VERSION,
  accountingAuditFingerprint,
  isCurrentAccountingFingerprint
} from '@/lib/rewardsAuditFingerprint'
import { buildJournalRelayOperation, buildLegacyBackfillRelayProof, LEGACY_BACKFILL_REASON } from '@/api/monero/rewardsRelayProof'
import {
  paymentVerificationFacts,
  validatePaymentVerification
} from '@/api/monero/paymentVerification'
import {
  recordedBatchMembershipMismatch,
  recordedOutflowCoverage
} from '@/api/monero/rewardsOutflowCoverage'

// Deterministic, evidence-bound accounting repair manifest (rewards accounting
// repair §8, Task 12). PURE: the function is a total function of its input
// object — it reads no DB, opens no wallet, sends nothing and never mutates the
// provided evidence/ledger/decisions. Task 13 applies a confirmed manifest.
//
// Input shape:
//   {
//     scope: { network, walletAddress },
//     boundary: { height, blockHash },
//     evidence: <collectRewardsWalletEvidence output>,
//     ledger: {
//       receipts: FeeObservation rows, downvotes: ObservedDownvote rows,
//       payouts: RewardPayout rows, distributions: RewardDistribution rows,
//       transactions: RewardsWalletTransaction rows,
//       bountyPayments: BountyPayment rows, items: Item rows,
//       earns: Earn rows
//     },
//     decisions: {
//       receipts: { [txHash]: { feeType, rewardsPiconeros, recipientMajor,
//                              recipientMinor, confirmedAt, height?, verified,
//                              donationRewardsPct? } } — a classification is
//                              accepted only when explicitly verified and its
//                              source/split/height are evidence-compatible,
//       periodConfigs: [{ from, to, verified, config }],
//       receiptAllocations: { [receiptId]: { rewardsPiconeros } }
//     },
//     config: current PlatformFeeConfig allocation percentages,
//     reserve: { feeHeadroomPiconeros, dustFloorPiconeros },
//     opsCarryProvenance: { [distributionId]: { verified: true, source } }
//   }
//
// Output manifest (v2, rewards reconciliation plan Tasks 1–3):
//   { version: 2, accountingFingerprintVersion: 2, scope, boundary,
//     evidenceDigest, ledgerFingerprint, protectedRewardsFingerprint,
//     preconditionFingerprint, decisionsDigest, issues[], operations[],
//     before, after, digest }
// `ledgerFingerprint` is the SHARED `accounting:v2:` audit identity from
// Task 1 (`accountingAuditFingerprint` over the same snapshot input the
// builder consumed) — the union money digest is no longer an accounting
// authority. All money values are exact decimal strings; BigInts never escape.
//
// The apply gate (Task 13) consumes three extra public interfaces from this
// module, all fail-closed:
//   - `readRepairLedger(models, scope, { reserve } = {})` reads the same safe
//     row projections the builder consumes through the ONE shared audit
//     snapshot (complete groups + config + reserve + the v2 audit fingerprint),
//     scoped to the registered platform wallet;
//   - `assertRepairPreconditions(manifest, ledger, evidence)` is the pure
//     comparator: the approved evidence digest/scope/boundary must still hold,
//     the scoped ledger fingerprint and protected reward snapshot must be
//     unchanged, the complete `preconditionFingerprint` (observations,
//     transactions, reward contracts and fee config) must match, and no
//     distribution may be actively SENDING;
//   - `chainFactsFingerprint(evidence)` projects only the STABLE confirmed
//     chain facts (no tip/confirmation/mempool churn) so a rescan that proves
//     the same facts at a later tip stays comparable; the CLI refuses when it
//     does not.

// `preconditionFingerprint` covers the COMPLETE approved precondition set the
// builder consumed (every normalized ledger row plus the fee-allocation config)
// so an apply can refuse a new/changed observation, transaction, reward
// contract or config even when the change has no matching operation.
//
// Operations are the closed repair vocabulary the guarded APPLY applies:
//   { kind: 'update'|'insert', table, id|txHash|key, before, after, reason }
// `before` carries the exact expected current values (null for an insert), and
// for updates only the fields the repair changes. A confirmed attempted
// PREPARED -> RELAYED journal promotion additionally carries its closed v2
// `relayProof` (api/monero/rewardsRelayProof.js); the same proof also binds
// the ONE journal-less legacy backfill insert authorized by complete
// independently surviving evidence (rewards reconciliation Task 4, reason
// `legacy-complete-payment-backfill`). Every other operation never touches a
// reward contract (RewardPayout / Earn / distribution reward totals), a payout
// state, or an actual sweep principal/hash.
//
// Issues identify the exact row/hash and reason. ANY material issue means the
// manifest is NOT applicable (Task 13 refuses); there is deliberately no way to
// suppress or delete an issue. `rebuildOpsSnapshots` and `manifestDigest` are
// the other public interfaces.

const TX_HASH_RE = /^[0-9a-f]{64}$/
const REWARDS_NETWORKS = new Set(['STAGENET', 'MAINNET'])

// FeeObservation.feeType -> rewardsInflow raw source key (mirrors the SQL
// reader in api/monero/rewardsInflow.js).
const SOURCE_BY_FEE_TYPE = {
  POSTING: 'posting',
  TERRITORY_CREATE: 'territory',
  TERRITORY_BILLING: 'territory',
  TERRITORY_UNARCHIVE: 'territory',
  TERRITORY_UPDATE: 'territory',
  DONATE: 'donate',
  BOOST: 'boost',
  TIP_UNWALLETED: 'walletlesstip',
  BOUNTY_ROLLOVER: 'bountyrollover',
  BOUNTY_FEE: 'bountyfee'
}

// Percentage-split sources whose allocation at a historical date cannot be
// reconstructed from TODAY's config: a correction needs verified period config
// evidence or an explicit reviewed allocation decision.
const PERCENT_CONFIG_KEY = {
  POSTING: 'postingFeeRewardsPct',
  TERRITORY_CREATE: 'territoryFeeRewardsPct',
  TERRITORY_BILLING: 'territoryFeeRewardsPct',
  TERRITORY_UNARCHIVE: 'territoryFeeRewardsPct',
  TERRITORY_UPDATE: 'territoryFeeRewardsPct',
  BOOST: 'boostRewardsPct',
  TIP_UNWALLETED: 'walletlessTipRewardsPct'
}

// ---------------------------------------------------------------------------
// Canonical serialization + digest
// ---------------------------------------------------------------------------

// Object keys are sorted recursively and LISTS OF FACTS (arrays whose elements
// are all plain objects: operations, issues, fact rows) are sorted by their
// canonical JSON, so input order can never change a digest. Arrays of
// primitives keep their order.
function canonicalValue (value) {
  if (Array.isArray(value)) {
    const items = value.map(canonicalValue)
    if (items.length > 0 && items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      return [...items].sort((a, b) => {
        const ja = JSON.stringify(a)
        const jb = JSON.stringify(b)
        return ja < jb ? -1 : ja > jb ? 1 : 0
      })
    }
    return items
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key])
    return out
  }
  return value
}

function digestOf (value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

// Recompute a manifest's digest. Canonical serialization excludes ONLY the
// top-level `digest` field (which cannot hash itself).
export function manifestDigest (manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifestDigest: a manifest object is required')
  }
  const { digest, ...rest } = manifest
  return digestOf(rest)
}

// ---------------------------------------------------------------------------
// Ops snapshot propagation (controller-mandated shape)
// ---------------------------------------------------------------------------

// Rebuild each distribution's ops-inflow/carry/available chronologically while
// preserving checkpoints and recorded sweep principal/hash fields:
//   inflow    = opsInflowPiconeros + receiptOpsDeltas.get(id)
//   carry     = prior ? prior.opsAvailable - provenSwept(prior) -
//               (row.opsNetworkFeesAccounted - prior.opsNetworkFeesAccounted)
//             : row.opsRolledOverPiconeros
//   available = inflow + carry
// `provenSweptByDistribution` is a Map of distribution id -> de-duplicated
// proved swept BigInt (defaults to an empty Map); a prior row's recorded
// opsSweptPiconeros is the fallback. Inputs are never mutated.
export function rebuildOpsSnapshots (distributions, receiptOpsDeltas, provenSweptByDistribution = new Map()) {
  let prior = null
  return [...distributions].sort((a, b) => a.periodEnd - b.periodEnd || a.id - b.id).map(row => {
    const inflow = row.opsInflowPiconeros + (receiptOpsDeltas.get(row.id) ?? 0n)
    const carry = prior
      ? prior.opsAvailablePiconeros - (provenSweptByDistribution.get(prior.id) ?? prior.opsSweptPiconeros) -
        (row.opsNetworkFeesAccountedPiconeros - prior.opsNetworkFeesAccountedPiconeros)
      : row.opsRolledOverPiconeros
    const corrected = {
      ...row,
      opsInflowPiconeros: inflow,
      opsRolledOverPiconeros: carry,
      opsAvailablePiconeros: inflow + carry
    }
    prior = corrected
    return corrected
  })
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeScope (scope) {
  if (!scope || typeof scope !== 'object') throw new Error('buildRewardsReconciliation: a scope is required')
  if (!REWARDS_NETWORKS.has(scope.network)) throw new Error('buildRewardsReconciliation: unsupported rewards network')
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress.trim() === '') {
    throw new Error('buildRewardsReconciliation: wallet address is not configured')
  }
  return { network: scope.network, walletAddress: scope.walletAddress }
}

function normalizeBoundary (boundary) {
  if (!boundary || !Number.isSafeInteger(boundary.height) || boundary.height <= 0) {
    throw new Error('buildRewardsReconciliation: a fixed positive boundary height is required')
  }
  const blockHash = normalizeHash(boundary.blockHash)
  if (!blockHash) throw new Error('buildRewardsReconciliation: a fixed boundary block hash is required')
  return { height: boundary.height, blockHash }
}

function normalizeHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}

function intOrNull (value) {
  return Number.isSafeInteger(value) ? value : null
}

function stringOrNull (value) {
  return typeof value === 'string' ? value : null
}

function numericId (value) {
  if (Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return null
}

function amountOrNull (value) {
  try {
    if (value == null) return null
    return money(value)
  } catch {
    return null
  }
}

const decimalOrNull = value => {
  const amount = amountOrNull(value)
  return amount == null ? null : amount.toString()
}

function isoOrNull (value) {
  if (value == null) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function msOrNull (value) {
  if (value == null) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

const arrayOf = value => (Array.isArray(value) ? value : [])

const sortByNumberedId = (a, b) => (numericId(a?.id) ?? 0) - (numericId(b?.id) ?? 0)

function normalizeConfig (config) {
  const source = config && typeof config === 'object' ? config : {}
  const pct = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }
  return {
    downvoteRewardsPct: pct(source.downvoteRewardsPct, 100),
    postingFeeRewardsPct: pct(source.postingFeeRewardsPct, 70),
    territoryFeeRewardsPct: pct(source.territoryFeeRewardsPct, 30),
    boostRewardsPct: pct(source.boostRewardsPct, 30),
    walletlessTipRewardsPct: pct(source.walletlessTipRewardsPct, 70)
  }
}

// ---------------------------------------------------------------------------
// Evidence normalization (explicit safe fields only)
// ---------------------------------------------------------------------------

function normalizeDestination (destination) {
  return {
    address: typeof destination?.address === 'string' && destination.address !== '' ? destination.address : null,
    amountPiconeros: decimalOrNull(destination?.amountPiconeros)
  }
}

function normalizeIncomingEntry (entry) {
  return {
    txHash: normalizeHash(entry?.txHash),
    accountIndex: intOrNull(entry?.accountIndex),
    subaddressIndex: intOrNull(entry?.subaddressIndex),
    amountPiconeros: decimalOrNull(entry?.amountPiconeros),
    height: intOrNull(entry?.height),
    confirmations: intOrNull(entry?.confirmations) ?? 0,
    inTxPool: entry?.inTxPool === true,
    isConfirmed: entry?.isConfirmed === true,
    fromOwnTransaction: entry?.fromOwnTransaction === true,
    isSelfTransfer: entry?.isSelfTransfer === true
  }
}

function normalizeOutgoingEntry (entry) {
  return {
    txHash: normalizeHash(entry?.txHash),
    accountIndex: intOrNull(entry?.accountIndex),
    feePiconeros: decimalOrNull(entry?.feePiconeros),
    destinations: arrayOf(entry?.destinations).map(normalizeDestination),
    destinationsReadable: entry?.destinationsReadable !== false,
    height: intOrNull(entry?.height),
    confirmations: intOrNull(entry?.confirmations) ?? 0,
    inTxPool: entry?.inTxPool === true,
    isConfirmed: entry?.isConfirmed === true,
    isRelayed: entry?.isRelayed === true,
    isSelfTransfer: entry?.isSelfTransfer === true,
    relayState: entry?.relayState ?? (entry?.isConfirmed === true ? 'confirmed' : entry?.inTxPool === true ? 'pool' : 'unrelayed')
  }
}

const byHashKey = (a, b) =>
  String(a.txHash ?? '').localeCompare(String(b.txHash ?? '')) ||
  (a.accountIndex ?? 0) - (b.accountIndex ?? 0) ||
  (a.subaddressIndex ?? 0) - (b.subaddressIndex ?? 0)

function normalizeDerivation (derivation) {
  const derived = arrayOf(derivation?.derived)
    .map(entry => ({
      majorIndex: intOrNull(entry?.majorIndex) ?? 0,
      minorIndex: intOrNull(entry?.minorIndex) ?? 0,
      address: entry?.address ?? null
    }))
    .sort((a, b) => a.majorIndex - b.majorIndex || a.minorIndex - b.minorIndex)
  const mismatches = arrayOf(derivation?.mismatches).map(entry => ({
    majorIndex: intOrNull(entry?.majorIndex) ?? 0,
    minorIndex: intOrNull(entry?.minorIndex) ?? 0,
    expectedAddress: entry?.expectedAddress ?? null,
    derivedAddress: entry?.derivedAddress ?? null
  }))
  return { complete: derivation?.complete === true && mismatches.length === 0, derived, mismatches }
}

// Normalize an evidence object to the explicit safe projection the manifest
// digest is computed over. Exported so the apply comparator and CLI re-normalize
// through the SAME path (an evidence object that does not normalize to the
// approved digest can never authorize an apply).
export function normalizeEvidence (value) {
  const evidence = value && typeof value === 'object' ? value : {}
  const normalizeTip = tip => (tip && Number.isSafeInteger(tip.height)
    ? { height: tip.height, blockHash: normalizeHash(tip.blockHash) }
    : null)
  const escrow = evidence.escrow && typeof evidence.escrow === 'object'
    ? {
        walletAddress: evidence.escrow.walletAddress ?? null,
        derivation: normalizeDerivation(evidence.escrow.derivation),
        incoming: arrayOf(evidence.escrow.incoming).map(normalizeIncomingEntry).sort(byHashKey),
        outgoing: arrayOf(evidence.escrow.outgoing).map(normalizeOutgoingEntry).sort(byHashKey),
        bridge: {
          pendingIncoming: arrayOf(evidence.escrow.bridge?.pendingIncoming).map(normalizeIncomingEntry).sort(byHashKey),
          pendingOutgoing: arrayOf(evidence.escrow.bridge?.pendingOutgoing).map(normalizeOutgoingEntry).sort(byHashKey)
        },
        // The collector's ESCROW payment verifications (rewards reconciliation
        // Task 4): projected like the top-level verifications so the reverse
        // escrow-leg coverage can bind collected evidence — never silently
        // discarded.
        paymentVerifications: arrayOf(evidence.escrow.paymentVerifications)
      }
    : null
  const balances = evidence.balances && typeof evidence.balances === 'object' ? evidence.balances : {}
  const accounts = {}
  for (const key of Object.keys(balances.accounts ?? {}).sort((a, b) => Number(a) - Number(b))) {
    const amount = decimalOrNull(balances.accounts[key])
    if (amount != null) accounts[key] = amount
  }
  return {
    // The v2 evidence contract (rewards reconciliation Task 3): the approved
    // collection carries its contract version, the explicit observation
    // window and the safe verifier results it was built from. Payment
    // verifications are part of the approved evidence digest; repair
    // authorization against them requires evidenceVersion 2 (enforced where
    // they are indexed for promotion).
    evidenceVersion: intOrNull(evidence.evidenceVersion),
    collectionStartedAt: isoOrNull(evidence.collectionStartedAt),
    observedAt: isoOrNull(evidence.observedAt),
    paymentVerifications: arrayOf(evidence.paymentVerifications),
    scope: evidence.scope && typeof evidence.scope === 'object'
      ? { network: evidence.scope.network ?? null, walletAddress: evidence.scope.walletAddress ?? null }
      : null,
    boundary: evidence.boundary && Number.isSafeInteger(evidence.boundary.height)
      ? { height: evidence.boundary.height, blockHash: normalizeHash(evidence.boundary.blockHash) }
      : null,
    daemon: evidence.daemon
      ? { tipBefore: normalizeTip(evidence.daemon.tipBefore), tipAfter: normalizeTip(evidence.daemon.tipAfter) }
      : null,
    restoreHeight: Number(evidence.restoreHeight) || 0,
    restoreProvenance: evidence.restoreProvenance ?? null,
    firstActivityHeight: intOrNull(evidence.firstActivityHeight),
    walletHeight: intOrNull(evidence.walletHeight),
    derivation: normalizeDerivation(evidence.derivation),
    balances: {
      totalPiconeros: decimalOrNull(balances.totalPiconeros),
      unlockedPiconeros: decimalOrNull(balances.unlockedPiconeros),
      accounts
    },
    incoming: arrayOf(evidence.incoming).map(normalizeIncomingEntry).sort(byHashKey),
    outgoing: arrayOf(evidence.outgoing).map(normalizeOutgoingEntry).sort(byHashKey),
    bridge: {
      pendingIncoming: arrayOf(evidence.bridge?.pendingIncoming).map(normalizeIncomingEntry).sort(byHashKey),
      pendingOutgoing: arrayOf(evidence.bridge?.pendingOutgoing).map(normalizeOutgoingEntry).sort(byHashKey)
    },
    escrow
  }
}

// ---------------------------------------------------------------------------
// Ledger normalization (safe field projections)
// ---------------------------------------------------------------------------

function normalizeReceipt (row) {
  const id = numericId(row?.id)
  if (id == null) return null
  return {
    id,
    txHash: normalizeHash(row.txHash),
    // Legacy pseudo-rows (`abandoned-<paymentId>`) are not 64-hex hashes: the
    // raw value is retained so the mandated funding-identification predicate
    // can still classify them (zero-value, so they never change ops carry).
    rawTxHash: typeof row.txHash === 'string' && row.txHash !== '' ? row.txHash : null,
    feeType: typeof row.feeType === 'string' ? row.feeType : null,
    walletReceipt: row.walletReceipt === true,
    state: typeof row.state === 'string' ? row.state : null,
    piconeros: amountOrNull(row.piconeros),
    rewardsPiconeros: amountOrNull(row.rewardsPiconeros),
    donationRewardsPct: Number.isSafeInteger(row.donationRewardsPct) ? row.donationRewardsPct : null,
    recipientMajor: intOrNull(row.recipientMajor) ?? 0,
    recipientMinor: intOrNull(row.recipientMinor) ?? 0,
    height: intOrNull(row.height),
    confirmedAt: msOrNull(row.confirmedAt),
    postId: intOrNull(row.postId),
    payInId: intOrNull(row.payInId)
  }
}

function normalizeDownvote (row) {
  const id = numericId(row?.id)
  if (id == null) return null
  return {
    id,
    txHash: normalizeHash(row.txHash),
    piconeros: amountOrNull(row.piconeros),
    state: typeof row.state === 'string' ? row.state : null,
    height: intOrNull(row.height),
    confirmedAt: msOrNull(row.confirmedAt)
  }
}

function normalizePayout (row) {
  const id = numericId(row?.id)
  if (id == null) return null
  return {
    id,
    distributionId: intOrNull(row.distributionId),
    recipientAddress: typeof row.recipientAddress === 'string' ? row.recipientAddress : null,
    piconeros: amountOrNull(row.piconeros),
    txHash: normalizeHash(row.txHash),
    state: typeof row.state === 'string' ? row.state : null
  }
}

function normalizeDistribution (row) {
  const id = numericId(row?.id)
  if (id == null) return null
  const normalized = {
    id,
    periodStart: msOrNull(row.periodStart),
    periodEnd: msOrNull(row.periodEnd),
    poolPiconeros: amountOrNull(row.poolPiconeros),
    distributedPiconeros: amountOrNull(row.distributedPiconeros),
    rolledOverPiconeros: amountOrNull(row.rolledOverPiconeros),
    opsInflowPiconeros: amountOrNull(row.opsInflowPiconeros),
    opsRolledOverPiconeros: amountOrNull(row.opsRolledOverPiconeros),
    opsAvailablePiconeros: amountOrNull(row.opsAvailablePiconeros),
    opsSweptPiconeros: amountOrNull(row.opsSweptPiconeros),
    opsSweepTxHash: typeof row.opsSweepTxHash === 'string' ? row.opsSweepTxHash : null,
    opsNetworkFeesAccountedPiconeros: amountOrNull(row.opsNetworkFeesAccountedPiconeros)
  }
  // rebuildOpsSnapshots performs the mandated arithmetic on these fields.
  normalized.opsInflowPiconeros = normalized.opsInflowPiconeros ?? 0n
  normalized.opsRolledOverPiconeros = normalized.opsRolledOverPiconeros ?? 0n
  normalized.opsAvailablePiconeros = normalized.opsAvailablePiconeros ?? 0n
  normalized.opsSweptPiconeros = normalized.opsSweptPiconeros ?? 0n
  normalized.opsNetworkFeesAccountedPiconeros = normalized.opsNetworkFeesAccountedPiconeros ?? 0n
  return normalized
}

function normalizeJournalRow (row) {
  const txHash = normalizeHash(row?.txHash)
  if (txHash == null) return null
  return {
    id: numericId(row.id),
    network: row.network ?? null,
    walletAddress: row.walletAddress ?? null,
    txHash,
    kind: typeof row.kind === 'string' ? row.kind : null,
    state: typeof row.state === 'string' ? row.state : null,
    accountIndex: intOrNull(row.accountIndex) ?? 0,
    distributionId: intOrNull(row.distributionId),
    principalPiconeros: amountOrNull(row.principalPiconeros),
    networkFeePiconeros: amountOrNull(row.networkFeePiconeros),
    metadata: row.metadata ?? null,
    // The shared ledger helper fingerprints a Date as `toISOString()` and any
    // other non-null value via `String(...)`. Normalizing to an exact ISO
    // string here yields the same fingerprint for real Prisma Dates and for
    // structurally-cloned (cross-realm) dates, while `relayAttempted` remains
    // the builder's own boolean view.
    preparedAt: isoOrNull(row.preparedAt),
    relayAttemptedAt: isoOrNull(row.relayAttemptedAt),
    relayAttempted: row.relayAttemptedAt != null,
    relayedAt: isoOrNull(row.relayedAt),
    relayProvenance: stringOrNull(row.relayProvenance),
    // Proof-era capture + declared-proof facts (rewards reconciliation
    // Task 3): the promotion binds a verified payment to the row's own
    // capture identity, and the complete precondition fingerprint covers them.
    dispatchId: stringOrNull(row.dispatchId),
    captureContractVersion: intOrNull(row.captureContractVersion),
    claimDigest: normalizeHash(row.claimDigest),
    paymentClaims: row.paymentClaims ?? null,
    proofId: stringOrNull(row.proofId)
  }
}

function normalizeBountyPayment (row) {
  const id = numericId(row?.id)
  if (id == null) return null
  return {
    id,
    itemId: intOrNull(row.itemId),
    piconeros: amountOrNull(row.piconeros),
    feePiconeros: amountOrNull(row.feePiconeros) ?? 0n,
    recipientAddress: typeof row.recipientAddress === 'string' ? row.recipientAddress : null,
    kind: row.kind ?? null,
    txHash: normalizeHash(row.txHash),
    feeTxHash: normalizeHash(row.feeTxHash),
    state: row.state ?? null,
    feeRecipientAddress: row.feeRecipientAddress ?? null,
    networkFeePiconeros: amountOrNull(row.networkFeePiconeros),
    recipientReceivedPiconeros: amountOrNull(row.recipientReceivedPiconeros),
    feeReceivedPiconeros: amountOrNull(row.feeReceivedPiconeros),
    feeSettlementNetworkFeePiconeros: amountOrNull(row.feeSettlementNetworkFeePiconeros)
  }
}

function normalizeLedger (value) {
  const ledger = value && typeof value === 'object' ? value : {}
  return {
    receipts: arrayOf(ledger.receipts).map(normalizeReceipt).filter(Boolean).sort(sortByNumberedId),
    downvotes: arrayOf(ledger.downvotes).map(normalizeDownvote).filter(Boolean).sort(sortByNumberedId),
    payouts: arrayOf(ledger.payouts).map(normalizePayout).filter(Boolean).sort(sortByNumberedId),
    distributions: arrayOf(ledger.distributions).map(normalizeDistribution).filter(Boolean).sort(sortByNumberedId),
    transactions: arrayOf(ledger.transactions).map(normalizeJournalRow).filter(Boolean).sort((a, b) => a.txHash.localeCompare(b.txHash)),
    bountyPayments: arrayOf(ledger.bountyPayments).map(normalizeBountyPayment).filter(Boolean).sort(sortByNumberedId),
    // Recorded escrow journals (final-review I1 round 3): the authoritative
    // leg rows the reverse escrow coverage binds against — a leg's covering
    // verification must bind the recorded journal owner and carry the leg's
    // frozen membership. Raw paymentClaims travel verbatim (the claims
    // derivation authenticates them against the row's own digest).
    escrowTransactions: arrayOf(ledger.escrowTransactions).map(row => ({
      id: numericId(row?.id),
      network: stringOrNull(row?.network),
      walletAddress: stringOrNull(row?.walletAddress),
      txHash: normalizeHash(row?.txHash),
      kind: stringOrNull(row?.kind),
      leg: stringOrNull(row?.leg),
      bountyPaymentId: numericId(row?.bountyPaymentId),
      itemId: intOrNull(row?.itemId),
      state: stringOrNull(row?.state),
      dispatchId: stringOrNull(row?.dispatchId),
      claimDigest: normalizeHash(row?.claimDigest),
      paymentClaims: row?.paymentClaims ?? null
    })).filter(row => row.txHash != null)
      .sort((a, b) => a.txHash.localeCompare(b.txHash) || (a.id ?? -1) - (b.id ?? -1)),
    observedBounties: arrayOf(ledger.observedBounties).map(row => ({
      id: numericId(row?.id),
      txHash: normalizeHash(row?.txHash),
      postId: intOrNull(row?.postId),
      paymentId: typeof row?.paymentId === 'string' && row.paymentId !== '' ? row.paymentId : null
    })).filter(row => row.txHash != null || row.postId != null)
      .sort((a, b) => (a.id ?? -1) - (b.id ?? -1) || String(a.txHash).localeCompare(String(b.txHash))),
    observedBountyReceipts: arrayOf(ledger.observedBountyReceipts).map(row => ({
      bountyId: numericId(row?.bountyId),
      txHash: normalizeHash(row?.txHash)
    })).filter(row => row.txHash != null)
      .sort((a, b) => a.txHash.localeCompare(b.txHash) || (a.bountyId ?? -1) - (b.bountyId ?? -1)),
    items: arrayOf(ledger.items).map(row => ({ id: numericId(row?.id), bountyPiconeros: amountOrNull(row?.bountyPiconeros), bountyFeePiconeros: amountOrNull(row?.bountyFeePiconeros) })).filter(row => row.id != null),
    earns: arrayOf(ledger.earns).map(row => ({
      id: numericId(row?.id),
      userId: intOrNull(row?.userId),
      distributionId: intOrNull(row?.distributionId),
      piconeros: amountOrNull(row?.piconeros)
    })).filter(row => row.id != null).sort(sortByNumberedId)
  }
}

// ---------------------------------------------------------------------------
// Allocation helpers (Task 5 helpers, historical terms)
// ---------------------------------------------------------------------------

function rawFromReceipts (receipts, downvotes) {
  const raw = { downvote: 0n }
  for (const row of receipts) {
    if (row.walletReceipt !== true || row.state !== 'CONFIRMED' || row.piconeros == null) continue
    if (row.feeType === 'DONATE') {
      // allocateInflow expects raw.donate to be the ALREADY-SCALED share and
      // raw.donateRaw the unscaled total — the reader floors each donation row
      // independently. Never accumulate the full amount into raw.donate.
      const pct = BigInt(row.donationRewardsPct ?? 100)
      raw.donate = (raw.donate ?? 0n) + row.piconeros * pct / 100n
      raw.donateRaw = (raw.donateRaw ?? 0n) + row.piconeros
      continue
    }
    const key = SOURCE_BY_FEE_TYPE[row.feeType]
    if (key == null) continue
    raw[key] = (raw[key] ?? 0n) + row.piconeros
    if (row.feeType === 'BOUNTY_ROLLOVER') {
      raw.bountyrolloverRewards = (raw.bountyrolloverRewards ?? 0n) + (row.rewardsPiconeros ?? row.piconeros)
    }
  }
  for (const row of downvotes) {
    if (row.state !== 'CONFIRMED' || row.piconeros == null) continue
    raw.downvote += row.piconeros
  }
  return raw
}

// The ops share a whole distribution period contributes under the SAME
// aggregation the shared inflow reader uses: percentage sources are floored at
// the AGGREGATE per-source sum (verified historical period terms required),
// donations are floored per row (their stored percentage), BOUNTY_FEE is 100%
// ops, and BOUNTY_ROLLOVER uses each row's exact/legacy reward split. Returns
// null when a percentage source is present without verified historical terms.
function periodOpsPiconeros (receipts, distribution, decisions) {
  let ops = 0n
  const grouped = new Map() // config key -> aggregate sum
  for (const row of receipts) {
    if (row.walletReceipt !== true || row.state !== 'CONFIRMED' || row.piconeros == null) continue
    if (distribution.periodStart == null || distribution.periodEnd == null ||
      row.confirmedAt == null || row.confirmedAt < distribution.periodStart || row.confirmedAt >= distribution.periodEnd) continue
    switch (row.feeType) {
      case 'BOUNTY_FEE':
        ops += row.piconeros
        break
      case 'BOUNTY_ROLLOVER':
        ops += row.piconeros - (row.rewardsPiconeros ?? row.piconeros)
        break
      case 'DONATE': {
        const pct = BigInt(row.donationRewardsPct ?? 100)
        ops += row.piconeros - row.piconeros * pct / 100n
        break
      }
      default: {
        const key = PERCENT_CONFIG_KEY[row.feeType]
        if (key == null) return null // unknown fee type inside an affected period
        grouped.set(key, (grouped.get(key) ?? 0n) + row.piconeros)
      }
    }
  }
  if (grouped.size > 0) {
    const periodConfig = configForDistribution(decisions, distribution)
    if (!periodConfig) return null
    for (const [key, sum] of grouped) {
      ops += sum - sum * BigInt(periodConfig[key]) / 100n
    }
  }
  return ops
}

// Do two destination lists (as `{ address, amount }` facts) describe exactly the
// same multiset of payments? Order never matters; duplicates are significant.
function multisetMatches (expected, actual) {
  if (expected.length !== actual.length) return false
  const remaining = [...actual]
  for (const wanted of expected) {
    const index = remaining.findIndex(candidate => candidate.address === wanted.address && candidate.amount === wanted.amount)
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return true
}

// The mandated legacy funding-identification predicate (Task 1 migration,
// reused by manifest generation): a BOUNTY_FEE observation is a funding-time
// accrual when it is tied to an ObservedBounty's funding — the funding tx
// itself, one of the bounty's partial-funding receipts, or a legacy
// `abandoned-<paymentId>` pseudo-row — or when the escrow wallet's own
// confirmed incoming history carries its hash. Zero-fee pseudo-rows contribute
// nothing; positive identified rows are exactly the accruals the migration
// marks noncash.
function isIdentifiedFundingReceipt (receipt, { observedByPostId, receiptHashesByBountyId, escrowIncomingHashes }) {
  if (receipt.feeType !== 'BOUNTY_FEE') return false
  if (receipt.txHash != null && escrowIncomingHashes.has(receipt.txHash)) return true
  if (receipt.postId == null) return false
  for (const bounty of observedByPostId.get(receipt.postId) ?? []) {
    if (receipt.txHash != null && bounty.txHash != null && bounty.txHash === receipt.txHash) return true
    if (receipt.rawTxHash != null && bounty.paymentId != null &&
      receipt.rawTxHash === `abandoned-${bounty.paymentId}`) return true
    if (receipt.txHash != null && (receiptHashesByBountyId.get(bounty.id) ?? new Set()).has(receipt.txHash)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

/**
 * Build a deterministic repair manifest purely from provided
 * evidence/ledger/decisions.
 *
 * @param {object} input see the module header.
 * @returns {object} the versioned manifest (all money as decimal strings).
 */
export function buildRewardsReconciliation (input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('buildRewardsReconciliation: an input object is required')
  }
  const scope = normalizeScope(input.scope)
  const boundary = normalizeBoundary(input.boundary)
  const evidence = normalizeEvidence(input.evidence)
  // Raw receipt visibility (final-review B2): the ONE shared receipt rule
  // classifies the RAW rows — a raw-formed malformed amount (`7`, `'07'`,
  // `'+7'`) is not an observable monetary row even though the normalizer can
  // read it. The complete raw group stays the fingerprint/precondition
  // authority (every row is retained and projected below); this classification
  // only fixes the monetary working set the analysis consumes.
  const observableReceiptIds = new Set()
  for (const row of arrayOf(input.ledger?.receipts)) {
    const id = numericId(row?.id)
    if (id != null && isObservableMonetaryReceipt(row)) observableReceiptIds.add(id)
  }
  const ledger = normalizeLedger(input.ledger)
  // The ONE shared monetary working-set filter (final-review I3), driven by
  // the RAW classification above: applied separately INSIDE analysis, never to
  // the fingerprint or precondition input.
  const analysisReceipts = ledger.receipts.filter(row => observableReceiptIds.has(row.id))
  const decisions = input.decisions && typeof input.decisions === 'object' ? input.decisions : {}
  const config = normalizeConfig(input.config)
  const reserveInputs = input.reserve && typeof input.reserve === 'object' ? input.reserve : {}
  const opsCarryProvenance = input.opsCarryProvenance && typeof input.opsCarryProvenance === 'object' ? input.opsCarryProvenance : {}

  const issues = []
  const operations = []
  const issue = (code, details = {}) => issues.push({ code, ...details })

  // The approved normalized-collection digest: bound into the manifest and
  // into every relayProof so an apply can never mix evidence generations.
  const evidenceDigest = digestOf(evidence)

  // -- Evidence integrity ---------------------------------------------------

  if (!evidence.scope || evidence.scope.network !== scope.network || evidence.scope.walletAddress !== scope.walletAddress) {
    issue('SCOPE_MISMATCH', { source: 'evidence', reason: 'evidence scope does not match the manifest scope' })
  }
  if (evidence.walletHeight == null || evidence.walletHeight < boundary.height + 1) {
    // The wallet's height is a scanned block COUNT: covering the boundary
    // INDEX requires at least index + 1 scanned blocks.
    issue('UNSYNCED_HEIGHT', { walletHeight: evidence.walletHeight, boundaryHeight: boundary.height })
  }
  if (!evidence.daemon?.tipBefore || !evidence.daemon?.tipAfter) {
    issue('BOUNDARY_EVIDENCE_MISSING', { reason: 'daemon tip evidence before and after the scan is required' })
  } else {
    const { tipBefore, tipAfter } = evidence.daemon
    const matchesBoundary = tip => tip && tip.height === boundary.height && tip.blockHash === boundary.blockHash
    if (!matchesBoundary(tipBefore) || !matchesBoundary(tipAfter)) {
      issue('BOUNDARY_CHANGED', {
        reason: 'the daemon boundary differs before/after the scan; evidence heights must not be mixed',
        tipBefore,
        tipAfter
      })
    }
  }
  if (!evidence.derivation.complete) {
    issue('INCOMPLETE_DERIVATION', {
      reason: 'derived wallet addresses do not fully match the registered SubaddressIndex rows',
      mismatches: evidence.derivation.mismatches
    })
  }
  if (evidence.restoreHeight > 0) {
    if (evidence.restoreProvenance !== 'verified-first-activity' ||
      evidence.firstActivityHeight == null ||
      evidence.firstActivityHeight < evidence.restoreHeight) {
      issue('RESTORE_ABOVE_FIRST_EVIDENCE', {
        restoreHeight: evidence.restoreHeight,
        firstActivityHeight: evidence.firstActivityHeight,
        reason: 'a restore above genesis needs verified first-wallet-activity evidence at or after the restore height'
      })
    }
  }

  const ownedAddresses = new Set([
    scope.walletAddress,
    ...evidence.derivation.derived.map(entry => entry.address).filter(Boolean)
  ])

  // -- Journal scope + duplicate conflicts ----------------------------------

  const journal = []
  const foreignJournalHashes = new Set()
  for (const row of ledger.transactions) {
    if (row.network !== scope.network || row.walletAddress !== scope.walletAddress) {
      issue('SCOPE_MISMATCH', {
        source: 'ledger',
        txHash: row.txHash,
        reason: 'journal row outside the configured wallet scope'
      })
      foreignJournalHashes.add(row.txHash)
      continue
    }
    journal.push(row)
  }
  const journalByHash = new Map()
  for (const row of journal) {
    const list = journalByHash.get(row.txHash) ?? []
    list.push(row)
    journalByHash.set(row.txHash, list)
  }
  const analysisJournal = []
  for (const [txHash, rows] of [...journalByHash.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rows.length > 1) {
      issue('DUPLICATE_HASH_CONFLICT', {
        txHash,
        reason: 'more than one journal row claims one transaction hash',
        kinds: rows.map(row => row.kind).sort()
      })
    }
    analysisJournal.push([...rows].sort(sortByNumberedId)[0])
  }

  // Deterministic ledger-membership indexes used by both journal validation and
  // outgoing classification.
  const payoutsById = new Map(ledger.payouts.map(payout => [payout.id, payout]))
  const sweepHashOwners = new Map() // hash -> sorted distribution ids
  for (const distribution of ledger.distributions) {
    if (typeof distribution.opsSweepTxHash !== 'string') continue
    // The shared ledger accepts '' as "no recorded hashes" (parseHashList) and
    // does not split it; only a non-empty string is parsed and validated.
    if (distribution.opsSweepTxHash === '') continue
    for (const part of distribution.opsSweepTxHash.split(',')) {
      const hash = normalizeHash(part.trim())
      if (!hash) {
        issue('SWEEP_HASH_MALFORMED', {
          table: 'RewardDistribution',
          id: distribution.id,
          entry: part.trim(),
          reason: 'the recorded sweep hash list contains a non-hash entry'
        })
        continue
      }
      const owners = sweepHashOwners.get(hash) ?? []
      if (!owners.includes(distribution.id)) owners.push(distribution.id)
      owners.sort((a, b) => a - b)
      sweepHashOwners.set(hash, owners)
    }
  }
  for (const [txHash, owners] of sweepHashOwners) {
    if (owners.length > 1) {
      issue('SWEEP_HASH_OWNERSHIP_CONFLICT', {
        txHash,
        distributionIds: owners,
        reason: 'more than one recorded distribution claims the same sweep hash'
      })
    }
  }
  // Every journal fact a repair may rely on is validated against the recorded
  // ledger (members, destination semantics, proven fee, ownership) so an
  // unresolved attribution conflict becomes an exact material issue.
  for (const row of analysisJournal) {
    validateJournalFact({ row, payoutsById, sweepHashOwners, scope, issue })
  }

  // -- Before ledger facts (Task 7 union; scoped, deduplicated rows) --------

  const beforeSummary = summarizeRewardsLedger({
    payouts: ledger.payouts,
    distributions: ledger.distributions,
    transactions: analysisJournal,
    scope
  })

  // -- Receipt/receipt-evidence matching ------------------------------------

  const afterReceipts = analysisReceipts.map(row => ({ ...row }))
  const afterReceiptById = new Map(afterReceipts.map(row => [row.id, row]))
  const receiptCorrections = []
  const matchedReceiptIds = new Set()
  const incomingHashes = new Set(evidence.incoming.map(entry => entry.txHash).filter(Boolean))
  const escrowIncomingHashes = new Set((evidence.escrow?.incoming ?? []).map(entry => entry.txHash).filter(Boolean))

  const receiptsByKey = new Map()
  for (const receipt of ledger.receipts) {
    if (!receipt.txHash) continue
    const key = `${receipt.txHash}:${receipt.recipientMajor}:${receipt.recipientMinor}`
    const list = receiptsByKey.get(key) ?? []
    list.push(receipt)
    receiptsByKey.set(key, list)
  }
  const itemsById = new Map(ledger.items.map(item => [item.id, item]))
  const bountyPaymentsByHash = new Map(ledger.bountyPayments.filter(payment => payment.txHash).map(payment => [payment.txHash, payment]))
  const observedByPostId = new Map()
  for (const bounty of ledger.observedBounties) {
    if (bounty.postId == null) continue
    const list = observedByPostId.get(bounty.postId) ?? []
    list.push(bounty)
    observedByPostId.set(bounty.postId, list)
  }
  const receiptHashesByBountyId = new Map()
  for (const observation of ledger.observedBountyReceipts) {
    if (observation.bountyId == null) continue
    const hashes = receiptHashesByBountyId.get(observation.bountyId) ?? new Set()
    hashes.add(observation.txHash)
    receiptHashesByBountyId.set(observation.bountyId, hashes)
  }
  const fundingIdentification = { observedByPostId, receiptHashesByBountyId, escrowIncomingHashes }

  const externalIncoming = evidence.incoming.filter(entry => entry.isConfirmed && !entry.inTxPool && !entry.fromOwnTransaction && !entry.isSelfTransfer)
  const inboundByKey = new Map()
  for (const entry of [...externalIncoming].sort(byHashKey)) {
    const key = `${entry.txHash}:${entry.accountIndex}:${entry.subaddressIndex}`
    const prior = inboundByKey.get(key)
    if (!prior) {
      inboundByKey.set(key, entry)
      continue
    }
    if (prior.amountPiconeros !== entry.amountPiconeros || prior.height !== entry.height) {
      issue('AMBIGUOUS_PAIRING', {
        txHash: entry.txHash,
        accountIndex: entry.accountIndex,
        subaddressIndex: entry.subaddressIndex,
        reason: 'two wallet outputs share a hash/index with different amounts or heights'
      })
    }
  }

  const unmatchedIncoming = []
  for (const key of [...inboundByKey.keys()].sort()) {
    const entry = inboundByKey.get(key)
    if (!entry.txHash || entry.amountPiconeros == null) {
      issue('INVALID_EVIDENCE_ENTRY', { txHash: entry.txHash, reason: 'wallet output without a valid hash/amount' })
      continue
    }
    const candidates = (receiptsByKey.get(key) ?? []).filter(receipt => !matchedReceiptIds.has(receipt.id))
    if (candidates.length === 0) {
      unmatchedIncoming.push(entry)
      continue
    }
    let chosen = null
    if (candidates.length === 1) {
      chosen = candidates[0]
    } else {
      const inboundAmount = BigInt(entry.amountPiconeros)
      const exact = candidates.filter(receipt =>
        receipt.piconeros === inboundAmount &&
        (receipt.height == null || entry.height == null || receipt.height === entry.height))
      if (exact.length === 1) {
        chosen = exact[0]
      } else {
        issue('AMBIGUOUS_PAIRING', {
          txHash: entry.txHash,
          accountIndex: entry.accountIndex,
          subaddressIndex: entry.subaddressIndex,
          reason: 'no single ledger row can be paired with this wallet output',
          receiptIds: candidates.map(receipt => receipt.id)
        })
        continue
      }
    }
    matchedReceiptIds.add(chosen.id)
    if (!chosen.walletReceipt) {
      issue('NONCASH_ROW_HAS_CHAIN_EVIDENCE', { table: 'FeeObservation', id: chosen.id, txHash: chosen.txHash })
      continue
    }
    if (chosen.state !== 'CONFIRMED') {
      issue('UNMATURED_RECEIPT', { table: 'FeeObservation', id: chosen.id, txHash: chosen.txHash, state: chosen.state })
      continue
    }
    if (chosen.piconeros == null) {
      issue('INVALID_RECEIPT', { table: 'FeeObservation', id: chosen.id, reason: 'unreadable receipt amount' })
      continue
    }
    if (chosen.height != null && entry.height != null && chosen.height !== entry.height) {
      issue('HEIGHT_MISMATCH', { table: 'FeeObservation', id: chosen.id, txHash: chosen.txHash, ledgerHeight: chosen.height, chainHeight: entry.height })
      continue
    }
    const inboundAmount = BigInt(entry.amountPiconeros)
    // A rollover's split is validated independently of the amount comparison:
    // a net receipt already equal to 139 can still carry a legacy NULL (or
    // wrong) reward component that must be repaired to the frozen prize.
    if (chosen.piconeros !== inboundAmount || chosen.feeType === 'BOUNTY_ROLLOVER') {
      const correction = buildReceiptCorrection({
        receipt: chosen,
        newAmount: inboundAmount,
        itemsById,
        bountyPaymentsByHash,
        decisions,
        config
      })
      if (correction?.unverified) {
        issue(correction.unverified, { table: 'FeeObservation', id: chosen.id, txHash: chosen.txHash })
      } else if (correction) {
        operations.push(correction.operation)
        receiptCorrections.push(correction)
        Object.assign(afterReceiptById.get(chosen.id), correction.afterRow)
      }
    }
  }

  // Downvote receipts: pair by the full (hash, receiving index, amount,
  // height) tuple against the same chain evidence. Downvotes only ever arrive
  // on the primary address (0/0); duplicate hash candidates are ambiguous.
  const downvotesByHash = new Map()
  for (const downvote of ledger.downvotes) {
    if (!downvote.txHash) continue
    const list = downvotesByHash.get(downvote.txHash) ?? []
    list.push(downvote)
    downvotesByHash.set(downvote.txHash, list)
  }
  const matchedDownvoteIds = new Set()
  for (let i = unmatchedIncoming.length - 1; i >= 0; i--) {
    const entry = unmatchedIncoming[i]
    if (entry.accountIndex !== 0 || entry.subaddressIndex !== 0) continue
    const candidates = downvotesByHash.get(entry.txHash)
    if (!candidates) continue
    if (candidates.length > 1) {
      unmatchedIncoming.splice(i, 1)
      issue('AMBIGUOUS_DOWNVOTE_PAIRING', {
        txHash: entry.txHash,
        downvoteIds: candidates.map(downvote => downvote.id).sort((a, b) => a - b)
      })
      continue
    }
    const downvote = candidates[0]
    unmatchedIncoming.splice(i, 1)
    matchedDownvoteIds.add(downvote.id)
    if (downvote.piconeros == null || entry.amountPiconeros == null ||
      downvote.piconeros !== BigInt(entry.amountPiconeros)) {
      issue('DOWNVOTE_AMOUNT_MISMATCH', { table: 'ObservedDownvote', id: downvote.id, txHash: downvote.txHash })
    } else if (downvote.height != null && entry.height != null && downvote.height !== entry.height) {
      issue('DOWNVOTE_HEIGHT_MISMATCH', {
        table: 'ObservedDownvote',
        id: downvote.id,
        txHash: downvote.txHash,
        ledgerHeight: downvote.height,
        chainHeight: entry.height
      })
    }
  }
  for (const downvote of ledger.downvotes) {
    if (downvote.state === 'CONFIRMED' && !matchedDownvoteIds.has(downvote.id)) {
      issue('UNMATCHED_BOOKED_RECEIPT', { table: 'ObservedDownvote', id: downvote.id, txHash: downvote.txHash })
    }
  }

  // Explicit operator classifications for otherwise-unmatched wallet outputs.
  for (const entry of unmatchedIncoming.sort(byHashKey)) {
    const decision = decisions.receipts?.[entry.txHash]
    if (!decision) {
      issue('UNKNOWN_INCOMING', {
        txHash: entry.txHash,
        accountIndex: entry.accountIndex,
        subaddressIndex: entry.subaddressIndex,
        amountPiconeros: entry.amountPiconeros,
        height: entry.height,
        reason: 'unbooked wallet receipt requires an explicit operator classification'
      })
      continue
    }
    const classification = buildInsertedReceipt({
      entry,
      decision,
      issue,
      context: { itemsById, bountyPaymentsByHash, distributions: ledger.distributions, decisions }
    })
    if (classification) {
      operations.push(classification.operation)
      afterReceipts.push(classification.afterRow)
      receiptCorrections.push(classification)
    }
  }

  // Booked cash rows with no chain evidence: identified funding accruals are
  // marked noncash; anything else is an unmatched booked receipt.
  for (const receipt of analysisReceipts) {
    if (matchedReceiptIds.has(receipt.id)) continue
    if (receipt.walletReceipt !== true || receipt.state !== 'CONFIRMED') continue
    if (receipt.piconeros == null) {
      issue('INVALID_RECEIPT', { table: 'FeeObservation', id: receipt.id, reason: 'unreadable receipt amount' })
      continue
    }
    if (receipt.feeType === 'BOUNTY_FEE' && receipt.txHash && escrowIncomingHashes.has(receipt.txHash) && !incomingHashes.has(receipt.txHash)) {
      // Legacy funding-time accrual: the nominal fee was booked as if it were
      // cash, but the funding tx landed in the ESCROW wallet. Preserve every
      // other field; only eligibility moves.
      operations.push({
        kind: 'update',
        table: 'FeeObservation',
        id: receipt.id,
        before: { walletReceipt: true },
        after: { walletReceipt: false },
        reason: 'funding-accrual-not-cash'
      })
      Object.assign(afterReceiptById.get(receipt.id), { walletReceipt: false })
      receiptCorrections.push({
        receipt,
        afterRow: { walletReceipt: false },
        beforeRewards: 0n,
        afterRewards: 0n
      })
      continue
    }
    issue('UNMATCHED_BOOKED_RECEIPT', {
      table: 'FeeObservation',
      id: receipt.id,
      txHash: receipt.txHash,
      amountPiconeros: receipt.piconeros.toString()
    })
  }

  // -- Safe payment-verification collection ---------------------------------

  // Proof-era authority (rewards reconciliation Task 3): the approved
  // collection may carry #1 verifier results. They are indexed by
  // role/scope/hash with duplicate/conflict detection BEFORE any outgoing
  // classification, and repair authorization against them requires the v2
  // evidence contract — an old report can still be displayed, but its
  // verifications never promote a relay.
  const verificationsByRoleAndHash = new Map()
  const suppliedVerifications = arrayOf(input.evidence?.paymentVerifications)
  if (suppliedVerifications.length > 0) {
    if (evidence.evidenceVersion !== 2) {
      issue('EVIDENCE_VERSION_UNSUPPORTED', {
        reason: 'payment verifications authorize repair only under the v2 evidence contract'
      })
    } else {
      for (const entry of suppliedVerifications) {
        if (!validatePaymentVerification(entry)) {
          issue('PAYMENT_VERIFICATION_INVALID', {
            reason: 'a collected payment verification is not a safe PaymentVerificationV1 result'
          })
          continue
        }
        if (!entry.scope || entry.scope.network !== scope.network ||
          entry.scope.walletAddress !== scope.walletAddress) {
          issue('PAYMENT_VERIFICATION_SCOPE_MISMATCH', {
            txHash: entry.txHash,
            journalRole: entry.journalRole,
            reason: 'a collected payment verification names another wallet scope'
          })
          continue
        }
        const key = `${entry.journalRole}:${entry.txHash}`
        const prior = verificationsByRoleAndHash.get(key)
        if (prior !== undefined) {
          const conflicts = prior === null ||
            String(prior.journalId) !== String(entry.journalId) ||
            JSON.stringify(canonicalValue(paymentVerificationFacts(prior))) !==
              JSON.stringify(canonicalValue(paymentVerificationFacts(entry)))
          if (conflicts) {
            issue('PAYMENT_VERIFICATION_CONFLICT', {
              txHash: entry.txHash,
              journalRole: entry.journalRole,
              reason: 'two collected verifications disagree for one journal role/scope/hash'
            })
            verificationsByRoleAndHash.set(key, null) // poisoned: never binds
          }
          continue
        }
        verificationsByRoleAndHash.set(key, entry)
      }
    }
  }

  // -- Reverse recorded-outflow coverage ------------------------------------

  // Every recorded outflow (payouts, recorded sweep hashes, escrow settlement
  // legs) is proved row-first against a COMPLETE payment verification —
  // INDEPENDENT of any drift computation: there is deliberately no
  // aggregate-drift guard here or anywhere below. Relay journal rows, confirmed
  // history and pending bridge entries are operational recovery facts and
  // chain presence, never strict coverage (final-review I1): a recorded
  // outflow without complete proof stays a named issue whatever the
  // destination/fee history shows. Exact same-cause records are deduplicated
  // against the builder's own.
  const emittedIssueKeys = new Set(issues.map(entry => JSON.stringify(canonicalValue(entry))))
  for (const record of recordedOutflowCoverage({ ledger, evidence, scope })) {
    const key = JSON.stringify(canonicalValue(record))
    if (emittedIssueKeys.has(key)) continue
    emittedIssueKeys.add(key)
    issues.push(record)
  }

  // -- Hot outgoing classification ------------------------------------------

  const afterTransactions = analysisJournal.map(row => ({ ...row }))
  const journalAnalysisByHash = new Map(analysisJournal.map(row => [row.txHash, row]))
  // RELAYED rows whose NULL persisted fee is proven by owned confirmed history
  // (filled during the outgoing pass) — these are resolved by the exact fee
  // correction, not by a blocking issue.
  const recoverableFees = new Map()
  const payoutsByHash = new Map()
  for (const payout of ledger.payouts) {
    if (!payout.txHash) continue
    const list = payoutsByHash.get(payout.txHash) ?? []
    list.push(payout)
    payoutsByHash.set(payout.txHash, list)
  }
  const bridgePendingByHash = new Map(evidence.bridge.pendingOutgoing.map(entry => [entry.txHash, entry]))

  const destinationsOf = entry => entry.destinations.map(destination => (destination.amountPiconeros == null
    ? destination
    : { address: destination.address, amount: BigInt(destination.amountPiconeros) }))

  const feeCorrection = (row, entry) => {
    const actualFee = BigInt(entry.feePiconeros)
    const recordedFee = row.networkFeePiconeros
    if (recordedFee === actualFee) return
    operations.push({
      kind: 'update',
      table: 'RewardsWalletTransaction',
      txHash: row.txHash,
      // The journal's identity is (network, walletAddress, txHash): bind the
      // correction to the approved scope so a same-hash row in another wallet
      // can never be matched (the apply dispatcher requires all three).
      network: scope.network,
      walletAddress: scope.walletAddress,
      before: { networkFeePiconeros: recordedFee == null ? null : recordedFee.toString() },
      after: { networkFeePiconeros: actualFee.toString() },
      reason: 'wallet-history-fee'
    })
    const afterRow = afterTransactions.find(candidate => candidate.txHash === row.txHash)
    if (afterRow) afterRow.networkFeePiconeros = actualFee
  }

  const verifyJournalDestinations = (row, entry) =>
    journalRelayEvidenceMismatch({ row, entry, scope, ownedAddresses })

  // Journal-less legacy backfill (rewards reconciliation Task 4): a complete
  // independently surviving legacy verification — never a destination-only or
  // tx-hash-only input, and never a new signing operation — backfills ONE
  // historical journal row carrying the same closed v2 relayProof with null
  // journal/dispatch/claim/proof-inventory identity. `relayedAt` is the time
  // the evidence was checked (the observation), never a reconstructed
  // broadcast time, and every proof-era capture column is explicitly null.
  const legacyBackfillVerification = txHash => {
    const bound = verificationsByRoleAndHash.get(`REWARDS:${txHash}`)
    if (!bound || bound.status !== 'complete' || bound.captureMode !== 'LEGACY_SURVIVING_PROOF') return null
    return bound
  }
  const pushLegacyBackfill = ({ kind, entry, verification, distributionId, principalPiconeros, metadata }) => {
    let relayProof
    try {
      relayProof = buildLegacyBackfillRelayProof({ verification, evidenceDigest })
    } catch (err) {
      if (typeof err?.code !== 'string' || !err.message.startsWith(`${err.code}: `)) throw err
      issue(err.code, { txHash: entry.txHash, reason: err.message.slice(err.code.length + 2) })
      return
    }
    const after = {
      network: scope.network,
      walletAddress: scope.walletAddress,
      txHash: entry.txHash,
      kind,
      state: 'RELAYED',
      accountIndex: entry.accountIndex ?? 0,
      distributionId,
      principalPiconeros: principalPiconeros.toString(),
      networkFeePiconeros: BigInt(verification.totals.F).toString(),
      metadata,
      relayAttemptedAt: null,
      relayedAt: verification.observedAt,
      relayProvenance: LEGACY_BACKFILL_REASON,
      dispatchId: null,
      captureContractVersion: null,
      claimDigest: null,
      paymentClaims: null,
      proofId: null
    }
    operations.push({
      kind: 'insert',
      table: 'RewardsWalletTransaction',
      key: { network: scope.network, walletAddress: scope.walletAddress, txHash: entry.txHash },
      before: null,
      after,
      relayProof,
      reason: LEGACY_BACKFILL_REASON
    })
    afterTransactions.push({ ...after, principalPiconeros, networkFeePiconeros: BigInt(after.networkFeePiconeros) })
  }

  // Evidence-bound promotion of one attempted PREPARED row (rewards
  // reconciliation Task 3): the complete verified payment resolves the row's
  // journal contradiction/pending-attempt state with ONE closed operation, or
  // records the exact refusal — generic issues are never doubled for a row a
  // verification was collected for.
  const relayPromotionAttemptedHashes = new Set()
  const promotedAfterByHash = new Map()
  const promoteJournalRow = (row, verification) => {
    if (promotedAfterByHash.has(row.txHash)) return
    try {
      const operation = buildJournalRelayOperation({
        row,
        verification,
        evidenceDigest,
        collectionStartedAt: evidence.collectionStartedAt,
        collectedAt: evidence.observedAt
      })
      operations.push(operation)
      const afterRow = afterTransactions.find(candidate => candidate.txHash === row.txHash)
      if (afterRow) {
        // The copied after-ledger resolves BEFORE fees/principal, ops
        // carry/checkpoints and uncertainty are recomputed below.
        afterRow.state = 'RELAYED'
        afterRow.relayedAt = operation.after.relayedAt
        afterRow.relayProvenance = operation.after.relayProvenance
        if (operation.after.networkFeePiconeros !== undefined) {
          afterRow.networkFeePiconeros = BigInt(operation.after.networkFeePiconeros)
        }
        promotedAfterByHash.set(row.txHash, afterRow)
      }
    } catch (err) {
      if (typeof err?.code !== 'string' || !err.message.startsWith(`${err.code}: `)) throw err
      issue(err.code, { txHash: row.txHash, kind: row.kind, reason: err.message.slice(err.code.length + 2) })
    }
  }

  for (const entry of evidence.outgoing.filter(row => row.isConfirmed && !row.inTxPool).sort(byHashKey)) {
    if (!entry.txHash) {
      issue('INVALID_EVIDENCE_ENTRY', { reason: 'confirmed outgoing without a transaction hash' })
      continue
    }
    if (foreignJournalHashes.has(entry.txHash)) continue // excluded foreign fact: the scope issue already blocks APPLY
    const candidateRow = journalAnalysisByHash.get(entry.txHash)
    if (candidateRow && candidateRow.state === 'PREPARED' && candidateRow.relayAttempted &&
      (journalByHash.get(entry.txHash)?.length ?? 0) === 1) {
      const bound = verificationsByRoleAndHash.get(`REWARDS:${entry.txHash}`)
      if (bound !== undefined) {
        // A verification was collected for this row: the promotion path owns
        // its issue handling. No restored destination requirement — the
        // verifier's own receipt/structure/partition gates are the authority.
        relayPromotionAttemptedHashes.add(entry.txHash)
        if (bound !== null) promoteJournalRow(candidateRow, bound)
        continue
      }
    }
    if (entry.destinations.length === 0 || !entry.destinationsReadable ||
      entry.destinations.some(destination => destination.address == null || destination.amountPiconeros == null)) {
      issue('MISSING_DESTINATIONS', { txHash: entry.txHash })
      continue
    }
    const row = journalAnalysisByHash.get(entry.txHash)
    if (journalByHash.get(entry.txHash)?.length > 1) continue // already a material duplicate conflict
    if (row) {
      if (row.state === 'RELAYED') {
        const mismatch = verifyJournalDestinations(row, entry)
        if (mismatch) {
          issue('JOURNAL_DESTINATION_MISMATCH', { txHash: entry.txHash, kind: row.kind, reason: mismatch })
        } else if (entry.feePiconeros == null) {
          issue('MISSING_OUTGOING_FEE', { txHash: entry.txHash })
        } else {
          if (row.networkFeePiconeros == null) recoverableFees.set(entry.txHash, BigInt(entry.feePiconeros))
          feeCorrection(row, entry)
        }
      } else {
        issue('JOURNAL_STATE_CONTRADICTION', {
          txHash: entry.txHash,
          state: row.state,
          reason: 'the transaction is confirmed on chain but the journal does not record a relay'
        })
      }
      continue
    }

    // No journal row: a journal-less historical payout backfills ONLY from a
    // complete independently surviving proof of the exact recorded batch.
    // Destination-only or tx-hash-only evidence inserts nothing — the reverse
    // coverage names the gap (missing history, pending or member mismatch).
    const payouts = payoutsByHash.get(entry.txHash) ?? []
    if (payouts.length > 0) {
      const bound = legacyBackfillVerification(entry.txHash)
      if (bound && recordedBatchMembershipMismatch(payouts, bound.members) === null) {
        const distributionIds = new Set(payouts.map(payout => payout.distributionId).filter(id => id != null))
        pushLegacyBackfill({
          kind: 'PAYOUT',
          entry,
          verification: bound,
          distributionId: distributionIds.size === 1 ? [...distributionIds][0] : null,
          principalPiconeros: payouts.reduce((acc, payout) => acc + (payout.piconeros ?? 0n), 0n),
          metadata: {
            payouts: payouts
              .map(payout => ({ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: (payout.piconeros ?? 0n).toString() }))
              .sort((a, b) => a.payoutId - b.payoutId)
          }
        })
        continue
      }
      if (payouts.some(payout => payout.state === 'SENT' || payout.state === 'CONFIRMED')) {
        continue // a recorded row claims this hash: already named row-first
      }
    }

    const sweepOwners = sweepHashOwners.get(entry.txHash)
    if (sweepOwners != null) {
      const bound = legacyBackfillVerification(entry.txHash)
      if (bound && bound.members.length === 1) {
        pushLegacyBackfill({
          kind: 'OPS_SWEEP',
          entry,
          verification: bound,
          distributionId: sweepOwners.length === 1 ? sweepOwners[0] : null,
          principalPiconeros: BigInt(bound.members[0].actualPiconeros),
          metadata: { destination: bound.members[0].address }
        })
      }
      continue // the recorded hash's coverage gap is already named row-first
    }

    if (entry.isSelfTransfer && destinationsOf(entry).every(destination => ownedAddresses.has(destination.address))) {
      const bound = legacyBackfillVerification(entry.txHash)
      if (bound && bound.members.length > 0 &&
        bound.members.every(member => ownedAddresses.has(member.address))) {
        pushLegacyBackfill({
          kind: 'CONSOLIDATION',
          entry,
          verification: bound,
          distributionId: null,
          principalPiconeros: 0n,
          metadata: { destination: scope.walletAddress, selfTransfer: true }
        })
        continue
      }
      // Without surviving proof an internal transfer stays a named unresolved
      // outflow — never auto-classified from destinations alone.
    }

    issue('UNKNOWN_OUTGOING', {
      txHash: entry.txHash,
      destinations: entry.destinations,
      reason: 'unexplained hot-wallet outflow; refusing to guess a classification'
    })
  }

  // -- Journal rows without chain evidence ----------------------------------

  const outgoingHashSet = new Set([
    ...evidence.outgoing.filter(entry => entry.isConfirmed && !entry.inTxPool).map(entry => entry.txHash),
    ...evidence.bridge.pendingOutgoing.map(entry => entry.txHash)
  ])
  for (const row of analysisJournal) {
    if (row.state === 'RELAYED') {
      if (!outgoingHashSet.has(row.txHash)) {
        issue('JOURNAL_ROW_NOT_ON_CHAIN', { txHash: row.txHash, kind: row.kind })
      }
      continue
    }
    if (row.state === 'PREPARED') {
      if (relayPromotionAttemptedHashes.has(row.txHash)) continue // resolved, or its exact promotion refusal was recorded
      if (!row.relayAttempted) continue
      const pending = bridgePendingByHash.get(row.txHash)
      if (!(pending && pending.relayState === 'pool' && pending.isRelayed)) {
        issue('PENDING_ATTEMPT_UNRESOLVED', {
          txHash: row.txHash,
          kind: row.kind,
          reason: 'an attempted relay has no mempool evidence; the attempt is unresolved'
        })
      }
      continue
    }
    if (row.state !== 'NOT_RELAYED') {
      issue('INVALID_JOURNAL_STATE', { txHash: row.txHash, state: row.state })
    }
  }

  // -- Pending bridge outgoing ----------------------------------------------

  for (const entry of evidence.bridge.pendingOutgoing.sort(byHashKey)) {
    if (!entry.txHash) {
      issue('INVALID_EVIDENCE_ENTRY', { reason: 'pending outgoing without a transaction hash' })
      continue
    }
    const row = journalAnalysisByHash.get(entry.txHash)
    if (row) {
      if (row.state === 'NOT_RELAYED') {
        issue('JOURNAL_STATE_CONTRADICTION', { txHash: entry.txHash, state: row.state })
      }
      continue // RELAYED/PREPARED pending items are explicit bridge facts
    }
    if ((payoutsByHash.get(entry.txHash) ?? []).length > 0) continue
    if (sweepHashOwners.has(entry.txHash)) continue
    if (entry.isSelfTransfer) continue
    issue('UNKNOWN_PENDING_OUTGOING', {
      txHash: entry.txHash,
      destinations: entry.destinations,
      reason: 'pending outgoing has no journal/payout/sweep membership'
    })
  }

  // Every uncertainty trigger in the shared ledger union is either (a) named by
  // a specific exact issue above, (b) an explicitly validated mempool bridge
  // attempt, or (c) a NULL persisted fee proven by owned confirmed history.
  // Re-summarize a copy with ONLY (b) and (c) neutralized: if uncertainty
  // remains, the catch-all blocks APPLY — the ledger helper's uncertainty flag
  // is never silently discarded.
  const ledgerIssueCodes = new Set([
    'SCOPE_MISMATCH', 'DUPLICATE_HASH_CONFLICT', 'INVALID_JOURNAL_ROW',
    'JOURNAL_METADATA_INVALID', 'JOURNAL_MEMBER_UNKNOWN', 'JOURNAL_MEMBER_MISMATCH',
    'JOURNAL_FEE_INVALID', 'SWEEP_HASH_MALFORMED', 'SWEEP_HASH_OWNERSHIP_CONFLICT',
    'SWEEP_OWNERSHIP_MISMATCH', 'JOURNAL_ROW_NOT_ON_CHAIN', 'JOURNAL_STATE_CONTRADICTION',
    'PENDING_ATTEMPT_UNRESOLVED'
  ])
  if (beforeSummary.accountingUncertain && !issues.some(entry => ledgerIssueCodes.has(entry.code))) {
    const adjustedJournal = analysisJournal.map(row => {
      const promotedAfter = promotedAfterByHash.get(row.txHash)
      if (promotedAfter) return promotedAfter // the relay is resolved: exact state/fee proven above
      if (row.state === 'PREPARED' && row.relayAttempted) {
        const pending = bridgePendingByHash.get(row.txHash)
        if (pending && pending.relayState === 'pool' && pending.isRelayed) {
          return { ...row, relayAttemptedAt: null, relayAttempted: false }
        }
      }
      if (row.state === 'RELAYED' && row.networkFeePiconeros == null && recoverableFees.has(row.txHash)) {
        return { ...row, networkFeePiconeros: recoverableFees.get(row.txHash) }
      }
      return row
    })
    const adjustedSummary = summarizeRewardsLedger({
      payouts: ledger.payouts,
      distributions: ledger.distributions,
      transactions: adjustedJournal,
      scope
    })
    if (adjustedSummary.accountingUncertain) {
      issue('LEDGER_UNCERTAINTY', {
        reason: 'the scoped ledger union reports unresolved attribution conflicts without a classified cause'
      })
    }
  }

  // -- Bounty settlement metadata recovery (escrow-owned history) -----------

  const escrowOutgoingByHash = new Map((evidence.escrow?.outgoing ?? []).map(entry => [entry.txHash, entry]))
  const settlementOps = []
  const openPayments = ledger.bountyPayments.filter(payment => payment.state === 'SENT' || payment.state === 'CONFIRMED')
  if (openPayments.length > 0 && !evidence.escrow) {
    issue('MISSING_ESCROW_EVIDENCE', { reason: 'registered bounty payouts require the escrow wallet history for settlement recovery' })
  } else {
    for (const payment of openPayments) {
      // A missing transaction hash or a leg absent from escrow evidence is
      // named row-first by the reverse recorded-outflow coverage
      // (RECORDED_ESCROW_LEG_EVIDENCE_MISSING) — settlement columns are not
      // evidence, and the same cause is never issued twice here.
      if (!payment.txHash) continue
      const leg = escrowOutgoingByHash.get(payment.txHash)
      if (!leg) continue
      const recovered = recoverSettlement({ payment, leg, escrowOutgoingByHash, scope, issue })
      if (recovered) settlementOps.push(recovered)
    }
  }

  // -- Receipt ops deltas + reward-side deficit -----------------------------

  // Ops deltas are computed per affected DISTRIBUTION with the shared reader's
  // aggregation (aggregate floors for percentage sources, per-row donation
  // floors) so an individually floored per-receipt subtraction can never
  // understate the corrected carry.
  //
  // Migration-classified funding evidence: the schema migration marks every
  // identified legacy funding-time BOUNTY_FEE accrual walletReceipt=false
  // BEFORE this manifest runs, but the stored distribution snapshots were
  // computed while those rows were still eligible cash. Each affected period's
  // ops inflow must therefore be corrected by the identified phantom
  // contribution exactly once — reconstructed from the mandated identification
  // predicate, NEVER by blanket-subtracting every ineligible row. The
  // un-applied correction is recognized only while the stored inflow still
  // carries it (stored − current reconstruction == phantom); once corrected the
  // reconstruction delta is zero, so regenerating after an APPLY changes
  // nothing. Any other stored value is ambiguous and blocks APPLY.
  const receiptOpsDeltas = new Map()
  let rewardFundingDeficit = 0n
  const affectedDistributions = new Map()
  const migratedFundingOps = new Map()
  for (const correction of receiptCorrections) {
    const distribution = distributionForTime(ledger.distributions, correction.receipt.confirmedAt)
    if (distribution) affectedDistributions.set(distribution.id, distribution)
    if (correction.afterRewards != null && correction.beforeRewards != null && correction.beforeRewards > correction.afterRewards) {
      rewardFundingDeficit += correction.beforeRewards - correction.afterRewards
    }
  }
  for (const receipt of analysisReceipts) {
    if (receipt.walletReceipt !== false || receipt.state !== 'CONFIRMED' ||
      receipt.feeType !== 'BOUNTY_FEE' || receipt.piconeros == null) continue
    if (!isIdentifiedFundingReceipt(receipt, fundingIdentification)) continue
    const distribution = distributionForTime(ledger.distributions, receipt.confirmedAt)
    if (!distribution) continue
    // BOUNTY_FEE is 100% ops; the zero-fee abandonment pseudo-rows add nothing.
    if (receipt.piconeros === 0n) continue
    migratedFundingOps.set(distribution.id, (migratedFundingOps.get(distribution.id) ?? 0n) + receipt.piconeros)
    affectedDistributions.set(distribution.id, distribution)
  }
  for (const distribution of [...affectedDistributions.values()].sort((a, b) => a.periodEnd - b.periodEnd || a.id - b.id)) {
    const beforeOps = periodOpsPiconeros(analysisReceipts, distribution, decisions)
    const afterOps = periodOpsPiconeros(afterReceipts, distribution, decisions)
    if (beforeOps == null || afterOps == null) {
      issue('UNVERIFIED_ALLOCATION', {
        table: 'RewardDistribution',
        id: distribution.id,
        reason: 'the period contains percentage-source receipts without verified historical allocation terms'
      })
      continue
    }
    const phantom = migratedFundingOps.get(distribution.id) ?? 0n
    if (phantom > 0n) {
      // The stored snapshot is either still the historical reconstruction
      // (beforeOps + phantom, carrying the migration-flipped accrual) or already
      // the corrected absolute target; both rebuild to the SAME target, so a
      // regeneration after an APPLY computes delta 0 and never subtracts twice.
      const stillCarriesPhantom = distribution.opsInflowPiconeros === beforeOps + phantom
      if (stillCarriesPhantom || distribution.opsInflowPiconeros === afterOps) {
        const delta = afterOps - distribution.opsInflowPiconeros
        if (delta !== 0n) receiptOpsDeltas.set(distribution.id, delta)
      } else {
        issue('UNRECONCILED_MIGRATED_FUNDING', {
          table: 'RewardDistribution',
          id: distribution.id,
          storedInflowPiconeros: distribution.opsInflowPiconeros.toString(),
          currentOpsPiconeros: beforeOps.toString(),
          correctedOpsPiconeros: afterOps.toString(),
          migratedFundingOpsPiconeros: phantom.toString(),
          reason: 'the stored ops inflow matches neither the pre- nor post-migration reconstruction'
        })
      }
      continue
    }
    const delta = afterOps - beforeOps
    if (delta !== 0n) receiptOpsDeltas.set(distribution.id, delta)
  }

  // -- Corrected ops snapshots ----------------------------------------------

  const afterPartialSummary = summarizeRewardsLedger({
    payouts: ledger.payouts,
    distributions: ledger.distributions,
    transactions: afterTransactions,
    scope
  })
  const provenSwept = new Map()
  for (const id of new Set([...beforeSummary.sweptByDistribution.keys(), ...afterPartialSummary.sweptByDistribution.keys()])) {
    provenSwept.set(id, afterPartialSummary.sweptByDistribution.get(id) ?? beforeSummary.sweptByDistribution.get(id) ?? 0n)
  }
  const correctedDistributions = rebuildOpsSnapshots(ledger.distributions, receiptOpsDeltas, provenSwept)
  const distributionById = new Map(ledger.distributions.map(row => [row.id, row]))
  for (const corrected of correctedDistributions) {
    const original = distributionById.get(corrected.id)
    if (!original) continue
    if (original.opsInflowPiconeros === corrected.opsInflowPiconeros &&
      original.opsRolledOverPiconeros === corrected.opsRolledOverPiconeros &&
      original.opsAvailablePiconeros === corrected.opsAvailablePiconeros) continue
    const operation = {
      kind: 'update',
      table: 'RewardDistribution',
      id: corrected.id,
      before: {
        opsInflowPiconeros: original.opsInflowPiconeros.toString(),
        opsRolledOverPiconeros: original.opsRolledOverPiconeros.toString(),
        opsAvailablePiconeros: original.opsAvailablePiconeros.toString()
      },
      after: {
        opsInflowPiconeros: corrected.opsInflowPiconeros.toString(),
        opsRolledOverPiconeros: corrected.opsRolledOverPiconeros.toString(),
        opsAvailablePiconeros: corrected.opsAvailablePiconeros.toString()
      },
      reason: 'ops-inflow-rebuild'
    }
    const proven = provenSwept.get(corrected.id) ?? 0n
    if (proven !== original.opsSweptPiconeros) {
      // The factual (de-duplicated, journal/ledger-proved) swept amount drives
      // the carry calculation; the recorded principal/hash fields are preserved
      // untouched and the distinction is auditable here.
      operation.sweepAccounting = {
        recordedPiconeros: original.opsSweptPiconeros.toString(),
        provenPiconeros: proven.toString(),
        recordedHash: original.opsSweepTxHash ?? null
      }
    }
    operations.push(operation)
  }

  // The first distribution's opening carry cannot be recomputed from anything
  // in the ledger: without verified provenance a nonzero value blocks APPLY.
  const firstDistribution = correctedDistributions.length > 0
    ? [...ledger.distributions].sort((a, b) => a.periodEnd - b.periodEnd || a.id - b.id)[0]
    : null
  if (firstDistribution &&
    firstDistribution.opsRolledOverPiconeros !== 0n &&
    opsCarryProvenance[firstDistribution.id]?.verified !== true) {
    issue('UNVERIFIED_FIRST_CARRY', {
      table: 'RewardDistribution',
      id: firstDistribution.id,
      opsRolledOverPiconeros: firstDistribution.opsRolledOverPiconeros.toString(),
      reason: 'the first row carry has no verified provenance'
    })
  }

  // -- Resulting totals (same Task 5/7 helpers) -----------------------------

  const afterSummary = summarizeRewardsLedger({
    payouts: ledger.payouts,
    distributions: correctedDistributions,
    transactions: afterTransactions,
    scope
  })

  const reserveFor = () => {
    const balances = Object.keys(evidence.balances.accounts).length > 0
      ? evidence.balances.accounts
      : { 0: evidence.balances.totalPiconeros ?? '0' }
    try {
      return standingReserve(balances, {
        feeHeadroom: amountOrNull(reserveInputs.feeHeadroomPiconeros) ?? 0n,
        dustFloor: amountOrNull(reserveInputs.dustFloorPiconeros) ?? 0n
      })
    } catch {
      issue('INVALID_RESERVE_INPUT', { reason: 'reserve inputs are not exact nonnegative amounts' })
      return 0n
    }
  }

  const walletTotal = amountOrNull(evidence.balances.totalPiconeros)
  const walletUnlocked = amountOrNull(evidence.balances.unlockedPiconeros) ?? 0n
  if (walletTotal == null) issue('MISSING_BALANCE_EVIDENCE', { reason: 'full total balance is required for the drift comparison' })

  const stateTotals = ({ receipts, downvotes, summary, distributionRows, deficit }) => {
    const allInflow = allocateInflow(rawFromReceipts(receipts, downvotes), config)
    const ledgerBalance = allInflow.totalPiconeros - summary.totalSentPiconeros - summary.totalNetworkFeesPiconeros
    const difference = walletTotal == null ? 0n : ledgerBalance - walletTotal
    const last = [...distributionRows].sort((a, b) => a.periodEnd - b.periodEnd || a.id - b.id).at(-1) ?? null
    const cycleStart = last?.periodEnd ?? null
    const inCycle = row => cycleStart != null && row.confirmedAt != null && row.confirmedAt >= cycleStart
    const cycleInflow = allocateInflow(
      rawFromReceipts(receipts.filter(inCycle), downvotes.filter(inCycle)),
      config
    )
    const carry = opsCarry({
      distribution: last,
      totalNetworkFeesPiconeros: summary.totalNetworkFeesPiconeros,
      provenSweptPiconeros: last ? (summary.sweptByDistribution.get(last.id) ?? 0n) : 0n
    })
    return {
      receiptsPiconeros: allInflow.totalPiconeros.toString(),
      rewardsPiconeros: allInflow.rewardsPiconeros.toString(),
      opsPiconeros: allInflow.opsPiconeros.toString(),
      totalSentPiconeros: summary.totalSentPiconeros.toString(),
      totalNetworkFeesPiconeros: summary.totalNetworkFeesPiconeros.toString(),
      outstandingRewardsPiconeros: summary.outstandingRewardsPiconeros.toString(),
      ledgerBalancePiconeros: ledgerBalance.toString(),
      walletTotalPiconeros: (walletTotal ?? 0n).toString(),
      unlockedPiconeros: walletUnlocked.toString(),
      differencePiconeros: difference.toString(),
      positiveDriftPiconeros: (difference > 0n ? difference : 0n).toString(),
      nextPoolPiconeros: (cycleInflow.rewardsPiconeros + (last?.rolledOverPiconeros ?? 0n)).toString(),
      opsPendingPiconeros: (carry + cycleInflow.opsPiconeros).toString(),
      reservePiconeros: reserveFor().toString(),
      fundingDeficitPiconeros: deficit.toString()
    }
  }

  const beforeTotals = stateTotals({
    receipts: analysisReceipts,
    downvotes: ledger.downvotes,
    summary: beforeSummary,
    distributionRows: ledger.distributions,
    deficit: 0n
  })
  const afterTotals = stateTotals({
    receipts: afterReceipts,
    downvotes: ledger.downvotes,
    summary: afterSummary,
    distributionRows: correctedDistributions,
    deficit: rewardFundingDeficit
  })

  // -- Immutable reward-contract fingerprint --------------------------------

  const protectedRewardsFingerprint = protectedRewardsFingerprintOf(ledger)

  // -- Reviewed decision + carry-provenance digest ---------------------------

  // Every reviewed input that can change the manifest's meaning — receipt
  // classifications, verified historical allocation terms, explicit per-row
  // allocations and first-carry provenance — is folded into the manifest via a
  // canonical safe projection, so changing e.g. a provenance source changes the
  // digest even when the resulting operations stay identical.
  const decisionsDigest = digestOf({
    receipts: Object.keys(decisions.receipts ?? {}).sort().map(txHash => {
      const decision = decisions.receipts[txHash] ?? {}
      return {
        txHash,
        feeType: decision.feeType ?? null,
        rewardsPiconeros: decimalOrNull(decision.rewardsPiconeros),
        recipientMajor: intOrNull(decision.recipientMajor),
        recipientMinor: intOrNull(decision.recipientMinor),
        confirmedAt: isoOrNull(decision.confirmedAt),
        height: intOrNull(decision.height),
        verified: decision.verified === true,
        donationRewardsPct: intOrNull(decision.donationRewardsPct)
      }
    }),
    periodConfigs: arrayOf(decisions.periodConfigs).map(entry => ({
      from: isoOrNull(entry?.from),
      to: isoOrNull(entry?.to),
      verified: entry?.verified === true,
      config: normalizeConfig(entry?.config)
    })),
    receiptAllocations: Object.keys(decisions.receiptAllocations ?? {}).sort().map(id => ({
      id,
      rewardsPiconeros: decimalOrNull(decisions.receiptAllocations[id]?.rewardsPiconeros)
    })),
    opsCarryProvenance: Object.keys(opsCarryProvenance).sort().map(id => ({
      id,
      verified: opsCarryProvenance[id]?.verified === true,
      source: typeof opsCarryProvenance[id]?.source === 'string' ? opsCarryProvenance[id].source : null
    }))
  })

  // -- Manifest assembly ----------------------------------------------------

  const sortedIssues = [...issues].sort((a, b) => {
    const ja = JSON.stringify(canonicalValue(a))
    const jb = JSON.stringify(canonicalValue(b))
    return ja < jb ? -1 : ja > jb ? 1 : 0
  })
  const sortedOperations = [...operations, ...settlementOps].sort((a, b) => {
    const ja = JSON.stringify(canonicalValue(a))
    const jb = JSON.stringify(canonicalValue(b))
    return ja < jb ? -1 : ja > jb ? 1 : 0
  })

  const manifest = {
    version: 2,
    accountingFingerprintVersion: ACCOUNTING_FINGERPRINT_VERSION,
    scope,
    boundary,
    evidenceDigest,
    // The SHARED v2 audit identity over the COMPLETE raw snapshot input the
    // builder consumed (rewards reconciliation Task 1; final-review I3) —
    // never a union money digest and never a filtered working set.
    ledgerFingerprint: accountingAuditFingerprint({
      scope: input.scope,
      ledger: input.ledger,
      config: input.config,
      reserve: input.reserve
    }),
    protectedRewardsFingerprint,
    preconditionFingerprint: ledgerPreconditionFingerprint(input.ledger, config),
    decisionsDigest,
    issues: sortedIssues,
    operations: sortedOperations,
    before: { ...beforeTotals, protectedRewardsFingerprint },
    after: { ...afterTotals, protectedRewardsFingerprint },
    digest: null
  }
  manifest.digest = manifestDigest(manifest)
  return manifest
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Validate one journal fact against the recorded ledger. Every conflict a
// repair might otherwise rely on becomes an exact material issue:
//   - unknown kind/state, unreadable principal, missing proven fee;
//   - PAYOUT members must be readable, unique, sum to the principal, name an
//     existing recorded payout, and match that payout's address/amount (and an
//     already-recorded different hash);
//   - OPS_SWEEP destination semantics and recorded ownership;
//   - CONSOLIDATION self-transfer semantics and zero principal.
function validateJournalFact ({ row, payoutsById, sweepHashOwners, scope, issue }) {
  if (!['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'].includes(row.kind) ||
    !['PREPARED', 'RELAYED', 'NOT_RELAYED'].includes(row.state)) {
    issue('INVALID_JOURNAL_ROW', { txHash: row.txHash, kind: row.kind, state: row.state })
    return
  }
  if (row.principalPiconeros == null) {
    issue('INVALID_JOURNAL_ROW', { txHash: row.txHash, reason: 'unreadable journal principal' })
  }
  // A NULL persisted fee for a RELAYED row is NOT material when owned confirmed
  // history proves the actual fee: the outgoing pass emits the exact correction
  // operation instead. When no owned history can prove it, that same pass emits
  // MISSING_OUTGOING_FEE (unreadable) or JOURNAL_ROW_NOT_ON_CHAIN (absent).

  if (row.kind === 'PAYOUT') {
    const members = row.metadata?.payouts
    if (!Array.isArray(members) || members.length === 0) {
      issue('JOURNAL_METADATA_INVALID', { txHash: row.txHash, reason: 'payout members are unreadable' })
      return
    }
    const seen = new Set()
    let sum = 0n
    for (const member of members) {
      const payoutId = intOrNull(member?.payoutId)
      const address = typeof member?.recipientAddress === 'string' && member.recipientAddress !== '' ? member.recipientAddress : null
      const amount = amountOrNull(member?.piconeros)
      if (payoutId == null || payoutId <= 0 || address == null || amount == null) {
        issue('JOURNAL_METADATA_INVALID', { txHash: row.txHash, reason: 'a payout member is unreadable' })
        return
      }
      if (seen.has(payoutId)) {
        issue('JOURNAL_MEMBER_MISMATCH', { txHash: row.txHash, payoutId, reason: 'duplicate payout member id' })
        return
      }
      seen.add(payoutId)
      sum += amount
      const recorded = payoutsById.get(payoutId)
      if (!recorded) {
        issue('JOURNAL_MEMBER_UNKNOWN', { txHash: row.txHash, payoutId, reason: 'journal member has no recorded payout row' })
        return
      }
      if (recorded.recipientAddress !== address || recorded.piconeros !== amount) {
        issue('JOURNAL_MEMBER_MISMATCH', { txHash: row.txHash, payoutId, reason: 'journal member does not match the recorded payout' })
        return
      }
      if (recorded.distributionId != null && row.distributionId != null && recorded.distributionId !== row.distributionId) {
        issue('JOURNAL_MEMBER_MISMATCH', {
          txHash: row.txHash,
          payoutId,
          reason: 'recorded payout belongs to a different distribution than the journal row'
        })
        return
      }
      if (recorded.txHash != null && recorded.txHash !== row.txHash) {
        issue('JOURNAL_MEMBER_MISMATCH', { txHash: row.txHash, payoutId, reason: 'recorded payout already carries a different transaction hash' })
        return
      }
    }
    if (row.principalPiconeros != null && sum !== row.principalPiconeros) {
      issue('JOURNAL_MEMBER_MISMATCH', { txHash: row.txHash, reason: 'journal members do not sum to the journal principal' })
    }
    return
  }

  if (row.kind === 'OPS_SWEEP') {
    if (typeof row.metadata?.destination !== 'string' || row.metadata.destination === '') {
      issue('JOURNAL_METADATA_INVALID', { txHash: row.txHash, reason: 'sweep destination is unreadable' })
      return
    }
    const owners = sweepHashOwners.get(row.txHash)
    if (owners && row.distributionId != null && !owners.includes(row.distributionId)) {
      issue('SWEEP_OWNERSHIP_MISMATCH', {
        txHash: row.txHash,
        distributionId: row.distributionId,
        distributionIds: owners,
        reason: 'the journal sweep declares a distribution that does not own the recorded hash'
      })
    }
    return
  }

  // CONSOLIDATION
  if (row.principalPiconeros != null && row.principalPiconeros !== 0n) {
    issue('JOURNAL_METADATA_INVALID', { txHash: row.txHash, reason: 'consolidation principal must be zero' })
  }
  if (row.metadata?.selfTransfer !== true || row.metadata?.destination !== scope.walletAddress) {
    issue('JOURNAL_METADATA_INVALID', { txHash: row.txHash, reason: 'consolidation must be a self transfer to the wallet primary address' })
  }
}

function distributionForTime (distributions, time) {
  if (time == null) return null
  return distributions.find(distribution =>
    distribution.periodStart != null && distribution.periodEnd != null &&
    time >= distribution.periodStart && time < distribution.periodEnd) ?? null
}

function configForTime (decisions, time) {
  for (const entry of arrayOf(decisions.periodConfigs)) {
    if (entry?.verified !== true) continue
    const from = msOrNull(entry.from)
    const to = msOrNull(entry.to)
    if (from == null || to == null || time == null || time < from || time >= to) continue
    return normalizeConfig(entry.config)
  }
  return null
}

// Verified historical terms covering a WHOLE distribution period. Partial
// overlap is not enough to reconstruct that period's allocation.
function configForDistribution (decisions, distribution) {
  for (const entry of arrayOf(decisions.periodConfigs)) {
    if (entry?.verified !== true) continue
    const from = msOrNull(entry.from)
    const to = msOrNull(entry.to)
    if (from == null || to == null || distribution.periodStart == null || distribution.periodEnd == null) continue
    if (from <= distribution.periodStart && to >= distribution.periodEnd) return normalizeConfig(entry.config)
  }
  return null
}

// Resolve a historical receipt's reward/ops split under verified ORIGINAL
// terms: an explicit reviewed allocation decision wins; otherwise a verified
// period config supplies the source's percentage. Returns null when neither
// exists — the caller refuses to correct rather than use today's config.
function allocationForHistoricalSource (receipt, config, decisions, amount) {
  const explicit = decisions.receiptAllocations?.[receipt.id]
  if (explicit && amountOrNull(explicit.rewardsPiconeros) != null) {
    const rewards = amountOrNull(explicit.rewardsPiconeros)
    if (rewards > amount) return null
    return { rewards, ops: amount - rewards }
  }
  const periodConfig = configForTime(decisions, receipt.confirmedAt)
  if (!periodConfig) return null
  const key = PERCENT_CONFIG_KEY[receipt.feeType]
  if (!key) return null
  const rewards = amount * BigInt(periodConfig[key]) / 100n
  return { rewards, ops: amount - rewards }
}

// Build one verified receipt correction (amount and/or exact split). Returns
// null when nothing needs repairing, or `{ unverified }` when the repair
// cannot be derived from verified terms.
function buildReceiptCorrection ({ receipt, newAmount, itemsById, bountyPaymentsByHash, decisions, config }) {
  const result = {
    receipt,
    operation: null,
    afterRow: {},
    beforeRewards: 0n,
    afterRewards: 0n
  }
  if (receipt.feeType === 'BOUNTY_ROLLOVER') {
    const payment = bountyPaymentsByHash.get(receipt.txHash)
    const item = payment?.itemId != null ? itemsById.get(payment.itemId) : null
    const bookedPrize = item?.bountyPiconeros
    if (bookedPrize == null) {
      return { ...result, unverified: 'UNVERIFIED_ROLLOVER_SPLIT' }
    }
    const rewards = bookedPrize < newAmount ? bookedPrize : newAmount
    const amountChanged = receipt.piconeros !== newAmount
    // NULL means the legacy read books the FULL amount as rewards, so it is
    // always a split needing repair (to the exact frozen-prize component).
    const splitChanged = receipt.rewardsPiconeros == null || receipt.rewardsPiconeros !== rewards
    if (!amountChanged && !splitChanged) return null
    const before = {}
    const after = {}
    if (amountChanged) {
      before.piconeros = receipt.piconeros.toString()
      after.piconeros = newAmount.toString()
    }
    if (splitChanged) {
      before.rewardsPiconeros = decimalOrNull(receipt.rewardsPiconeros)
      after.rewardsPiconeros = rewards.toString()
    }
    result.operation = {
      kind: 'update',
      table: 'FeeObservation',
      id: receipt.id,
      before,
      after,
      reason: amountChanged ? 'chain-verified-receipt-amount' : 'chain-verified-rollover-split'
    }
    if (amountChanged) result.afterRow.piconeros = newAmount
    if (splitChanged) result.afterRow.rewardsPiconeros = rewards
    result.beforeRewards = receipt.rewardsPiconeros ?? receipt.piconeros
    result.afterRewards = rewards
    return result
  }
  if (receipt.piconeros === newAmount) return null
  if (receipt.feeType === 'BOUNTY_FEE') {
    result.operation = {
      kind: 'update',
      table: 'FeeObservation',
      id: receipt.id,
      before: { piconeros: receipt.piconeros.toString() },
      after: { piconeros: newAmount.toString() },
      reason: 'chain-verified-receipt-amount'
    }
    result.afterRow = { piconeros: newAmount }
    return result
  }
  const allocation = receipt.feeType === 'DONATE'
    ? { rewards: newAmount * BigInt(receipt.donationRewardsPct ?? 100) / 100n }
    : allocationForHistoricalSource({ ...receipt, piconeros: newAmount }, config, decisions, newAmount)
  if (allocation == null) return { ...result, unverified: 'UNVERIFIED_ALLOCATION' }
  const beforeAllocation = receipt.feeType === 'DONATE'
    ? { rewards: receipt.piconeros * BigInt(receipt.donationRewardsPct ?? 100) / 100n }
    : allocationForHistoricalSource(receipt, config, decisions, receipt.piconeros)
  if (beforeAllocation == null) return { ...result, unverified: 'UNVERIFIED_ALLOCATION' }
  result.operation = {
    kind: 'update',
    table: 'FeeObservation',
    id: receipt.id,
    before: { piconeros: receipt.piconeros.toString() },
    after: { piconeros: newAmount.toString() },
    reason: 'chain-verified-receipt-amount'
  }
  result.afterRow = { piconeros: newAmount }
  result.beforeRewards = beforeAllocation.rewards
  result.afterRewards = allocation.rewards
  return result
}

// Build one operator-classified missing receipt. The decision must bind the
// source, reward split, receiving index, chain height and a VERIFIED timestamp
// from evidence, and the requested split must be exactly what the source's
// downstream allocation books (a BOUNTY_FEE is 100% ops, a donation uses its
// percentage, a rollover uses the frozen booked prize, a percentage source uses
// the current allocation config) — any contradiction is refused.
function buildInsertedReceipt ({ entry, decision, issue, context }) {
  const incomplete = reason => {
    issue('INCOMPLETE_CLASSIFICATION', { txHash: entry.txHash, reason })
    return null
  }
  const feeType = typeof decision.feeType === 'string' ? decision.feeType : null
  const rewards = amountOrNull(decision.rewardsPiconeros)
  const amount = amountOrNull(entry.amountPiconeros)
  const recipientMajor = intOrNull(decision.recipientMajor)
  const recipientMinor = intOrNull(decision.recipientMinor)
  const confirmedAt = isoOrNull(decision.confirmedAt)
  if (feeType == null || !SOURCE_BY_FEE_TYPE[feeType]) return incomplete('the classification source is not a supported fee type')
  if (amount == null) return incomplete('the wallet output amount is unreadable')
  if (rewards == null || rewards < 0n || rewards > amount) return incomplete('the reward split must be an exact amount within the receipt')
  if (recipientMajor == null || recipientMinor == null ||
    recipientMajor !== entry.accountIndex || recipientMinor !== entry.subaddressIndex) {
    return incomplete('the receiving index must match the chain evidence')
  }
  if (confirmedAt == null) return incomplete('the confirmedAt must be a valid timestamp')
  if (decision.verified !== true) return incomplete('the classification must be explicitly verified')
  if (decision.height != null && intOrNull(decision.height) !== entry.height) {
    return incomplete('the classification height must match the chain evidence')
  }
  const expectedRewards = classificationRewards({ feeType, amount, decision, entry, context })
  if (expectedRewards == null) return incomplete('the reward split cannot be derived from verified source terms')
  if (expectedRewards !== rewards) {
    return incomplete(`the ${feeType} source books ${expectedRewards} piconeros to rewards, not the requested ${rewards}`)
  }
  const height = intOrNull(decision.height) ?? entry.height
  const afterRow = {
    id: entry.txHash,
    txHash: entry.txHash,
    feeType,
    walletReceipt: true,
    state: 'CONFIRMED',
    piconeros: amount,
    rewardsPiconeros: rewards,
    donationRewardsPct: intOrNull(decision.donationRewardsPct),
    recipientMajor,
    recipientMinor,
    height,
    confirmedAt: new Date(confirmedAt).getTime(),
    postId: intOrNull(decision.postId),
    payInId: null
  }
  const operation = {
    kind: 'insert',
    table: 'FeeObservation',
    key: { txHash: entry.txHash, recipientMajor, recipientMinor },
    before: null,
    after: {
      txHash: entry.txHash,
      feeType,
      piconeros: amount.toString(),
      rewardsPiconeros: rewards.toString(),
      walletReceipt: true,
      state: 'CONFIRMED',
      recipientMajor,
      recipientMinor,
      height,
      confirmedAt,
      payInId: null,
      postId: afterRow.postId,
      subName: null,
      donationRewardsPct: afterRow.donationRewardsPct
    },
    reason: 'operator-classified-inbound'
  }
  return {
    receipt: afterRow,
    operation,
    afterRow,
    beforeRewards: 0n,
    afterRewards: rewards
  }
}

// The exact rewards component the reader/allocation will book for a classified
// source, or null when it cannot be derived from verified terms. Percentage
// sources are HISTORICAL allocation facts: they must match the verified terms
// of the period containing the decision's confirmedAt — today's config is
// never a substitute (fail closed when no verified historical terms exist).
function classificationRewards ({ feeType, amount, decision, entry, context }) {
  if (feeType === 'BOUNTY_FEE') return 0n
  if (feeType === 'DONATE') {
    const pct = decision.donationRewardsPct == null ? 100n : BigInt(intOrNull(decision.donationRewardsPct) ?? -1)
    if (pct < 0n || pct > 100n) return null
    return amount * pct / 100n
  }
  if (feeType === 'BOUNTY_ROLLOVER') {
    const payment = context.bountyPaymentsByHash.get(entry.txHash)
    const item = payment?.itemId != null ? context.itemsById.get(payment.itemId) : null
    const bookedPrize = item?.bountyPiconeros
    if (bookedPrize == null) return null
    return bookedPrize < amount ? bookedPrize : amount
  }
  const key = PERCENT_CONFIG_KEY[feeType]
  if (!key) return null
  const confirmedAt = msOrNull(decision.confirmedAt)
  const distribution = distributionForTime(context.distributions, confirmedAt)
  if (!distribution) return null
  const periodConfig = configForDistribution(context.decisions, distribution)
  if (!periodConfig) return null
  return amount * BigInt(periodConfig[key]) / 100n
}

// Recover one BountyPayment's frozen settlement facts from the escrow wallet's
// OWN outgoing history (never today's env). Returns an operation or null.
function recoverSettlement ({ payment, leg, escrowOutgoingByHash, scope, issue }) {
  const before = {}
  const after = {}
  const record = (field, beforeValue, afterValue) => {
    const normalize = value => (value == null ? null : typeof value === 'bigint' ? value.toString() : value)
    if (normalize(beforeValue) === normalize(afterValue)) return
    before[field] = normalize(beforeValue)
    after[field] = normalize(afterValue)
  }
  const legFee = amountOrNull(leg.feePiconeros)
  const destinations = leg.destinations
  if (legFee == null || destinations.some(destination => destination.address == null || destination.amountPiconeros == null)) {
    issue('MISSING_SETTLEMENT_EVIDENCE', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'escrow history settlement facts are unreadable' })
    return null
  }
  const finish = () => {
    if (Object.keys(after).length === 0) return null
    return {
      kind: 'update',
      table: 'BountyPayment',
      id: payment.id,
      before,
      after,
      reason: 'escrow-history-settlement'
    }
  }

  if (payment.kind === 'ROLLOVER' || payment.feePiconeros === 0n) {
    if (destinations.length !== 1 || destinations[0].address !== payment.recipientAddress) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'escrow settlement does not match the frozen single destination' })
      return null
    }
    const received = BigInt(destinations[0].amountPiconeros)
    if (payment.piconeros != null && received + legFee !== payment.piconeros) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'escrow settlement does not sum to the consumed amount' })
      return null
    }
    record('networkFeePiconeros', payment.networkFeePiconeros, legFee)
    record('recipientReceivedPiconeros', payment.recipientReceivedPiconeros, received)
    record('feeReceivedPiconeros', payment.feeReceivedPiconeros, 0n)
    return finish()
  }

  if (payment.feeTxHash != null) {
    // Legacy deferred fee (pre-2026-09-18): the payout tx pays ONLY the prize,
    // and the separate feeTxHash leg carries the frozen fee. Each leg's miner
    // fee is an extra escrow cost (no subtractFeeFrom), so each destination
    // receives its full booked amount — there is no combined sum to check.
    if (destinations.length !== 1 || destinations[0].address !== payment.recipientAddress) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'legacy prize leg does not match the frozen recipient destination' })
      return null
    }
    const received = BigInt(destinations[0].amountPiconeros)
    if (payment.piconeros != null && received !== payment.piconeros) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'legacy prize leg does not match the booked prize' })
      return null
    }
    record('networkFeePiconeros', payment.networkFeePiconeros, legFee)
    record('recipientReceivedPiconeros', payment.recipientReceivedPiconeros, received)
    const feeLeg = escrowOutgoingByHash.get(payment.feeTxHash)
    const feeDestination = feeLeg?.destinations?.length === 1 ? feeLeg.destinations[0] : null
    if (!feeDestination || feeDestination.address == null || feeDestination.amountPiconeros == null || amountOrNull(feeLeg.feePiconeros) == null) {
      if (payment.feeReceivedPiconeros == null || payment.feeSettlementNetworkFeePiconeros == null) {
        issue('MISSING_SETTLEMENT_EVIDENCE', { table: 'BountyPayment', id: payment.id, txHash: payment.feeTxHash, reason: 'legacy fee-leg settlement evidence is missing' })
      }
      return finish()
    }
    if (payment.feeRecipientAddress != null && payment.feeRecipientAddress !== feeDestination.address) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.feeTxHash, reason: 'the frozen fee destination disagrees with escrow history' })
      return null
    }
    if (BigInt(feeDestination.amountPiconeros) !== payment.feePiconeros) {
      issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.feeTxHash, reason: 'legacy fee leg does not match the frozen fee' })
      return null
    }
    record('feeRecipientAddress', payment.feeRecipientAddress, feeDestination.address)
    record('feeReceivedPiconeros', payment.feeReceivedPiconeros, BigInt(feeDestination.amountPiconeros))
    record('feeSettlementNetworkFeePiconeros', payment.feeSettlementNetworkFeePiconeros, amountOrNull(feeLeg.feePiconeros))
    return finish()
  }

  const prize = destinations.find(destination => destination.address === payment.recipientAddress)
  const others = destinations.filter(destination => destination.address !== payment.recipientAddress)
  if (!prize || others.length !== 1) {
    issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'prize and fee destinations cannot be attributed' })
    return null
  }
  const feeDestination = others[0]
  if (payment.feeRecipientAddress != null && payment.feeRecipientAddress !== feeDestination.address) {
    issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, reason: 'the frozen fee destination disagrees with escrow history' })
    return null
  }
  const prizeAmount = BigInt(prize.amountPiconeros)
  const feeAmount = BigInt(feeDestination.amountPiconeros)
  const consumed = (payment.piconeros ?? 0n) + payment.feePiconeros
  if (payment.piconeros != null && prizeAmount + feeAmount + legFee !== consumed) {
    issue('SETTLEMENT_MISMATCH', { table: 'BountyPayment', id: payment.id, txHash: payment.txHash, reason: 'escrow settlement does not sum to the consumed amount' })
    return null
  }
  record('feeRecipientAddress', payment.feeRecipientAddress, feeDestination.address)
  record('networkFeePiconeros', payment.networkFeePiconeros, legFee)
  record('recipientReceivedPiconeros', payment.recipientReceivedPiconeros, prizeAmount)
  record('feeReceivedPiconeros', payment.feeReceivedPiconeros, feeAmount)
  return finish()
}

// ---------------------------------------------------------------------------
// Apply preconditions (Task 13)
// ---------------------------------------------------------------------------

// The immutable reward-contract fingerprint embedded in every manifest and
// re-checked before an apply: recipient rows (address/amount/state/hash), the
// reward-side distribution totals and every Earn row. Extracted so the builder
// and the apply comparator run the SAME projection.
function protectedRewardsFingerprintOf (ledger) {
  return digestOf({
    payouts: ledger.payouts
      .map(payout => ({
        id: payout.id,
        distributionId: payout.distributionId,
        recipientAddress: payout.recipientAddress,
        piconeros: decimalOrNull(payout.piconeros),
        txHash: payout.txHash,
        state: payout.state
      }))
      .sort(sortByNumberedId),
    distributions: ledger.distributions
      .map(distribution => ({
        id: distribution.id,
        poolPiconeros: decimalOrNull(distribution.poolPiconeros),
        distributedPiconeros: decimalOrNull(distribution.distributedPiconeros),
        rolledOverPiconeros: decimalOrNull(distribution.rolledOverPiconeros)
      }))
      .sort(sortByNumberedId),
    earns: ledger.earns
      .map(earn => ({ id: earn.id, userId: earn.userId, distributionId: earn.distributionId, piconeros: decimalOrNull(earn.piconeros) }))
      .sort(sortByNumberedId)
  })
}

// The COMPLETE approved precondition projection: every normalized ledger row the
// builder consumes plus the fee-allocation config. Money becomes exact decimal
// strings so the projection (and its digest) is JSON/audit safe. Re-normalizing
// through the same `normalizeLedger`/`normalizeConfig` path keeps the build-time
// and apply-time fingerprints identical for identical rows.
function ledgerPreconditionView (ledger, config) {
  const normalized = normalizeLedger(ledger)
  const amount = value => decimalOrNull(value)
  return {
    receipts: normalized.receipts.map(row => ({
      ...row,
      piconeros: amount(row.piconeros),
      rewardsPiconeros: amount(row.rewardsPiconeros)
    })),
    downvotes: normalized.downvotes.map(row => ({ ...row, piconeros: amount(row.piconeros) })),
    payouts: normalized.payouts.map(row => ({ ...row, piconeros: amount(row.piconeros) })),
    distributions: normalized.distributions.map(row => ({
      id: row.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      poolPiconeros: amount(row.poolPiconeros),
      distributedPiconeros: amount(row.distributedPiconeros),
      rolledOverPiconeros: amount(row.rolledOverPiconeros),
      opsInflowPiconeros: amount(row.opsInflowPiconeros),
      opsRolledOverPiconeros: amount(row.opsRolledOverPiconeros),
      opsAvailablePiconeros: amount(row.opsAvailablePiconeros),
      opsSweptPiconeros: amount(row.opsSweptPiconeros),
      opsSweepTxHash: row.opsSweepTxHash,
      opsNetworkFeesAccountedPiconeros: amount(row.opsNetworkFeesAccountedPiconeros)
    })),
    transactions: normalized.transactions.map(row => ({
      ...row,
      principalPiconeros: amount(row.principalPiconeros),
      networkFeePiconeros: amount(row.networkFeePiconeros)
    })),
    bountyPayments: normalized.bountyPayments.map(row => ({
      ...row,
      piconeros: amount(row.piconeros),
      feePiconeros: amount(row.feePiconeros),
      networkFeePiconeros: amount(row.networkFeePiconeros),
      recipientReceivedPiconeros: amount(row.recipientReceivedPiconeros),
      feeReceivedPiconeros: amount(row.feeReceivedPiconeros),
      feeSettlementNetworkFeePiconeros: amount(row.feeSettlementNetworkFeePiconeros)
    })),
    observedBounties: normalized.observedBounties.map(row => ({ ...row })),
    observedBountyReceipts: normalized.observedBountyReceipts.map(row => ({ ...row })),
    items: normalized.items.map(row => ({ id: row.id, bountyPiconeros: amount(row.bountyPiconeros), bountyFeePiconeros: amount(row.bountyFeePiconeros) })),
    earns: normalized.earns.map(row => ({ ...row, piconeros: amount(row.piconeros) })),
    // v2 snapshot groups (rewards reconciliation Task 2): the complete
    // precondition now also binds the escrow journal, the declared-proof
    // inventory, the proven wallet identities/subaddresses and the audited
    // reserve inputs. Money becomes exact decimal strings; dates canonicalize
    // to the same ISO instant for Prisma Dates and ISO strings alike.
    escrowTransactions: arrayOf(ledger.escrowTransactions).map(row => ({
      id: numericId(row?.id),
      network: stringOrNull(row?.network),
      walletAddress: stringOrNull(row?.walletAddress),
      txHash: normalizeHash(row?.txHash),
      dispatchId: stringOrNull(row?.dispatchId),
      proofId: stringOrNull(row?.proofId),
      captureContractVersion: intOrNull(row?.captureContractVersion),
      claimDigest: normalizeHash(row?.claimDigest),
      paymentClaims: row?.paymentClaims ?? null,
      kind: stringOrNull(row?.kind),
      leg: stringOrNull(row?.leg),
      bountyPaymentId: intOrNull(row?.bountyPaymentId),
      itemId: intOrNull(row?.itemId),
      accountIndex: intOrNull(row?.accountIndex),
      principalPiconeros: amount(row?.principalPiconeros),
      networkFeePiconeros: amount(row?.networkFeePiconeros),
      metadata: row?.metadata ?? null,
      state: stringOrNull(row?.state),
      preparedAt: isoOrNull(row?.preparedAt),
      relayAttemptedAt: isoOrNull(row?.relayAttemptedAt),
      relayedAt: isoOrNull(row?.relayedAt),
      relayProvenance: stringOrNull(row?.relayProvenance)
    })),
    proofInventory: arrayOf(ledger.proofInventory).map(entry => ({
      owner: {
        journalRole: stringOrNull(entry?.owner?.journalRole),
        journalId: numericId(entry?.owner?.journalId)
      },
      reference: {
        txHash: normalizeHash(entry?.reference?.txHash),
        kind: stringOrNull(entry?.reference?.kind),
        dispatchId: stringOrNull(entry?.reference?.dispatchId),
        leg: stringOrNull(entry?.reference?.leg),
        bountyPaymentId: intOrNull(entry?.reference?.bountyPaymentId),
        itemId: intOrNull(entry?.reference?.itemId)
      },
      proof: entry?.proof == null
        ? null
        : {
            proofId: stringOrNull(entry.proof.proofId),
            revision: intOrNull(entry.proof.revision),
            masterKeyVersion: intOrNull(entry.proof.masterKeyVersion),
            bindingVersion: intOrNull(entry.proof.bindingVersion),
            envelopeVersion: intOrNull(entry.proof.envelopeVersion),
            payloadVersion: intOrNull(entry.proof.payloadVersion),
            claimDigest: normalizeHash(entry.proof.claimDigest),
            bindingDigest: normalizeHash(entry.proof.bindingDigest),
            envelopeIntegrityDigest: normalizeHash(entry.proof.envelopeIntegrityDigest)
          }
    })),
    accounts: arrayOf(ledger.accounts).map(row => ({
      id: numericId(row?.id),
      label: stringOrNull(row?.label),
      network: stringOrNull(row?.network),
      address: stringOrNull(row?.address)
    })).filter(row => row.id != null),
    subaddresses: arrayOf(ledger.subaddresses).map(row => ({
      id: numericId(row?.id),
      accountId: numericId(row?.accountId),
      majorIndex: intOrNull(row?.majorIndex),
      minorIndex: intOrNull(row?.minorIndex),
      address: stringOrNull(row?.address),
      state: stringOrNull(row?.state)
    })).filter(row => row.id != null),
    reserve: {
      feeHeadroomPiconeros: decimalOrNull(ledger.reserve?.feeHeadroomPiconeros),
      dustFloorPiconeros: decimalOrNull(ledger.reserve?.dustFloorPiconeros)
    },
    config: normalizeConfig(config)
  }
}

// Complete approved-precondition fingerprint. Embedded in the manifest at build
// time and recomputed from a fresh scoped read before any apply: any new or
// changed observation, journal transaction, reward-contract row, item term,
// fee-config value, escrow fact, declared proof, wallet identity/subaddress or
// audited reserve input changes it and refuses the apply.
export function ledgerPreconditionFingerprint (ledger, config) {
  return digestOf(ledgerPreconditionView(ledger, config))
}

// The STABLE chain facts a rescan must still prove: scope, derivation, restore
// provenance, the full total balance, every CONFIRMED incoming/outgoing fact,
// every PENDING bridge proof (escrow included) and every nested ESCROW
// payment-verification fact. Tip heights, block hashes, confirmation counts
// and locked/unlocked balances are deliberately excluded — they legitimately
// move while the chain advances — but adding, removing or changing any
// confirmed fact, any pending attempt/proof OR any collected escrow verifier
// fact the approved manifest may rely on is an incompatible rescan: the CLI
// refuses and requires a new manifest/review (final-review I2). Verification
// facts enter through #1's stable-facts projection so advancing confirmation
// counts and the later recheck time never enter; an entry that is not a safe
// PaymentVerificationV1 result is retained as an explicit invalid marker so
// garbage can never silently alias a real fact.
function chainIncomingFact (entry) {
  return {
    txHash: entry.txHash,
    accountIndex: entry.accountIndex,
    subaddressIndex: entry.subaddressIndex,
    amountPiconeros: entry.amountPiconeros,
    height: entry.height,
    fromOwnTransaction: entry.fromOwnTransaction,
    isSelfTransfer: entry.isSelfTransfer
  }
}

function chainOutgoingFact (entry) {
  return {
    txHash: entry.txHash,
    accountIndex: entry.accountIndex,
    feePiconeros: entry.feePiconeros,
    destinations: entry.destinations,
    height: entry.height,
    isRelayed: entry.isRelayed,
    isSelfTransfer: entry.isSelfTransfer,
    relayState: entry.relayState
  }
}

function chainPendingIncomingFact (entry) {
  return {
    txHash: entry.txHash,
    accountIndex: entry.accountIndex,
    subaddressIndex: entry.subaddressIndex,
    amountPiconeros: entry.amountPiconeros,
    inTxPool: entry.inTxPool,
    isConfirmed: entry.isConfirmed
  }
}

function chainPendingOutgoingFact (entry) {
  return {
    txHash: entry.txHash,
    accountIndex: entry.accountIndex,
    feePiconeros: entry.feePiconeros,
    destinations: entry.destinations,
    inTxPool: entry.inTxPool,
    isConfirmed: entry.isConfirmed,
    isRelayed: entry.isRelayed,
    isSelfTransfer: entry.isSelfTransfer,
    relayState: entry.relayState
  }
}

// Stable verifier-fact projection of a collected verification list. A valid
// result projects through #1's `paymentVerificationFacts` (versions, surviving
// digest, boundary, advancing confirmation counts and observation time
// excluded); anything else keeps an explicit invalid marker — a changed or
// garbled nested fact can never alias the approved fact it replaces.
function chainVerificationFact (entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
    !validatePaymentVerification(entry)) {
    return { paymentVerificationInvalid: true }
  }
  return paymentVerificationFacts(entry)
}

export function chainFactsFingerprint (evidence) {
  const normalized = normalizeEvidence(evidence)
  const confirmed = entry => entry.isConfirmed && !entry.inTxPool
  return digestOf({
    scope: normalized.scope,
    derivation: normalized.derivation,
    restoreHeight: normalized.restoreHeight,
    restoreProvenance: normalized.restoreProvenance,
    firstActivityHeight: normalized.firstActivityHeight,
    totalBalancePiconeros: normalized.balances.totalPiconeros,
    incoming: normalized.incoming.filter(confirmed).map(chainIncomingFact),
    outgoing: normalized.outgoing.filter(confirmed).map(chainOutgoingFact),
    pendingIncoming: normalized.bridge.pendingIncoming.map(chainPendingIncomingFact),
    pendingOutgoing: normalized.bridge.pendingOutgoing.map(chainPendingOutgoingFact),
    escrow: normalized.escrow
      ? {
          walletAddress: normalized.escrow.walletAddress,
          derivation: normalized.escrow.derivation,
          incoming: normalized.escrow.incoming.filter(confirmed).map(chainIncomingFact),
          outgoing: normalized.escrow.outgoing.filter(confirmed).map(chainOutgoingFact),
          pendingIncoming: normalized.escrow.bridge.pendingIncoming.map(chainPendingIncomingFact),
          pendingOutgoing: normalized.escrow.bridge.pendingOutgoing.map(chainPendingOutgoingFact),
          paymentVerificationFacts: normalized.escrow.paymentVerifications.map(chainVerificationFact)
        }
      : null
  })
}

// Shared relay-proof validation (manifest builder + apply dispatcher): does the
// CONFIRMED owned outgoing `entry` prove the recorded journal `row`'s exact
// facts? Returns null when proved, else a reason string. `row` carries
// { kind, metadata, principalPiconeros }; `entry` is a normalized outgoing
// evidence entry (decimal-string destination amounts); `ownedAddresses` must
// contain every wallet-owned address (primary + derived) for consolidation
// self-transfer checks. The builder uses this to classify relays; the apply
// dispatcher uses the SAME check to refuse an unproved PREPARED -> RELAYED
// journal-state transition.
export function journalRelayEvidenceMismatch ({ row, entry, scope, ownedAddresses }) {
  const destinations = arrayOf(entry?.destinations).map(destination => (destination.amountPiconeros == null
    ? destination
    : { address: destination.address, amount: BigInt(destination.amountPiconeros) }))
  if (row?.kind === 'PAYOUT') {
    const members = Array.isArray(row.metadata?.payouts) ? row.metadata.payouts : null
    if (!members || members.length === 0) return 'unreadable payout members'
    let expected
    try {
      expected = members.map(member => ({ address: member.recipientAddress, amount: BigInt(member.piconeros) }))
    } catch {
      return 'unreadable payout member amount'
    }
    return multisetMatches(expected, destinations) ? null : 'payout destinations do not match the journal members'
  }
  if (row?.kind === 'OPS_SWEEP') {
    const destination = row.metadata?.destination
    if (typeof destination !== 'string' || destination === '') return 'unreadable sweep destination'
    if (destinations.length !== 1 || destinations[0].address !== destination ||
      destinations[0].amount !== (row.principalPiconeros ?? 0n)) {
      return 'sweep destinations do not match the journal fact'
    }
    return null
  }
  if (row?.kind === 'CONSOLIDATION') {
    const destination = row.metadata?.destination
    if (typeof destination !== 'string' || destination === '') return 'unreadable consolidation destination'
    if (row.metadata?.selfTransfer !== true || destination !== scope?.walletAddress) return 'consolidation is not a self transfer'
    if (destinations.length === 0 || !destinations.every(candidate => ownedAddresses?.has(candidate.address))) {
      return 'consolidation destinations are not all wallet-owned'
    }
    return null
  }
  return 'unknown journal kind'
}

// Safe field reader for the build/apply precondition comparison. ONE delegated
// read through the shared v2 audit snapshot (rewards reconciliation Task 1):
// the exact same scoped selects, registered-identity proof and proof-inventory
// reads the audit uses, so the repair path can never consume a different set
// of facts than the audit fingerprinted. Returns the COMPLETE snapshot groups
// (including the escrow journal, identity rows, subaddresses and proof
// inventory), the fee config, the audited reserve inputs and the snapshot's
// `accounting:v2:` fingerprint — the SAME full identity the audit and the
// public ledger reader fingerprint (final-review I3: the snapshot is the
// fingerprint/precondition authority and is never pre-filtered here). Any
// monetary working-set reduction (the ONE shared receipt-visibility rule
// `isObservableMonetaryReceipt`) is applied separately inside the builder's
// analysis, never to the fingerprint input. Accepts a transaction client so
// the whole comparison runs in the caller's Serializable snapshot.
export async function readRepairLedger (models, scope, { reserve } = {}) {
  const snapshot = await readRewardsAuditSnapshot(models, {
    scope,
    reserve: reserve ?? readRewardsAuditReserve()
  })
  return {
    receipts: snapshot.ledger.receipts,
    downvotes: snapshot.ledger.downvotes,
    payouts: snapshot.ledger.payouts,
    distributions: snapshot.ledger.distributions,
    transactions: snapshot.ledger.transactions,
    escrowTransactions: snapshot.ledger.escrowTransactions,
    bountyPayments: snapshot.ledger.bountyPayments,
    observedBounties: snapshot.ledger.observedBounties,
    observedBountyReceipts: snapshot.ledger.observedBountyReceipts,
    items: snapshot.ledger.items,
    earns: snapshot.ledger.earns,
    accounts: snapshot.ledger.accounts,
    subaddresses: snapshot.ledger.subaddresses,
    proofInventory: snapshot.ledger.proofInventory,
    config: snapshot.config,
    reserve: snapshot.reserve,
    accountingFingerprint: snapshot.accountingFingerprint,
    accountingFingerprintVersion: ACCOUNTING_FINGERPRINT_VERSION,
    scope: snapshot.scope
  }
}

// Pure apply precondition comparator. Every check is fail-closed and throws on
// mismatch so the caller's transaction rolls back before any financial write:
//   1. the fresh precondition read IS the shared v2 accounting snapshot (a
//      current-format `accounting:v2:` audit identity at version 2 — a
//      legacy-shaped read can never be compared against an approved manifest);
//   2. the approved evidence (scope, fixed boundary hash and full normalized
//      digest, including its v2 payment verifications) is exactly the evidence
//      the manifest was built from;
//   3. no distribution is actively SENDING (writers are not paused — checked
//      before any content comparison: writer state is not ledger content);
//   4. the protected reward contracts (recipients, distribution reward totals,
//      Earn rows) are unchanged;
//   5. the complete precondition fingerprint (observations, transactions,
//      bounty payments, items, fee config, escrow journal, declared proof
//      inventory, wallet identities/subaddresses and the audited reserve) is
//      unchanged — the fine-grained what-changed check;
//   6. the shared `accounting:v2:` audit fingerprint over the same scoped
//      snapshot input the builder consumed is unchanged — the v2 catch-all
//      identity (it also covers distribution status/payoutCount/opsSweepState
//      facts outside the precondition view; the union money digest is not an
//      accounting authority).
export function assertRepairPreconditions (manifest, ledger, evidence) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('assertRepairPreconditions: an approved manifest is required')
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('assertRepairPreconditions: a freshly read ledger is required')
  }
  if (ledger.accountingFingerprintVersion !== ACCOUNTING_FINGERPRINT_VERSION ||
    !isCurrentAccountingFingerprint(ledger.accountingFingerprint, ledger.accountingFingerprint)) {
    throw new Error('repair precondition: the fresh precondition read is not the current v2 accounting snapshot')
  }
  const scope = manifest.scope
  const normalizedEvidence = normalizeEvidence(evidence)
  if (!normalizedEvidence.scope ||
    normalizedEvidence.scope.network !== scope?.network ||
    normalizedEvidence.scope.walletAddress !== scope?.walletAddress) {
    throw new Error('repair precondition: evidence scope does not match the approved manifest')
  }
  if (!normalizedEvidence.boundary ||
    normalizedEvidence.boundary.height !== manifest.boundary?.height ||
    normalizedEvidence.boundary.blockHash !== manifest.boundary?.blockHash) {
    throw new Error('repair precondition: evidence boundary does not match the approved fixed boundary')
  }
  if (digestOf(normalizedEvidence) !== manifest.evidenceDigest) {
    throw new Error('repair precondition: evidence does not match the approved evidence digest')
  }

  const sending = arrayOf(ledger.distributions).filter(row => row?.status === 'SENDING')
  if (sending.length > 0) {
    throw new Error(`repair precondition: distribution ${sending.map(row => row.id).join(', ')} is actively SENDING; writers are not paused`)
  }

  const normalized = normalizeLedger(ledger)
  if (protectedRewardsFingerprintOf(normalized) !== manifest.protectedRewardsFingerprint) {
    throw new Error('repair precondition: a protected reward contract changed since the manifest was approved')
  }
  if (ledgerPreconditionFingerprint(ledger, ledger.config) !== manifest.preconditionFingerprint) {
    throw new Error('repair precondition: the approved ledger, item terms or fee config changed since the manifest was approved')
  }
  if (accountingAuditFingerprint({
    scope: ledger.scope ?? scope,
    ledger,
    config: ledger.config,
    reserve: ledger.reserve
  }) !== manifest.ledgerFingerprint) {
    throw new Error('repair precondition: the scoped ledger changed since the manifest was approved')
  }
  return true
}
