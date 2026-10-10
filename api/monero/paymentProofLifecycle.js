import { money } from '@/lib/rewardsAccounting'
import {
  decodeReceivingIdentity,
  normalizePaymentClaims,
  paymentClaimDigest
} from './paymentClaims'
import { openPaymentProof, sealPaymentProof } from './paymentProofCrypto'

// Payment-proof lifecycle: paused-writer inventory check and key-version
// rotation (Finding #1, Task 8). Read-only check + re-encryption rotation over
// the existing PaymentTransactionProof rows — this module NEVER provisions,
// elects or drops registry keys, never signs, never relays, and never touches
// journal or payout rows: recorded SENT/CONFIRMED delivery and principal facts
// are outside its write surface by construction (its only write is the proof
// CAS below).
//
// Full-envelope reads are private to the Task 3 store and to THIS module (the
// rotation allowance). Everything returned or loggable is safe metadata:
// versions, counts, ids, and fixed issue codes — never key material, envelope
// bytes, claims or payload content.
//
// PER-ROW AUTHENTICATION mirrors the store's private authenticateOwnerPair:
// the expected claims are reconstructed from the authoritative owner row plus
// its immutable capture facts (journal columns + stored paymentClaims +
// payload built structure), the claim digests are cross-checked, and the OLD
// envelope is opened against those expected claims BEFORE anything is
// re-sealed. The derivation helpers below are a deliberate, documented copy of
// the store's private logic (the store must not be modified to export them);
// any drift fails CLOSED — a row rotation refuses to touch is reported as an
// unresolved issue, never re-encrypted under a guessed identity.
//
// ROTATION MECHANICS (per row):
//   1. full proof row read (private query),
//   2. authenticate (above); rows already at the target version are verified
//      and SKIPPED without re-encryption (no gratuitous rewrap; corruption is
//      still reported — skipping a corrupt row as success is forbidden),
//   3. re-seal the authenticated payload under the ALREADY-PROVISIONED target
//      version with FRESH random DEK/nonces (sealPaymentProof), through a
//      pinned VIEW over the real provider — the registry itself is never
//      mutated and the target is never elected current,
//   4. ONE CAS update guarded by id + old revision + claim digest; the
//      rotation guard trigger enforces the strictly increasing revision and
//      immutable owner linkage/claimDigest at the database,
//   5. after each batch, the persisted revision/version are RE-READ and
//      verified — Prisma 5.20 can resolve an interactive $transaction
//      callback even when Postgres rejects a deferred-constraint COMMIT, so a
//      resolved callback is never trusted as persistence evidence.
//
// Corrupt rows (failed authentication/decryption, absent key versions, owner
// problems) keep their old version and exact old bytes, are reported as fixed
// safe issues, and never abort the remaining rows — the rotation is resumable
// and idempotent. No logger: callers (the CLI) own all output.
//
// Errors are fixed uppercase codes only.

const INVALID = 'PROOF_LIFECYCLE_INVALID'
const PROVIDER_INVALID = 'PROOF_LIFECYCLE_PROVIDER_INVALID'
const WRITERS_REQUIRED = 'PROOF_ROTATION_WRITERS_REQUIRED'
const TARGET_NOT_PROVISIONED = 'PROOF_ROTATION_TARGET_NOT_PROVISIONED'
const CONFLICT = 'PROOF_ROTATION_CONFLICT'
const VERIFY_FAILED = 'PROOF_ROTATION_VERIFY_FAILED'
const DURABILITY_REFUSED = 'PROOF_ROTATION_DURABILITY_REFUSED'

const OWNER_MISSING = 'PAYMENT_PROOF_OWNER_MISSING'
const OWNER_CONFLICT = 'PAYMENT_PROOF_OWNER_CONFLICT'
const LEGACY_OWNER = 'PAYMENT_PROOF_LEGACY_OWNER'
const CAPTURE_MISMATCH = 'PAYMENT_PROOF_CAPTURE_MISMATCH'

const DEFAULT_BATCH_SIZE = 100

// Row-classifiable fixed codes: authentication/claims/owner problems are
// per-row issues (the row stays untouched). Anything else (DB transport,
// programming errors) propagates — a database failure is not row corruption.
const ROW_CODE = /^(TXPROOF_|PAYMENT_CLAIMS_|PAYMENT_PROOF_CAPTURE_MISMATCH|PAYMENT_PROOF_OWNER_MISSING|PAYMENT_PROOF_OWNER_CONFLICT|PAYMENT_PROOF_LEGACY_OWNER)/

const fail = code => { throw new Error(code) }

function assertModels (models) {
  if (!models || !models.paymentTransactionProof ||
    typeof models.paymentTransactionProof.findMany !== 'function') {
    fail(INVALID)
  }
}

function assertLifecycleProvider (keyProvider) {
  if (!keyProvider || typeof keyProvider !== 'object' ||
    typeof keyProvider.getMasterKey !== 'function' ||
    typeof keyProvider.getCurrentVersion !== 'function' ||
    typeof keyProvider.getRegisteredVersions !== 'function') {
    fail(PROVIDER_INVALID)
  }
}

// --- owner-fact helpers (mirrors of the store's private logic) ----------------

const isCompleteCapture = journal =>
  journal.dispatchId != null && journal.captureContractVersion != null &&
  journal.claimDigest != null && journal.paymentClaims != null && journal.proofId != null

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

// Built facts as captured by the proof payload itself (the immutable capture
// facts used to re-derive the expected claims). Public built fields stay
// explicit null when the SDK never populated them; the unavailable change
// amount stays explicit null (never a coerced 0).
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

function memberFor (id, leg, address, network, grossPiconeros, actualPiconeros) {
  const decoded = decodeReceivingIdentity(address, network)
  return {
    id: String(id),
    leg,
    address,
    type: decoded.type,
    paymentId: decoded.paymentId,
    receivingIdentity: decoded.identity,
    grossPiconeros: canonicalAmount(grossPiconeros),
    actualPiconeros: canonicalAmount(actualPiconeros)
  }
}

const canonicalAmount = value => {
  const amount = money(value)
  if (amount < 0n) fail(INVALID)
  return amount.toString()
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
  grossPiconeros: canonicalAmount(gross),
  actualPiconeros: canonicalAmount(actual)
})

// Every actual destination must be attributable to the contracted members
// while every member obligation survives (final-review I5): members may SHARE
// one destination address, so matching is per CANONICAL DESTINATION AGGREGATE
// — one destination per address with the summed amount, or several entries
// for the same address summing to it, must both be accepted. The fee-
// subtracted actual amounts still match the correct legs. Only a genuinely
// unattributable destination (no member claims its address, or a sum drifts)
// is refused.
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
  if (destinationTotals.size !== memberTotals.size) fail(CAPTURE_MISMATCH)
  for (const [address, total] of destinationTotals) {
    if (memberTotals.get(address) !== total) fail(CAPTURE_MISMATCH)
  }
}

// The store's claims derivation, mirrored. Scope/dispatchId come from the
// journal row's own immutable capture facts.
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
    const prize = BigInt(owner.frozenTerms.prizePiconeros)
    const fee = BigInt(owner.frozenTerms.feePiconeros)
    if (fee === 0n) {
      if (prize <= built.networkFeePiconeros) fail(CAPTURE_MISMATCH)
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
    if (fee <= built.networkFeePiconeros) fail(CAPTURE_MISMATCH)
    const feeActual = fee - built.networkFeePiconeros
    const prizeMember = memberFor(owner.bountyPaymentId, 'PRINCIPAL',
      owner.frozenTerms.recipientAddress, network, prize, prize)
    const feeMember = memberFor(owner.bountyPaymentId, 'FEE',
      owner.frozenTerms.feeRecipientAddress, network, fee, feeActual)
    const members = sortMembers([prizeMember, feeMember])
    assertDestinationsMatchMembers(built, members)
    // Destination-ordered legs; two members may SHARE one address
    // (final-review I5); visit each address once with prize before fee.
    const legs = [...new Set(built.destinations.map(destination => destination.address))]
      .flatMap(address => [prizeMember, feeMember]
        .filter(member => member.address === address)
        .map(member => feeLeg(member, member.leg === 'PRINCIPAL' ? prize : fee, BigInt(member.actualPiconeros))))
    if (legs.length !== members.length) fail(CAPTURE_MISMATCH)
    return normalizePaymentClaims({
      ...base,
      kind: owner.kind,
      principalPiconeros: (prize + fee).toString(),
      members,
      feePolicy: { mode: 'SUBTRACT_LAST', legs },
      receivingAggregates: deriveAggregates(members)
    })
  }

  if (owner.kind === 'CONSOLIDATION') {
    const destination = owner.metadata.destination
    let total = 0n
    for (const out of built.destinations) {
      if (out.address !== destination) fail(CAPTURE_MISMATCH)
      total += out.amountPiconeros
    }
    if (total <= 0n) fail(CAPTURE_MISMATCH)
    return normalizePaymentClaims({
      ...base,
      kind: 'CONSOLIDATION',
      principalPiconeros: '0',
      members: [],
      feePolicy: { mode: 'NONE', legs: [] },
      receivingAggregates: [],
      // The consolidation target is the DESTINATION's derived position (the
      // wallet primary: account 0, subaddress 0), never the swept source
      // account (final-review I6).
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

/**
 * Authenticate one proof row against its authoritative owner. Returns
 * `{ claims, payload, journalRole, journalId }` on success or
 * `{ code, journalRole, journalId }` (fixed row-classifiable code) on
 * refusal. Unexpected (non-row) errors propagate to the caller.
 */
async function authenticateProofRow (models, proof, keyProvider) {
  const journalRole = proof.rewardsJournalId != null
    ? 'REWARDS'
    : proof.escrowJournalId != null ? 'ESCROW' : null
  const journalId = journalRole === 'REWARDS'
    ? proof.rewardsJournalId
    : journalRole === 'ESCROW' ? proof.escrowJournalId : null
  const refused = code => ({ code, journalRole, journalId: journalId === null ? null : journalId.toString() })

  try {
    if (journalRole === null) fail(OWNER_MISSING)
    const model = journalRole === 'REWARDS' ? models.rewardsWalletTransaction : models.escrowWalletTransaction
    const journal = await model.findUnique({ where: { id: journalId } })
    if (!journal) fail(OWNER_MISSING)
    if (journal.proofId !== proof.id) fail(OWNER_CONFLICT)
    if (proof.claimDigest !== journal.claimDigest) fail(OWNER_CONFLICT)
    if (journalRole === 'REWARDS' && !isCompleteCapture(journal)) fail(LEGACY_OWNER)

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

    const payload = openPaymentProof({
      claims: storedClaims,
      envelope: envelopeFromProofRow(proof),
      keyProvider
    })
    if (payload.builtStructure.txHash !== storedClaims.txHash ||
      payload.builtStructure.networkFeePiconeros !== storedClaims.networkFeePiconeros) fail(CAPTURE_MISMATCH)

    // Capture integrity: the claims tuple must be exactly what the journal
    // row's own columns plus the captured built facts imply.
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

    return { claims: storedClaims, payload, journalRole, journalId: journal.id }
  } catch (err) {
    const code = String(err?.message || '')
    if (ROW_CODE.test(code)) {
      return refused(code)
    }
    throw err
  }
}

const issueFor = (proof, result, code) => ({
  proofId: proof.id,
  journalRole: result.journalRole,
  journalId: result.journalId,
  code
})

const countByVersion = rows => {
  const byVersion = {}
  for (const row of rows) byVersion[row.masterKeyVersion] = (byVersion[row.masterKeyVersion] ?? 0) + 1
  return byVersion
}

// A pinned VIEW over the real provider: getCurrentVersion reports the target
// so sealPaymentProof wraps under the TARGET version. It delegates every key
// lookup to the real provider — no key is invented, the registry is never
// mutated, and the target is never elected the provider's current version
// (election is a provisioning act outside the lifecycle's scope).
const pinnedProvider = (keyProvider, targetVersion) => ({
  getMasterKey: version => keyProvider.getMasterKey(version),
  getCurrentVersion: () => targetVersion,
  getRegisteredVersions: () => keyProvider.getRegisteredVersions()
})

// The CAS replacement: the whole replacement envelope plus the strictly
// increasing revision. Version columns are the Int form of the envelope's
// canonical string versions (same mapping as the store's proofData). Owner
// linkage, claimDigest (unchanged) and createdAt are never written.
const replacementData = (envelope, revision) => ({
  revision,
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
})

/**
 * Safe inventory check over every stored payment proof: which key versions the
 * rows actually require, which of those are missing from the provider, every
 * row-level problem (owner linkage, capture integrity, corruption, absent key
 * versions) as a fixed safe issue, and safe counts. Never returns key
 * material, envelope bytes or claim content. Read-only.
 *
 * @param {{models: object, keyProvider: object}} request
 * @returns {Promise<{requiredVersions: number[], missingVersions: number[],
 *   currentVersion: number, ownerIssues: Array<{proofId: string, journalRole: string|null,
 *   journalId: string|null, code: string}>, counts: {proofs: number, byVersion: object}}>}
 */
export async function checkPaymentProofInventory (request) {
  const { models, keyProvider } = request ?? {}
  assertModels(models)
  assertLifecycleProvider(keyProvider)

  const registered = keyProvider.getRegisteredVersions()
  const currentVersion = keyProvider.getCurrentVersion()
  const rows = await models.paymentTransactionProof.findMany({ orderBy: [{ id: 'asc' }] })

  const ownerIssues = []
  for (const proof of rows) {
    const result = await authenticateProofRow(models, proof, keyProvider)
    if (result.code !== undefined) ownerIssues.push(issueFor(proof, result, result.code))
  }

  const requiredVersions = [...new Set(rows.map(row => row.masterKeyVersion))].sort((a, b) => a - b)
  const missingVersions = requiredVersions.filter(version => !registered.includes(version))

  return {
    requiredVersions,
    missingVersions,
    currentVersion,
    ownerIssues,
    counts: { proofs: rows.length, byVersion: countByVersion(rows) }
  }
}

/**
 * Rotate every rotatable proof to an ALREADY-PROVISIONED target key version.
 * Requires writersPaused === true (a caller-asserted operational pause: this
 * module cannot itself stop writers). Per row: authenticate the OLD envelope
 * against claims reconstructed from the authoritative owner, re-seal the
 * authenticated payload under the target version with fresh random DEK/nonces,
 * and CAS-update the whole envelope with revision+1. Rows already at the
 * target are verified and skipped WITHOUT re-encryption; corrupt rows keep
 * their old version and bytes and are reported as fixed safe issues. After
 * each batch the persisted revision/version are re-read (a resolved
 * $transaction callback is never trusted alone). Claim identity, digest and
 * owner linkage never change; no key is provisioned, elected or dropped.
 *
 * @param {{models: object, keyProvider: object, targetVersion: number,
 *   writersPaused: boolean, batchSize?: number}} request
 * @returns {Promise<{rotated: number, skipped: number, conflicts: number,
 *   issues: Array<{proofId: string, journalRole: string|null, journalId: string|null,
 *   code: string}>, counts: {proofs: number, byVersion: object, byVersionAfter: object}}>}
 */
export async function rotatePaymentProofs (request) {
  const { models, keyProvider, targetVersion, writersPaused, batchSize = DEFAULT_BATCH_SIZE } = request ?? {}
  assertModels(models)
  assertLifecycleProvider(keyProvider)
  if (writersPaused !== true) fail(WRITERS_REQUIRED)
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) fail(INVALID)
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) fail(INVALID)
  const registered = keyProvider.getRegisteredVersions()
  if (!registered.includes(targetVersion)) fail(TARGET_NOT_PROVISIONED)
  if (typeof models.$transaction !== 'function') fail(INVALID)

  const rows = await models.paymentTransactionProof.findMany({ orderBy: [{ id: 'asc' }] })
  const sealer = pinnedProvider(keyProvider, targetVersion)

  let rotated = 0
  let skipped = 0
  let conflicts = 0
  const issues = []

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const rotatedHere = []
    for (const proof of batch) {
      const result = await authenticateProofRow(models, proof, keyProvider)
      if (result.code !== undefined) {
        issues.push(issueFor(proof, result, result.code))
        continue
      }
      if (proof.masterKeyVersion === targetVersion) {
        // Authenticated at the target: skip WITHOUT re-encryption.
        skipped++
        continue
      }

      const replacement = sealPaymentProof({
        claims: result.claims,
        payload: result.payload,
        keyProvider: sealer
      })
      try {
        await models.$transaction(async client => {
          // Durability parity with the store's pair writes: the rotation's
          // only write must not acknowledge below a flushed commit. Read
          // committed is deliberate — the CAS predicate below is the guard.
          await client.$executeRaw`SET LOCAL synchronous_commit = on`
          const shown = await client.$queryRaw`SHOW synchronous_commit`
          if (shown?.[0]?.synchronous_commit !== 'on') fail(DURABILITY_REFUSED)
          const updated = await client.paymentTransactionProof.updateMany({
            where: { id: proof.id, revision: proof.revision, claimDigest: proof.claimDigest },
            data: replacementData(replacement, proof.revision + 1)
          })
          if (updated.count !== 1) fail(CONFLICT)
        })
        rotated++
        rotatedHere.push({ id: proof.id, revision: proof.revision + 1 })
      } catch (err) {
        if (String(err?.message || '') !== CONFLICT) throw err
        conflicts++
        issues.push(issueFor(proof, result, CONFLICT))
      }
    }

    // Verify persisted state by RE-READING the revisions: Prisma 5.20 can
    // resolve an interactive $transaction callback even when Postgres rejects
    // a deferred-constraint COMMIT, so the callback result is never trusted
    // as evidence of persistence.
    for (const item of rotatedHere) {
      const persisted = await models.paymentTransactionProof.findUnique({
        where: { id: item.id },
        select: { revision: true, masterKeyVersion: true }
      })
      if (!persisted || persisted.revision !== item.revision ||
        persisted.masterKeyVersion !== targetVersion) fail(VERIFY_FAILED)
    }
  }

  const after = await models.paymentTransactionProof.findMany({ select: { masterKeyVersion: true } })
  return {
    rotated,
    skipped,
    conflicts,
    issues,
    counts: { proofs: rows.length, byVersion: countByVersion(rows), byVersionAfter: countByVersion(after) }
  }
}
