import { createHash, randomUUID } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { logWarn } from '@/lib/logger'
import { isUniqueViolation } from '@/lib/error'
import { money } from '@/lib/rewardsAccounting'
import { assertWalletScope } from './rewardsTransactions'
import { scalarFromHexLE } from './paymentKeyStructure'
import {
  canonicalPaymentJson,
  decodeReceivingIdentity,
  normalizePaymentClaims,
  paymentClaimDigest
} from './paymentClaims'
import { openPaymentProof, sealPaymentProof } from './paymentProofCrypto'

// Atomic payment-proof store (Finding #1, Task 3).
//
// Every hot-wallet or escrow send captures ONE durable pair before any relay:
// the immutable journal row (rewards journal or escrow dispatch journal) and
// its encrypted PaymentTransactionProof envelope, written together in ONE
// Serializable transaction with `synchronous_commit = on`. The envelope is
// sealed OUTSIDE the transaction (sealing never sees the database); the
// transaction only re-validates frozen contracts and lands the pair.
//
// COMMIT-ACKNOWLEDGEMENT CONTRACT (binding for every caller):
//   A resolved prepare/claim result is durable authorization to proceed.
//   A THROWN result is NOT evidence of absence: when the outcome is unknown
//   (transport dropped around commit) the caller must NOT relay and must NOT
//   rebuild identity — it re-reads the pair (assertPreparedPayment,
//   loadPaymentProof, or an idempotent re-prepare). Only a fresh successful
//   pair read that authenticates the same hash/claims re-authorizes anything;
//   a failing read never proves the pair absent.
//
// Durability prerequisites: `SET LOCAL synchronous_commit = on` (verified by
// `SHOW synchronous_commit` in the same transaction) makes the commit wait for
// WAL flush. That requires durable PostgreSQL storage: fsync=on,
// full_page_writes=on, non-volatile disks for pg_wal. synchronous_commit
// cannot be weakened below `on` for these writes: if SHOW reports anything
// else the preparation refuses (PAYMENT_PROOF_DURABILITY_REFUSED) rather than
// acknowledging an unflushed commit.
//
// Claims derive from FROZEN DB owner facts (rewards journal metadata /
// BountyPayment frozen terms) plus the built transaction's real facts; caller
// `owner` fields are EXPECTATIONS, never DB authority. The candidate dispatch
// UUID is minted once outside the retry loop; an existing scoped
// (network, walletAddress, txHash) row owns its ORIGINAL dispatchId —
// identical preparation re-adopts it and never conflicts or replaces identity.
//
// Nothing here logs or returns envelope bytes, nonces, tags, ciphertext,
// wrapped DEKs, or key material: readPaymentProofInventory exposes safe
// metadata plus an integrity digest over the stored envelope bytes, and every
// full-envelope read is private to this module (and the separately authorized
// rotation task). Errors are fixed uppercase codes only; BigInt piconeros are
// preserved end to end.

const INVALID = 'PAYMENT_PROOF_STORE_INVALID'
const TX_INVALID = 'PAYMENT_PROOF_TX_INVALID'
const OWNER_CONFLICT = 'PAYMENT_PROOF_OWNER_CONFLICT'
const LEGACY_OWNER = 'PAYMENT_PROOF_LEGACY_OWNER'
const LEGACY_MISSING = 'LEGACY_PROOF_MISSING'
const CAPTURE_MISMATCH = 'PAYMENT_PROOF_CAPTURE_MISMATCH'
const NOT_PREPARED = 'PAYMENT_PROOF_NOT_PREPARED'
const ATTEMPT_CONFLICT = 'PAYMENT_PROOF_ATTEMPT_CONFLICT'
const DURABILITY_REFUSED = 'PAYMENT_PROOF_DURABILITY_REFUSED'

const CAPTURE_CONTRACT_VERSION = 1
const TX_HASH_RE = /^[0-9a-f]{64}$/
const HEX_64 = /^[0-9a-f]{64}$/
// Installed monero-ts network enum values (mirrored from rewardsTransactions.js).
const NETWORK_NAMES = { 0: 'MAINNET', 2: 'STAGENET' }
const REWARDS_KINDS = new Set(['PAYOUT', 'OPS_SWEEP', 'CONSOLIDATION'])
const ESCROW_KINDS = new Set(['AWARD', 'RECLAIM', 'ROLLOVER', 'LEGACY_SEPARATE_FEE'])
const ESCROW_LEGS = new Set(['DISPOSITION', 'LEGACY_SEPARATE_FEE'])
const JOURNAL_TABLES = { REWARDS: 'RewardsWalletTransaction', ESCROW: 'EscrowWalletTransaction' }
const INVENTORY_DIGEST_DOMAIN = 'stashernews/monero/proof-inventory/v1\0'

// DB-only idempotent preparation may retry a concurrent serialization/unique
// conflict (Prisma P2002/P2034, raw 23505/40001). Relay is never inside a
// retried transaction.
const PREPARE_CONFLICT_RETRIES = 5

const fail = code => { throw new Error(code) }

const canonical = value => {
  const amount = money(value)
  if (amount < 0n) fail(INVALID)
  return amount.toString()
}

// --- owner expectation validation (closed unions) -----------------------------

const requireAddressText = value => {
  if (typeof value !== 'string' || value.trim() === '') fail(INVALID)
  return value
}

// Mirrors the existing rewards-journal closed metadata union (BigInt amounts).
function validateRewardMetadata ({ kind, metadata, principalPiconeros }) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail(INVALID)
  const keys = Object.keys(metadata).sort().join(',')
  if (kind === 'PAYOUT') {
    if (keys !== 'payouts' || !Array.isArray(metadata.payouts) || metadata.payouts.length === 0) fail(INVALID)
    const seen = new Set()
    let sum = 0n
    const payouts = metadata.payouts.map(payout => {
      if (!payout || typeof payout !== 'object' || Array.isArray(payout) ||
        Object.keys(payout).sort().join(',') !== 'payoutId,piconeros,recipientAddress') fail(INVALID)
      if (!Number.isSafeInteger(payout.payoutId) || payout.payoutId <= 0) fail(INVALID)
      if (seen.has(payout.payoutId)) fail(INVALID)
      seen.add(payout.payoutId)
      const piconeros = money(payout.piconeros)
      if (piconeros < 0n) fail(INVALID)
      sum += piconeros
      return { payoutId: payout.payoutId, recipientAddress: requireAddressText(payout.recipientAddress), piconeros }
    })
    if (sum !== principalPiconeros) fail(OWNER_CONFLICT)
    payouts.sort((a, b) => a.payoutId - b.payoutId)
    return { payouts }
  }
  if (kind === 'OPS_SWEEP') {
    if (keys !== 'destination') fail(INVALID)
    return { destination: requireAddressText(metadata.destination) }
  }
  // CONSOLIDATION: self transfer to the wallet's own primary address.
  if (keys !== 'destination,selfTransfer') fail(INVALID)
  if (metadata.selfTransfer !== true) fail(INVALID)
  if (principalPiconeros !== 0n) fail(OWNER_CONFLICT)
  return { destination: requireAddressText(metadata.destination), selfTransfer: true }
}

function validateFrozenTerms (frozenTerms) {
  if (!frozenTerms || typeof frozenTerms !== 'object' || Array.isArray(frozenTerms)) fail(INVALID)
  if (Object.keys(frozenTerms).sort().join(',') !== 'feePiconeros,feeRecipientAddress,prizePiconeros,recipientAddress') fail(INVALID)
  const prizePiconeros = canonical(frozenTerms.prizePiconeros)
  const feePiconeros = canonical(frozenTerms.feePiconeros)
  let feeRecipientAddress = null
  if (frozenTerms.feeRecipientAddress !== null) {
    feeRecipientAddress = requireAddressText(frozenTerms.feeRecipientAddress)
  }
  if ((BigInt(feePiconeros) === 0n) !== (feeRecipientAddress === null)) fail(INVALID)
  return {
    recipientAddress: requireAddressText(frozenTerms.recipientAddress),
    prizePiconeros,
    feePiconeros,
    feeRecipientAddress
  }
}

// Optional caller settlement expectations (readBountySettlement shape). Only
// the unambiguous fact is cross-checked here — the built tx's real fee; the
// full settlement attribution stays the escrow dispatch module's concern.
function validateSettlement (settlement) {
  if (settlement === null || settlement === undefined) return null
  if (typeof settlement !== 'object' || Array.isArray(settlement)) fail(INVALID)
  if (Object.keys(settlement).sort().join(',') !== 'feeReceivedPiconeros,networkFeePiconeros,recipientReceivedPiconeros') fail(INVALID)
  return {
    networkFeePiconeros: canonical(settlement.networkFeePiconeros),
    recipientReceivedPiconeros: canonical(settlement.recipientReceivedPiconeros),
    feeReceivedPiconeros: canonical(settlement.feeReceivedPiconeros)
  }
}

// Validates the caller's owner EXPECTATIONS into the closed owner-fact shape
// the store derives claims from. Database rows re-validate these inside the
// transaction — the caller never has the final word.
function validateOwner (owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) fail(INVALID)
  if (owner.journalRole === 'REWARDS') {
    if (Object.keys(owner).sort().join(',') !== 'accountIndex,distributionId,journalRole,kind,metadata,principalPiconeros') fail(INVALID)
    if (typeof owner.kind !== 'string' || !REWARDS_KINDS.has(owner.kind)) fail(INVALID)
    if (!Number.isSafeInteger(owner.accountIndex) || owner.accountIndex < 0) fail(INVALID)
    if (owner.distributionId != null && (!Number.isSafeInteger(owner.distributionId) || owner.distributionId <= 0)) fail(INVALID)
    const principalPiconeros = money(owner.principalPiconeros)
    if (principalPiconeros < 0n) fail(INVALID)
    return {
      journalRole: 'REWARDS',
      kind: owner.kind,
      accountIndex: owner.accountIndex,
      distributionId: owner.distributionId ?? null,
      principalPiconeros,
      metadata: validateRewardMetadata({ kind: owner.kind, metadata: owner.metadata, principalPiconeros })
    }
  }
  if (owner.journalRole === 'ESCROW') {
    if (Object.keys(owner).sort().join(',') !== 'bountyPaymentId,frozenTerms,itemId,journalRole,kind,leg,settlement') fail(INVALID)
    if (typeof owner.kind !== 'string' || !ESCROW_KINDS.has(owner.kind)) fail(INVALID)
    if (typeof owner.leg !== 'string' || !ESCROW_LEGS.has(owner.leg)) fail(INVALID)
    if ((owner.kind === 'LEGACY_SEPARATE_FEE') !== (owner.leg === 'LEGACY_SEPARATE_FEE')) fail(INVALID)
    if (!Number.isSafeInteger(owner.bountyPaymentId) || owner.bountyPaymentId <= 0) fail(INVALID)
    if (!Number.isSafeInteger(owner.itemId) || owner.itemId <= 0) fail(INVALID)
    const frozenTerms = validateFrozenTerms(owner.frozenTerms)
    if (owner.leg === 'LEGACY_SEPARATE_FEE' && BigInt(frozenTerms.feePiconeros) <= 0n) fail(INVALID)
    return {
      journalRole: 'ESCROW',
      kind: owner.kind,
      leg: owner.leg,
      bountyPaymentId: owner.bountyPaymentId,
      itemId: owner.itemId,
      frozenTerms,
      settlement: validateSettlement(owner.settlement)
    }
  }
  fail(INVALID)
}

// --- wallet scope (the wallet is the scope authority) --------------------------

async function resolveWalletScope (wallet) {
  if (!wallet || typeof wallet.getPrimaryAddress !== 'function' || typeof wallet.getNetworkType !== 'function') {
    throw new Error('wallet scope mismatch: wallet cannot prove its identity')
  }
  const networkType = await wallet.getNetworkType()
  const network = NETWORK_NAMES[networkType]
  if (network === undefined) throw new Error('wallet scope mismatch: unsupported network')
  const walletAddress = await wallet.getPrimaryAddress()
  // The proven scope must cohere: the wallet's primary address must decode as
  // a PRIMARY address on the network the wallet itself claims.
  try {
    const decoded = decodeReceivingIdentity(walletAddress, network)
    if (decoded.type !== 'PRIMARY') throw new Error('not a primary address')
  } catch {
    throw new Error('wallet scope mismatch: wallet primary address does not match the rewards wallet scope')
  }
  await assertWalletScope(wallet, { network, walletAddress })
  return { network, walletAddress }
}

// --- built transaction facts ---------------------------------------------------

function readDestination (raw) {
  if (!raw || typeof raw.getAddress !== 'function' || typeof raw.getAmount !== 'function') fail(TX_INVALID)
  const address = raw.getAddress()
  if (typeof address !== 'string' || address === '') fail(TX_INVALID)
  return { address, amountPiconeros: money(raw.getAmount()) }
}

// Validates one chunk of the SDK's secret key-bundle string: 64 lowercase hex
// chars encoding a little-endian scalar strictly inside 0 < s < curve order.
// Every real Monero tx secret (r and each r_i) satisfies this; anything else
// is not a capturable key bundle.
function requireSecretScalarChunk (chunk) {
  if (typeof chunk !== 'string' || !HEX_64.test(chunk)) fail(TX_INVALID)
  try {
    scalarFromHexLE(chunk)
  } catch {
    fail(TX_INVALID)
  }
}

// Optional POPULATED public facts are validated as canonical curve points.
function requireCanonicalPointChunk (chunk) {
  if (typeof chunk !== 'string' || !HEX_64.test(chunk)) fail(TX_INVALID)
  try {
    const point = ed25519.ExtendedPoint.fromHex(chunk)
    if (Buffer.from(point.toRawBytes()).toString('hex') !== chunk) fail(TX_INVALID)
  } catch (err) {
    if (String(err?.message || '').startsWith('PAYMENT_PROOF_')) throw err
    fail(TX_INVALID)
  }
}

async function readBuiltTx (tx) {
  if (!tx || typeof tx !== 'object') fail(TX_INVALID)
  const rawHash = typeof tx.getHash === 'function' ? await tx.getHash() : null
  const txHash = rawHash == null ? '' : String(rawHash).toLowerCase()
  if (!TX_HASH_RE.test(txHash)) fail(TX_INVALID)
  if (typeof tx.getFee !== 'function') fail(TX_INVALID)
  const networkFeePiconeros = money(await tx.getFee())
  if (networkFeePiconeros < 0n) fail(TX_INVALID)

  if (typeof tx.getOutgoingTransfer !== 'function') fail(TX_INVALID)
  const outgoing = tx.getOutgoingTransfer()
  const rawDestinations = outgoing && typeof outgoing.getDestinations === 'function'
    ? outgoing.getDestinations()
    : null
  if (!Array.isArray(rawDestinations) || rawDestinations.length === 0) fail(TX_INVALID)
  const destinations = rawDestinations.map(readDestination)

  const changeAddress = (typeof tx.getChangeAddress === 'function' ? await tx.getChangeAddress() : null) ?? null
  if (changeAddress !== null && (typeof changeAddress !== 'string' || changeAddress === '')) fail(TX_INVALID)
  // An unavailable change amount is explicit null — never coerced to 0 — and
  // an exposed address does not imply the SDK also exposed the amount.
  let changeAmountPiconeros = null
  if (typeof tx.getChangeAmount === 'function') {
    const rawChangeAmount = await tx.getChangeAmount()
    if (rawChangeAmount !== null && rawChangeAmount !== undefined) {
      changeAmountPiconeros = money(rawChangeAmount)
      if (changeAmountPiconeros < 0n) fail(TX_INVALID)
    }
  }
  if (changeAddress === null && changeAmountPiconeros !== null) fail(TX_INVALID)

  // The installed SDK's MoneroTx.getKey() returns a STRING of concatenated
  // little-endian SECRET key material: the main tx secret first, then the
  // ordered additional per-output secrets (final-review C1). The bundle is
  // captured exactly as built; the corresponding public keys are NOT exposed
  // by the built object, so the public built facts are optional/nullable and
  // are NEVER required to equal the secret bundle (the confirmed raw chain
  // supplies the later independent correspondence gate).
  if (typeof tx.getKey !== 'function') fail(TX_INVALID)
  const keyBundleHex = tx.getKey()
  if (typeof keyBundleHex !== 'string' ||
    !/^(?:[0-9a-f]{2})*$/.test(keyBundleHex) ||
    keyBundleHex.length === 0 ||
    keyBundleHex.length % 64 !== 0) {
    fail(TX_INVALID)
  }
  const additionalKeyCount = keyBundleHex.length / 64 - 1
  for (let offset = 0; offset < keyBundleHex.length; offset += 64) {
    requireSecretScalarChunk(keyBundleHex.slice(offset, offset + 64))
  }

  // Optional populated public facts: validated as canonical points when the
  // SDK exposes them, never compared against the secret bundle here.
  const mainPublicKey = typeof tx.getMainPublicKey === 'function' ? await tx.getMainPublicKey() : null
  if (mainPublicKey !== null) requireCanonicalPointChunk(mainPublicKey)
  let additionalPublicKeys = null
  if (typeof tx.getAdditionalPublicKeys === 'function') {
    const rawAdditional = await tx.getAdditionalPublicKeys()
    if (rawAdditional !== null && rawAdditional !== undefined) {
      if (!Array.isArray(rawAdditional) || rawAdditional.length !== additionalKeyCount) fail(TX_INVALID)
      for (const additional of rawAdditional) requireCanonicalPointChunk(additional)
      additionalPublicKeys = [...rawAdditional]
    }
  }
  let outputKeys = null
  if (typeof tx.getOutputKeys === 'function') {
    const rawOutputKeys = await tx.getOutputKeys()
    if (rawOutputKeys !== null && rawOutputKeys !== undefined) {
      if (!Array.isArray(rawOutputKeys) || rawOutputKeys.length === 0) fail(TX_INVALID)
      for (const outputKey of rawOutputKeys) requireCanonicalPointChunk(outputKey)
      outputKeys = [...rawOutputKeys]
    }
  }

  return {
    txHash,
    networkFeePiconeros,
    destinations,
    changeAddress,
    changeAmountPiconeros,
    mainPublicKey,
    additionalPublicKeys,
    outputKeys,
    additionalKeyCount,
    keyBundleHex
  }
}

// ProofPayloadV1 built strictly from validated transaction facts. Public
// fields the SDK did not populate stay explicit null — never invented.
function buildPayload (built) {
  return {
    payloadVersion: '1',
    keyBundleHex: built.keyBundleHex,
    additionalKeyCount: built.additionalKeyCount,
    builtStructure: {
      txHash: built.txHash,
      networkFeePiconeros: built.networkFeePiconeros.toString(),
      actualDestinations: built.destinations.map(destination => ({
        address: destination.address,
        amountPiconeros: destination.amountPiconeros.toString()
      })),
      changeAddress: built.changeAddress,
      changeAmountPiconeros: built.changeAmountPiconeros === null ? null : built.changeAmountPiconeros.toString(),
      mainPublicKey: built.mainPublicKey ?? null,
      additionalPublicKeys: built.additionalPublicKeys === null || built.additionalPublicKeys === undefined
        ? null
        : [...built.additionalPublicKeys],
      outputKeys: built.outputKeys === null || built.outputKeys === undefined
        ? null
        : [...built.outputKeys]
    }
  }
}

// The stored payload must describe exactly the built object the caller holds:
// same hash, same real fee, same actual destinations/change, same exact key
// bundle.
function assertPayloadMatchesBuilt (payload, built) {
  const expected = buildPayload(built)
  if (payload.keyBundleHex !== expected.keyBundleHex ||
    canonicalPaymentJson(payload.builtStructure) !== canonicalPaymentJson(expected.builtStructure)) {
    fail(CAPTURE_MISMATCH)
  }
}

// --- claims derivation (frozen owner facts + built facts) ----------------------

function memberFor (id, leg, address, network, grossPiconeros, actualPiconeros) {
  const decoded = decodeReceivingIdentity(address, network)
  return {
    id: String(id),
    leg,
    address,
    type: decoded.type,
    paymentId: decoded.paymentId,
    receivingIdentity: decoded.identity,
    grossPiconeros: canonical(grossPiconeros),
    actualPiconeros: canonical(actualPiconeros)
  }
}

function sortMembers (members) {
  return [...members].sort((a, b) => {
    const aId = BigInt(a.id)
    const bId = BigInt(b.id)
    if (aId !== bId) return aId < bId ? -1 : 1
    return a.leg < b.leg ? -1 : a.leg > b.leg ? 1 : 0
  })
}

function deriveAggregates (members) {
  const totals = new Map()
  for (const member of members) {
    totals.set(member.receivingIdentity, (totals.get(member.receivingIdentity) ?? 0n) + BigInt(member.actualPiconeros))
  }
  return [...totals.entries()]
    .map(([receivingIdentity, amountPiconeros]) => ({ receivingIdentity, amountPiconeros: amountPiconeros.toString() }))
    .sort((a, b) => (a.receivingIdentity < b.receivingIdentity ? -1 : a.receivingIdentity > b.receivingIdentity ? 1 : 0))
}

const feeLeg = (member, gross, actual) => ({
  memberId: member.id,
  leg: member.leg,
  grossPiconeros: canonical(gross),
  actualPiconeros: canonical(actual)
})

// Every actual destination must be attributable to the contracted members
// while every member obligation survives (final-review I5): members may SHARE
// one destination address, so matching is per CANONICAL DESTINATION AGGREGATE
// — one destination per address with the summed amount, or several entries
// for the same address summing to it, must both be accepted. The fee-
// subtracted actual amounts still match the correct legs: each member keeps
// its exact contracted actual amount and the per-address sums must be exact.
// Only a genuinely unattributable destination (no member claims its address,
// or a sum drifts) is refused.
function assertDestinationsMatchMembers (built, members) {
  const destinationTotals = new Map()
  for (const destination of built.destinations) {
    destinationTotals.set(
      destination.address,
      (destinationTotals.get(destination.address) ?? 0n) + destination.amountPiconeros
    )
  }
  const memberTotals = new Map()
  for (const member of members) {
    memberTotals.set(
      member.address,
      (memberTotals.get(member.address) ?? 0n) + BigInt(member.actualPiconeros)
    )
  }
  if (destinationTotals.size !== memberTotals.size) fail(OWNER_CONFLICT)
  for (const [address, total] of destinationTotals) {
    if (memberTotals.get(address) !== total) fail(OWNER_CONFLICT)
  }
}

function deriveClaims ({ owner, built, scope, dispatchId }) {
  const network = scope.network
  const change = built.changeAddress === null
    ? null
    : {
        accountIndex: owner.journalRole === 'REWARDS' ? String(owner.accountIndex) : '0',
        subaddressIndex: '0',
        address: built.changeAddress
      }
  const base = {
    application: 'stashernews/monero/payment',
    bindingVersion: '1',
    captureContractVersion: '1',
    dispatchId,
    journalRole: owner.journalRole,
    scope: { network, walletAddress: scope.walletAddress },
    txHash: built.txHash,
    sourceAccounts: [String(owner.journalRole === 'REWARDS' ? owner.accountIndex : 0)],
    distributionId: owner.journalRole === 'REWARDS' && owner.distributionId != null
      ? String(owner.distributionId)
      : null,
    bountyPaymentId: owner.journalRole === 'ESCROW' ? String(owner.bountyPaymentId) : null,
    itemId: owner.journalRole === 'ESCROW' ? String(owner.itemId) : null,
    networkFeePiconeros: built.networkFeePiconeros.toString(),
    frozenTerms: owner.journalRole === 'ESCROW' ? owner.frozenTerms : null,
    ownedTargets: [],
    change
  }

  if (owner.journalRole === 'ESCROW') {
    if (owner.leg === 'LEGACY_SEPARATE_FEE') {
      // The pre-2026-09-18 separate fee tx: the frozen fee destination
      // receives the FULL fee (no subtraction), exactly one destination.
      const fee = BigInt(owner.frozenTerms.feePiconeros)
      const member = memberFor(owner.bountyPaymentId, 'LEGACY_SEPARATE_FEE',
        owner.frozenTerms.feeRecipientAddress, network, fee, fee)
      assertDestinationsMatchMembers(built, [member])
      return normalizePaymentClaims({
        ...base,
        kind: owner.kind,
        principalPiconeros: fee.toString(),
        members: [member],
        feePolicy: { mode: 'NONE', legs: [feeLeg(member, fee, fee)] },
        receivingAggregates: deriveAggregates([member])
      })
    }
    // Disposition: the prize always; the fee rides in the same tx when frozen,
    // subtracted from the LAST destination (destination-ordered fee legs).
    const prize = BigInt(owner.frozenTerms.prizePiconeros)
    const fee = BigInt(owner.frozenTerms.feePiconeros)
    if (fee === 0n) {
      if (prize <= built.networkFeePiconeros) fail(OWNER_CONFLICT)
      const actual = prize - built.networkFeePiconeros
      const member = memberFor(owner.bountyPaymentId, 'PRINCIPAL',
        owner.frozenTerms.recipientAddress, network, prize, actual)
      assertDestinationsMatchMembers(built, [member])
      return normalizePaymentClaims({
        ...base,
        kind: owner.kind,
        principalPiconeros: prize.toString(),
        members: [member],
        feePolicy: { mode: 'SUBTRACT_LAST', legs: [feeLeg(member, prize, actual)] },
        receivingAggregates: deriveAggregates([member])
      })
    }
    if (fee <= built.networkFeePiconeros) fail(OWNER_CONFLICT)
    const feeActual = fee - built.networkFeePiconeros
    const prizeMember = memberFor(owner.bountyPaymentId, 'PRINCIPAL',
      owner.frozenTerms.recipientAddress, network, prize, prize)
    const feeMember = memberFor(owner.bountyPaymentId, 'FEE',
      owner.frozenTerms.feeRecipientAddress, network, fee, feeActual)
    const members = sortMembers([prizeMember, feeMember])
    assertDestinationsMatchMembers(built, members)
    // Fee-policy legs stay in DESTINATION order (the order SUBTRACT_LAST
    // subtracts from): the built tx carries the prize first, fee last. Two
    // members may SHARE one address: visit each address once, preserving
    // contractual prize-before-fee order within a merged destination.
    const legs = [...new Set(built.destinations.map(destination => destination.address))]
      .flatMap(address => [prizeMember, feeMember]
        .filter(member => member.address === address)
        .map(member => feeLeg(member, member.leg === 'PRINCIPAL' ? prize : fee, BigInt(member.actualPiconeros))))
    if (legs.length !== members.length) fail(OWNER_CONFLICT)
    return normalizePaymentClaims({
      ...base,
      kind: owner.kind,
      principalPiconeros: (prize + fee).toString(),
      members,
      feePolicy: { mode: 'SUBTRACT_LAST', legs },
      receivingAggregates: deriveAggregates(members)
    })
  }

  // REWARDS journal owners.
  if (owner.kind === 'CONSOLIDATION') {
    const destination = owner.metadata.destination
    let total = 0n
    for (const out of built.destinations) {
      if (out.address !== destination) fail(OWNER_CONFLICT)
      total += out.amountPiconeros
    }
    if (total <= 0n) fail(TX_INVALID)
    return normalizePaymentClaims({
      ...base,
      kind: 'CONSOLIDATION',
      principalPiconeros: '0',
      members: [],
      feePolicy: { mode: 'NONE', legs: [] },
      receivingAggregates: [],
      // The consolidation target is the DESTINATION's derived position —
      // production consolidations pay the wallet primary address (account 0,
      // subaddress 0) regardless of which source account was swept
      // (final-review I6).
      ownedTargets: [{
        accountIndex: '0',
        subaddressIndex: '0',
        address: destination,
        amountPiconeros: total.toString()
      }]
    })
  }

  if (owner.kind === 'OPS_SWEEP') {
    const principal = owner.principalPiconeros
    const member = memberFor(1, 'PRINCIPAL', owner.metadata.destination, network, principal, principal)
    assertDestinationsMatchMembers(built, [member])
    return normalizePaymentClaims({
      ...base,
      kind: 'OPS_SWEEP',
      principalPiconeros: principal.toString(),
      members: [member],
      feePolicy: { mode: 'NONE', legs: [feeLeg(member, principal, principal)] },
      receivingAggregates: deriveAggregates([member])
    })
  }

  // PAYOUT: exact batch amounts with NO fee subtraction (the change output
  // absorbs the network fee); every payout is one PRINCIPAL member keyed by
  // its payoutId.
  const members = sortMembers(owner.metadata.payouts.map(payout =>
    memberFor(payout.payoutId, 'PRINCIPAL', payout.recipientAddress, network, payout.piconeros, payout.piconeros)))
  assertDestinationsMatchMembers(built, members)
  return normalizePaymentClaims({
    ...base,
    kind: 'PAYOUT',
    principalPiconeros: owner.principalPiconeros.toString(),
    members,
    feePolicy: {
      mode: 'NONE',
      legs: members.map(member => feeLeg(member, member.grossPiconeros, member.actualPiconeros))
    },
    receivingAggregates: deriveAggregates(members)
  })
}

// --- DB owner-fact readers ------------------------------------------------------

function journalModel (client, journalRole) {
  const model = journalRole === 'REWARDS'
    ? client.rewardsWalletTransaction
    : client.escrowWalletTransaction
  if (!model || typeof model.findUnique !== 'function') fail(INVALID)
  return model
}

async function readEscrowPayout (client, owner) {
  const payout = await client.bountyPayment.findUnique({ where: { id: owner.bountyPaymentId } })
  if (!payout || payout.itemId !== owner.itemId) fail(OWNER_CONFLICT)
  // The live disposition KIND is a material owner fact: a live row whose kind
  // diverged from the captured expectation must never receive captured
  // settlement facts (final-review I11). Scoped to the DISPOSITION leg — the
  // LEGACY_SEPARATE_FEE leg's journal kind is the leg name, while the live
  // row keeps its disposition kind.
  if (owner.leg === 'DISPOSITION' && payout.kind !== owner.kind) fail(OWNER_CONFLICT)
  const requestedFee = payout.kind === 'ROLLOVER' ? 0n : money(payout.feePiconeros)
  const terms = owner.frozenTerms
  if (payout.recipientAddress !== terms.recipientAddress) fail(OWNER_CONFLICT)
  if (money(payout.piconeros) !== BigInt(terms.prizePiconeros)) fail(OWNER_CONFLICT)
  if (requestedFee !== BigInt(terms.feePiconeros)) fail(OWNER_CONFLICT)
  // The frozen fee destination is compared in BOTH directions — a fee-less
  // contract must not accept a live row carrying a divergent fee address
  // either (final-review I11).
  if ((payout.feeRecipientAddress ?? null) !== terms.feeRecipientAddress) fail(OWNER_CONFLICT)
  if (owner.leg === 'LEGACY_SEPARATE_FEE' &&
    (requestedFee <= 0n || !payout.txHash || payout.feeTxHash != null || payout.feePendingAt == null)) {
    fail(OWNER_CONFLICT)
  }
  return payout
}

async function assertEscrowDispatchable (payout, owner) {
  if (owner.leg === 'LEGACY_SEPARATE_FEE') {
    // The deferred-fee retry path: the prize already relayed, the fee not yet.
    // The fee may settle while the prize payout is still SENT OR after it
    // matured to CONFIRMED (the change can unlock after the payout matures, so
    // stopping at CONFIRMED would strand the fee in escrow forever — matching
    // the worker/send contract that re-offers deferred fees for SENT and
    // CONFIRMED payouts alike). This exception is scoped to the fee leg only:
    // a CONFIRMED payout's DISPOSITION leg is still refused below (a confirmed
    // prize must never be re-dispatched).
    if (payout.state !== 'SENT' && payout.state !== 'CONFIRMED') fail(OWNER_CONFLICT)
    return
  }
  if (payout.state !== 'QUEUED') fail(OWNER_CONFLICT)
}

// The frozen participant contract: every payout in the batch must still be the
// QUEUED reward it was contracted as when the dispatch was planned.
async function assertRewardsParticipants (client, owner) {
  if (owner.kind !== 'PAYOUT' || owner.distributionId == null) return
  for (const payout of owner.metadata.payouts) {
    const row = await client.rewardPayout.findUnique({ where: { id: payout.payoutId } })
    if (!row || row.distributionId !== owner.distributionId ||
      row.recipientAddress !== payout.recipientAddress ||
      money(row.piconeros) !== payout.piconeros ||
      row.state !== 'QUEUED') fail(OWNER_CONFLICT)
  }
}

// --- pair writing ----------------------------------------------------------------

function journalData ({ owner, scope, built, claims, claimDigest, dispatchId, proofId, metadata }) {
  const shared = {
    network: scope.network,
    walletAddress: scope.walletAddress,
    txHash: built.txHash,
    dispatchId,
    proofId,
    captureContractVersion: CAPTURE_CONTRACT_VERSION,
    claimDigest,
    paymentClaims: claims,
    principalPiconeros: BigInt(claims.principalPiconeros),
    networkFeePiconeros: built.networkFeePiconeros
  }
  if (owner.journalRole === 'REWARDS') {
    return { ...shared, kind: owner.kind, accountIndex: owner.accountIndex, distributionId: owner.distributionId, metadata }
  }
  return {
    ...shared,
    kind: owner.kind,
    leg: owner.leg,
    bountyPaymentId: owner.bountyPaymentId,
    itemId: owner.itemId,
    accountIndex: 0,
    metadata: { bountyPaymentId: owner.bountyPaymentId, itemId: owner.itemId, leg: owner.leg }
  }
}

function proofData (envelope, proofId, journalId, journalRole) {
  const data = {
    id: proofId,
    revision: 1,
    masterKeyVersion: envelope.masterKeyVersion,
    bindingVersion: Number(envelope.bindingVersion),
    envelopeVersion: Number(envelope.envelopeVersion),
    payloadVersion: Number(envelope.payloadVersion),
    claimDigest: envelope.claimDigest,
    bindingDigest: envelope.bindingDigest,
    dataNonce: Buffer.from(envelope.dataNonce),
    dataTag: Buffer.from(envelope.dataTag),
    ciphertext: Buffer.from(envelope.ciphertext),
    wrapNonce: Buffer.from(envelope.wrapNonce),
    wrapTag: Buffer.from(envelope.wrapTag),
    wrappedDek: Buffer.from(envelope.wrappedDek)
  }
  if (journalRole === 'REWARDS') data.rewardsJournalId = journalId
  else data.escrowJournalId = journalId
  return data
}

// --- envelopes / capture authentication ------------------------------------------

function envelopeFromProofRow (proof) {
  return {
    envelopeVersion: String(proof.envelopeVersion),
    payloadVersion: String(proof.payloadVersion),
    bindingVersion: String(proof.bindingVersion),
    masterKeyVersion: proof.masterKeyVersion,
    claimDigest: proof.claimDigest,
    bindingDigest: proof.bindingDigest,
    dataNonce: Buffer.from(proof.dataNonce),
    dataTag: Buffer.from(proof.dataTag),
    ciphertext: Buffer.from(proof.ciphertext),
    wrapNonce: Buffer.from(proof.wrapNonce),
    wrapTag: Buffer.from(proof.wrapTag),
    wrappedDek: Buffer.from(proof.wrappedDek)
  }
}

const hex = value => Buffer.from(value).toString('hex')

// Integrity digest over the STORED envelope bytes (never the bytes themselves):
// out-of-band ciphertext or header changes invalidate review, while rotation
// simply moves this digest (the claim digest stays).
function envelopeIntegrityDigest (proof) {
  return createHash('sha256')
    .update(INVENTORY_DIGEST_DOMAIN)
    .update(canonicalPaymentJson({
      bindingVersion: String(proof.bindingVersion),
      masterKeyVersion: String(proof.masterKeyVersion),
      envelopeVersion: String(proof.envelopeVersion),
      payloadVersion: String(proof.payloadVersion),
      claimDigest: proof.claimDigest,
      bindingDigest: proof.bindingDigest,
      dataNonceHex: hex(proof.dataNonce),
      dataTagHex: hex(proof.dataTag),
      ciphertextHex: hex(proof.ciphertext),
      wrapNonceHex: hex(proof.wrapNonce),
      wrapTagHex: hex(proof.wrapTag),
      wrappedDekHex: hex(proof.wrappedDek)
    }), 'utf8')
    .digest('hex')
}

// The plan's locked proofInventory shape: safe metadata + integrity digests,
// never envelope bytes.
function inventoryFor (proof) {
  return {
    proofId: proof.id,
    revision: proof.revision,
    masterKeyVersion: proof.masterKeyVersion,
    bindingVersion: proof.bindingVersion,
    envelopeVersion: proof.envelopeVersion,
    payloadVersion: proof.payloadVersion,
    claimDigest: proof.claimDigest,
    bindingDigest: proof.bindingDigest,
    envelopeIntegrityDigest: envelopeIntegrityDigest(proof)
  }
}

function assertOwnerLink (journal, proof, journalRole) {
  if (!proof) fail(CAPTURE_MISMATCH)
  const link = journalRole === 'REWARDS' ? proof.rewardsJournalId : proof.escrowJournalId
  if (link !== journal.id || proof.claimDigest !== journal.claimDigest) fail(CAPTURE_MISMATCH)
}

// Journal metadata is stored in the existing closed union (piconeros as
// decimal strings); normalize it back into the derivation shape.
function normalizeStoredMetadata (kind, metadata) {
  if (!metadata || typeof metadata !== 'object') fail(CAPTURE_MISMATCH)
  if (kind === 'PAYOUT') {
    if (!Array.isArray(metadata.payouts)) fail(CAPTURE_MISMATCH)
    return {
      payouts: [...metadata.payouts].map(payout => ({
        payoutId: payout.payoutId,
        recipientAddress: payout.recipientAddress,
        piconeros: money(payout.piconeros)
      }))
    }
  }
  if (kind === 'OPS_SWEEP') return { destination: metadata.destination }
  return { destination: metadata.destination, selfTransfer: metadata.selfTransfer === true }
}

// Built facts as captured by the proof payload itself (used to re-derive the
// expected claims WITHOUT any caller input — the load-time capture gate).
// Public built fields stay explicit null when the SDK never populated them;
// the unavailable change amount stays explicit null (never a coerced 0).
function builtFromPayload (payload) {
  const built = payload.builtStructure
  return {
    txHash: built.txHash,
    networkFeePiconeros: BigInt(built.networkFeePiconeros),
    destinations: built.actualDestinations.map(destination => ({
      address: destination.address,
      amountPiconeros: BigInt(destination.amountPiconeros)
    })),
    changeAddress: built.changeAddress,
    changeAmountPiconeros: built.changeAmountPiconeros === null || built.changeAmountPiconeros === undefined
      ? null
      : BigInt(built.changeAmountPiconeros),
    mainPublicKey: built.mainPublicKey ?? null,
    additionalPublicKeys: built.additionalPublicKeys ?? null,
    outputKeys: built.outputKeys ?? null,
    additionalKeyCount: payload.additionalKeyCount,
    keyBundleHex: payload.keyBundleHex
  }
}

const isCompleteCapture = (journal, journalRole) =>
  journal.dispatchId != null && journal.captureContractVersion != null &&
  journal.claimDigest != null && journal.paymentClaims != null && journal.proofId != null

/**
 * Reconstructs the authoritative claims for a stored owner row and
 * authenticates its proof end to end: stored claims vs journal columns, claim
 * digest vs journal and proof, envelope authentication against the
 * reconstructed claims, and a full re-derivation of the claims from the row's
 * own captured facts (payload built structure). Uses NO caller input, so it is
 * equally the load-time gate and the locked pre-CAS re-authentication.
 */
async function authenticateOwnerPair (client, journal, journalRole, keyProvider) {
  if (journalRole === 'REWARDS' && !isCompleteCapture(journal, journalRole)) fail(LEGACY_MISSING)
  const proof = await client.paymentTransactionProof.findUnique({ where: { id: journal.proofId } })
  assertOwnerLink(journal, proof, journalRole)

  const storedClaims = normalizePaymentClaims(journal.paymentClaims)
  if (storedClaims.dispatchId !== journal.dispatchId ||
    storedClaims.txHash !== journal.txHash ||
    storedClaims.scope.network !== journal.network ||
    storedClaims.scope.walletAddress !== journal.walletAddress ||
    storedClaims.journalRole !== journalRole) fail(CAPTURE_MISMATCH)
  if (journalRole === 'REWARDS' &&
    (storedClaims.kind !== journal.kind ||
      storedClaims.principalPiconeros !== journal.principalPiconeros.toString())) fail(CAPTURE_MISMATCH)
  const storedDigest = paymentClaimDigest(storedClaims)
  if (storedDigest !== journal.claimDigest || storedDigest !== proof.claimDigest) fail(CAPTURE_MISMATCH)
  const payload = openPaymentProof({ claims: storedClaims, envelope: envelopeFromProofRow(proof), keyProvider })
  if (payload.builtStructure.txHash !== storedClaims.txHash ||
    payload.builtStructure.networkFeePiconeros !== storedClaims.networkFeePiconeros) fail(CAPTURE_MISMATCH)

  // Capture integrity: the claims tuple must be exactly what the journal row's
  // own columns plus the captured built facts imply.
  const ownerFacts = journalRole === 'REWARDS'
    ? {
        journalRole: 'REWARDS',
        kind: journal.kind,
        accountIndex: journal.accountIndex,
        distributionId: journal.distributionId,
        principalPiconeros: money(journal.principalPiconeros),
        metadata: normalizeStoredMetadata(journal.kind, journal.metadata)
      }
    : {
        journalRole: 'ESCROW',
        kind: journal.kind,
        leg: journal.leg,
        bountyPaymentId: journal.bountyPaymentId,
        itemId: journal.itemId,
        frozenTerms: storedClaims.frozenTerms,
        settlement: null
      }
  const derived = deriveClaims({
    owner: ownerFacts,
    built: builtFromPayload(payload),
    scope: { network: journal.network, walletAddress: journal.walletAddress },
    dispatchId: journal.dispatchId
  })
  if (paymentClaimDigest(derived) !== journal.claimDigest) fail(CAPTURE_MISMATCH)
  return { claims: storedClaims, payload, proof, claimDigest: journal.claimDigest }
}

const toJournalId = journalId => {
  let id
  try {
    id = BigInt(journalId)
  } catch {
    fail(INVALID)
  }
  if (id < 0n) fail(INVALID)
  return id
}

// DB-only idempotent preparation may retry a concurrent serialization/unique
// conflict (Prisma P2002/P2034, raw 23505/40001). Relay is never retried here.
const isRetryablePreparationConflict = err =>
  isUniqueViolation(err) ||
  err?.code === 'P2034' ||
  err?.cause?.code === 'P2034' ||
  err?.code === '40001' ||
  err?.cause?.code === '40001' ||
  /could not serialize access/i.test(String(err?.message || ''))

const isSerializationConflict = err =>
  err?.code === 'P2034' ||
  err?.cause?.code === 'P2034' ||
  err?.code === '40001' ||
  err?.cause?.code === '40001' ||
  /could not serialize access/i.test(String(err?.message || ''))

// --- locked exports ------------------------------------------------------------

/**
 * Durable atomic preparation of one payment: derives the immutable claims from
 * frozen DB owner facts plus the built transaction, seals the proof envelope
 * OUTSIDE any transaction, then lands the journal row + proof row together in
 * ONE Serializable `synchronous_commit = on` transaction. Returns
 * `{ journal, proofId, revision, claimDigest, dispatchId, created }`.
 *
 * An existing scoped (network, walletAddress, txHash) owner owns its ORIGINAL
 * dispatchId: identical preparation re-adopts it, re-authenticates its
 * envelope and returns it unchanged (`created: false`); differing immutable
 * claims refuse with PAYMENT_PROOF_OWNER_CONFLICT. A thrown result — including
 * an UNKNOWN commit outcome — authorizes NO relay until a fresh complete pair
 * read authenticates the same hash/claims.
 *
 * @param {{models: object, wallet: object, tx: object, owner: object, keyProvider: object}} request
 * @returns {Promise<{journal: object, proofId: string, revision: number, claimDigest: string, dispatchId: string, created: boolean}>}
 */
export async function preparePaymentDispatch (request) {
  const { models, wallet, tx, owner, keyProvider } = request ?? {}
  if (!models || typeof models.$transaction !== 'function') fail(INVALID)
  const ownerFacts = validateOwner(owner)
  const scope = await resolveWalletScope(wallet)
  const built = await readBuiltTx(tx)
  if (ownerFacts.journalRole === 'ESCROW' && ownerFacts.settlement !== null &&
    ownerFacts.settlement.networkFeePiconeros !== built.networkFeePiconeros.toString()) {
    fail(OWNER_CONFLICT)
  }
  // One candidate identity per preparation: minted outside the retry loop so
  // retries can never invent a second dispatch for the same built tx.
  const candidateDispatchId = randomUUID().toLowerCase()
  const proofId = randomUUID().toLowerCase()

  // Claims + envelope are derived and sealed OUTSIDE any transaction; the
  // Serializable transaction below re-validates every frozen fact before the
  // sealed pair may land.
  let claims
  let claimDigest
  try {
    claims = deriveClaims({ owner: ownerFacts, built, scope, dispatchId: candidateDispatchId })
    claimDigest = paymentClaimDigest(claims)
  } catch (err) {
    const code = String(err?.message || '')
    if (code.startsWith('PAYMENT_PROOF_')) throw err
    // Codec refusals on caller-derived expectations are conflicts with the
    // frozen contract, not corruption.
    if (code.startsWith('PAYMENT_CLAIMS_')) fail(OWNER_CONFLICT)
    throw err
  }
  const payload = buildPayload(built)
  const envelope = sealPaymentProof({ claims, payload, keyProvider })
  if (envelope.claimDigest !== claimDigest) fail(CAPTURE_MISMATCH)

  for (let attempt = 1; ; attempt++) {
    try {
      return await models.$transaction(async client => {
        await client.$executeRaw`SET LOCAL synchronous_commit = on`
        const shown = await client.$queryRaw`SHOW synchronous_commit`
        if (shown?.[0]?.synchronous_commit !== 'on') fail(DURABILITY_REFUSED)

        const existing = await journalModel(client, ownerFacts.journalRole).findUnique({
          where: {
            network_walletAddress_txHash: {
              network: scope.network,
              walletAddress: scope.walletAddress,
              txHash: built.txHash
            }
          }
        })
        if (existing) {
          // The scoped row owns its ORIGINAL dispatchId: reconstruct the
          // expected claims with THAT UUID and compare every other payment
          // fact and the exact built key bundle. A concurrent winner's UUID is
          // adopted identically on a DB-only retry — identical preparation
          // never conflicts and never replaces identity.
          if (ownerFacts.journalRole === 'REWARDS' &&
            (existing.dispatchId == null || existing.proofId == null)) fail(LEGACY_OWNER)
          const reconstructed = deriveClaims({
            owner: ownerFacts,
            built,
            scope,
            dispatchId: existing.dispatchId
          })
          if (paymentClaimDigest(reconstructed) !== existing.claimDigest) fail(OWNER_CONFLICT)
          const proof = await client.paymentTransactionProof.findUnique({ where: { id: existing.proofId } })
          assertOwnerLink(existing, proof, ownerFacts.journalRole)
          const payloadOpened = openPaymentProof({
            claims: reconstructed,
            envelope: envelopeFromProofRow(proof),
            keyProvider
          })
          assertPayloadMatchesBuilt(payloadOpened, built)
          return {
            journal: existing,
            proofId: proof.id,
            revision: proof.revision,
            claimDigest: existing.claimDigest,
            dispatchId: existing.dispatchId,
            created: false
          }
        }

        // Create path: re-validate the CURRENT participant contracts (rewards)
        // / frozen escrow terms + fee destination (escrow), then land the pair.
        if (ownerFacts.journalRole === 'REWARDS') {
          await assertRewardsParticipants(client, ownerFacts)
        } else {
          const legRow = await client.escrowWalletTransaction.findUnique({
            where: {
              network_walletAddress_bountyPaymentId_leg: {
                network: scope.network,
                walletAddress: scope.walletAddress,
                bountyPaymentId: ownerFacts.bountyPaymentId,
                leg: ownerFacts.leg
              }
            }
          })
          // One tx per escrow leg: an attempted (or any existing) leg can
          // never gain a competing txHash.
          if (legRow) fail(OWNER_CONFLICT)
          const payout = await readEscrowPayout(client, ownerFacts)
          await assertEscrowDispatchable(payout, ownerFacts)
        }

        let journal
        if (ownerFacts.journalRole === 'REWARDS') {
          journal = await client.rewardsWalletTransaction.create({
            data: journalData({
              owner: ownerFacts,
              scope,
              built,
              claims,
              claimDigest,
              dispatchId: candidateDispatchId,
              proofId,
              metadata: ownerFacts.metadata
            })
          })
        } else {
          journal = await client.escrowWalletTransaction.create({
            data: journalData({
              owner: ownerFacts,
              scope,
              built,
              claims,
              claimDigest,
              dispatchId: candidateDispatchId,
              proofId
            })
          })
        }
        await client.paymentTransactionProof.create({
          data: proofData(envelope, proofId, journal.id, ownerFacts.journalRole)
        })
        // The landed capture must read back complete and bidirectionally
        // linked (the deferred triggers re-check this again at COMMIT).
        const persisted = await journalModel(client, ownerFacts.journalRole).findUnique({ where: { id: journal.id } })
        if (!persisted || !isCompleteCapture(persisted, ownerFacts.journalRole) ||
          persisted.proofId !== proofId || persisted.dispatchId !== candidateDispatchId ||
          persisted.claimDigest !== claimDigest) fail(CAPTURE_MISMATCH)
        return {
          journal: persisted,
          proofId,
          revision: 1,
          claimDigest,
          dispatchId: candidateDispatchId,
          created: true
        }
      }, { isolationLevel: 'Serializable' })
    } catch (err) {
      if (attempt >= PREPARE_CONFLICT_RETRIES || !isRetryablePreparationConflict(err)) throw err
      logWarn({ txHash: built.txHash, attempt }, 'preparePaymentDispatch: retrying a DB-only preparation conflict')
    }
  }
}

/**
 * Authoritative read-only load of one captured payment: reconstructs the
 * expected claims from the journal row + authoritative captured facts,
 * compares them to the immutable capture (claimDigest + binding) and
 * authenticates the envelope with real crypto. Returns
 * `{ journal, claims, payload, inventory }`. A legacy journal row (no capture
 * tuple) refuses with the fixed `LEGACY_PROOF_MISSING` code — never an empty
 * bundle. Never writes, never overwrites a proof.
 *
 * @param {{models: object, journalRole: 'REWARDS'|'ESCROW', journalId: BigInt|string|number, keyProvider: object}} request
 * @returns {Promise<{journal: object, claims: object, payload: object, inventory: object}>}
 */
export async function loadPaymentProof (request) {
  const { models, journalRole, journalId, keyProvider } = request ?? {}
  if (!models || (journalRole !== 'REWARDS' && journalRole !== 'ESCROW')) fail(INVALID)
  const journal = await journalModel(models, journalRole).findUnique({ where: { id: toJournalId(journalId) } })
  if (!journal) fail(NOT_PREPARED)
  const { claims, payload, proof } = await authenticateOwnerPair(models, journal, journalRole, keyProvider)
  return { journal, claims, payload, inventory: inventoryFor(proof) }
}

/**
 * Asserts that `journalId` holds an authentic prepared pair for EXACTLY the
 * built transaction `tx` (same hash, same claims, same key bundle, same built
 * structure) and returns `{ journal, proofId, revision, claimDigest }`. This
 * is private authorization for the next relay step, not a JSON permission.
 *
 * @param {{models: object, wallet: object, tx: object, journalRole: 'REWARDS'|'ESCROW', journalId: BigInt|string|number, keyProvider: object}} request
 * @returns {Promise<{journal: object, proofId: string, revision: number, claimDigest: string}>}
 */
export async function assertPreparedPayment (request) {
  const { models, wallet, tx, journalRole, journalId, keyProvider } = request ?? {}
  if (!models || (journalRole !== 'REWARDS' && journalRole !== 'ESCROW')) fail(INVALID)
  const scope = await resolveWalletScope(wallet)
  const built = await readBuiltTx(tx)
  const journal = await journalModel(models, journalRole).findUnique({ where: { id: toJournalId(journalId) } })
  if (!journal || (journalRole === 'REWARDS' && !isCompleteCapture(journal, journalRole))) fail(NOT_PREPARED)
  if (journal.network !== scope.network || journal.walletAddress !== scope.walletAddress ||
    journal.txHash !== built.txHash) fail(CAPTURE_MISMATCH)
  const { proof, claimDigest, payload } = await authenticateOwnerPair(models, journal, journalRole, keyProvider)
  assertPayloadMatchesBuilt(payload, built)
  return { journal, proofId: proof.id, revision: proof.revision, claimDigest }
}

/**
 * Claims the SINGLE relay attempt with a CAS inside a DB-only Serializable
 * transaction: locks the journal + proof rows, RE-authenticates the pair,
 * verifies the caller's built tx, compares `expectedProof`
 * ({proofId, revision, claimDigest}) against the locked rows (and re-verifies
 * the proof revision inside the same transaction), then flips exactly
 * `state = 'PREPARED' AND relayAttemptedAt IS NULL` to `relayAttemptedAt`.
 * Returns the acknowledged attempt
 * `{ journal, proofId, revision, claimDigest, relayAttemptedAt }`; any claim
 * failure, already-attempted row, or stale expectedProof refuses with the
 * fixed PAYMENT_PROOF_ATTEMPT_CONFLICT code.
 *
 * @param {{models: object, wallet: object, tx: object, journalRole: 'REWARDS'|'ESCROW', journalId: BigInt|string|number, keyProvider: object, expectedProof: {proofId: string, revision: number, claimDigest: string}}} request
 * @returns {Promise<{journal: object, proofId: string, revision: number, claimDigest: string, relayAttemptedAt: Date}>}
 */
export async function claimPaymentAttempt (request) {
  const { models, wallet, tx, journalRole, journalId, keyProvider, expectedProof } = request ?? {}
  if (!models || typeof models.$transaction !== 'function' ||
    (journalRole !== 'REWARDS' && journalRole !== 'ESCROW')) fail(INVALID)
  if (!expectedProof || typeof expectedProof !== 'object' ||
    typeof expectedProof.proofId !== 'string' ||
    !Number.isSafeInteger(expectedProof.revision) || expectedProof.revision <= 0 ||
    typeof expectedProof.claimDigest !== 'string' || !HEX_64.test(expectedProof.claimDigest)) fail(INVALID)
  const scope = await resolveWalletScope(wallet)
  const built = await readBuiltTx(tx)
  const id = toJournalId(journalId)
  const table = JOURNAL_TABLES[journalRole]

  for (let attempt = 1; ; attempt++) {
    try {
      return await models.$transaction(async client => {
        // Durability parity with the prepare transaction (final-review I10):
        // a relay attempt marker that can vanish under async commit would
        // make a broadcast look never-attempted after a crash.
        await client.$executeRaw`SET LOCAL synchronous_commit = on`
        const shown = await client.$queryRaw`SHOW synchronous_commit`
        if (shown?.[0]?.synchronous_commit !== 'on') fail(DURABILITY_REFUSED)
        // Lock the journal row first: concurrent claimants serialize here and
        // a serialization loser retries into the already-attempted refusal.
        const locked = await client.$queryRawUnsafe(
          `SELECT * FROM "${table}" WHERE id = $1 FOR UPDATE`, id)
        const journal = locked?.[0]
        if (!journal || (journalRole === 'REWARDS' && !isCompleteCapture(journal, journalRole))) fail(NOT_PREPARED)
        if (journal.network !== scope.network || journal.walletAddress !== scope.walletAddress ||
          journal.txHash !== built.txHash) fail(CAPTURE_MISMATCH)
        await client.$queryRawUnsafe(
          'SELECT id FROM "PaymentTransactionProof" WHERE id = $1::uuid FOR UPDATE', journal.proofId)
        const authenticated = await authenticateOwnerPair(client, journal, journalRole, keyProvider)
        assertPayloadMatchesBuilt(authenticated.payload, built)
        if (expectedProof.proofId !== authenticated.proof.id ||
          expectedProof.revision !== authenticated.proof.revision ||
          expectedProof.claimDigest !== authenticated.proof.claimDigest) fail(ATTEMPT_CONFLICT)

        const claimed = await journalModel(client, journalRole).updateMany({
          where: { id: journal.id, state: 'PREPARED', relayAttemptedAt: null },
          data: { relayAttemptedAt: new Date() }
        })
        if (claimed.count !== 1) fail(ATTEMPT_CONFLICT)
        // The proof revision must be unchanged inside this same transaction.
        const reread = await client.$queryRawUnsafe(
          'SELECT revision FROM "PaymentTransactionProof" WHERE id = $1::uuid FOR UPDATE', journal.proofId)
        if (reread?.[0]?.revision !== expectedProof.revision) fail(ATTEMPT_CONFLICT)
        const fresh = await journalModel(client, journalRole).findUnique({ where: { id: journal.id } })
        return {
          journal: fresh,
          proofId: authenticated.proof.id,
          revision: authenticated.proof.revision,
          claimDigest: authenticated.claimDigest,
          relayAttemptedAt: fresh.relayAttemptedAt
        }
      }, { isolationLevel: 'Serializable' })
    } catch (err) {
      if (attempt >= PREPARE_CONFLICT_RETRIES || !isSerializationConflict(err)) throw err
      logWarn({ journalId: id.toString(), attempt }, 'claimPaymentAttempt: retrying a DB serialization conflict')
    }
  }
}

/**
 * Safe proof inventory for the given owner selectors
 * (`{journalRole, journalId}` list or single object): one
 * `{proofId, revision, masterKeyVersion, bindingVersion, envelopeVersion,
 * payloadVersion, claimDigest, bindingDigest, envelopeIntegrityDigest}`
 * record per selector, or `null` for a missing pair / legacy row. The
 * integrity digest is computed over the stored envelope bytes so out-of-band
 * ciphertext changes invalidate review; envelope bytes, nonces, tags,
 * ciphertext and wrapped DEKs NEVER leave this module through this surface.
 * Full-envelope SELECTs stay private to this store (and the rotation task).
 *
 * @param {object} models Prisma client (or a transactional client)
 * @param {Array<{journalRole: 'REWARDS'|'ESCROW', journalId: BigInt|string|number}>|{journalRole: 'REWARDS'|'ESCROW', journalId: BigInt|string|number}} ownerSelectors
 * @returns {Promise<Array<object|null>>} inventory records aligned with the selectors
 */
export async function readPaymentProofInventory (models, ownerSelectors) {
  if (!models) fail(INVALID)
  const selectors = Array.isArray(ownerSelectors) ? ownerSelectors : [ownerSelectors]
  const results = []
  for (const selector of selectors) {
    const { journalRole, journalId } = selector ?? {}
    if (journalRole !== 'REWARDS' && journalRole !== 'ESCROW') fail(INVALID)
    const journal = await journalModel(models, journalRole).findUnique({
      where: { id: toJournalId(journalId) },
      select: { proofId: true, claimDigest: true }
    })
    if (!journal?.proofId) {
      results.push(null)
      continue
    }
    const proof = await models.paymentTransactionProof.findUnique({ where: { id: journal.proofId } })
    if (!proof || proof.claimDigest !== journal.claimDigest) {
      results.push(null)
      continue
    }
    results.push(inventoryFor(proof))
  }
  return results
}
