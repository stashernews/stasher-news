/* eslint-env jest */

// Task 1 (rewards reconciliation): the authoritative scoped audit snapshot
// reader. Fake model objects are driven from the shared auditLedgerFixture so
// the REAL #1 proof-store inventory path (safe metadata + integrity digest)
// runs against synthetic proof rows; no real DB, wallet, key or network.

import { canonicalPaymentJson } from '@/api/monero/paymentClaims'
import { readPaymentProofInventory } from '@/api/monero/paymentProofStore'
import {
  isObservableMonetaryReceipt,
  readRewardsAuditReserve,
  readRewardsAuditSnapshot
} from '@/api/monero/rewardsAuditSnapshot'
import { accountingAuditFingerprint, accountingAuditProjection } from '@/lib/rewardsAuditFingerprint'
import { auditLedgerFixture } from '@/test/fixtures/payment-proof'

const altHash = seed => seed.toString(16).padStart(2, '0').repeat(32)

// Synthetic encrypted-envelope bytes (throwaway, never real key material) so
// the real #1 store computes a real envelopeIntegrityDigest over them.
function proofRowFor (proofId, claimDigest) {
  const seed = Buffer.from(proofId.slice(-2), 'hex')[0] ?? 0
  return {
    id: proofId,
    revision: 1,
    masterKeyVersion: 1,
    bindingVersion: 1,
    envelopeVersion: 1,
    payloadVersion: 1,
    claimDigest,
    bindingDigest: altHash(0x31),
    dataNonce: Buffer.from([seed, 1, 2, 3]),
    dataTag: Buffer.from([seed, 4, 5, 6]),
    ciphertext: Buffer.from([seed, 7, 8, 9]),
    wrapNonce: Buffer.from([seed, 10, 11, 12]),
    wrapTag: Buffer.from([seed, 13, 14, 15]),
    wrappedDek: Buffer.from([seed, 16, 17, 18])
  }
}

function fakeModelsFromFixture () {
  const f = auditLedgerFixture()
  const rewardsRow = f.ledger.transactions[0]
  const escrowRow = f.ledger.escrowTransactions[0]
  const proofById = new Map([
    [rewardsRow.proofId, proofRowFor(rewardsRow.proofId, rewardsRow.claimDigest)],
    [escrowRow.proofId, proofRowFor(escrowRow.proofId, escrowRow.claimDigest)]
  ])
  const models = {
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) => {
        const row = f.ledger.accounts.find(a => a.label === where.label && a.network === where.network)
        return row == null ? null : { id: row.id, label: row.label, network: row.network, address: row.address }
      })
    },
    subaddressIndex: {
      findMany: jest.fn(async ({ where }) =>
        f.ledger.subaddresses.filter(row => where.accountId.in.includes(row.accountId)))
    },
    feeObservation: { findMany: jest.fn(async () => f.ledger.receipts) },
    observedDownvote: { findMany: jest.fn(async () => f.ledger.downvotes) },
    rewardPayout: { findMany: jest.fn(async () => f.ledger.payouts) },
    rewardDistribution: { findMany: jest.fn(async () => f.ledger.distributions) },
    rewardsWalletTransaction: {
      findMany: jest.fn(async () => f.ledger.transactions),
      findUnique: jest.fn(async ({ where }) =>
        f.ledger.transactions.find(row => row.id === where.id) ?? null)
    },
    escrowWalletTransaction: {
      findMany: jest.fn(async () => f.ledger.escrowTransactions),
      findUnique: jest.fn(async ({ where }) =>
        f.ledger.escrowTransactions.find(row => row.id === where.id) ?? null)
    },
    bountyPayment: { findMany: jest.fn(async () => f.ledger.bountyPayments) },
    observedBounty: { findMany: jest.fn(async () => f.ledger.observedBounties) },
    observedBountyReceipt: { findMany: jest.fn(async () => f.ledger.observedBountyReceipts) },
    item: {
      findMany: jest.fn(async ({ where }) =>
        f.ledger.items.filter(row => where.id.in.includes(row.id)))
    },
    earn: { findMany: jest.fn(async () => f.ledger.earns) },
    platformFeeConfig: { findUnique: jest.fn(async () => f.config) },
    paymentTransactionProof: {
      findUnique: jest.fn(async ({ where }) => proofById.get(where.id) ?? null)
    }
  }
  return { f, models }
}

describe('readRewardsAuditSnapshot', () => {
  test('the proven platform identity is read before any authoritative read', async () => {
    const { f, models } = fakeModelsFromFixture()
    await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(models.moneroAccount.findFirst).toHaveBeenCalledWith({
      where: { label: 'platform_rewards', network: f.scope.network },
      orderBy: { id: 'asc' },
      select: { id: true, label: true, network: true, address: true }
    })
  })

  test('refuses a scope that is not the registered platform_rewards identity', async () => {
    const foreign = fakeModelsFromFixture()
    await expect(readRewardsAuditSnapshot(foreign.models, {
      scope: { network: foreign.f.scope.network, walletAddress: foreign.f.scope.walletAddress + 'x' },
      reserve: foreign.f.reserve
    })).rejects.toThrow(/platform_rewards/)

    const absent = fakeModelsFromFixture()
    absent.f.ledger.accounts = absent.f.ledger.accounts.filter(a => a.label !== 'platform_rewards')
    await expect(readRewardsAuditSnapshot(absent.models, {
      scope: absent.f.scope, reserve: absent.f.reserve
    })).rejects.toThrow(/platform_rewards/)

    const otherNetwork = fakeModelsFromFixture()
    await expect(readRewardsAuditSnapshot(otherNetwork.models, {
      scope: { network: 'MAINNET', walletAddress: otherNetwork.f.scope.walletAddress },
      reserve: otherNetwork.f.reserve
    })).rejects.toThrow(/platform_rewards/)
  })

  test('scopes the escrow journal to the registered bounty_escrow identity', async () => {
    const { f, models } = fakeModelsFromFixture()
    await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    const escrowAddress = f.ledger.accounts.find(a => a.label === 'bounty_escrow').address
    expect(models.moneroAccount.findFirst).toHaveBeenCalledWith({
      where: { label: 'bounty_escrow', network: f.scope.network },
      orderBy: { id: 'asc' },
      select: { id: true, label: true, network: true, address: true }
    })
    expect(models.escrowWalletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { network: f.scope.network, walletAddress: escrowAddress }
    }))
  })

  test('an unregistered escrow wallet leaves the escrow groups empty', async () => {
    const { f, models } = fakeModelsFromFixture()
    f.ledger.accounts = f.ledger.accounts.filter(a => a.label !== 'bounty_escrow')
    const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(models.escrowWalletTransaction.findMany).not.toHaveBeenCalled()
    expect(snapshot.ledger.escrowTransactions).toEqual([])
    expect(snapshot.ledger.accounts.map(a => a.label)).toEqual(['platform_rewards'])
    expect(snapshot.ledger.proofInventory.map(entry => entry.owner.journalRole))
      .toEqual(['REWARDS'])
  })

  test('reads the receipt group complete: every state, boost allocation via config', async () => {
    const { f, models } = fakeModelsFromFixture()
    await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(models.feeObservation.findMany).toHaveBeenCalledTimes(1)
    const [receiptQuery] = models.feeObservation.findMany.mock.calls[0]
    // no state filter and no drop filter: the audited group is complete
    expect(receiptQuery.where).toBeUndefined()
    expect(receiptQuery.select).toEqual({
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
    })
    expect(models.platformFeeConfig.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: {
        downvoteRewardsPct: true,
        postingFeeRewardsPct: true,
        territoryFeeRewardsPct: true,
        boostRewardsPct: true,
        walletlessTipRewardsPct: true
      }
    })
    expect(models.observedDownvote.findMany).toHaveBeenCalledWith({
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
    })
    expect(models.subaddressIndex.findMany).toHaveBeenCalledWith({
      where: { accountId: { in: [1, 2] } },
      select: { id: true, accountId: true, majorIndex: true, minorIndex: true, address: true, state: true },
      orderBy: [{ accountId: 'asc' }, { majorIndex: 'asc' }, { minorIndex: 'asc' }]
    })
  })

  test('selects the exact safe columns of every remaining group', async () => {
    const { f, models } = fakeModelsFromFixture()
    await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(models.rewardPayout.findMany).toHaveBeenCalledWith({
      select: { id: true, distributionId: true, curatorId: true, recipientAddress: true, piconeros: true, state: true, txHash: true }
    })
    expect(models.rewardDistribution.findMany).toHaveBeenCalledWith({
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
    })
    expect(models.rewardsWalletTransaction.findMany).toHaveBeenCalledWith({
      where: { network: f.scope.network, walletAddress: f.scope.walletAddress },
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
    })
    const escrowAddress = f.ledger.accounts.find(a => a.label === 'bounty_escrow').address
    expect(models.escrowWalletTransaction.findMany).toHaveBeenCalledWith({
      where: { network: f.scope.network, walletAddress: escrowAddress },
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
    expect(models.bountyPayment.findMany).toHaveBeenCalledWith({
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
    })
    expect(models.observedBounty.findMany).toHaveBeenCalledWith({
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
    })
    expect(models.observedBountyReceipt.findMany).toHaveBeenCalledWith({
      select: { id: true, bountyId: true, txHash: true, piconeros: true, height: true, detectedAt: true }
    })
    expect(models.item.findMany).toHaveBeenCalledWith({
      where: { id: { in: [503, 504] } },
      select: { id: true, bountyPiconeros: true, bountyFeePiconeros: true }
    })
    expect(models.earn.findMany).toHaveBeenCalledWith({
      select: { id: true, userId: true, distributionId: true, piconeros: true }
    })
  })

  test('returns the complete snapshot with a self-consistent v2 fingerprint', async () => {
    const { f, models } = fakeModelsFromFixture()
    const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(Object.keys(snapshot).sort())
      .toEqual(['accountingFingerprint', 'config', 'ledger', 'reserve', 'scope'])
    expect(snapshot.accountingFingerprint).toMatch(/^accounting:v2:[0-9a-f]{64}$/)
    expect(snapshot.accountingFingerprint).toBe(accountingAuditFingerprint({
      scope: snapshot.scope, ledger: snapshot.ledger, config: snapshot.config, reserve: snapshot.reserve
    }))
    expect(snapshot.scope).toEqual({ network: 'STAGENET', walletAddress: f.scope.walletAddress })
    expect(snapshot.reserve).toEqual({ feeHeadroomPiconeros: 1000000000n, dustFloorPiconeros: 1000000000n })
    for (const group of ['accounts', 'subaddresses', 'receipts', 'downvotes', 'payouts', 'distributions',
      'transactions', 'escrowTransactions', 'bountyPayments', 'observedBounties',
      'observedBountyReceipts', 'items', 'earns', 'proofInventory']) {
      expect(Array.isArray(snapshot.ledger[group])).toBe(true)
    }
  })

  test('the audited receipt group retains boost and every non-CONFIRMED chain-addressable row', async () => {
    const { f, models } = fakeModelsFromFixture()
    const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    // no drop filter ran: DETECTED/PENDING rows and the unreadable-hash row
    // with a positive material amount are all still audited
    expect(snapshot.ledger.receipts.map(row => row.state))
      .toEqual(expect.arrayContaining(['PENDING', 'DETECTED', 'CONFIRMED']))
    expect(snapshot.ledger.receipts.some(row => row.txHash === 'not-a-chain-hash' && row.piconeros === 300n)).toBe(true)
    expect(isObservableMonetaryReceipt(snapshot.ledger.receipts.find(row => row.id === 104n))).toBe(true)
    // the boost allocation row is audited and config exposes its percentage
    expect(snapshot.ledger.receipts.some(row => row.feeType === 'BOOST')).toBe(true)
    expect(snapshot.config.boostRewardsPct).toBe(30)
  })

  test('proof inventory entries come from the #1 safe store and carry no envelope bytes', async () => {
    const { f, models } = fakeModelsFromFixture()
    const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    // the exact #1 inventory records, byte-integrity digest included
    const direct = await readPaymentProofInventory(models, [
      { journalRole: 'REWARDS', journalId: f.ledger.transactions[0].id },
      { journalRole: 'ESCROW', journalId: f.ledger.escrowTransactions[0].id }
    ])
    expect(snapshot.ledger.proofInventory).toHaveLength(2)
    expect(snapshot.ledger.proofInventory[0]).toEqual({
      owner: { journalRole: 'REWARDS', journalId: f.ledger.transactions[0].id },
      reference: {
        txHash: f.ledger.transactions[0].txHash,
        kind: 'PAYOUT',
        dispatchId: f.ledger.transactions[0].dispatchId,
        leg: null,
        bountyPaymentId: null,
        itemId: null
      },
      proof: direct[0]
    })
    expect(snapshot.ledger.proofInventory[1].reference).toEqual({
      txHash: f.ledger.escrowTransactions[0].txHash,
      kind: 'AWARD',
      dispatchId: f.ledger.escrowTransactions[0].dispatchId,
      leg: 'DISPOSITION',
      bountyPaymentId: 701,
      itemId: 503
    })
    expect(direct[0].envelopeIntegrityDigest).toMatch(/^[0-9a-f]{64}$/)
    // the legacy journal row (no proofId) never produced a selector — one
    // findUnique per proof-declaring journal row (the extra call below is this
    // test's own direct inventory comparison)
    expect(models.rewardsWalletTransaction.findUnique).toHaveBeenCalledTimes(2)
    expect(models.rewardsWalletTransaction.findUnique).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ where: { id: f.ledger.transactions[0].id } }))
    expect(models.escrowWalletTransaction.findUnique).toHaveBeenCalledTimes(2)
    expect(models.escrowWalletTransaction.findUnique).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ where: { id: f.ledger.escrowTransactions[0].id } }))
    // and no envelope byte field reaches the public snapshot
    const serialized = canonicalPaymentJson(accountingAuditProjection({
      scope: snapshot.scope, ledger: snapshot.ledger, config: snapshot.config, reserve: snapshot.reserve
    }))
    expect(serialized).not.toMatch(/ciphertext|nonce|wrappeddek|datatag|wraptag|viewkey|spendkey/i)
  })

  test('a missing or broken proof row is retained as a null proof, never dropped', async () => {
    const { f, models } = fakeModelsFromFixture()
    // the legacy PREPARED sweep row gains a proofId whose proof row is gone
    f.ledger.transactions[1].proofId = '00000000-0000-4000-8000-000000000099'
    const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(snapshot.ledger.proofInventory).toHaveLength(3)
    const broken = snapshot.ledger.proofInventory.find(entry => entry.owner.journalId === 502n)
    expect(broken.owner).toEqual({ journalRole: 'REWARDS', journalId: 502n })
    expect(broken.proof).toBeNull()
  })

  test('in-flight funding terms are linked through ObservedBounty.postId', async () => {
    // item 504 has an ObservedBounty (DETECTED funding) but NO BountyPayment:
    // its declared terms must still be read and audited.
    const { f, models } = fakeModelsFromFixture()
    const before = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: f.reserve })
    expect(models.item.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: expect.arrayContaining([504]) } } }))
    expect(before.ledger.items.some(row => row.id === 504)).toBe(true)
    expect(before.ledger.observedBounties.some(row => row.postId === 504)).toBe(true)

    // a change to the in-flight item's prize terms moves the fingerprint
    const repriced = fakeModelsFromFixture()
    repriced.f.ledger.items[1].bountyPiconeros += 1n
    const repricedSnapshot = await readRewardsAuditSnapshot(repriced.models, {
      scope: repriced.f.scope, reserve: repriced.f.reserve
    })
    expect(repricedSnapshot.accountingFingerprint).not.toBe(before.accountingFingerprint)

    // and so does a change to its fee terms (previously null)
    const feeChanged = fakeModelsFromFixture()
    feeChanged.f.ledger.items[1].bountyFeePiconeros = 7n
    const feeChangedSnapshot = await readRewardsAuditSnapshot(feeChanged.models, {
      scope: feeChanged.f.scope, reserve: feeChanged.f.reserve
    })
    expect(feeChangedSnapshot.accountingFingerprint).not.toBe(before.accountingFingerprint)
  })

  test('pending receipt state and config changes move the snapshot fingerprint', async () => {
    const fresh = fakeModelsFromFixture()
    const freshSnapshot = await readRewardsAuditSnapshot(fresh.models, {
      scope: fresh.f.scope, reserve: fresh.f.reserve
    })

    const stateChanged = fakeModelsFromFixture()
    stateChanged.f.ledger.receipts[0].state = 'PENDING'
    const stateSnapshot = await readRewardsAuditSnapshot(stateChanged.models, {
      scope: stateChanged.f.scope, reserve: stateChanged.f.reserve
    })
    expect(stateSnapshot.accountingFingerprint).not.toBe(freshSnapshot.accountingFingerprint)

    const configChanged = fakeModelsFromFixture()
    configChanged.f.config.boostRewardsPct = 31
    const configSnapshot = await readRewardsAuditSnapshot(configChanged.models, {
      scope: configChanged.f.scope, reserve: configChanged.f.reserve
    })
    expect(configSnapshot.accountingFingerprint).not.toBe(freshSnapshot.accountingFingerprint)
  })

  test('the effective reserve is the single injected input, never mixed with env', async () => {
    const { f, models } = fakeModelsFromFixture()
    const previous = process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS
    process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS = '999999'
    try {
      const injected = { feeHeadroomPiconeros: 5n, dustFloorPiconeros: 6n }
      const snapshot = await readRewardsAuditSnapshot(models, { scope: f.scope, reserve: injected })
      expect(snapshot.reserve).toEqual(injected)
      expect(snapshot.accountingFingerprint).toBe(accountingAuditFingerprint({
        scope: snapshot.scope, ledger: snapshot.ledger, config: snapshot.config, reserve: injected
      }))
    } finally {
      if (previous === undefined) delete process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS
      else process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS = previous
    }
  })

  test('missing models, config row or malformed reserve fail closed', async () => {
    const { f, models } = fakeModelsFromFixture()
    await expect(readRewardsAuditSnapshot(undefined, { scope: f.scope, reserve: f.reserve }))
      .rejects.toThrow(/models/)
    await expect(readRewardsAuditSnapshot(models, {})).rejects.toThrow(/scope/)
    await expect(readRewardsAuditSnapshot(models, { scope: f.scope }))
      .rejects.toThrow(/reserve/)

    const noEarn = fakeModelsFromFixture()
    delete noEarn.models.earn
    await expect(readRewardsAuditSnapshot(noEarn.models, { scope: noEarn.f.scope, reserve: noEarn.f.reserve }))
      .rejects.toThrow(/earn/)

    const noProofs = fakeModelsFromFixture()
    delete noProofs.models.paymentTransactionProof
    await expect(readRewardsAuditSnapshot(noProofs.models, { scope: noProofs.f.scope, reserve: noProofs.f.reserve }))
      .rejects.toThrow(/paymentTransactionProof/)

    const noConfig = fakeModelsFromFixture()
    noConfig.models.platformFeeConfig.findUnique.mockResolvedValue(null)
    await expect(readRewardsAuditSnapshot(noConfig.models, { scope: noConfig.f.scope, reserve: noConfig.f.reserve }))
      .rejects.toThrow(/PlatformFeeConfig/)

    const stringReserve = fakeModelsFromFixture()
    await expect(readRewardsAuditSnapshot(stringReserve.models, {
      scope: stringReserve.f.scope,
      reserve: { feeHeadroomPiconeros: '1000000000', dustFloorPiconeros: 1000000000n }
    })).rejects.toThrow(/BigInt/)

    const partialReserve = fakeModelsFromFixture()
    await expect(readRewardsAuditSnapshot(partialReserve.models, {
      scope: partialReserve.f.scope,
      reserve: { feeHeadroomPiconeros: 1000000000n }
    })).rejects.toThrow(/dustFloorPiconeros/)
  })
})

describe('readRewardsAuditReserve', () => {
  const HEADROOM = 'REWARDS_TX_FEE_HEADROOM_PICONEROS'
  const DUST = 'REWARDS_OPS_SWEEP_MIN_PICONEROS'
  let saved

  beforeEach(() => {
    saved = { [HEADROOM]: process.env[HEADROOM], [DUST]: process.env[DUST] }
    delete process.env[HEADROOM]
    delete process.env[DUST]
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test('the exact existing defaults are one billion piconeros each', () => {
    expect(readRewardsAuditReserve()).toEqual({
      feeHeadroomPiconeros: 1000000000n,
      dustFloorPiconeros: 1000000000n
    })
  })

  test('env overrides are audited effective values when canonical', () => {
    process.env[HEADROOM] = '2500000000'
    process.env[DUST] = '0'
    expect(readRewardsAuditReserve()).toEqual({
      feeHeadroomPiconeros: 2500000000n,
      dustFloorPiconeros: 0n
    })
  })

  test.each(['12x', '-5', '1e9', '1.5', '0x10'])(
    'invalid env value %p refuses instead of defaulting', value => {
      process.env[HEADROOM] = value
      expect(() => readRewardsAuditReserve()).toThrow(/REWARDS_TX_FEE_HEADROOM_PICONEROS/)
    })
})

describe('isObservableMonetaryReceipt (the one shared receipt filter)', () => {
  const hash = altHash(0x99)
  test.each([
    ['valid chain hash in a PENDING state', { txHash: hash, state: 'PENDING', piconeros: 0n }, true],
    ['valid chain hash in a CONFIRMED state', { txHash: hash, state: 'CONFIRMED', piconeros: 0n }, true],
    ['valid chain hash with walletReceipt false', { txHash: hash, state: 'CONFIRMED', walletReceipt: false, piconeros: 0n }, true],
    ['unreadable hash with a positive material amount', { txHash: 'nope', state: 'DETECTED', piconeros: 5n }, true],
    ['absent hash with a positive material amount', { txHash: null, state: 'DETECTED', piconeros: 5n }, true],
    ['unreadable hash with a zero amount', { txHash: 'nope', state: 'DETECTED', piconeros: 0n }, false],
    ['absent hash with a null amount', { txHash: null, piconeros: null }, false],
    ['unsafe number amounts are not material money', { txHash: null, piconeros: 5.5 }, false],
    ['a missing row is not observable', null, false]
  ])('%s', (_name, row, expected) => {
    expect(isObservableMonetaryReceipt(row)).toBe(expected)
  })

  test('uppercase hex normalizes, so case never hides a chain fact', () => {
    expect(isObservableMonetaryReceipt({ txHash: hash.toUpperCase(), piconeros: 0n })).toBe(true)
  })
})
