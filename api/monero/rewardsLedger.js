import { createHash } from 'node:crypto'
import { money } from '@/lib/rewardsAccounting'
import {
  readRewardsAuditReserve,
  readRewardsAuditSnapshot
} from '@/api/monero/rewardsAuditSnapshot'
import {
  ACCOUNTING_FINGERPRINT_VERSION,
  isCurrentAccountingFingerprint
} from '@/lib/rewardsAuditFingerprint'

// The factual rewards-hot-wallet ledger (rewards accounting repair §5): ONE
// read-side union of proved facts for:
//   - the next-distribution pool and the transparency pages
//     (lib/rewardsPool.js, api/resolvers/rewards.js, api/resolvers/rewardsWallet.js),
//   - the ops-sweep spending bound and the weekly distribution checkpoint
//     (api/monero/rewards.js, worker/rewardsDistributor.js),
//   - the repair manifest (§12/§13, via the ledger fingerprint).
//
//   I = all CONFIRMED eligible hot-wallet receipts (read by rewardsInflow.js),
//   P = de-duplicated reward principal PROVEN sent (recorded SENT/CONFIRMED
//       rows plus any journal-proven relay the recipient row has not recovered),
//   S = de-duplicated ops-sweep principal proven sent (recorded opsSwept once,
//       plus journal-proven sweep relays not represented in the distribution's
//       comma-separated sweep hash list),
//   F = unique RELAYED hot-wallet transaction fees, consolidations included.
//   Balance = I - P - S - F; this module owns P, S and F only.
//
// It is a read-side union of proved facts, NOT a send eligibility engine and
// NOT a second payout contract. A PREPARED row is not an expense; an attempted
// PREPARED row is accounting uncertainty (never proved principal or cost). A
// RELAYED hash is one fact: its fee counts exactly once and its principal is
// de-duplicated against the recorded payout facts by (txHash, payoutId) — by
// payoutId alone a real double-send would disappear. A journal row proves its
// members only when they sum exactly to its principal; a commitment is
// released by exactly one fully-matching proof, and multiple hashes, corrupt
// metadata or mismatched members retain it. Conflicting amounts or unresolvable
// overlap flag uncertainty and may never release sweepable funds; a proven
// outflow is never silently omitted.
//
// This module never instantiates Prisma and never opens a wallet.

// Networks the platform rewards wallet is provisioned for. TESTNET is
// deliberately excluded (walletScope fails closed before any send).
const REWARDS_NETWORKS = new Set(['STAGENET', 'MAINNET'])
const TX_HASH_RE = /^[0-9a-f]{64}$/
const JOURNAL_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])
// A recorded payout in one of these states is a proved send, not a commitment.
const SENT_PAYOUT_STATES = new Set(['SENT', 'CONFIRMED'])
// Queued and unreconciled FAILED rows are still owed, including older
// distributions; only a validated journal relay releases them.
const OPEN_PAYOUT_STATES = new Set(['QUEUED', 'FAILED'])

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

// Exact nonnegative BigInt or null (unreadable/negative). Never rounds.
function nonnegative (value) {
  try {
    const amount = money(value)
    return amount < 0n ? null : amount
  } catch {
    return null
  }
}

// Exact signed BigInt or null (unreadable). Used ONLY for the contractual
// signed ops fields; principal/fees/amounts stay nonnegative.
function signedAmount (value) {
  try {
    return money(value)
  } catch {
    return null
  }
}

const amountOrZero = value => {
  try {
    return value == null ? 0n : money(value)
  } catch {
    return 0n
  }
}

const amountString = value => {
  try {
    return money(value).toString()
  } catch {
    return null
  }
}

// Stable recursive key ordering for the fingerprint (mirrors the journal's
// canonical metadata comparison).
function canonicalJson (value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

// Parse a distribution's comma-separated sweep hash list. A malformed entry is
// retained as uncertainty (the recorded sweep fact cannot be fully trusted)
// but never becomes an exact hash.
function parseHashList (value) {
  if (value == null || value === '') return { hashes: new Set(), valid: true }
  if (typeof value !== 'string') return { hashes: new Set(), valid: false }
  const hashes = new Set()
  let valid = true
  for (const part of value.split(',')) {
    const hash = normalizeHash(part.trim())
    if (hash) hashes.add(hash)
    else valid = false
  }
  return { hashes, valid }
}

// Parse a PAYOUT journal row's closed metadata union. EVERY member that
// exposes a positive payout id is returned, even when its amount or address is
// unreadable — a conflicting reference must still retain that payout's
// commitment. `valid` is true only when every member is fully readable with no
// duplicate payout id.
function readPayoutMembers (row) {
  const list = row?.metadata?.payouts
  if (!Array.isArray(list) || list.length === 0) return null
  const members = []
  const seen = new Set()
  let valid = true
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      valid = false
      continue
    }
    const payoutId = Number.isSafeInteger(entry.payoutId) && entry.payoutId > 0 ? entry.payoutId : null
    const recipientAddress = typeof entry.recipientAddress === 'string' && entry.recipientAddress.trim() !== ''
      ? entry.recipientAddress
      : null
    const piconeros = nonnegative(entry.piconeros)
    if (payoutId == null || recipientAddress == null || piconeros == null) {
      valid = false
      if (payoutId != null && !seen.has(payoutId)) {
        seen.add(payoutId)
        members.push({ payoutId, recipientAddress, piconeros, readable: false })
      }
      continue
    }
    if (seen.has(payoutId)) {
      // The same payout id twice in one transaction is contradictory
      // attribution, never two independent proofs.
      valid = false
      continue
    }
    seen.add(payoutId)
    members.push({ payoutId, recipientAddress, piconeros, readable: true })
  }
  return { members, valid }
}

// Immutability comparison for a duplicated hash (the DB unique key makes this
// defensive only): identical facts collapse to one, conflicting facts are
// uncertainty and never two counted outflows.
function sameJournalFacts (a, b) {
  return a.kind === b.kind &&
    a.state === b.state &&
    (a.distributionId ?? null) === (b.distributionId ?? null) &&
    amountString(a.principalPiconeros) === amountString(b.principalPiconeros) &&
    amountString(a.networkFeePiconeros) === amountString(b.networkFeePiconeros) &&
    JSON.stringify(canonicalJson(a.metadata ?? null)) === JSON.stringify(canonicalJson(b.metadata ?? null))
}

// A published audit clears the positive-drift warning ONLY when it is provably
// CLEAN: its persisted report must carry a manifest (flat APPLY report, or a
// CHECK report's `{ manifest, evidence }`) whose `issues` list is empty. An
// audit published while material unknowns remained — or a report whose shape
// cannot prove cleanliness — never clears the gate, no matter how its stored
// drift reads.
function auditManifest (audit) {
  const report = audit?.report
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null
  const manifest = report.manifest ?? report
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.issues)) return null
  return manifest
}

function auditIsClean (audit) {
  const manifest = auditManifest(audit)
  return manifest != null && manifest.issues.length === 0
}

// The audit's positive drift warns continuously until a CLEAN check of exactly
// the CURRENT ledger facts reports no discrepancy. Currency is strict and
// versioned: only a stored `accounting:v2:` fingerprint that equals the
// current one is current — a stored legacy bare hash, a v1 string or a
// malformed value is stale by definition (no old-projection fallback, no DB
// backfill) — and a matching check that was published with material issues is
// not clean either: neither can clear the warning.
function positiveDriftFromAudits (audits, fingerprint) {
  const rows = audits ?? []
  const current = rows.find(a => isCurrentAccountingFingerprint(a?.ledgerFingerprint, fingerprint))
  if (current && auditIsClean(current)) {
    const drift = amountOrZero(current.positiveDriftPiconeros)
    return drift > 0n ? drift : 0n
  }
  let carried = 0n
  for (const row of rows) {
    const drift = amountOrZero(row?.positiveDriftPiconeros)
    if (drift > carried) carried = drift
  }
  return carried
}

// ---- Exact rational arithmetic (BigInt numerator/denominator). Fractions are
// kept reduced with a positive denominator so equality, sign and comparison
// checks are exact. ----
function bigGcd (a, b) {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b !== 0n) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

function fraction (numerator, denominator = 1n) {
  let n = BigInt(numerator)
  let d = BigInt(denominator)
  if (d === 0n) throw new Error('rational arithmetic: zero denominator')
  if (n === 0n) return { n: 0n, d: 1n }
  const g = bigGcd(n, d)
  n /= g
  d /= g
  if (d < 0n) {
    n = -n
    d = -d
  }
  return { n, d }
}

const fractionAdd = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d)
const fractionSubtract = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d)
const fractionMultiply = (a, b) => fraction(a.n * b.n, a.d * b.d)
const fractionDivide = (a, b) => fraction(a.n * b.d, a.d * b.n)
const fractionNegate = value => ({ n: -value.n, d: value.d })
const fractionSign = value => (value.n < 0n ? -1 : value.n > 0n ? 1 : 0)
const fractionCompare = (a, b) => {
  const lhs = a.n * b.d
  const rhs = b.n * a.d
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}

// Exact minimum of the covering LP
//   minimize Σ_h u_h  subject to  Σ_{h∈H_d} u_h ≥ s_d (s_d > 0), u_h ≥ 0,
// solved through its dual
//   maximize Σ_d s_d y_d  subject to  Σ_{d∋h} y_d ≤ 1, y_d ≥ 0
// with a rational simplex (BigInt fractions, Bland's rule) started from the
// all-slack basis y = 0, so no phase-I artificials are needed. Strong duality
// makes the dual optimum exactly the covering minimum; the optimum is NOT
// assumed integral (the incidence structure is not totally unimodular — three
// pairwise-overlapping distributions give a half-integral dual optimum, e.g.
// y = ½ each for A=100{H,K}, B=100{K,L}, C=100{H,L} → 150n, while any
// pairwise-disjoint/integral cover undercounts it at 100n). The dual is
// bounded whenever every distribution has at least one hash (u_h = max_d s_d
// is primal-feasible), which the caller guarantees. Returns the exact optimum
// as a reduced fraction, or null when the dual is unbounded (defensive only —
// the caller treats it as an internal invariant violation and fails
// conservative, never understated).
function coveringMinimumExact ({ hashes, hashSets, surpluses }) {
  const m = surpluses.length
  const n = hashes.length
  const columns = m + n // 0..m-1 dual y_d, m..m+n-1 slack z_h
  const rows = []
  for (let h = 0; h < n; h++) {
    const row = new Array(columns + 1)
    for (let j = 0; j <= columns; j++) row[j] = fraction(0n)
    for (let d = 0; d < m; d++) {
      if (hashSets[d].has(hashes[h])) row[d] = fraction(1n)
    }
    row[m + h] = fraction(1n)
    row[columns] = fraction(1n)
    rows.push(row)
  }
  const basis = []
  for (let h = 0; h < n; h++) basis.push(m + h)
  // Objective row z (z_j = c_Bᵀ B⁻¹ A_j, z[columns] = current objective) and
  // the fixed minimization costs c_j = -s_d for the dual variables.
  const z = new Array(columns + 1).fill(fraction(0n))
  const costs = new Array(columns).fill(fraction(0n))
  for (let d = 0; d < m; d++) costs[d] = fraction(-surpluses[d])

  for (;;) {
    // Bland: the entering variable is the smallest index with a negative
    // reduced cost.
    let entering = -1
    for (let j = 0; j < columns; j++) {
      if (fractionCompare(costs[j], z[j]) < 0) {
        entering = j
        break
      }
    }
    if (entering === -1) break // optimal: every reduced cost is nonnegative

    // Ratio test; Bland's tie-break prefers the smallest basic variable index.
    let leavingRow = -1
    let bestRatio = null
    let leavingBasisIndex = Infinity
    for (let i = 0; i < n; i++) {
      const coefficient = rows[i][entering]
      if (fractionSign(coefficient) <= 0) continue
      const ratio = fractionDivide(rows[i][columns], coefficient)
      const comparison = bestRatio === null ? -1 : fractionCompare(ratio, bestRatio)
      if (comparison < 0 || (comparison === 0 && basis[i] < leavingBasisIndex)) {
        bestRatio = ratio
        leavingRow = i
        leavingBasisIndex = basis[i]
      }
    }
    if (leavingRow === -1) return null // dual unbounded ⇔ primal infeasible

    // Gauss-Jordan pivot; the objective row is updated so the entering
    // column's z-value becomes its cost. Every step stays exact.
    const pivotValue = rows[leavingRow][entering]
    const enteringReduced = fractionSubtract(costs[entering], z[entering])
    const pivotRow = rows[leavingRow]
    for (let j = 0; j <= columns; j++) pivotRow[j] = fractionDivide(pivotRow[j], pivotValue)
    for (let j = 0; j <= columns; j++) z[j] = fractionAdd(z[j], fractionMultiply(enteringReduced, pivotRow[j]))
    for (let i = 0; i < n; i++) {
      if (i === leavingRow) continue
      const factor = rows[i][entering]
      if (fractionSign(factor) === 0) continue
      for (let j = 0; j <= columns; j++) rows[i][j] = fractionSubtract(rows[i][j], fractionMultiply(factor, pivotRow[j]))
    }
    basis[leavingRow] = entering
  }

  return fractionNegate(z[columns]) // dual maximum = -minimization objective
}

// Exact conservative floor for ONE connected component of the
// distribution↔hash graph (see the sweep-totals comment): the minimum of
// Σ x_h over the component's hashes subject to x_h ≥ j_h (journal-proven
// principal per hash) and Σ_{h∈H_d} x_h ≥ r_d (recorded ops-swept total per
// distribution), with x_h ≥ 0 real. Writing x_h = j_h + u_h leaves the
// covering LP minimize Σ u_h s.t. Σ_{h∈H_d} u_h ≥ s_d (s_d = r_d − Σ_{h∈H_d} j_h),
// which coveringMinimumExact solves exactly through its dual. The optimum is
// not assumed integral: for A=100{H,K}, B=100{K,L}, C=100{H,L} it is 150n
// (x = 50n per hash, dual y = ½ each) and any disjoint-cover enumeration
// undercounts it at 100n. Fractional optima are valid; the reported integral
// floor is the CEILING of the exact optimum (every integral outflow
// consistent with the evidence is ≥ ceil), and such a component is flagged
// uncertain — its shared-hash conflicts already flag it, this is a defensive
// invariant. A recorded distribution with an EMPTY hash set has no variable to
// absorb its claim: its recorded total is a separate proven outflow added
// directly (it shares no hash with anyone). Components hold a handful of rows
// in practice; the simplex is exact at any size and never relaxes a
// constraint, because an approximation could undercut a proven outflow.
function exactSweepComponentFloor ({ distributionIds, hashes, recordedTotals, recordedHashSets, journalPrincipalByHash }, uncertain) {
  const journalOf = hash => journalPrincipalByHash.get(hash) ?? 0n
  const journalSum = hashes.reduce((acc, hash) => acc + journalOf(hash), 0n)

  // Hash-less recorded claims cannot join the LP: each is counted once,
  // directly (it shares no hash with any other distribution).
  let directPiconeros = 0n
  const lpDistributionIds = []
  for (const id of distributionIds) {
    const hashSet = [...(recordedHashSets.get(id) ?? [])].sort()
    if (hashSet.length === 0) {
      const recordedTotal = recordedTotals.get(id) ?? 0n
      if (recordedTotal > 0n) directPiconeros += recordedTotal
      continue
    }
    lpDistributionIds.push(id)
  }

  // Only a positive surplus can bind; a nonpositive one is already satisfied
  // by the journal floors.
  const active = []
  for (const id of lpDistributionIds) {
    const hashSet = [...(recordedHashSets.get(id) ?? [])].sort()
    let ownJournal = 0n
    for (const hash of hashSet) ownJournal += journalOf(hash)
    const surplus = (recordedTotals.get(id) ?? 0n) - ownJournal
    if (surplus > 0n) active.push({ id, surplus, hashSet: new Set(hashSet) })
  }

  if (active.length === 0) return journalSum + directPiconeros

  const minimum = coveringMinimumExact({
    hashes,
    hashSets: active.map(entry => entry.hashSet),
    surpluses: active.map(entry => entry.surplus)
  })
  if (minimum === null) {
    // Defensive: the primal is infeasible only when an active distribution
    // has no hashes, which the split above excludes — this branch is
    // unreachable by construction. If it ever fires, fail conservative and
    // count every positive-surplus claim separately, never understated.
    uncertain()
    return journalSum + directPiconeros + active.reduce((acc, entry) => acc + entry.surplus, 0n)
  }
  const quotient = minimum.n / minimum.d
  const remainder = minimum.n % minimum.d
  if (remainder !== 0n) uncertain()
  return journalSum + directPiconeros + (remainder === 0n ? quotient : quotient + 1n)
}

// Pure factual union. Same return fields as readRewardsWalletLedger.
export function summarizeRewardsLedger ({
  payouts = [],
  distributions = [],
  transactions = [],
  scope,
  positiveDriftPiconeros = 0n
} = {}) {
  const scoped = normalizeScope(scope)
  let accountingUncertain = false
  const uncertain = () => { accountingUncertain = true }

  // --- One journal fact per unique hash, scoped to the configured wallet. ---
  const journalByHash = new Map()
  for (const row of transactions) {
    if (row == null) {
      uncertain()
      continue
    }
    if (row.network !== scoped.network || row.walletAddress !== scoped.walletAddress) {
      throw new Error('rewards ledger: journal row outside the configured wallet scope')
    }
    const hash = normalizeHash(row.txHash)
    if (!hash) {
      uncertain()
      continue
    }
    const existing = journalByHash.get(hash)
    if (existing === undefined) {
      journalByHash.set(hash, row)
    } else if (!sameJournalFacts(existing, row)) {
      uncertain()
    }
  }

  // --- F: unique RELAYED fees; PREPARED is never an expense. ---
  let totalNetworkFeesPiconeros = 0n
  for (const row of journalByHash.values()) {
    if (!JOURNAL_KINDS.has(row.kind)) uncertain()
    if (row.state === 'RELAYED') {
      const fee = nonnegative(row.networkFeePiconeros)
      if (fee == null) uncertain()
      else totalNetworkFeesPiconeros += fee
      if (row.kind === 'CONSOLIDATION' && nonnegative(row.principalPiconeros) !== 0n) uncertain()
    } else if (row.state === 'PREPARED') {
      // A never-attempted PREPARED row is inert (it cannot relay without
      // burning the attempt). An attempted one is unresolved uncertainty.
      if (row.relayAttemptedAt != null) uncertain()
    } else if (row.state !== 'NOT_RELAYED') {
      uncertain()
    }
  }

  // --- Recorded payout facts (indexed by id and by exact hash), iterated in
  // deterministic id order. ---
  const recorded = new Map()
  const sortedPayouts = [...payouts].sort((a, b) => {
    const ai = Number.isSafeInteger(a?.id) ? a.id : -1
    const bi = Number.isSafeInteger(b?.id) ? b.id : -1
    return ai - bi
  })
  for (const row of sortedPayouts) {
    if (row == null || !Number.isSafeInteger(row.id)) {
      uncertain()
      continue
    }
    if (recorded.has(row.id)) {
      uncertain()
      continue
    }
    recorded.set(row.id, row)
  }
  const recordedByHash = new Map()
  for (const row of recorded.values()) {
    const hash = normalizeHash(row.txHash)
    if (!hash) continue
    const list = recordedByHash.get(hash) ?? []
    list.push(row)
    recordedByHash.set(hash, list)
  }

  // --- Journal PAYOUT rows: only a transaction-level-valid row can prove a
  // payout (all members readable, no duplicate payout id, and the members sum
  // EXACTLY to the journal principal). A corrupt row keeps its proven principal
  // for same-hash reconciliation below and marks every payout it names as
  // conflicted, so it can never release a commitment or double-count a fact.
  const membersByPayout = new Map()
  const conflictedPayouts = new Set()
  const corruptPayoutRows = []
  const sortedJournalPayouts = [...journalByHash.values()]
    .filter(row => row.kind === 'PAYOUT' && row.state === 'RELAYED')
    .sort((a, b) => (normalizeHash(a.txHash) ?? '').localeCompare(normalizeHash(b.txHash) ?? ''))
  for (const row of sortedJournalPayouts) {
    const principal = nonnegative(row.principalPiconeros)
    if (principal == null) {
      uncertain()
      continue
    }
    const hash = normalizeHash(row.txHash)
    const parsed = readPayoutMembers(row)
    const members = parsed?.members ?? []
    const readableMembers = members.filter(m => m.readable)
    const memberTotal = readableMembers.reduce((acc, m) => acc + m.piconeros, 0n)
    const rowValid = parsed != null && parsed.valid &&
      readableMembers.length === members.length && members.length > 0 &&
      memberTotal === principal
    if (!rowValid) {
      // Every payout id the row references — even through an unreadable member
      // — keeps its commitment: conflicting references are surfaced, never
      // silently discarded with the malformed member.
      for (const member of members) conflictedPayouts.add(member.payoutId)
      corruptPayoutRows.push({ hash, principal })
      uncertain()
      continue
    }
    for (const member of members) {
      const list = membersByPayout.get(member.payoutId) ?? []
      list.push({ hash, distributionId: row.distributionId ?? null, ...member })
      membersByPayout.set(member.payoutId, list)
    }
  }

  // --- P and the outstanding reward commitments, per payout obligation. ---
  // A commitment is released ONLY by exactly one fully-matching, transaction-
  // valid journal proof naming it; multiple hashes, mismatched members, corrupt
  // rows naming it, or an unreadable payout amount all retain the commitment
  // and flag uncertainty (never omit the proven outflow).
  let payoutSentPiconeros = 0n
  let outstandingRewardsPiconeros = 0n
  const payoutIds = new Set([...recorded.keys(), ...membersByPayout.keys()])
  for (const payoutId of [...payoutIds].sort((a, b) => a - b)) {
    const row = recorded.get(payoutId)
    const members = membersByPayout.get(payoutId) ?? []

    if (!row) {
      // Journal-proven relay(s) with no recorded recipient row (a post-relay
      // persist failure): the proofs are outflows. Nothing is owed here, but
      // two distinct hashes for one payout are contradictory attribution.
      const hashes = new Set(members.map(m => m.hash))
      payoutSentPiconeros += members.reduce((acc, m) => acc + m.piconeros, 0n)
      if (hashes.size > 1 || conflictedPayouts.has(payoutId)) uncertain()
      continue
    }

    const principal = nonnegative(row.piconeros)
    if (principal == null) uncertain()
    const hashes = new Set(members.map(m => m.hash))
    const matchesRow = member => {
      const amountOk = principal != null && member.piconeros === principal
      const addressOk = member.recipientAddress === row.recipientAddress
      const distributionOk = member.distributionId == null || row.distributionId == null ||
        member.distributionId === row.distributionId
      return amountOk && addressOk && distributionOk
    }
    const proofs = members.map(member => ({ ...member, matches: matchesRow(member) }))
    const proofHashes = new Set(proofs.filter(m => m.matches).map(m => m.hash))

    if (SENT_PAYOUT_STATES.has(row.state)) {
      const recordedPrincipal = principal ?? 0n
      if (members.length === 0) {
        payoutSentPiconeros += recordedPrincipal
        continue
      }
      const recordedHash = normalizeHash(row.txHash)
      if (recordedHash == null) {
        // The recorded send has no hash: the journal evidence may be that same
        // relay or additional ones. Count each fact once, never add both.
        const factTotal = members.reduce((acc, m) => acc + m.piconeros, 0n)
        payoutSentPiconeros += recordedPrincipal > factTotal ? recordedPrincipal : factTotal
        uncertain()
        continue
      }
      let sameHash = 0n
      let extra = 0n
      for (const member of proofs) {
        if (member.hash === recordedHash) {
          if (!member.matches) uncertain()
          sameHash += member.piconeros
        } else {
          // A second distinct proven hash for one payout is a real double-send:
          // its actual principal stays visible and flags uncertainty.
          extra += member.piconeros
          uncertain()
        }
      }
      if (hashes.size > 1 || conflictedPayouts.has(payoutId)) uncertain()
      const bestSame = recordedPrincipal > sameHash ? recordedPrincipal : sameHash
      payoutSentPiconeros += bestSame + extra
      continue
    }

    if (OPEN_PAYOUT_STATES.has(row.state)) {
      if (members.length === 0) {
        // Unproven commitment: owed until a journal relay proves delivery.
        const owed = principal ?? 0n
        if (owed > 0n) outstandingRewardsPiconeros += owed
        continue
      }
      // Every proven member is a real outflow.
      for (const member of proofs) payoutSentPiconeros += member.piconeros
      const singleProof = proofHashes.size === 1 && hashes.size === 1 &&
        !conflictedPayouts.has(payoutId) && proofs.every(m => m.matches)
      if (singleProof && principal != null) continue // settled: owed = principal - released = 0
      uncertain()
      const owed = principal ?? 0n
      if (owed > 0n) outstandingRewardsPiconeros += owed
      continue
    }

    // Unknown payout state: neither proved sent nor a trustworthy commitment.
    uncertain()
  }

  // --- Corrupt journal rows: reconcile their proven principal against recorded
  // payout facts carrying the same hash, so a recorded send and its journal row
  // are never both counted and corrupted metadata can never release a
  // commitment. The row's fee is already counted exactly once above. ---
  for (const corrupt of corruptPayoutRows.sort((a, b) => (a.hash ?? '').localeCompare(b.hash ?? ''))) {
    if (corrupt.hash == null) continue
    const sameHash = recordedByHash.get(corrupt.hash) ?? []
    let sentSameHash = 0n
    for (const row of sameHash) {
      if (!SENT_PAYOUT_STATES.has(row.state)) continue
      const amount = nonnegative(row.piconeros)
      if (amount == null) uncertain()
      else sentSameHash += amount
    }
    if (sameHash.length === 0) {
      // No recorded recipient fact at all: the principal is a proven outflow.
      payoutSentPiconeros += corrupt.principal
    } else if (sentSameHash > 0n) {
      // The recorded send(s) sharing this exact hash are already counted: add
      // only the excess the journal proves beyond them.
      if (corrupt.principal !== sentSameHash) uncertain()
      if (corrupt.principal > sentSameHash) payoutSentPiconeros += corrupt.principal - sentSameHash
    } else {
      // Only open recorded rows share the hash: the relay is proven but the
      // corrupted metadata cannot release the commitment.
      payoutSentPiconeros += corrupt.principal
    }
  }

  // --- Phase A: recorded sweep facts from a deterministic, sorted snapshot.
  // A hash recorded by MORE THAN ONE distribution is itself a conflict (never
  // silently preferred to whichever distribution appears first). ---
  const distributionsById = new Map()
  const recordedTotals = new Map()
  const recordedHashSets = new Map()
  const hashOwners = new Map() // hash -> sorted array of recorded distribution ids
  const sortedDistributions = [...distributions].sort((a, b) => {
    const ai = Number.isSafeInteger(a?.id) ? a.id : -1
    const bi = Number.isSafeInteger(b?.id) ? b.id : -1
    return ai - bi
  })
  for (const distribution of sortedDistributions) {
    if (distribution == null || !Number.isSafeInteger(distribution.id)) {
      uncertain()
      continue
    }
    if (distributionsById.has(distribution.id)) {
      uncertain()
      continue
    }
    const recorded = distribution.opsSweptPiconeros == null ? 0n : nonnegative(distribution.opsSweptPiconeros)
    if (recorded == null) uncertain()
    distributionsById.set(distribution.id, distribution)
    recordedTotals.set(distribution.id, recorded ?? 0n)
    const parsed = parseHashList(distribution.opsSweepTxHash)
    if (!parsed.valid) uncertain()
    recordedHashSets.set(distribution.id, parsed.hashes)
    for (const hash of [...parsed.hashes].sort()) {
      const owners = hashOwners.get(hash) ?? []
      owners.push(distribution.id)
      hashOwners.set(hash, owners)
    }
  }
  for (const owners of hashOwners.values()) {
    if (owners.length > 1) uncertain()
  }

  // --- Phase B: journal sweep facts (hash order), validated against the
  // complete recorded owner set. A hash recorded by ANY distribution is
  // represented; a hash absent from every recorded list is an extra proven
  // sweep attributed to its declared distribution when that row exists. ---
  const sortedJournalSweeps = [...journalByHash.values()]
    .filter(row => row.kind === 'OPS_SWEEP' && row.state === 'RELAYED')
    .sort((a, b) => (normalizeHash(a.txHash) ?? '').localeCompare(normalizeHash(b.txHash) ?? ''))
  const journalPrincipalByHash = new Map() // distinct sweep hash -> proven principal
  const unrepresentedJournal = new Map() // distId -> BigInt of proven additional sweeps
  let unattributedSweepPiconeros = 0n
  for (const row of sortedJournalSweeps) {
    const principal = nonnegative(row.principalPiconeros)
    if (principal == null) {
      uncertain()
      continue
    }
    const hash = normalizeHash(row.txHash)
    journalPrincipalByHash.set(hash, principal)
    const declaredId = Number.isSafeInteger(row.distributionId) ? row.distributionId : null
    const owners = hashOwners.get(hash) ?? []
    if (owners.length > 0) {
      // Represented by at least one recorded distribution: its principal is
      // already part of the recorded facts and is never added again.
      if (declaredId != null && !owners.includes(declaredId)) uncertain()
      continue
    }
    // The hash is absent from every recorded list: an extra proven sweep.
    const ownerId = declaredId != null && distributionsById.has(declaredId) ? declaredId : null
    if (ownerId == null) {
      // Proven sweep principal with no recorded distribution to carry it.
      unattributedSweepPiconeros += principal
      uncertain()
      continue
    }
    unrepresentedJournal.set(ownerId, (unrepresentedJournal.get(ownerId) ?? 0n) + principal)
  }

  // --- Deterministic conservative proven totals. Recorded distributions
  // sharing a sweep hash form one connected component (union-find over the
  // shared hashes); a component's conservative floor is the EXACT minimum of
  // Σ x_h subject to the lower-bound evidence: x_h ≥ j_h (journal-proven
  // principal per hash) and Σ_{h∈H_d} x_h ≥ r_d (recorded ops-swept total per
  // distribution), computed by exactSweepComponentFloor with an exact
  // rational simplex — never an integral or pairwise-disjoint approximation.
  // A component-wide max(recorded, journal) would both overcount (a shared
  // hash serving two recorded totals) and undercount (a distinct hash's
  // proven journal floor beyond what the shared-hash constraints consume);
  // uncertainty does not repair an understated outflow, so the floor is
  // never approximated. Extra journal principal is added only for hashes
  // absent from every recorded list, and each distribution keeps the
  // conservative per-distribution floor max(its recorded total, the
  // journaled principal of its own hashes) below. ---
  const parent = new Map()
  for (const id of recordedTotals.keys()) parent.set(id, id)
  const findRoot = id => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(id) !== root) {
      const next = parent.get(id)
      parent.set(id, root)
      id = next
    }
    return root
  }
  for (const owners of hashOwners.values()) {
    for (let i = 1; i < owners.length; i++) {
      const a = findRoot(owners[0])
      const b = findRoot(owners[i])
      if (a !== b) parent.set(b, a)
    }
  }
  const components = new Map() // root -> { ids, hashes }
  for (const id of recordedTotals.keys()) {
    const root = findRoot(id)
    const entry = components.get(root) ?? { ids: [], hashes: new Set() }
    entry.ids.push(id)
    components.set(root, entry)
  }
  for (const entry of components.values()) {
    for (const id of entry.ids) {
      for (const hash of recordedHashSets.get(id) ?? []) entry.hashes.add(hash)
    }
  }

  const sweptByDistribution = new Map()
  let sweepSentPiconeros = unattributedSweepPiconeros
  for (const entry of components.values()) {
    sweepSentPiconeros += exactSweepComponentFloor({
      distributionIds: entry.ids,
      hashes: [...entry.hashes].sort(),
      recordedTotals,
      recordedHashSets,
      journalPrincipalByHash
    }, uncertain)
  }
  for (const extra of unrepresentedJournal.values()) sweepSentPiconeros += extra
  for (const id of [...recordedTotals.keys()].sort((a, b) => a - b)) {
    const recordedTotal = recordedTotals.get(id)
    const hashSet = recordedHashSets.get(id)
    let journalSum = 0n
    let journaledCount = 0
    for (const hash of [...hashSet].sort()) {
      const principal = journalPrincipalByHash.get(hash)
      if (principal == null) continue
      journalSum += principal
      journaledCount += 1
    }
    if (journaledCount > 0) {
      if (journalSum > recordedTotal) {
        // Journal facts prove more swept than the recorded total.
        uncertain()
      } else if (journaledCount >= hashSet.size && journalSum !== recordedTotal) {
        // Every recorded hash is journaled but the sums disagree.
        uncertain()
      }
    }
    // Conservative floor: never below the recorded total nor below the
    // journaled principal of this distribution's own hashes (a shared hash is
    // floored for each owner without being summed twice in sweepSent).
    const proven = (recordedTotal > journalSum ? recordedTotal : journalSum) +
      (unrepresentedJournal.get(id) ?? 0n)
    // Nonnegative residual: a sweep can never exceed the snapshot it draws
    // from; an exceeded snapshot is a corrupt overlap, not free cash. A
    // NEGATIVE opsAvailable is a contractual signed ops debt, not corruption:
    // it is certain when nothing was swept against it (a later distribution's
    // income repays the debt). Only a proven sweep while the snapshot is in
    // deficit is an excessive sweep — it exceeded every possible nonnegative
    // obligation — and stays uncertainty.
    const owner = distributionsById.get(id)
    if (owner?.opsAvailablePiconeros != null) {
      const available = signedAmount(owner.opsAvailablePiconeros)
      if (available == null) uncertain()
      else if (available >= 0n) {
        if (proven > available) uncertain()
      } else if (proven > 0n) {
        uncertain()
      }
    }
    sweptByDistribution.set(id, proven)
  }

  const totalSentPiconeros = payoutSentPiconeros + sweepSentPiconeros
  const drift = amountOrZero(positiveDriftPiconeros)

  // --- Union digest: explicit safe ledger fields only, deterministic order.
  // This digest covers ONLY the money-union facts (payouts, distributions,
  // journal, derived totals). It is a stability digest for the union, NOT an
  // accounting audit fingerprint: freshness and repair compare the shared
  // versioned `accounting:v2:` snapshot fingerprint instead. ---
  const facts = {
    scope: { network: scoped.network, walletAddress: scoped.walletAddress },
    payouts: payouts
      .filter(row => row != null && Number.isSafeInteger(row.id))
      .map(row => ({
        id: row.id,
        distributionId: row.distributionId ?? null,
        state: row.state ?? null,
        txHash: normalizeHash(row.txHash),
        recipientAddress: row.recipientAddress ?? null,
        piconeros: amountString(row.piconeros)
      }))
      .sort((a, b) => a.id - b.id),
    distributions: distributions
      .filter(row => row != null && Number.isSafeInteger(row.id))
      .map(row => ({
        id: row.id,
        opsSweptPiconeros: amountString(row.opsSweptPiconeros),
        opsSweepTxHash: row.opsSweepTxHash ?? null
      }))
      .sort((a, b) => a.id - b.id),
    transactions: [...journalByHash.values()]
      .map(row => ({
        txHash: normalizeHash(row.txHash),
        kind: row.kind ?? null,
        state: row.state ?? null,
        distributionId: row.distributionId ?? null,
        principalPiconeros: amountString(row.principalPiconeros),
        networkFeePiconeros: amountString(row.networkFeePiconeros),
        relayAttemptedAt: row.relayAttemptedAt == null
          ? null
          : (row.relayAttemptedAt instanceof Date
              ? row.relayAttemptedAt.toISOString()
              : String(row.relayAttemptedAt)),
        metadata: canonicalJson(row.metadata ?? null)
      }))
      .sort((a, b) => (a.txHash ?? '').localeCompare(b.txHash ?? '')),
    totals: {
      totalNetworkFeesPiconeros: totalNetworkFeesPiconeros.toString(),
      totalSentPiconeros: totalSentPiconeros.toString(),
      payoutSentPiconeros: payoutSentPiconeros.toString(),
      sweepSentPiconeros: sweepSentPiconeros.toString(),
      outstandingRewardsPiconeros: outstandingRewardsPiconeros.toString(),
      accountingUncertain,
      positiveDriftPiconeros: drift.toString()
    }
  }
  const unionFingerprint = createHash('sha256').update(JSON.stringify(canonicalJson(facts))).digest('hex')

  return {
    totalNetworkFeesPiconeros,
    totalSentPiconeros,
    payoutSentPiconeros,
    sweepSentPiconeros,
    sweptByDistribution,
    outstandingRewardsPiconeros,
    accountingUncertain,
    positiveDriftPiconeros: drift,
    unionFingerprint
  }
}

// Scoped DB reader for every freshness consumer: the money totals come from
// the unchanged de-duplicated PAYOUT/OPS_SWEEP/CONSOLIDATION union over the
// shared snapshot's scoped journal/payout/distribution groups, and the audit
// fingerprint is the shared `accounting:v2:` digest of ONE complete safe
// snapshot (rewards reconciliation Task 1) read in the caller's Serializable
// transaction — never a wallet, daemon or key provider. The configured scope
// must be the registered platform_rewards identity (label + network, resolved
// like the #1 collector; foreign or absent identity refuses). Accepts a
// transaction client so callers can read it in their own snapshot.
export async function readRewardsWalletLedger (models, { scope } = {}) {
  const scoped = normalizeScope(scope)
  if (typeof models?.rewardsWalletReconciliation?.findMany !== 'function') {
    throw new Error('readRewardsWalletLedger: models.rewardsWalletReconciliation is required')
  }

  const [snapshot, audits] = await Promise.all([
    readRewardsAuditSnapshot(models, { scope: scoped, reserve: readRewardsAuditReserve() }),
    models.rewardsWalletReconciliation.findMany({
      where: { network: scoped.network, walletAddress: scoped.walletAddress },
      orderBy: { checkedAt: 'desc' },
      select: { positiveDriftPiconeros: true, ledgerFingerprint: true, report: true }
    })
  ])

  // Money totals continue from the existing union — receipt eligibility,
  // escrow, proof-inventory or config facts can never redefine them — while
  // freshness is exactly the shared versioned snapshot fingerprint.
  const union = summarizeRewardsLedger({
    payouts: snapshot.ledger.payouts,
    distributions: snapshot.ledger.distributions,
    transactions: snapshot.ledger.transactions,
    scope: scoped
  })
  return {
    ...union,
    fingerprint: snapshot.accountingFingerprint,
    accountingFingerprintVersion: ACCOUNTING_FINGERPRINT_VERSION,
    positiveDriftPiconeros: positiveDriftFromAudits(audits, snapshot.accountingFingerprint)
  }
}
