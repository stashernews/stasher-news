import { readPaymentProofInventory } from '@/api/monero/paymentProofStore'
import { accountingAuditFingerprint } from '@/lib/rewardsAuditFingerprint'

// One authoritative scoped reader/select/filter contract for the rewards
// accounting audit (rewards reconciliation plan, Task 1). Every freshness
// consumer reads through `readRewardsAuditSnapshot` so the ledger groups, the
// receipt visibility rule and the `accounting:v2:` fingerprint can never drift
// apart. No wallet, daemon or key provider is ever opened here: the proof
// inventory comes from the #1 store's SAFE `readPaymentProofInventory` surface
// (metadata + integrity digests only), and the caller passes its Prisma
// transaction client as `models` so the whole snapshot reads one consistent
// Serializable view.
//
// Scope is the INDEPENDENTLY REGISTERED platform_rewards identity — proven
// before any authoritative read, exactly like the #1 collector. A configured
// scope that disagrees with the registered `platform_rewards` account is
// refused; the escrow journal is scoped to the separately checked registered
// `bounty_escrow` account (optional, as in the collector). All unscoped ledger
// groups belong to that single proven platform wallet in this DB. Missing
// required models, config row or reserve input fails closed.

const REWARDS_NETWORKS = new Set(['MAINNET', 'STAGENET'])
const CHAIN_HASH_RE = /^[0-9a-f]{64}$/
const CANONICAL_AMOUNT_RE = /^(0|[1-9][0-9]*)$/

// The exact existing reserve inputs of the reconciliation CLI (defaults kept
// byte-identical): fee headroom per relayed tx and the ops-sweep dust floor.
const FEE_HEADROOM_ENV = 'REWARDS_TX_FEE_HEADROOM_PICONEROS'
const OPS_SWEEP_MIN_ENV = 'REWARDS_OPS_SWEEP_MIN_PICONEROS'
const FEE_HEADROOM_DEFAULT = '1000000000'
const OPS_SWEEP_MIN_DEFAULT = '1000000000'

const REQUIRED_MODELS = Object.freeze([
  ['moneroAccount', 'findFirst'],
  ['subaddressIndex', 'findMany'],
  ['feeObservation', 'findMany'],
  ['observedDownvote', 'findMany'],
  ['rewardPayout', 'findMany'],
  ['rewardDistribution', 'findMany'],
  ['rewardsWalletTransaction', 'findMany'],
  ['rewardsWalletTransaction', 'findUnique'],
  ['escrowWalletTransaction', 'findMany'],
  ['escrowWalletTransaction', 'findUnique'],
  ['bountyPayment', 'findMany'],
  ['observedBounty', 'findMany'],
  ['observedBountyReceipt', 'findMany'],
  ['item', 'findMany'],
  ['earn', 'findMany'],
  ['platformFeeConfig', 'findUnique'],
  ['paymentTransactionProof', 'findUnique']
])

function normalizeChainHash (value) {
  if (typeof value !== 'string') return null
  const hash = value.toLowerCase()
  return CHAIN_HASH_RE.test(hash) ? hash : null
}

function canonicalAmountOrNull (value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && CANONICAL_AMOUNT_RE.test(value)) return BigInt(value)
  return null
}

/**
 * The ONE receipt-visibility rule every consumer shares: a FeeObservation is
 * an observable monetary row when its txHash is a valid chain hash (in ANY
 * state) OR its material amount is a readable positive piconero value. Rows
 * failing both stay in the audited snapshot (nothing is allowed to disappear)
 * but carry no money-union weight; JS-number amounts are never material.
 *
 * @param {object|null} row a FeeObservation-shaped row
 * @returns {boolean}
 */
export function isObservableMonetaryReceipt (row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (normalizeChainHash(row.txHash) !== null) return true
  const amount = canonicalAmountOrNull(row.piconeros)
  return amount !== null && amount > 0n
}

/**
 * Effective audited reserve inputs. One shared effective value (never mixed
 * current-env versus manifest snapshot): the caller reads it once and passes
 * it explicitly into `readRewardsAuditSnapshot`.
 *
 * @param {object} [env=process.env]
 * @returns {{feeHeadroomPiconeros: bigint, dustFloorPiconeros: bigint}}
 */
export function readRewardsAuditReserve (env = process.env) {
  return {
    feeHeadroomPiconeros: reserveAmount(env?.[FEE_HEADROOM_ENV], FEE_HEADROOM_DEFAULT, FEE_HEADROOM_ENV),
    dustFloorPiconeros: reserveAmount(env?.[OPS_SWEEP_MIN_ENV], OPS_SWEEP_MIN_DEFAULT, OPS_SWEEP_MIN_ENV)
  }
}

function reserveAmount (value, fallback, name) {
  const text = value === undefined || value === null || value === '' ? fallback : value
  if (typeof text !== 'string' || !CANONICAL_AMOUNT_RE.test(text)) {
    throw new Error(`readRewardsAuditReserve: ${name} must be a canonical nonnegative decimal piconero string`)
  }
  return BigInt(text)
}

function normalizeScope (scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('readRewardsAuditSnapshot: a scope is required')
  }
  if (!REWARDS_NETWORKS.has(scope.network)) {
    throw new Error('readRewardsAuditSnapshot: unsupported rewards network')
  }
  if (typeof scope.walletAddress !== 'string' || scope.walletAddress === '') {
    throw new Error('readRewardsAuditSnapshot: wallet address is not configured')
  }
  return { network: scope.network, walletAddress: scope.walletAddress }
}

function requireReserve (reserve) {
  if (reserve === null || typeof reserve !== 'object' || Array.isArray(reserve)) {
    throw new Error('readRewardsAuditSnapshot: a reserve is required')
  }
  for (const key of ['feeHeadroomPiconeros', 'dustFloorPiconeros']) {
    if (typeof reserve[key] !== 'bigint') {
      throw new Error(`readRewardsAuditSnapshot: reserve.${key} must be a BigInt piconero amount`)
    }
  }
  return { feeHeadroomPiconeros: reserve.feeHeadroomPiconeros, dustFloorPiconeros: reserve.dustFloorPiconeros }
}

function requireModels (models) {
  for (const [model, method] of REQUIRED_MODELS) {
    if (typeof models?.[model]?.[method] !== 'function') {
      throw new Error(`readRewardsAuditSnapshot: models.${model}.${method} is required`)
    }
  }
}

// The registered identity for one wallet label, resolved like the #1
// collector (orderBy id asc pins resolution when duplicates exist).
function loadRegisteredAccount (models, label, network) {
  return models.moneroAccount.findFirst({
    where: { label, network },
    orderBy: { id: 'asc' },
    select: { id: true, label: true, network: true, address: true }
  })
}

/**
 * Read the complete safe audit snapshot inside the caller's transaction.
 *
 * @param {object} models Prisma client (or a transactional client)
 * @param {object} options `{ scope, reserve }` — the proven
 *   `{ network, walletAddress }` scope and the effective
 *   `{ feeHeadroomPiconeros, dustFloorPiconeros }` BigInt reserve
 *   (`readRewardsAuditReserve()`).
 * @returns {Promise<object>} `{ scope, ledger, config, reserve,
 *   accountingFingerprint }` where ledger carries receipts/downvotes/payouts/
 *   distributions/transactions/escrowTransactions/bountyPayments/
 *   observedBounties/observedBountyReceipts/items/earns/accounts/subaddresses/
 *   proofInventory (complete groups, safe fields only, BigInts/Dates intact —
 *   the fingerprint projection canonicalizes them).
 */
export async function readRewardsAuditSnapshot (models, { scope, reserve } = {}) {
  if (!models) throw new Error('readRewardsAuditSnapshot: models are required')
  const scoped = normalizeScope(scope)
  const auditedReserve = requireReserve(reserve)
  requireModels(models)

  // Scope is proven BEFORE any authoritative read: ledger facts from another
  // wallet's identity are worthless.
  const platformAccount = await loadRegisteredAccount(models, 'platform_rewards', scoped.network)
  if (!platformAccount) {
    throw new Error(`readRewardsAuditSnapshot: no platform_rewards account is registered for ${scoped.network}`)
  }
  if (platformAccount.address !== scoped.walletAddress || platformAccount.network !== scoped.network) {
    throw new Error('readRewardsAuditSnapshot: the configured scope is not the registered platform_rewards wallet')
  }
  const escrowAccount = await loadRegisteredAccount(models, 'bounty_escrow', scoped.network)

  const accountIds = escrowAccount ? [platformAccount.id, escrowAccount.id] : [platformAccount.id]

  const [
    receipts, downvotes, payouts, distributions, transactions, escrowTransactions,
    bountyPayments, observedBounties, observedBountyReceipts, earns, config, subaddresses
  ] = await Promise.all([
    // Complete group: no state filter — a receipt row is chain-addressable in
    // ANY state (see isObservableMonetaryReceipt) and invalid/unreadable
    // monetary rows are retained rather than allowed to disappear.
    models.feeObservation.findMany({
      select: {
        id: true,
        txHash: true,
        feeType: true,
        postId: true,
        subName: true,
        payInId: true,
        recipientMajor: true,
        recipientMinor: true,
        walletReceipt: true,
        state: true,
        piconeros: true,
        rewardsPiconeros: true,
        donationRewardsPct: true,
        height: true,
        confirmedAt: true
      }
    }),
    models.observedDownvote.findMany({
      select: {
        id: true,
        txHash: true,
        paymentId: true,
        postId: true,
        downvoterId: true,
        state: true,
        piconeros: true,
        height: true,
        confirmedAt: true
      }
    }),
    models.rewardPayout.findMany({
      select: {
        id: true,
        distributionId: true,
        curatorId: true,
        recipientAddress: true,
        piconeros: true,
        state: true,
        txHash: true
      }
    }),
    models.rewardDistribution.findMany({
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        poolPiconeros: true,
        distributedPiconeros: true,
        rolledOverPiconeros: true,
        payoutCount: true,
        opsInflowPiconeros: true,
        opsRolledOverPiconeros: true,
        opsAvailablePiconeros: true,
        opsSweptPiconeros: true,
        opsSweepState: true,
        opsSweepTxHash: true,
        opsNetworkFeesAccountedPiconeros: true
      }
    }),
    models.rewardsWalletTransaction.findMany({
      where: { network: scoped.network, walletAddress: scoped.walletAddress },
      select: {
        id: true,
        network: true,
        walletAddress: true,
        txHash: true,
        kind: true,
        accountIndex: true,
        distributionId: true,
        principalPiconeros: true,
        networkFeePiconeros: true,
        metadata: true,
        state: true,
        preparedAt: true,
        relayAttemptedAt: true,
        relayedAt: true,
        relayProvenance: true,
        dispatchId: true,
        captureContractVersion: true,
        claimDigest: true,
        paymentClaims: true,
        proofId: true
      }
    }),
    // The escrow journal is scoped to the separately checked registered
    // bounty_escrow identity, never to caller-supplied address text.
    escrowAccount
      ? models.escrowWalletTransaction.findMany({
        where: { network: scoped.network, walletAddress: escrowAccount.address },
        select: {
          id: true,
          network: true,
          walletAddress: true,
          txHash: true,
          dispatchId: true,
          proofId: true,
          captureContractVersion: true,
          claimDigest: true,
          paymentClaims: true,
          kind: true,
          leg: true,
          bountyPaymentId: true,
          itemId: true,
          accountIndex: true,
          principalPiconeros: true,
          networkFeePiconeros: true,
          metadata: true,
          state: true,
          preparedAt: true,
          relayAttemptedAt: true,
          relayedAt: true,
          relayProvenance: true
        }
      })
      : Promise.resolve([]),
    models.bountyPayment.findMany({
      select: {
        id: true,
        itemId: true,
        winnerUserId: true,
        kind: true,
        piconeros: true,
        feePiconeros: true,
        recipientAddress: true,
        feeRecipientAddress: true,
        state: true,
        txHash: true,
        feeTxHash: true,
        feePendingAt: true,
        networkFeePiconeros: true,
        recipientReceivedPiconeros: true,
        feeReceivedPiconeros: true,
        feeSettlementNetworkFeePiconeros: true,
        sentAt: true,
        confirmedAt: true,
        height: true
      }
    }),
    models.observedBounty.findMany({
      select: {
        id: true,
        postId: true,
        payerId: true,
        recipientAccountId: true,
        paymentId: true,
        txHash: true,
        piconeros: true,
        state: true,
        height: true,
        confirmedAt: true
      }
    }),
    models.observedBountyReceipt.findMany({
      select: { id: true, bountyId: true, txHash: true, piconeros: true, height: true, detectedAt: true }
    }),
    models.earn.findMany({
      select: { id: true, userId: true, distributionId: true, piconeros: true }
    }),
    models.platformFeeConfig.findUnique({
      where: { id: 1 },
      select: {
        downvoteRewardsPct: true,
        postingFeeRewardsPct: true,
        territoryFeeRewardsPct: true,
        boostRewardsPct: true,
        walletlessTipRewardsPct: true
      }
    }),
    models.subaddressIndex.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true, accountId: true, majorIndex: true, minorIndex: true, address: true, state: true },
      orderBy: [{ accountId: 'asc' }, { majorIndex: 'asc' }, { minorIndex: 'asc' }]
    })
  ])

  if (!config) {
    throw new Error('readRewardsAuditSnapshot: the PlatformFeeConfig row (id=1) is required')
  }

  // Linked Item terms: through BountyPayment.itemId AND through in-flight
  // bounty funding (ObservedBounty.postId, the declared Item relation) —
  // funding terms exist before any BountyPayment row does. Set dedup keeps
  // the identity list deterministic; the projection canonically sorts the
  // resulting Item rows.
  const itemIds = [...new Set([
    ...bountyPayments.map(row => row.itemId),
    ...observedBounties.map(row => row.postId)
  ].filter(Number.isSafeInteger))]
  const items = itemIds.length === 0
    ? []
    : await models.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, bountyPiconeros: true, bountyFeePiconeros: true }
    })

  // Safe proof inventory through the #1 store: one selector per journal row
  // that DECLARES a proof (a legacy row's proofId=null is already part of its
  // projected row). A selector whose proof row is missing or claim-mismatched
  // keeps a null proof entry — an anomaly must not disappear.
  const selectors = [
    ...transactions.filter(row => row.proofId != null)
      .map(row => ({ journalRole: 'REWARDS', journalId: row.id })),
    ...escrowTransactions.filter(row => row.proofId != null)
      .map(row => ({ journalRole: 'ESCROW', journalId: row.id }))
  ]
  const inventory = selectors.length > 0
    ? await readPaymentProofInventory(models, selectors)
    : []
  const rewardsById = new Map(transactions.map(row => [row.id, row]))
  const escrowById = new Map(escrowTransactions.map(row => [row.id, row]))
  const proofInventory = selectors.map((selector, index) => {
    const row = selector.journalRole === 'REWARDS'
      ? rewardsById.get(selector.journalId)
      : escrowById.get(selector.journalId)
    return {
      owner: { journalRole: selector.journalRole, journalId: row.id },
      reference: selector.journalRole === 'REWARDS'
        ? {
            txHash: row.txHash,
            kind: row.kind,
            dispatchId: row.dispatchId,
            leg: null,
            bountyPaymentId: null,
            itemId: null
          }
        : {
            txHash: row.txHash,
            kind: row.kind,
            dispatchId: row.dispatchId,
            leg: row.leg,
            bountyPaymentId: row.bountyPaymentId,
            itemId: row.itemId
          },
      proof: inventory[index]
    }
  })

  const accounts = escrowAccount ? [platformAccount, escrowAccount] : [platformAccount]
  const ledger = {
    accounts,
    subaddresses,
    receipts,
    downvotes,
    payouts,
    distributions,
    transactions,
    escrowTransactions,
    bountyPayments,
    observedBounties,
    observedBountyReceipts,
    items,
    earns,
    proofInventory
  }
  const scopeOut = { network: scoped.network, walletAddress: scoped.walletAddress }
  return {
    scope: scopeOut,
    ledger,
    config,
    reserve: auditedReserve,
    accountingFingerprint: accountingAuditFingerprint({
      scope: scopeOut, ledger, config, reserve: auditedReserve
    })
  }
}
