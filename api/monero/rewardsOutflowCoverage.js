import { validatePaymentVerification } from '@/api/monero/paymentVerification'
import { normalizePaymentClaims, paymentClaimDigest } from '@/api/monero/paymentClaims'

// Reverse recorded-outflow coverage (rewards reconciliation plan, Task 4).
// PURE: this module reads no DB, opens no wallet, touches no clock and never
// mutates its inputs. It proves every RECORDED outflow — payout rows, recorded
// sweep hashes, escrow settlement legs — against the collected evidence,
// row-first and INDEPENDENT of any drift computation: there is no drift input
// to accept and no aggregate balance that can gate or absorb an issue.
//
// For every recorded payout group/hash the exact batch must be proved by a
// COMPLETE payment verification whose proved members match the recorded batch
// exactly as a multiset (duplicates significant — same-address members are
// never attributed by output order; member identity comes from the frozen
// DB/capture contract and receipt proof covers aggregates only), plus its
// complete owned outgoing result.
//
// Strict recorded-outflow coverage (final-review I1) is verification-ONLY:
// a RELAYED PAYOUT journal row, a confirmed outgoing hash or a pending
// mempool bridge is operational relay history and chain presence — NEVER a
// complete-payment proof. A recorded payout whose evidence is missing,
// journal-only, pending-only, or a collected but unresolved/rejected/
// unsupported verifier result stays a NAMED issue per payout identity
// (irrespective of any drift), and no issue ever removes the recorded
// ledger debit or requeues/reverses the delivery.
//
// Sweep hash parsing retains malformed entries and duplicate ownership; a
// distribution's multi-hash principal allocation must be attributed EXACTLY
// (sum of attributed per-hash principals == recorded swept total; each hash's
// proof is the recorded single-destination payment). Mere `opsSweepTxHash`
// presence, a journal row, a confirmed hash or an unattributed complete proof
// is not evidence: a recorded hash needs its complete verification attributed
// to the exact recorded principal and destination. Recorded actual swept
// fields are never changed here.
//
// Escrow award/reclaim/rollover and legacy fee legs are covered under the
// escrow scope and require a COMPLETE ESCROW verification for the exact leg
// hash — confirmed escrow history alone is history, not whole-payment
// closure. A missing prize/fee leg is an issue even when every settlement
// column is populated — populated bookkeeping is not evidence.
//
// Issue records are safe, fixed-shape and deterministic:
//   { code, table, id?, txHash?, leg?, entry?, distributionIds?,
//     recordedPiconeros?, provenPiconeros?, reason } — irrelevant fields are
// omitted, reasons are fixed constants, and exact `id`s distinguish offsetting
// rows so one hash never collapses into a boolean hiding conflicting members.
// Exact same-cause records are deduplicated.

const TX_HASH_RE = /^[0-9a-f]{64}$/
const CANONICAL_AMOUNT_RE = /^(0|[1-9][0-9]*)$/

// Payout states whose recorded money must be proved by evidence.
const COVERED_PAYOUT_STATES = new Set(['SENT', 'CONFIRMED'])
// BountyPayment states with live escrow settlement legs.
const OPEN_BOUNTY_STATES = new Set(['SENT', 'CONFIRMED'])

// Fixed issue reasons (never arbitrary input text).
const REASONS = Object.freeze({
  PAYOUT_HASH_INVALID: 'the recorded payout carries no valid transaction hash',
  PAYOUT_EVIDENCE_MISSING: 'no complete payment verification, journal history or pending evidence exists for this recorded payout',
  PAYOUT_PROOF_UNSUPPORTED: 'the recorded payout has only pending or unsupported proof; pending complete-proof boundaries remain unresolved',
  PAYOUT_JOURNAL_NOT_PROOF: 'the covering journal row is relay history, not a complete payment verification; strict recorded-outflow coverage requires complete proof naming this payout exactly',
  PROOF_MEMBER_MISMATCH: 'the proved payment does not include this recorded payout exactly',
  PROOF_MEMBER_SURPLUS: 'the proved payment includes members beyond the recorded payout batch',
  SWEEP_MALFORMED: 'the recorded sweep hash list contains a non-hash entry',
  SWEEP_OWNERSHIP_CONFLICT: 'more than one recorded distribution claims the same sweep hash',
  SWEEP_EVIDENCE_MISSING: 'the recorded sweep hash has no complete payment verification attributed to its exact recorded principal and destination',
  SWEEP_PRINCIPAL_UNPROVEN: 'the recorded swept total is not exactly attributed by proved sweep payments',
  ESCROW_LEG_MISSING: 'the recorded escrow settlement leg has no complete payment verification attributed to its exact frozen membership',
  ESCROW_MEMBER_MISSING: 'the proved payment is missing a recorded escrow leg member',
  ESCROW_MEMBER_SURPLUS: 'the proved payment includes members beyond the recorded escrow leg membership',
  ESCROW_OWNER_MISMATCH: 'the verification does not bind the recorded escrow journal owner',
  ESCROW_CLAIMS_OWNER_MISMATCH: 'the recorded escrow claims do not bind the recorded journal and payment owner',
  ESCROW_CLAIMS_INVALID: 'the recorded escrow claims cannot be authenticated'
})

function normalizeHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}

// Exact nonnegative BigInt or null — never a rounded or defaulted amount.
function amountOrNull (value) {
  if (typeof value === 'bigint') return value < 0n ? null : value
  if (typeof value === 'string' && CANONICAL_AMOUNT_RE.test(value)) return BigInt(value)
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return null
}

// A safe numeric row identity (BigInt ids collapse into safe numbers so issue
// records stay JSON-safe and deduplicable).
function identifier (value) {
  if (Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return null
}

const arrayOf = value => (Array.isArray(value) ? value : [])

// Recursive sorted-key canonical JSON: validated verifier results and issue
// records have closed key sets, so this is a stable identity for both.
function canonicalJson (value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key])
    return out
  }
  return value
}

const recordKey = record => JSON.stringify(canonicalJson(record))

// Index the approved payment verifications by `journalRole:txHash`. Two gates
// mirror the builder exactly: verifications authorize coverage only under the
// v2 evidence contract, and a conflicting duplicate for one role/hash poisons
// the slot (it never binds; the builder names the conflict itself).
function indexVerifications ({ verifications, scope, evidenceVersion }) {
  const index = new Map()
  if (evidenceVersion !== 2) return index
  for (const entry of arrayOf(verifications)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (!validatePaymentVerification(entry)) continue
    if (!entry.scope || entry.scope.network !== scope?.network ||
      entry.scope.walletAddress !== scope?.walletAddress) continue
    const key = `${entry.journalRole ?? 'REWARDS'}:${entry.txHash}`
    const prior = index.get(key)
    if (prior !== undefined) {
      if (prior !== null && recordKey(prior) !== recordKey(entry)) index.set(key, null)
      continue
    }
    index.set(key, entry)
  }
  return index
}

const isComplete = verification => verification != null && verification?.status === 'complete'

/**
 * Does a complete verification's proved member multiset exactly cover the
 * recorded payout rows? Order never matters; duplicates are significant.
 * Returns null when covered, else a fixed mismatch reason.
 *
 * @param {Array<object>} recordedRows recorded payout rows of one hash batch
 * @param {Array<object>} members the verification's proved members
 * @returns {string|null}
 */
export function recordedBatchMembershipMismatch (recordedRows, members) {
  if (!Array.isArray(members) || members.length === 0) return REASONS.PROOF_MEMBER_MISMATCH
  const remaining = []
  for (const member of members) {
    const amount = amountOrNull(member?.actualPiconeros)
    const address = typeof member?.address === 'string' && member.address !== '' ? member.address : null
    if (amount == null || address == null) return REASONS.PROOF_MEMBER_MISMATCH
    remaining.push(`${amount}:${address}`)
  }
  for (const row of arrayOf(recordedRows)) {
    const amount = amountOrNull(row?.piconeros)
    const address = typeof row?.recipientAddress === 'string' && row.recipientAddress !== ''
      ? row.recipientAddress
      : null
    if (amount == null || address == null) return REASONS.PROOF_MEMBER_MISMATCH
    const index = remaining.indexOf(`${amount}:${address}`)
    if (index === -1) return REASONS.PROOF_MEMBER_MISMATCH
    remaining.splice(index, 1)
  }
  if (remaining.length > 0) return REASONS.PROOF_MEMBER_MISMATCH
  return null
}

// The per-hash coverage authority for one recorded payout batch, computed
// once per hash (final-review I1): 'verification' (a COMPLETE proof — the
// only strict coverage), 'journal' (RELAYED relay history: operational
// recovery context, never strict coverage), 'unsupported' (a collected but
// non-complete verifier result, a mempool bridge entry or a PREPARED
// attempt) or 'missing' (no evidence at all).
function payoutBatchSource (hash, context) {
  const verification = context.verifications.get(`REWARDS:${hash}`)
  if (isComplete(verification)) return 'verification'
  const journal = context.journalByHash.get(hash)
  if (journal != null && journal.kind === 'PAYOUT' && journal.state === 'RELAYED') return 'journal'
  if (verification !== undefined || context.pendingOutgoingHashes.has(hash) ||
    (journal != null && journal.state === 'PREPARED')) return 'unsupported'
  return 'missing'
}

// Per-row attribution against a complete verification's proved
// members: every recorded row the proof does not exactly cover is named.
function verificationUncoveredRows (rows, verification) {
  const remaining = []
  for (const member of arrayOf(verification.members)) {
    const amount = amountOrNull(member?.actualPiconeros)
    const address = typeof member?.address === 'string' && member.address !== '' ? member.address : null
    if (amount == null || address == null) return new Set(arrayOf(rows).map(row => identifier(row?.id)))
    remaining.push(`${amount}:${address}`)
  }
  const uncovered = new Set()
  for (const row of arrayOf(rows)) {
    const amount = amountOrNull(row?.piconeros)
    const address = typeof row?.recipientAddress === 'string' && row.recipientAddress !== ''
      ? row.recipientAddress
      : null
    const index = amount == null || address == null ? -1 : remaining.indexOf(`${amount}:${address}`)
    if (index === -1) {
      uncovered.add(identifier(row?.id))
      continue
    }
    remaining.splice(index, 1)
  }
  return uncovered
}

// Surplus proof members (final-review I1 round 2): after removing every
// recorded row's exact `amount:address` pair, the leftover proved members —
// payments the recorded batch never claims. Unreadable members never surface
// here: the per-row pass already names every recorded row when any member is
// unreadable.
function surplusProofMembers (rows, verification) {
  const remaining = []
  for (const member of arrayOf(verification.members)) {
    const amount = amountOrNull(member?.actualPiconeros)
    const address = typeof member?.address === 'string' && member.address !== '' ? member.address : null
    if (amount == null || address == null) continue
    remaining.push(`${amount}:${address}`)
  }
  for (const row of arrayOf(rows)) {
    const amount = amountOrNull(row?.piconeros)
    const address = typeof row?.recipientAddress === 'string' && row.recipientAddress !== ''
      ? row.recipientAddress
      : null
    if (amount == null || address == null) continue
    const index = remaining.indexOf(`${amount}:${address}`)
    if (index !== -1) remaining.splice(index, 1)
  }
  return remaining
}

// One recorded SENT/CONFIRMED payout: its hash must be valid and its batch
// proved row-first by a COMPLETE verification. Relay journal history, pending
// bridge entries and non-complete verifier results are individually named
// (final-review I1); per-row verification attribution keeps offsetting rows
// distinct.
function checkRecordedPayout (payout, context, addIssue) {
  const id = identifier(payout?.id)
  if (id == null) return
  const hash = normalizeHash(payout.txHash)
  if (hash == null) {
    addIssue({ code: 'RECORDED_PAYOUT_HASH_INVALID', table: 'RewardPayout', id: String(id), reason: REASONS.PAYOUT_HASH_INVALID })
    return
  }
  const rows = context.rowsByHash.get(hash) ?? []
  const source = context.batchSourceByHash.get(hash) ?? payoutBatchSource(hash, context)
  context.batchSourceByHash.set(hash, source)
  const base = { table: 'RewardPayout', id: String(id), txHash: hash }
  if (source === 'missing') {
    addIssue({ code: 'RECORDED_PAYOUT_EVIDENCE_MISSING', ...base, reason: REASONS.PAYOUT_EVIDENCE_MISSING })
    return
  }
  if (source === 'journal') {
    addIssue({ code: 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', ...base, reason: REASONS.PAYOUT_JOURNAL_NOT_PROOF })
    return
  }
  if (source === 'unsupported') {
    addIssue({ code: 'RECORDED_PAYOUT_PROOF_UNSUPPORTED', ...base, reason: REASONS.PAYOUT_PROOF_UNSUPPORTED })
    return
  }
  const uncovered = verificationUncoveredRows(rows, context.verifications.get(`REWARDS:${hash}`))
  if (uncovered.has(id)) {
    addIssue({ code: 'RECORDED_PAYOUT_MEMBER_MISMATCH', ...base, reason: REASONS.PROOF_MEMBER_MISMATCH })
  }
  // Exact frozen membership (final-review I1 round 2): the proof's member
  // multiset must match the recorded batch EXACTLY — leftover proved members
  // beyond the recorded batch are a named surplus, never silent
  // over-coverage.
  for (const leftover of surplusProofMembers(rows, context.verifications.get(`REWARDS:${hash}`))) {
    addIssue({
      code: 'RECORDED_PAYOUT_MEMBER_MISMATCH',
      table: 'RewardPayout',
      txHash: hash,
      entry: leftover,
      reason: REASONS.PROOF_MEMBER_SURPLUS
    })
  }
}

// Exact sweep attribution (final-review I1 round 2): a complete verification
// attributes a recorded sweep only when it is EXACTLY the recorded
// single-destination payment — exactly one readable member (an OPS_SWEEP pays
// exactly one destination), whose address matches the recorded sweep target.
// Sums over unrelated members never attribute a recorded sweep.
function sweepAttributedPiconeros (verification, recordedTarget) {
  if (!isComplete(verification) || !Array.isArray(verification.members) ||
    verification.members.length !== 1) return null
  const member = verification.members[0]
  const amount = amountOrNull(member?.actualPiconeros)
  const address = recipientOrNull(member?.address)
  if (amount == null || address == null) return null
  // recordedTarget '' means a journal row records a target that cannot be
  // read — fail closed (the target cannot be checked).
  if (recordedTarget != null && (recordedTarget === '' || member.address !== recordedTarget)) return null
  return amount
}

// The recorded sweep target for one hash: the scoped OPS_SWEEP journal row's
// destination. No journal row records no target (amount-only attribution);
// a journal row whose destination is unreadable records a target that cannot
// be checked ('' — fail closed).
function recordedSweepTarget (context, hash) {
  const journal = context.journalByHash.get(hash)
  if (journal == null || journal.kind !== 'OPS_SWEEP') return null
  const destination = journal.metadata?.destination
  return recipientOrNull(destination) ?? ''
}

// One distribution's recorded sweep hashes: malformed entries are retained,
// coverage is a COMPLETE verification per hash that attributes the recorded
// sweep EXACTLY — one member, the recorded destination, and a principal sum
// equal to the recorded swept total (mere opsSweepTxHash presence, a journal
// row, a confirmed hash or an unattributed complete proof is not evidence —
// final-review I1 round 2). Recorded actual swept fields are never changed
// here.
function checkRecordedSweepHashes (distribution, context, addIssue) {
  const id = identifier(distribution?.id)
  if (id == null) return
  const raw = typeof distribution.opsSweepTxHash === 'string' ? distribution.opsSweepTxHash : ''
  const hashes = []
  if (raw !== '') {
    for (const part of raw.split(',')) {
      const entry = part.trim()
      const hash = normalizeHash(entry)
      if (hash != null) hashes.push(hash)
      // `id` stays the raw numeric identity so this record is byte-identical
      // to the builder's own parse-time issue and deduplicates against it.
      else addIssue({ code: 'SWEEP_HASH_MALFORMED', table: 'RewardDistribution', id, entry, reason: REASONS.SWEEP_MALFORMED })
    }
  }
  const distinct = [...new Set(hashes)]
  let proven = 0n
  let sharedOwnership = false
  for (const hash of distinct) {
    const verification = context.verifications.get(`REWARDS:${hash}`)
    const attributed = sweepAttributedPiconeros(verification, recordedSweepTarget(context, hash))
    if (attributed == null) {
      addIssue({ code: 'RECORDED_SWEEP_EVIDENCE_MISSING', table: 'RewardDistribution', id: String(id), txHash: hash, reason: REASONS.SWEEP_EVIDENCE_MISSING })
    } else {
      proven += attributed
    }
    if ((context.sweepOwnersByHash.get(hash)?.filter(owner => owner != null).length ?? 0) > 1) sharedOwnership = true
  }
  const recorded = amountOrNull(distribution.opsSweptPiconeros) ?? 0n
  // Exact attribution (final-review I1 round 2): the attributed principal must
  // EQUAL the recorded swept total — under- AND over-attribution are named. A
  // shared-hash ownership conflict already names the attribution problem: the
  // per-distribution allocation is not decided twice for the same hash.
  if (recorded > 0n && proven !== recorded && !sharedOwnership) {
    addIssue({
      code: 'RECORDED_SWEEP_PRINCIPAL_UNPROVEN',
      table: 'RewardDistribution',
      id: String(id),
      recordedPiconeros: recorded.toString(),
      provenPiconeros: proven.toString(),
      reason: REASONS.SWEEP_PRINCIPAL_UNPROVEN
    })
  }
}

// One recorded bounty payment's escrow legs: the prize leg (txHash) and the
// legacy deferred-fee leg (feeTxHash) each need a COMPLETE ESCROW payment
// verification for the exact leg hash that carries the leg's EXACT FROZEN
// MEMBERSHIP. A recorded journal is either coherently owned or rejected, never
// discarded into the journal-less path. Authenticated captured membership and
// recorded settlement receipts are independent constraints on the SAME proof:
// claims cannot replace actuals or remove a recorded fee leg. Surplus AND missing
// members are named. Null actuals remain unknown, never nominal substitutes.
// Confirmed history/bookkeeping alone is not whole-payment closure; even a
// hashless principal remains a required leg with a named missing-proof issue.
function checkRecordedEscrowLegs (payment, context, addIssue) {
  const id = identifier(payment?.id)
  if (id == null || !OPEN_BOUNTY_STATES.has(payment?.state)) return
  const legs = [{ leg: 'PRINCIPAL', txHash: normalizeHash(payment.txHash) }]
  if (payment.feeTxHash != null) legs.push({ leg: 'FEE', txHash: normalizeHash(payment.feeTxHash) })
  for (const { leg, txHash } of legs) {
    const verification = txHash == null ? null : context.escrowVerifications.get(`ESCROW:${txHash}`)
    const journal = txHash == null ? null : context.escrowJournalByHash.get(txHash)
    // Complete-status prerequisite (final-review round 3): an
    // unresolved/rejected/unsupported result — however many members it
    // materializes — never covers a recorded leg.
    if (!isComplete(verification)) {
      const record = { code: 'RECORDED_ESCROW_LEG_EVIDENCE_MISSING', table: 'BountyPayment', id: String(id), leg, reason: REASONS.ESCROW_LEG_MISSING }
      if (txHash != null) record.txHash = txHash
      addIssue(record)
      continue
    }
    if (journal != null && (String(journal.bountyPaymentId) !== String(payment.id) ||
      String(verification.journalId) !== String(journal.id))) {
      addIssue({ code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH', table: 'BountyPayment', id: String(id), txHash, leg, reason: REASONS.ESCROW_OWNER_MISMATCH })
      continue
    }
    const captured = journal == null ? null : recordedClaimMembers(journal, payment)
    if (captured?.reason != null) {
      addIssue({ code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH', table: 'BountyPayment', id: String(id), txHash, leg, reason: captured.reason })
      continue
    }
    const recorded = recordedLegMembers(payment, leg, journal)
    // Check both sources independently. Merging/replacing sets would either
    // double-count honest members or allow a wildcard/unrecorded actual to mask
    // an exact captured amount (and the reverse). Exact same issues dedupe.
    // Captured membership defines the exact allowed set; settlement rows add
    // required receipts, not surplus constraints on still-unrecovered members.
    const identity = { id: String(id), txHash, leg }
    checkEscrowMemberSet(recorded, verification.members, identity, addIssue, captured == null)
    if (captured != null) checkEscrowMemberSet(captured.members, verification.members, identity, addIssue)
  }
}

function checkEscrowMemberSet (expected, members, identity, addIssue, exact = true) {
  const { missing, surplus } = memberSetDiff(expected, arrayOf(members))
  for (const entry of missing) {
    addIssue({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      table: 'BountyPayment',
      ...identity,
      entry: `${entry.leg}:${entry.address}:${entry.amount == null ? '?' : entry.amount}`,
      reason: REASONS.ESCROW_MEMBER_MISSING
    })
  }
  for (const member of exact ? surplus : []) {
    addIssue({
      code: 'RECORDED_ESCROW_LEG_MEMBER_MISMATCH',
      table: 'BountyPayment',
      ...identity,
      entry: `${member.leg}:${member.address}:${member.actualPiconeros}`,
      reason: REASONS.ESCROW_MEMBER_SURPLUS
    })
  }
}

const recipientOrNull = value => (typeof value === 'string' && value !== '' ? value : null)

// The frozen member multiset of a CAPTURED escrow dispatch, derived from the
// journal row's own authenticated claims (mirrors the escrow reconcile's
// derivation): member id is the bounty payment id, legs are the canonical
// PRINCIPAL / FEE / LEGACY_SEPARATE_FEE, addresses and amounts are the frozen
// terms minus the captured network fee. No claims means no extra constraint;
// present but invalid or wrongly owned claims are a rejection, not absence.
function recordedClaimMembers (journal, payment) {
  if (journal.paymentClaims == null) return null
  try {
    const claims = normalizePaymentClaims(journal.paymentClaims)
    if (paymentClaimDigest(claims) !== journal.claimDigest) return { reason: REASONS.ESCROW_CLAIMS_INVALID }
    if (String(claims.bountyPaymentId) !== String(journal.bountyPaymentId) ||
      String(claims.bountyPaymentId) !== String(payment.id)) {
      return { reason: REASONS.ESCROW_CLAIMS_OWNER_MISMATCH }
    }
    const memberId = String(claims.bountyPaymentId)
    const terms = claims.frozenTerms
    const prize = BigInt(terms.prizePiconeros)
    const fee = BigInt(terms.feePiconeros)
    const networkFee = BigInt(claims.networkFeePiconeros)
    if (claims.kind === 'LEGACY_SEPARATE_FEE') {
      return { members: [{ id: memberId, leg: 'LEGACY_SEPARATE_FEE', address: terms.feeRecipientAddress, amount: fee }] }
    }
    if (fee === 0n) {
      return { members: [{ id: memberId, leg: 'PRINCIPAL', address: terms.recipientAddress, amount: prize - networkFee }] }
    }
    return {
      members: [
        { id: memberId, leg: 'PRINCIPAL', address: terms.recipientAddress, amount: prize },
        { id: memberId, leg: 'FEE', address: terms.feeRecipientAddress, amount: fee - networkFee }
      ]
    }
  } catch {
    return { reason: REASONS.ESCROW_CLAIMS_INVALID }
  }
}

// Required membership from recorded settlement rows, regardless of capture.
// Amounts bind only where the ledger records them (a null settlement actual is
// "not yet known", and a nominal booking is never substituted for a net receipt);
// the member id and
// leg are always part of the exact identity.
function recordedLegMembers (payment, leg, journal) {
  const memberId = String(payment.id)
  if (leg === 'PRINCIPAL') {
    const entries = []
    const recipient = recipientOrNull(payment.recipientAddress)
    if (recipient != null) {
      entries.push({ id: memberId, leg: 'PRINCIPAL', address: recipient, amount: amountOrNull(payment.recipientReceivedPiconeros) })
    }
    // A recorded fee receipt with NO separate fee tx was paid inside this
    // leg: its member is required here regardless of feeTxHash presence.
    if (normalizeHash(payment.feeTxHash) == null) {
      const feeRecipient = recipientOrNull(payment.feeRecipientAddress)
      const feeReceived = amountOrNull(payment.feeReceivedPiconeros)
      if (feeRecipient != null && feeReceived != null) {
        entries.push({ id: memberId, leg: 'FEE', address: feeRecipient, amount: feeReceived })
      }
    }
    return entries
  }
  const feeRecipient = recipientOrNull(payment.feeRecipientAddress)
  if (feeRecipient == null) return []
  const separateFee = journal != null &&
    (journal.leg === 'LEGACY_SEPARATE_FEE' || journal.kind === 'LEGACY_SEPARATE_FEE')
  return [{
    id: memberId,
    leg: separateFee ? 'LEGACY_SEPARATE_FEE' : 'FEE',
    address: feeRecipient,
    amount: amountOrNull(payment.feeReceivedPiconeros)
  }]
}

// Exact multiset difference (final-review I1 round 3): every expected member
// is consumed by a proof member with the same id, leg and address and the
// exact recorded amount where one is recorded; unconsumed expectations are
// missing, unconsumed proof members are surplus.
function memberSetDiff (expected, members) {
  const remaining = [...members]
  const missing = []
  for (const entry of expected) {
    const index = remaining.findIndex(member =>
      String(member?.id) === entry.id &&
      member?.leg === entry.leg &&
      member?.address === entry.address &&
      (entry.amount == null || amountOrNull(member?.actualPiconeros) === entry.amount))
    if (index === -1) {
      missing.push(entry)
      continue
    }
    remaining.splice(index, 1)
  }
  return { missing, surplus: remaining }
}

/**
 * Prove every recorded outflow against the collected evidence. Pure and
 * drift-blind: the helper accepts no drift input and cannot gate on one.
 *
 * @param {{ledger: object, evidence: object, scope: object}} request
 *   `ledger` carries the audit-snapshot payout/distribution/bountyPayment/
 *   transaction groups (raw or normalized rows), `evidence` the collected
 *   `{ outgoing, bridge?, paymentVerifications?, escrow? }` facts and
 *   `scope` the proven `{ network, walletAddress }`.
 * @returns {Array<object>} deterministic sorted issue records
 */
export function recordedOutflowCoverage ({ ledger, evidence, scope } = {}) {
  const safeLedger = ledger !== null && typeof ledger === 'object' ? ledger : {}
  const safeEvidence = evidence !== null && typeof evidence === 'object' ? evidence : {}

  const journalByHash = new Map()
  for (const row of arrayOf(safeLedger.transactions)) {
    const hash = normalizeHash(row?.txHash)
    if (hash == null || journalByHash.has(hash)) continue
    journalByHash.set(hash, row)
  }
  const rowsByHash = new Map()
  for (const payout of arrayOf(safeLedger.payouts)) {
    const hash = normalizeHash(payout?.txHash)
    if (hash == null) continue
    const list = rowsByHash.get(hash) ?? []
    list.push(payout)
    rowsByHash.set(hash, list)
  }
  const sweepOwnersByHash = new Map()
  for (const distribution of arrayOf(safeLedger.distributions)) {
    const raw = typeof distribution?.opsSweepTxHash === 'string' ? distribution.opsSweepTxHash : ''
    if (raw === '') continue
    for (const part of raw.split(',')) {
      const hash = normalizeHash(part.trim())
      if (hash == null) continue
      const owners = sweepOwnersByHash.get(hash) ?? []
      if (!owners.includes(distribution?.id)) owners.push(distribution?.id)
      sweepOwnersByHash.set(hash, owners)
    }
  }
  const issues = []
  const seen = new Set()
  const addIssue = record => {
    const key = recordKey(record)
    if (seen.has(key)) return // dedupe the exact same cause
    seen.add(key)
    issues.push(record)
  }
  for (const [txHash, owners] of [...sweepOwnersByHash.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const named = [...new Set(owners.map(owner => identifier(owner)).filter(id => id != null))].sort((a, b) => a - b)
    if (named.length > 1) {
      addIssue({ code: 'SWEEP_HASH_OWNERSHIP_CONFLICT', txHash, distributionIds: named, reason: REASONS.SWEEP_OWNERSHIP_CONFLICT })
    }
  }

  const escrow = safeEvidence.escrow !== null && typeof safeEvidence.escrow === 'object' ? safeEvidence.escrow : null
  const verifications = indexVerifications({
    verifications: safeEvidence.paymentVerifications,
    scope,
    evidenceVersion: safeEvidence.evidenceVersion
  })
  const escrowVerifications = indexVerifications({
    verifications: escrow?.paymentVerifications,
    scope: { network: scope?.network, walletAddress: escrow?.walletAddress ?? scope?.walletAddress },
    evidenceVersion: safeEvidence.evidenceVersion
  })
  // Recorded escrow journals by leg hash: the authoritative owner/membership
  // rows the escrow coverage binds against (final-review I1 round 3).
  const escrowJournalByHash = new Map()
  for (const row of arrayOf(safeLedger.escrowTransactions)) {
    const hash = normalizeHash(row?.txHash)
    if (hash == null || escrowJournalByHash.has(hash)) continue
    escrowJournalByHash.set(hash, row)
  }
  const context = {
    journalByHash,
    rowsByHash,
    sweepOwnersByHash,
    verifications,
    escrowVerifications,
    escrowJournalByHash,
    pendingOutgoingHashes: new Set(arrayOf(safeEvidence.bridge?.pendingOutgoing)
      .map(entry => normalizeHash(entry?.txHash))
      .filter(hash => hash != null)),
    batchSourceByHash: new Map()
  }

  for (const payout of arrayOf(safeLedger.payouts)) {
    if (!COVERED_PAYOUT_STATES.has(payout?.state)) continue
    checkRecordedPayout(payout, context, addIssue)
  }
  for (const distribution of arrayOf(safeLedger.distributions)) {
    checkRecordedSweepHashes(distribution, context, addIssue)
  }
  for (const payment of arrayOf(safeLedger.bountyPayments)) {
    checkRecordedEscrowLegs(payment, context, addIssue)
  }

  // Deterministic output: canonical-JSON sort, exactly like the manifest's
  // fact lists, so input order can never reorder the records.
  return issues.map(record => ({ ...record })).sort((a, b) => {
    const ja = recordKey(a)
    const jb = recordKey(b)
    return ja < jb ? -1 : ja > jb ? 1 : 0
  })
}
