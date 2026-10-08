// Strict raw-chain and restored-ownership adapter (Finding #1, Task 4).
//
// `collectPaymentChainEvidence` builds the private, secret-free evidence
// session the payment verifier (Task 5) consumes:
//
//   - validated raw transaction records, fetched in ≤50-hash batches through
//     the injected `daemon.getPaymentTransactions` (the strict additive method
//     on daemonClient — the fixture/tests inject an equivalent fake; no real
//     daemon or network is ever touched here),
//   - the wallet's UNFILTERED owned-output scan across ALL accounts — spent
//     rows included, never filtered on unspent/frozen state — optionally
//     cross-checked against an independent fresh view-only scan (exact set
//     equality on the safe projection),
//   - true transaction-local output indexes derived by joining scan rows to
//     the raw vout keys BY STEALTH PUBLIC KEY. SDK `getIndex()` is the GLOBAL
//     output index (pinned monero-cpp monero_wallet_full.cpp:344) and is used
//     only as the cross-check value against `raw.outputIndices[localIndex]`
//     when the daemon supplied them — never as a local index.
//   - INDEPENDENT SENDER-SIDE OWNERSHIP ENUMERATION (final-review I2): every
//     raw output is re-derived against the derived sender addresses using
//     ephemeral sender view access — Hs(8*a*R || varint(i))*G + spend over
//     the main key and the output's ordered additional key — and the result
//     must EQUAL the SDK owned projection exactly, or the session refuses.
//     The derivation domain (scope primary + majors 1..5 primaries + every
//     recorded minor, account-0 minors included) is prepared and validated
//     BEFORE the scan; an owned index outside it refuses (derive-and-rescan
//     is the operator remedy).
//   - AUDITED CANDIDATE HASHES (final-review I3): raws are fetched for the
//     union of scanned hashes AND the caller's audited hashes (journal /
//     payout / sweep / escrow hashes), independent of owned-output presence —
//     a fetchable outgoing payment with no change/owned receipt is never
//     RAW_TX_MISSING. Strict ownership verification still happens after the
//     fetch.
//   - restored input ownership: each requested transaction's input key images
//     must resolve to owned prior outputs of this same scan, whose own raw
//     records are present. Coinbase transactions are acceptable INPUT SOURCES
//     (their output structure joins like any other) but are never treated as
//     spending-payment key inputs or fees (zero key images, zero fee enforced).
//
// The session return value holds Maps, closures and bigints — it must NEVER be
// serialized, logged, or placed in reports/GraphQL. It is private verifier
// input only. Missing rows are never filled from journals or captures: the
// only ownership inputs are the wallet scans, the daemon raw records and the
// wallet's own derived identity. The session carries its authoritative
// collection boundary and the derived position↔address map (final-review I4,
// I6) so the verifier never has to reconstruct either from volatile facts.
//
// Every refusal carries a fixed machine code (`error.code`).

import { decodeReceivingIdentity } from './paymentClaims'
import { oneTimeOutputKey, parseTxExtraStrict } from './paymentKeyStructure'

const HEX64 = /^[0-9a-f]{64}$/
const NETWORK_TYPES = Object.freeze({ MAINNET: 0, STAGENET: 2 })
// The derivation domain must cover the primary plus fee-account primaries
// 1..5 (final-review I2): runtime recovery may not declare the derivation
// complete by pre-listing accounts alone.
const REQUIRED_MAJORS = [1, 2, 3, 4, 5]

/**
 * Build a fixed-code evidence error.
 * @param {string} code
 * @param {string} [detail]
 * @returns {Error} with `.name = 'PaymentChainEvidenceError'` and `.code`
 */
export function paymentEvidenceError (code, detail) {
  const error = new Error(detail === undefined ? code : `${code}: ${detail}`)
  error.name = 'PaymentChainEvidenceError'
  error.code = code
  return error
}

function assertHex64 (value, code, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw paymentEvidenceError(code, `${label} must be 64 lowercase hex characters`)
  }
  return value
}

function assertSafeNonNegativeInt (value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw paymentEvidenceError(code, `${label} must be a non-negative safe integer`)
  }
  return value
}

/** Validate one SDK-shaped scan row into a frozen plain row (amounts bigint). */
function readScanRow (row) {
  if (row === null || typeof row !== 'object') {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'scan row is not an object')
  }
  let txHash
  let blockHeight
  try {
    txHash = row.getTx().getHash()
    blockHeight = row.getTx().getHeight()
  } catch {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'unreadable scan row tx hash/height')
  }
  assertHex64(txHash, 'WALLET_SCAN_INVALID', 'tx hash')
  assertSafeNonNegativeInt(blockHeight, 'WALLET_SCAN_INVALID', 'block height')
  const accountIndex = assertSafeNonNegativeInt(row.getAccountIndex(), 'WALLET_SCAN_INVALID', 'account index')
  const subaddressIndex = assertSafeNonNegativeInt(row.getSubaddressIndex(), 'WALLET_SCAN_INVALID', 'subaddress index')
  const globalIndex = assertSafeNonNegativeInt(row.getIndex(), 'WALLET_SCAN_INVALID', 'global index')
  const amountPiconeros = row.getAmount()
  if (typeof amountPiconeros !== 'bigint' || amountPiconeros < 0n) {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'amount must be a non-negative bigint')
  }
  const stealthPublicKey = assertHex64(row.getStealthPublicKey(), 'WALLET_SCAN_INVALID', 'stealth public key')
  const keyImageObject = row.getKeyImage()
  const keyImage = keyImageObject === null || keyImageObject === undefined ? null : keyImageObject.getHex()
  if (keyImage !== null && (typeof keyImage !== 'string' || !HEX64.test(keyImage))) {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'key image must be 64 lowercase hex characters')
  }
  const isSpent = typeof row.getIsSpent === 'function' ? row.getIsSpent() === true : false
  return Object.freeze({
    txHash,
    accountIndex,
    subaddressIndex,
    globalIndex,
    amountPiconeros,
    stealthPublicKey,
    keyImage,
    isSpent,
    blockHeight
  })
}

/**
 * Resolve a scan row's true transaction-local output index by its stealth
 * public key (exactly one hit required). The global cross-check is applied by
 * the caller AFTER local-duplicate detection so a corrupted duplicate row
 * reports the duplicate, not an incidental index mismatch.
 */
function joinPosition (row, raw) {
  const first = raw.voutKeys.indexOf(row.stealthPublicKey)
  if (first < 0 || raw.voutKeys.lastIndexOf(row.stealthPublicKey) !== first) {
    throw paymentEvidenceError(
      'OWNED_OUTPUT_JOIN_FAILED',
      `stealth key of ${row.txHash} global ${row.globalIndex} does not hit exactly one vout`
    )
  }
  return first
}

/**
 * Structural validation of one raw record (daemonClient.getPaymentTransactions
 * shape; the fixture serves the same shape plus tolerated extra fields).
 */
function validateRawRecord (record, requestedHashes, boundaryHeight) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', 'raw entry is not an object')
  }
  const txHash = record.txHash
  if (typeof txHash !== 'string' || !HEX64.test(txHash) || !requestedHashes.has(txHash)) {
    throw paymentEvidenceError('RAW_HASH_MISMATCH', String(txHash))
  }
  if (record.inTxPool !== false) {
    throw paymentEvidenceError('RAW_TX_IN_POOL', txHash)
  }
  if (record.isCoinbase !== true && record.isCoinbase !== false) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} isCoinbase must be a boolean`)
  }
  const blockHeight = assertSafeNonNegativeInt(record.blockHeight, 'RAW_RECORD_INVALID', `${txHash} blockHeight`)
  if (blockHeight >= boundaryHeight) {
    throw paymentEvidenceError('RAW_TX_ABOVE_BOUNDARY', `${txHash} height ${blockHeight} ≥ boundary ${boundaryHeight}`)
  }
  const voutKeys = record.voutKeys
  if (!Array.isArray(voutKeys) || voutKeys.length === 0 ||
    !voutKeys.every(key => typeof key === 'string' && HEX64.test(key))) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} voutKeys must be non-empty 64-hex keys`)
  }
  const inputKeyImages = record.inputKeyImages
  if (!Array.isArray(inputKeyImages) ||
    !inputKeyImages.every(ki => typeof ki === 'string' && HEX64.test(ki))) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} inputKeyImages must be 64-hex keys`)
  }
  if (new Set(inputKeyImages).size !== inputKeyImages.length) {
    throw paymentEvidenceError('DUPLICATE_KEY_IMAGE', txHash)
  }
  const feePiconeros = record.feePiconeros
  if (typeof feePiconeros !== 'bigint' || feePiconeros < 0n) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} feePiconeros must be a non-negative bigint`)
  }
  if (record.isCoinbase) {
    // Coinbases are input SOURCES only: no spending-payment key inputs, no fee.
    if (feePiconeros !== 0n || inputKeyImages.length !== 0) {
      throw paymentEvidenceError('RAW_COINBASE_INVALID', txHash)
    }
  } else if (inputKeyImages.length === 0) {
    throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} spends nothing it could own`)
  }
  // Block facts are required per record (final-review I4): maturity is derived
  // from independently checked heights, so the daemon-resolved block hash must
  // be present and well-formed on every fetched record.
  assertHex64(record.blockHash, 'RAW_RECORD_INVALID', `${txHash} blockHash`)
  const outputIndices = record.outputIndices === undefined ? null : record.outputIndices
  if (outputIndices !== null) {
    if (!Array.isArray(outputIndices) || outputIndices.length !== voutKeys.length) {
      throw paymentEvidenceError('RAW_OUTPUT_INDICES_LENGTH', txHash)
    }
    outputIndices.forEach((value, i) => assertSafeNonNegativeInt(value, 'RAW_INTEGER_UNSAFE', `${txHash} output_indices[${i}]`))
  }
  return record
}

/** Stable ordering for restored rows (by tx hash, then global index). */
const byHashThenGlobal = (a, b) => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.globalIndex - b.globalIndex)

/** Safe comparison projection (no key images / spent state / amounts as bigint). */
const safeProjection = rows => rows
  .map(({ keyImage, isSpent, blockHeight, amountPiconeros, ...rest }) => ({
    ...rest,
    amountPiconeros: amountPiconeros.toString()
  }))
  .sort(byHashThenGlobal)

function validateScope (scope) {
  if (!scope || typeof scope !== 'object' ||
    (scope.network !== 'MAINNET' && scope.network !== 'STAGENET') ||
    typeof scope.walletAddress !== 'string' || scope.walletAddress === '') {
    throw paymentEvidenceError('SCOPE_INVALID', 'scope must be { network, walletAddress }')
  }
}

function validateDerivation (derivation) {
  if (!derivation || typeof derivation !== 'object' || derivation.complete !== true ||
    !Array.isArray(derivation.mismatches) || derivation.mismatches.length !== 0 ||
    !Array.isArray(derivation.derived)) {
    throw paymentEvidenceError('DERIVATION_INVALID', 'derivation must be complete with no mismatches')
  }
}

/**
 * The PREPARED derivation domain (final-review I2): position → { address,
 * spendKey }, decoded from the derived addresses BEFORE any scan. The scope
 * primary (0:0) must be present, every REQUIRED_MAJORS primary must be
 * prepared, and every derived entry must decode on the scope network. A
 * narrowed or unprepared domain refuses up front instead of silently passing.
 */
export async function prepareRecordedPaymentAddresses ({ models, wallet, scope }) {
  if (typeof models?.subaddressIndex?.findMany !== 'function') {
    throw paymentEvidenceError('DERIVATION_INVALID', 'recorded subaddresses unavailable')
  }
  const rows = await models.subaddressIndex.findMany({
    where: { account: { address: scope.walletAddress, network: scope.network } },
    select: { majorIndex: true, minorIndex: true, address: true }
  })
  for (const row of rows) {
    assertSafeNonNegativeInt(row.majorIndex, 'DERIVATION_INVALID', 'recorded major')
    assertSafeNonNegativeInt(row.minorIndex, 'DERIVATION_INVALID', 'recorded minor')
  }
  if (rows.length === 0) return rows
  const accounts = await wallet.getAccounts()
  const maxMajor = Math.max(...rows.map(row => row.majorIndex))
  for (let major = accounts.length; major <= maxMajor; major++) await wallet.createAccount()
  for (const row of [...rows].sort((a, b) => a.majorIndex - b.majorIndex || a.minorIndex - b.minorIndex)) {
    const addresses = await wallet.getSubaddresses(row.majorIndex)
    for (let minor = addresses.length; minor <= row.minorIndex; minor++) await wallet.createSubaddress(row.majorIndex)
    const address = typeof wallet.getAddress === 'function'
      ? await wallet.getAddress(row.majorIndex, row.minorIndex)
      : (await wallet.getSubaddress(row.majorIndex, row.minorIndex)).getAddress()
    if (address !== row.address) throw paymentEvidenceError('DERIVATION_INVALID', 'recorded subaddress mismatch')
  }
  return rows
}

export async function readPaymentAuditHashes ({ models, scope, journalRole }) {
  const journal = journalRole === 'REWARDS' ? models.rewardsWalletTransaction : models.escrowWalletTransaction
  const rows = await journal.findMany({
    where: { network: scope.network, walletAddress: scope.walletAddress },
    select: { txHash: true }
  })
  const hashes = rows.map(row => row.txHash)
  if (journalRole === 'REWARDS') {
    const [payouts, distributions] = await Promise.all([
      models.rewardPayout.findMany({ where: { txHash: { not: null } }, select: { txHash: true } }),
      models.rewardDistribution.findMany({ where: { opsSweepTxHash: { not: null } }, select: { opsSweepTxHash: true } })
    ])
    hashes.push(...payouts.map(row => row.txHash), ...distributions.map(row => row.opsSweepTxHash))
  } else {
    const payouts = await models.bountyPayment.findMany({
      where: { OR: [{ txHash: { not: null } }, { feeTxHash: { not: null } }] },
      select: { txHash: true, feeTxHash: true }
    })
    hashes.push(...payouts.flatMap(row => [row.txHash, row.feeTxHash]))
  }
  return [...new Set(hashes.filter(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))]
}

// Bracket verification AND its DB promotion. A changed tip after the update
// throws inside the transaction, rolling back that promotion; the next pass
// may collect again, but this pass never approves mixed-boundary evidence.
export async function commitPaymentPromotionAtBoundary ({ models, daemon, boundary, promote }) {
  const check = async () => {
    const length = await daemon.getHeight()
    if (length !== boundary.height + 1 || await daemon.getBlockHashByHeight(boundary.height) !== boundary.blockHash) {
      throw paymentEvidenceError('BOUNDARY_INCONSISTENT', 'promotion boundary moved')
    }
  }
  try {
    return await models.$transaction(async client => {
      await check()
      const promoted = await promote(client)
      await check()
      return promoted
    })
  } catch {
    return false
  }
}

function preparedDomain (derivation, scope, journalRole) {
  const positions = new Map()
  const add = (majorIndex, minorIndex, address, label) => {
    const key = `${majorIndex}:${minorIndex}`
    if (positions.has(key)) {
      throw paymentEvidenceError('DERIVATION_INVALID', `duplicate derived position ${key}`)
    }
    let decoded
    try {
      decoded = decodeReceivingIdentity(address, scope.network)
    } catch {
      throw paymentEvidenceError('DERIVATION_INVALID', `${label} address does not decode on ${scope.network}`)
    }
    positions.set(key, { address, spendKey: decoded.spendKey })
  }
  for (const entry of derivation.derived) {
    if (!entry || typeof entry !== 'object') {
      throw paymentEvidenceError('DERIVATION_INVALID', 'derived entry is not an object')
    }
    const majorIndex = assertSafeNonNegativeInt(entry.majorIndex, 'DERIVATION_INVALID', 'derived majorIndex')
    const minorIndex = assertSafeNonNegativeInt(entry.minorIndex, 'DERIVATION_INVALID', 'derived minorIndex')
    add(majorIndex, minorIndex, entry.address, `derived ${majorIndex}/${minorIndex}`)
  }
  if (!positions.has('0:0') || positions.get('0:0').address !== scope.walletAddress) {
    throw paymentEvidenceError('DERIVATION_INVALID', 'the derivation domain is missing the scope primary 0:0')
  }
  for (const major of journalRole === 'REWARDS' ? REQUIRED_MAJORS : []) {
    if (!positions.has(`${major}:0`)) {
      throw paymentEvidenceError(
        'DERIVATION_INVALID',
        `the derivation domain is missing account ${major}'s primary — prepare/derive the domain before scanning`
      )
    }
  }
  return positions
}

/**
 * Collect the private raw-chain and restored-ownership evidence session.
 * Never serialize the return value; expose `ownershipFor`/`deriveOwnedIndexes`
 * to the verifier only. D/O/F/E arithmetic is the verifier's job — this module
 * provides the independent facts.
 *
 * @param {{
 *   wallet: object,
 *   daemon: { getPaymentTransactions: Function },
 *   scope: { network: string, walletAddress: string },
 *   derivation: object,
 *   boundary: { height: number, blockHash: string },
 *   viewWallet?: object,
 *   auditedHashes?: string[]
 * }} options `auditedHashes` are the audited candidate hashes (journal /
 *   payout / sweep / escrow) fetched independently of owned-output presence
 *   (final-review I3); unknown-to-the-daemon candidates simply stay absent and
 *   refuse at ownershipFor time.
 * @returns {{ rawByHash: Map<string, object>, ownedOutputs: object[],
 *   ownershipFor: Function, deriveOwnedIndexes: Function, boundary: object,
 *   addressForPosition: Function }}
 */
export async function collectPaymentChainEvidence ({
  wallet,
  daemon,
  scope,
  derivation,
  boundary,
  viewWallet,
  auditedHashes = [],
  pendingHashes = [],
  journalRole = 'REWARDS'
}) {
  if (!['REWARDS', 'ESCROW'].includes(journalRole)) throw paymentEvidenceError('DERIVATION_INVALID', 'unknown wallet role')
  if (!wallet || typeof wallet !== 'object') throw paymentEvidenceError('WALLET_SCAN_INVALID', 'wallet is required')
  if (typeof wallet.getOutputs !== 'function') {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'wallet.getOutputs is required')
  }
  if (typeof wallet.getPrimaryAddress !== 'function' || typeof wallet.getNetworkType !== 'function') {
    throw paymentEvidenceError('SCOPE_INVALID', 'wallet.getPrimaryAddress/getNetworkType are required to bind the scope')
  }
  if (!daemon || typeof daemon.getPaymentTransactions !== 'function') {
    throw paymentEvidenceError('RAW_RESPONSE_INVALID', 'daemon.getPaymentTransactions is required')
  }
  if (!Array.isArray(auditedHashes)) {
    throw paymentEvidenceError('AUDITED_HASHES_INVALID', 'auditedHashes must be an array of 64-hex transaction hashes')
  }
  validateScope(scope)

  // Bind the scanned wallet to the audited scope before trusting its rows.
  const primaryAddress = await wallet.getPrimaryAddress()
  if (primaryAddress !== scope.walletAddress) {
    throw paymentEvidenceError('SCOPE_MISMATCH', 'wallet primary address differs from scope.walletAddress')
  }
  const networkType = await wallet.getNetworkType()
  if (networkType !== NETWORK_TYPES[scope.network]) {
    throw paymentEvidenceError('SCOPE_MISMATCH', `wallet network type ${String(networkType)} differs from scope.network`)
  }

  validateDerivation(derivation)
  // The domain is prepared and validated BEFORE any scan (final-review I2).
  const domainPositions = preparedDomain(derivation, scope, journalRole)
  if (typeof derivation.primaryAddress === 'string' && derivation.primaryAddress !== scope.walletAddress) {
    throw paymentEvidenceError('DERIVATION_INVALID', 'derivation.primaryAddress differs from scope.walletAddress')
  }

  if (!boundary || typeof boundary !== 'object') {
    throw paymentEvidenceError('BOUNDARY_INVALID', 'boundary is required')
  }
  assertSafeNonNegativeInt(boundary.height, 'BOUNDARY_INVALID', 'boundary.height')
  assertHex64(boundary.blockHash, 'BOUNDARY_INVALID', 'boundary.blockHash')

  // Unfiltered owned-output scan: every account, spent rows retained.
  const scannedRows = await wallet.getOutputs()
  if (!Array.isArray(scannedRows)) {
    throw paymentEvidenceError('WALLET_SCAN_INVALID', 'wallet.getOutputs() must return an array')
  }
  const rows = scannedRows.map(readScanRow)

  const keyImageMap = new Map()
  for (const row of rows) {
    if (row.keyImage === null) continue
    if (keyImageMap.has(row.keyImage)) {
      throw paymentEvidenceError('DUPLICATE_KEY_IMAGE', row.keyImage)
    }
    keyImageMap.set(row.keyImage, row)
  }

  for (const row of rows) {
    if (!domainPositions.has(`${row.accountIndex}:${row.subaddressIndex}`)) {
      throw paymentEvidenceError(
        'DERIVATION_DOMAIN_INCOMPLETE',
        `owned index ${row.accountIndex}/${row.subaddressIndex} lies outside the prepared derivation domain — derive and rescan`
      )
    }
  }

  // Validated raw records for the UNION of scanned transaction hashes AND the
  // audited candidate hashes (final-review I3) — never only hashes found in
  // owned-output scans. Candidate hashes are normalized strictly; a candidate
  // unknown to the daemon stays absent from the session (its verification
  // refuses RAW_TX_MISSING at ownershipFor time — an unresolved result, never
  // a collect crash and never a filled row).
  const normalizedCandidates = auditedHashes.map(hash => {
    if (typeof hash !== 'string' || !HEX64.test(hash)) {
      throw paymentEvidenceError('AUDITED_HASHES_INVALID', 'auditedHashes must carry 64-lowercase-hex transaction hashes')
    }
    return hash
  })
  if (!Array.isArray(pendingHashes) || pendingHashes.some(hash => typeof hash !== 'string' || !HEX64.test(hash))) {
    throw paymentEvidenceError('AUDITED_HASHES_INVALID', 'pendingHashes must carry 64-lowercase-hex hashes')
  }
  const pending = new Set(pendingHashes)
  const hashes = [...new Set([...rows.map(row => row.txHash), ...normalizedCandidates.filter(hash => !pending.has(hash))])].sort()
  const rawByHash = new Map()
  const scannedHashes = new Set(rows.map(row => row.txHash))
  // Unknown pending candidates can still appear in recorded journals. The
  // daemon's confirmed-only API refuses an entire batch on a pool entry; split
  // ONLY that named refusal to isolate it. Other failures remain fail-closed.
  const fetchConfirmed = async batch => {
    try {
      return await daemon.getPaymentTransactions(batch)
    } catch (err) {
      if (err?.code !== 'RAW_TX_IN_POOL') throw err
      if (batch.length === 1) {
        if (scannedHashes.has(batch[0])) throw err
        pending.add(batch[0])
        return []
      }
      const midpoint = Math.ceil(batch.length / 2)
      return [...await fetchConfirmed(batch.slice(0, midpoint)), ...await fetchConfirmed(batch.slice(midpoint))]
    }
  }
  if (hashes.length > 0) {
    const response = await fetchConfirmed(hashes)
    if (!Array.isArray(response)) {
      throw paymentEvidenceError('RAW_RESPONSE_INVALID', 'getPaymentTransactions must return an array')
    }
    const requested = new Set(hashes)
    const returned = new Set()
    for (const record of response) {
      assertHex64(record?.txHash, 'RAW_HASH_MISMATCH', 'returned hash')
      if (!requested.has(record.txHash)) throw paymentEvidenceError('RAW_HASH_MISMATCH', record.txHash)
      if (returned.has(record.txHash)) throw paymentEvidenceError('RAW_TX_DUPLICATE', record.txHash)
      returned.add(record.txHash)
      if (record.inTxPool === true && !scannedHashes.has(record.txHash)) {
        pending.add(record.txHash)
        continue
      }
      const validated = validateRawRecord(record, requested, boundary.height)
      if (rawByHash.has(validated.txHash)) {
        throw paymentEvidenceError('RAW_TX_DUPLICATE', validated.txHash)
      }
      rawByHash.set(validated.txHash, validated)
    }
    for (const hash of hashes) {
      if (!rawByHash.has(hash) && scannedHashes.has(hash)) {
        throw paymentEvidenceError('RAW_TX_MISSING', hash)
      }
    }
  }

  // Join every restored row to its raw (true local index; global cross-check
  // only against daemon-supplied output_indices). Local duplicates are checked
  // before the cross-check so a corrupted duplicate row reports the duplicate,
  // not an incidental mismatch.
  const joinedByHash = new Map()
  const localIndexesByHash = new Map()
  const seenGlobalIndexes = new Set()
  for (const row of rows) {
    const raw = rawByHash.get(row.txHash)
    const outputIndex = joinPosition(row, raw)
    let localIndexes = localIndexesByHash.get(row.txHash)
    if (localIndexes === undefined) {
      localIndexes = new Set()
      localIndexesByHash.set(row.txHash, localIndexes)
    }
    if (localIndexes.has(outputIndex)) {
      throw paymentEvidenceError('DUPLICATE_OWNED_OUTPUT_INDEX', `${row.txHash} local ${outputIndex}`)
    }
    localIndexes.add(outputIndex)
    if (raw.outputIndices !== null && raw.outputIndices !== undefined) {
      if (raw.outputIndices[outputIndex] !== row.globalIndex) {
        throw paymentEvidenceError(
          'GLOBAL_LOCAL_INDEX_MISMATCH',
          `${row.txHash} local ${outputIndex} carries global ${raw.outputIndices[outputIndex]}, scan says ${row.globalIndex}`
        )
      }
    }
    if (seenGlobalIndexes.has(row.globalIndex)) {
      throw paymentEvidenceError('DUPLICATE_GLOBAL_INDEX', `global ${row.globalIndex} claimed twice`)
    }
    seenGlobalIndexes.add(row.globalIndex)
    const joined = Object.freeze({ ...row, outputIndex })
    const ownedList = joinedByHash.get(joined.txHash)
    if (ownedList === undefined) joinedByHash.set(joined.txHash, [joined])
    else ownedList.push(joined)
  }
  const ownedOutputs = Object.freeze(
    [...joinedByHash.values()].flat().sort(byHashThenGlobal)
  )

  // Optional independent fresh view-only scan must agree exactly on the safe
  // projection of the same complete derivation domain.
  if (viewWallet !== null && viewWallet !== undefined) {
    const viewRowsRaw = await viewWallet.getOutputs()
    if (!Array.isArray(viewRowsRaw)) {
      throw paymentEvidenceError('WALLET_SCAN_INVALID', 'viewWallet.getOutputs() must return an array')
    }
    const viewRows = viewRowsRaw.map(readScanRow)
    for (const row of viewRows) {
      if (!domainPositions.has(`${row.accountIndex}:${row.subaddressIndex}`)) {
        throw paymentEvidenceError(
          'DERIVATION_DOMAIN_INCOMPLETE',
          `view-scanned owned index ${row.accountIndex}/${row.subaddressIndex} lies outside the prepared derivation domain`
        )
      }
    }
    const viewJoined = viewRows.map(row => {
      // A view-scan row the full scan (and therefore rawByHash) never saw is
      // itself a scan disagreement — never a crash.
      const raw = rawByHash.get(row.txHash)
      if (raw === undefined) {
        throw paymentEvidenceError('OWNED_SCAN_DISAGREEMENT', `view scan saw ${row.txHash}, full scan did not`)
      }
      return Object.freeze({ ...row, outputIndex: joinPosition(row, raw) })
    })
    if (JSON.stringify(safeProjection(ownedOutputs)) !== JSON.stringify(safeProjection(viewJoined))) {
      throw paymentEvidenceError('OWNED_SCAN_DISAGREEMENT', 'full and view-only scans disagree')
    }
  }

  // INDEPENDENT SENDER-SIDE OWNERSHIP ENUMERATION (final-review I2): re-derive
  // every raw output against the prepared derived addresses with ephemeral
  // sender view access — Hs(8*a*R || varint(i))*G + spend, over the main key
  // and the output's ordered additional key — and REQUIRE exact equality with
  // the SDK owned projection (both directions). The scan alone is never the
  // completeness premise for O.
  const findOwnedPosition = (voutKey, candidates, outputIndex, viewSecretHex) => {
    for (const [position, { spendKey }] of domainPositions) {
      for (const publicKey of candidates) {
        const expected = oneTimeOutputKey({
          publicKey,
          secret: viewSecretHex,
          publicSpend: spendKey,
          outputIndex
        })
        if (expected === voutKey) return position
      }
    }
    return null
  }

  const enumerateRawOwnedOutputs = async () => {
    if (typeof wallet.getPrivateViewKey !== 'function') {
      throw paymentEvidenceError(
        'OWNERSHIP_ENUMERATION_UNAVAILABLE',
        'the sender wallet cannot prove ephemeral view access for raw ownership enumeration'
      )
    }
    const viewSecretHex = await wallet.getPrivateViewKey()
    if (typeof viewSecretHex !== 'string' || !HEX64.test(viewSecretHex)) {
      throw paymentEvidenceError('OWNERSHIP_ENUMERATION_UNAVAILABLE', 'the sender view key is unreadable')
    }
    const enumerated = new Map()
    for (const [txHash, raw] of rawByHash) {
      let keys = null
      if (typeof raw.extra === 'string') {
        try {
          const parsed = parseTxExtraStrict(raw.extra)
          keys = { main: parsed.main, additional: [...parsed.additional] }
        } catch (err) {
          if (err?.name === 'PaymentKeyStructureError') {
            throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} tx-extra is not strictly parseable`)
          }
          throw err
        }
      } else if (typeof raw.mainPublicKey === 'string' && HEX64.test(raw.mainPublicKey)) {
        keys = {
          main: raw.mainPublicKey,
          additional: Array.isArray(raw.additionalPublicKeys)
            ? raw.additionalPublicKeys.filter(key => typeof key === 'string' && HEX64.test(key))
            : []
        }
      }
      if (keys === null) {
        // No tx key material on the raw record: a receiver scan can never have
        // detected an owned output here, so scan rows for this record are a
        // contradiction rather than a gap.
        if ((joinedByHash.get(txHash) ?? []).length > 0) {
          throw paymentEvidenceError('OWNED_SCAN_DISAGREEMENT', `${txHash} has scan-owned outputs but no raw tx public key`)
        }
        continue
      }
      if (keys.additional.length > 0 && keys.additional.length !== raw.voutKeys.length) {
        throw paymentEvidenceError('RAW_RECORD_INVALID', `${txHash} additional tx keys do not cover every output`)
      }
      for (let outputIndex = 0; outputIndex < raw.voutKeys.length; outputIndex++) {
        const candidates = keys.additional.length > 0
          ? [keys.main, keys.additional[outputIndex]]
          : [keys.main]
        const matchedPosition = findOwnedPosition(raw.voutKeys[outputIndex], candidates, outputIndex, viewSecretHex)
        if (matchedPosition !== null) enumerated.set(`${txHash}:${outputIndex}`, matchedPosition)
      }
    }
    return enumerated
  }

  const enumeratedOwned = await enumerateRawOwnedOutputs()
  const scanOwned = new Map()
  for (const row of ownedOutputs) {
    scanOwned.set(`${row.txHash}:${row.outputIndex}`, `${row.accountIndex}:${row.subaddressIndex}`)
  }
  if (enumeratedOwned.size !== scanOwned.size) {
    throw paymentEvidenceError(
      'OWNED_SCAN_DISAGREEMENT',
      `raw ownership enumeration found ${enumeratedOwned.size} owned outputs, the SDK scan projected ${scanOwned.size}`
    )
  }
  for (const [key, position] of enumeratedOwned) {
    if (scanOwned.get(key) !== position) {
      throw paymentEvidenceError('OWNED_SCAN_DISAGREEMENT', `owned output ${key} disagrees between raw enumeration and scan`)
    }
  }

  const joinedRowFor = (txHash, row) => {
    const list = joinedByHash.get(txHash) ?? []
    const joined = list.find(candidate => candidate.globalIndex === row.globalIndex)
    if (joined === undefined) {
      throw paymentEvidenceError('PRIOR_TX_MISSING', `${txHash} global ${row.globalIndex}`)
    }
    return joined
  }

  /**
   * Restored ownership facts for one transaction. Unknown/unscanned hashes
   * refuse; every input key image must resolve to an owned prior output of
   * this scan whose own raw record is present (coinbase priors accepted as
   * sources only).
   */
  const ownershipFor = txHash => {
    assertHex64(txHash, 'RAW_HASH_MISMATCH', 'tx hash')
    if (pending.has(txHash)) throw paymentEvidenceError('RAW_TX_IN_POOL', txHash)
    const raw = rawByHash.get(txHash)
    if (raw === undefined) {
      throw paymentEvidenceError('RAW_TX_MISSING', txHash)
    }
    const owned = [...(joinedByHash.get(txHash) ?? [])].sort(byHashThenGlobal)
    const inputSources = raw.inputKeyImages.map(keyImage => {
      const prior = keyImageMap.get(keyImage)
      if (prior === undefined) {
        throw paymentEvidenceError('INPUT_NOT_OWNED_OR_MISSING', keyImage)
      }
      const priorRaw = rawByHash.get(prior.txHash)
      if (priorRaw === undefined) {
        throw paymentEvidenceError('PRIOR_TX_MISSING', prior.txHash)
      }
      return Object.freeze({
        keyImage,
        prior: joinedRowFor(prior.txHash, prior),
        priorRaw
      })
    })
    return Object.freeze({ raw, owned, inputSources })
  }

  /**
   * The owned outputs of one raw transaction mapped to their derivation-domain
   * positions (accepts a raw record object or a 64-hex hash).
   */
  const deriveOwnedIndexes = rawOrHash => {
    const txHash = typeof rawOrHash === 'string'
      ? rawOrHash
      : (rawOrHash !== null && typeof rawOrHash === 'object' ? rawOrHash.txHash : undefined)
    assertHex64(txHash, 'RAW_HASH_MISMATCH', 'tx hash')
    if (!rawByHash.has(txHash)) {
      throw paymentEvidenceError('RAW_TX_MISSING', txHash)
    }
    return (joinedByHash.get(txHash) ?? []).map(row => Object.freeze({
      outputIndex: row.outputIndex,
      globalIndex: row.globalIndex,
      accountIndex: row.accountIndex,
      subaddressIndex: row.subaddressIndex,
      amountPiconeros: row.amountPiconeros,
      stealthPublicKey: row.stealthPublicKey
    }))
  }

  return Object.freeze({
    journalRole,
    scope: Object.freeze({ network: scope.network, walletAddress: scope.walletAddress }),
    rawByHash,
    ownedOutputs,
    ownershipFor: Object.freeze(ownershipFor),
    deriveOwnedIndexes: Object.freeze(deriveOwnedIndexes),
    // The authoritative collection boundary (final-review I4): the verifier
    // consumes THIS, never a tip reconstructed from volatile raw facts.
    boundary: Object.freeze({ height: boundary.height, blockHash: boundary.blockHash }),
    // Independent position↔address correspondence from the prepared domain
    // (final-review I6): null outside the domain.
    addressForPosition: Object.freeze((majorIndex, subaddressIndex) => {
      if (!Number.isSafeInteger(majorIndex) || !Number.isSafeInteger(subaddressIndex)) return null
      return domainPositions.get(`${majorIndex}:${subaddressIndex}`)?.address ?? null
    }),
    derivedPositions: Object.freeze([...domainPositions.keys()].map(key => {
      const [majorIndex, minorIndex] = key.split(':').map(Number)
      return { majorIndex, minorIndex, address: domainPositions.get(key).address }
    }))
  })
}
