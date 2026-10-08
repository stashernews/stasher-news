/* eslint-env jest */
import { collectRewardsWalletEvidence } from '@/api/monero/rewardsWalletEvidence'
import { FI } from '../../fixtures/rewards-accounting-evidence'
import { paymentChainFixture } from '../../fixtures/payment-proof'

// Read-only evidence collection tests (rewards accounting repair §8, Task 12).
// Every wallet is a fake; no DB, no daemon, no SDK. The fakes define
// createTx/relayTx/sweepUnlocked as throw-on-call and every test asserts the
// audit never invoked them.

const { SCOPE, BOUNDARY, ADDRESS, TX, HEIGHT } = FI

const ADDRESS_FOR = (primary, major, minor) =>
  major === 0 && minor === 0 ? primary : `${primary}:${major}:${minor}`

// Every wallet constructed for a test is tracked so the zero-send guarantee is
// asserted on EVERY path (happy, rejection and retry), not just the happy one.
const createdWallets = []

function validCollectionFixture () {
  const chain = paymentChainFixture()
  const scope = chain.collectOptions.scope
  const derived = chain.collectOptions.derivation.derived
  const tiers = derived.map(row => [row.address])
  const wallet = makeAuditWallet({ primaryAddress: scope.walletAddress, height: chain.collectOptions.boundary.height + 1, subaddresses: tiers })
  const escrowWallet = makeAuditWallet({ label: 'escrow', primaryAddress: scope.walletAddress, height: chain.collectOptions.boundary.height + 1 })
  for (const audit of [wallet, escrowWallet]) {
    audit.getOutputs = chain.wallet.getOutputs
    audit.getPrivateViewKey = chain.wallet.getPrivateViewKey
    audit.getAddress = chain.wallet.getAddress
    audit.checkTxKey = chain.wallet.checkTxKey
  }
  const { models, rewardAccount, escrowAccount } = makeModels({
    rewardSubRows: derived.map(row => ({ ...row, accountId: 616, state: 'AVAILABLE' })),
    escrowSubRows: [],
    escrowJournalRows: [{ id: 1, txHash: chain.txHash, network: scope.network, walletAddress: scope.walletAddress, dispatchId: '00000000-0000-4000-8000-000000000001', captureContractVersion: 1 }]
  })
  rewardAccount.address = scope.walletAddress
  escrowAccount.address = scope.walletAddress
  // Captured owner metadata deliberately lacks a proof pair: the verifier
  // must reach that distinct refusal, not lose the valid escrow session.
  models.escrowWalletTransaction.findUnique = async () => ({
    id: 1,
    txHash: chain.txHash,
    network: scope.network,
    walletAddress: scope.walletAddress,
    dispatchId: '00000000-0000-4000-8000-000000000001',
    captureContractVersion: 1,
    claimDigest: 'ab'.repeat(32),
    paymentClaims: {},
    proofId: '00000000-0000-4000-8000-000000000002'
  })
  models.paymentTransactionProof = { findUnique: async () => null }
  chain.daemon.getTransactions = async hashes => hashes.map(hash => ({ hash }))
  return { chain, scope, wallet, escrowWallet, models, daemon: chain.daemon }
}

test('account-0-only escrow evidence collector retains its verification session', async () => {
  const f = validCollectionFixture()
  const evidence = await collectRewardsWalletEvidence({ ...f, wallet: f.wallet })
  expect(evidence.escrow.derivation.derived).toHaveLength(1)
  expect(evidence.escrow.paymentVerifications).toHaveLength(1)
  expect(evidence.escrow.paymentVerifications[0].issues).not.toContain('CHAIN_EVIDENCE_UNAVAILABLE')
})

test.each(['REWARDS', 'ESCROW'])('one pending %s candidate preserves two confirmed verification sessions', async role => {
  const f = validCollectionFixture()
  const pending = 'b2'.repeat(32)
  const second = 'b3'.repeat(32)
  const journalName = role === 'REWARDS' ? 'rewardsWalletTransaction' : 'escrowWalletTransaction'
  const audit = role === 'REWARDS' ? f.wallet : f.escrowWallet
  const owner = await f.models.escrowWalletTransaction.findUnique()
  const owners = [f.chain.txHash, second, pending].map((txHash, index) => ({ ...owner, id: index + 1, txHash }))
  f.models[journalName].findMany.mockResolvedValue(owners)
  f.models[journalName].findUnique = async ({ where }) => owners.find(row => BigInt(row.id) === where.id)
  const raw = f.chain.session.rawByHash[f.chain.txHash]
  f.chain.session.rawByHash[second] = { ...raw, txHash: second, voutKeys: [raw.voutKeys[0]], additionalPublicKeys: [raw.additionalPublicKeys[0]], outputIndices: [1001] }
  audit.getOutgoingTransfers.mockResolvedValue([makeTransfer({ hash: pending, inTxPool: true, isConfirmed: false })])
  const original = f.daemon.getPaymentTransactions.getMockImplementation()
  f.daemon.getPaymentTransactions.mockImplementation(async hashes => {
    if (hashes.includes(pending)) {
      const err = new Error('synthetic pool refusal')
      err.code = 'RAW_TX_IN_POOL'
      throw err
    }
    return original(hashes)
  })
  const evidence = await collectRewardsWalletEvidence(f)
  const results = role === 'REWARDS' ? evidence.paymentVerifications : evidence.escrow.paymentVerifications
  for (const hash of [f.chain.txHash, second]) {
    expect(results.find(result => result.txHash === hash).issues).not.toContain('CHAIN_EVIDENCE_UNAVAILABLE')
  }
  expect(results.find(result => result.txHash === pending)).toMatchObject({ status: 'unresolved', issues: ['CONFIRMATION_REQUIRED'] })
})

function expectNoSendCalls (wallet) {
  expect(wallet.createTx).not.toHaveBeenCalled()
  expect(wallet.relayTx).not.toHaveBeenCalled()
  expect(wallet.sweepUnlocked).not.toHaveBeenCalled()
}

afterEach(() => {
  for (const wallet of createdWallets) expectNoSendCalls(wallet)
  createdWallets.length = 0
})

function makeAuditWallet ({
  label = 'rewards',
  primaryAddress,
  networkType = 2,
  // Scanned block COUNT (monero-ts wallet height): covering boundary index
  // BOUNDARY.height requires at least BOUNDARY.height + 1 scanned blocks.
  height = BOUNDARY.height + 1,
  syncedHeight = height,
  subaddresses,
  incoming = [],
  outgoing = [],
  balances = {},
  log = []
}) {
  const tiers = (subaddresses ?? [[primaryAddress]]).map(tier => [...tier])
  const created = { subaddresses: [], accounts: [] }
  const track = name => log.push(`${label}:${name}`)
  const sub = (major, minor) => ({
    getAddress: () => tiers[major][minor],
    getAccountIndex: () => major,
    getSubaddressIndex: () => minor
  })
  const wallet = {
    created,
    tiers,
    getPrimaryAddress: jest.fn(async () => { track('getPrimaryAddress'); return primaryAddress }),
    getNetworkType: jest.fn(async () => { track('getNetworkType'); return networkType }),
    getHeight: jest.fn(async () => { track('getHeight'); return height }),
    sync: jest.fn(async () => { track('sync'); height = Math.max(height, syncedHeight) }),
    getAccounts: jest.fn(async () => tiers.map((_, index) => ({ index }))),
    createAccount: jest.fn(async () => {
      const index = tiers.length
      tiers.push([ADDRESS_FOR(primaryAddress, index, 0)])
      created.accounts.push(index)
      return { index }
    }),
    getSubaddresses: jest.fn(async (major) => (tiers[major] ?? []).map((_, minor) => sub(major, minor))),
    getSubaddress: jest.fn(async (major, minor) => sub(major, minor)),
    createSubaddress: jest.fn(async (major) => {
      const minor = (tiers[major] ?? []).length
      tiers[major].push(ADDRESS_FOR(primaryAddress, major, minor))
      created.subaddresses.push({ major, minor })
      return sub(major, minor)
    }),
    getIncomingTransfers: jest.fn(async () => { track('getIncomingTransfers'); return incoming }),
    getOutgoingTransfers: jest.fn(async () => { track('getOutgoingTransfers'); return outgoing }),
    getBalance: jest.fn(async (accountIndex = 0) => { track('getBalance'); return balances[accountIndex]?.total ?? 0n }),
    getUnlockedBalance: jest.fn(async (accountIndex = 0) => balances[accountIndex]?.unlocked ?? 0n),
    close: jest.fn(async () => { track('close') }),
    // The audit must never have send authority.
    createTx: jest.fn(() => { throw new Error('createTx must never be called by the read-only audit') }),
    relayTx: jest.fn(() => { throw new Error('relayTx must never be called by the read-only audit') }),
    sweepUnlocked: jest.fn(() => { throw new Error('sweepUnlocked must never be called by the read-only audit') })
  }
  createdWallets.push(wallet)
  return wallet
}

function makeTransfer ({
  hash = 'aa'.repeat(32),
  height = HEIGHT.PAYOUT,
  fee = 0n,
  accountIndex = 0,
  subaddressIndex = 0,
  amount = 0n,
  destinations = [],
  confirmations = 10,
  inTxPool = false,
  isConfirmed = true,
  isRelayed = true
} = {}) {
  const tx = {
    getHash: () => hash,
    getHeight: () => (inTxPool ? null : height),
    getFee: () => fee,
    getNumConfirmations: () => confirmations,
    getInTxPool: () => inTxPool,
    getIsConfirmed: () => isConfirmed,
    getIsRelayed: () => isRelayed
  }
  return {
    getTx: () => tx,
    getAccountIndex: () => accountIndex,
    getSubaddressIndex: () => subaddressIndex,
    getAmount: () => amount,
    getAddress: () => `${hash}:${accountIndex}:${subaddressIndex}`,
    getDestinations: () => destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount }))
  }
}

const REWARDS_SUB_ROWS = [
  { accountId: 616, majorIndex: 1, minorIndex: 0, address: ADDRESS_FOR(ADDRESS.WALLET, 1, 0), state: 'ASSIGNED' },
  { accountId: 616, majorIndex: 1, minorIndex: 1, address: ADDRESS_FOR(ADDRESS.WALLET, 1, 1), state: 'AVAILABLE' }
]
const ESCROW_SUB_ROWS = [
  { accountId: 617, majorIndex: 1, minorIndex: 0, address: ADDRESS.ESCROW_SUB, state: 'ASSIGNED' }
]

function makeModels ({
  rewardSubRows = REWARDS_SUB_ROWS,
  escrowSubRows = ESCROW_SUB_ROWS,
  registerEscrow = true,
  rewardJournalRows = [],
  escrowJournalRows = [],
  payoutRows = [],
  distributionRows = [],
  bountyRows = []
} = {}) {
  const rewardAccount = { id: 616, label: 'platform_rewards', address: ADDRESS.WALLET, network: SCOPE.network }
  const escrowAccount = registerEscrow ? { id: 617, label: 'bounty_escrow', address: ADDRESS.ESCROW, network: SCOPE.network } : null
  return {
    rewardAccount,
    escrowAccount,
    models: {
      moneroAccount: {
        findFirst: jest.fn(async ({ where }) => {
          if (where.label === 'platform_rewards') return rewardAccount
          if (where.label === 'bounty_escrow') return escrowAccount
          return null
        })
      },
      subaddressIndex: {
        findMany: jest.fn(async ({ where }) => (where.accountId === 616 ? rewardSubRows : escrowSubRows))
      },
      // ensureFeeAccounts audit mirroring: same grouping semantics as the SQL.
      $queryRaw: jest.fn(async (strings, ...values) => {
        const includeAvailable = values.includes(true)
        const rows = includeAvailable ? rewardSubRows : rewardSubRows.filter(r => r.state !== 'AVAILABLE')
        const byMajor = new Map()
        for (const row of rows) {
          byMajor.set(row.majorIndex, Math.max(byMajor.get(row.majorIndex) ?? 0, row.minorIndex))
        }
        return [...byMajor.entries()].map(([major, maxMinor]) => ({ major, maxMinor }))
      }),
      // Payment verification identity sources (Task 5): journal rows carry the
      // capture identity; payouts/sweeps/bounties carry recorded hashes only.
      rewardsWalletTransaction: {
        findMany: jest.fn(async () => rewardJournalRows)
      },
      escrowWalletTransaction: {
        findMany: jest.fn(async () => escrowJournalRows)
      },
      rewardPayout: {
        findMany: jest.fn(async () => payoutRows)
      },
      rewardDistribution: {
        findMany: jest.fn(async () => distributionRows)
      },
      bountyPayment: {
        findMany: jest.fn(async () => bountyRows)
      }
    }
  }
}

// monerod semantics are enforced: getHeight() returns the chain LENGTH (block
// count), and getBlockHashByHeight(h) only resolves existing block indices
// 0..topHeight. A boundary request for the chain length itself throws.
function makeDaemon ({ topHeight = BOUNDARY.height, blockHashes = [BOUNDARY.blockHash], missing = new Set(), log = [] } = {}) {
  let blockHashCalls = 0
  return {
    getHeight: jest.fn(async () => { log.push('daemon:getHeight'); return topHeight + 1 }),
    getBlockHashByHeight: jest.fn(async (height) => {
      log.push('daemon:getBlockHashByHeight')
      if (!Number.isSafeInteger(height) || height < 0 || height > topHeight) {
        throw new Error(`monerod get_block_header_by_height(${height}): block not found`)
      }
      const hash = blockHashes[blockHashCalls % blockHashes.length]
      blockHashCalls += 1
      return hash
    }),
    getTransactions: jest.fn(async (hashes) => {
      log.push('daemon:getTransactions')
      return hashes.filter(hash => !missing.has(hash)).map(hash => ({ hash }))
    })
  }
}

function makeHappyFixture (overrides = {}) {
  const log = []
  const rewardSubaddresses = [
    [ADDRESS.WALLET],
    [ADDRESS_FOR(ADDRESS.WALLET, 1, 0)],
    [ADDRESS_FOR(ADDRESS.WALLET, 2, 0)],
    [ADDRESS_FOR(ADDRESS.WALLET, 3, 0)],
    [ADDRESS_FOR(ADDRESS.WALLET, 4, 0)],
    [ADDRESS_FOR(ADDRESS.WALLET, 5, 0)]
  ]
  const incoming = [
    makeTransfer({ hash: TX.ROLLOVER, amount: 139n, height: HEIGHT.ROLLOVER }),
    makeTransfer({ hash: TX.CONSOLIDATION, amount: 27n, height: HEIGHT.CONSOLIDATION }),
    makeTransfer({ hash: TX.PAYOUT, amount: 5n, height: HEIGHT.PAYOUT }),
    makeTransfer({ hash: TX.INCOMING, amount: 5n, height: HEIGHT.INCOMING }),
    makeTransfer({ hash: TX.BRIDGE_INCOMING, amount: 4n, inTxPool: true, isConfirmed: false }),
    ...(overrides.extraIncoming ?? [])
  ]
  const outgoing = [
    makeTransfer({
      hash: TX.PAYOUT,
      fee: 7n,
      destinations: [{ address: ADDRESS.CURATOR_ONE, amount: 40n }, { address: ADDRESS.CURATOR_TWO, amount: 20n }]
    }),
    makeTransfer({
      hash: TX.CONSOLIDATION,
      fee: 3n,
      accountIndex: 1,
      destinations: [{ address: ADDRESS.WALLET, amount: 27n }]
    }),
    makeTransfer({
      hash: TX.SWEEP,
      fee: 2n,
      destinations: [{ address: ADDRESS.OPS, amount: 10n }]
    }),
    makeTransfer({
      hash: TX.PENDING_PAYOUT,
      fee: 1n,
      destinations: [{ address: ADDRESS.CURATOR_ONE, amount: 8n }],
      inTxPool: true,
      isConfirmed: false
    }),
    ...(overrides.extraOutgoing ?? [])
  ]
  const wallet = makeAuditWallet({
    label: 'rewards',
    primaryAddress: ADDRESS.WALLET,
    subaddresses: rewardSubaddresses,
    incoming,
    outgoing,
    balances: { 0: { total: 62n, unlocked: 52n } },
    log,
    ...overrides.wallet
  })
  const escrowWallet = makeAuditWallet({
    label: 'escrow',
    primaryAddress: ADDRESS.ESCROW,
    subaddresses: [[ADDRESS.ESCROW], [ADDRESS.ESCROW_SUB]],
    incoming: [makeTransfer({ hash: TX.FUNDING, amount: 120n, accountIndex: 1, subaddressIndex: 0, height: HEIGHT.FUNDING })],
    outgoing: [
      makeTransfer({
        hash: TX.AWARD,
        fee: 3n,
        destinations: [{ address: ADDRESS.CURATOR_ONE, amount: 100n }, { address: ADDRESS.COLD, amount: 17n }]
      }),
      makeTransfer({
        hash: TX.ROLLOVER,
        fee: 1n,
        destinations: [{ address: ADDRESS.WALLET, amount: 139n }]
      })
    ],
    balances: { 0: { total: 17n, unlocked: 0n } },
    log,
    ...overrides.escrowWallet
  })
  const { models } = makeModels(overrides.models)
  const daemon = makeDaemon({ log, ...overrides.daemon })
  return { wallet, escrowWallet, models, daemon, log }
}

describe('collectRewardsWalletEvidence', () => {
  test('collects normalized, safe, decimal-string evidence at a stable boundary', async () => {
    const { wallet, escrowWallet, models, daemon, log } = makeHappyFixture()
    const evidence = await collectRewardsWalletEvidence({
      models,
      scope: SCOPE,
      wallet,
      escrowWallet,
      daemon
    })

    expect(evidence.scope).toEqual(SCOPE)
    expect(evidence.boundary).toEqual(BOUNDARY)
    expect(evidence.daemon).toEqual({
      tipBefore: { height: BOUNDARY.height, blockHash: BOUNDARY.blockHash },
      tipAfter: { height: BOUNDARY.height, blockHash: BOUNDARY.blockHash }
    })
    // The boundary is the highest EXISTING block index, never the chain length.
    expect(daemon.getHeight).toHaveBeenCalledTimes(2)
    expect(daemon.getBlockHashByHeight).toHaveBeenCalledWith(BOUNDARY.height)
    expect(daemon.getBlockHashByHeight).not.toHaveBeenCalledWith(BOUNDARY.height + 1)
    expect(evidence.restoreHeight).toBe(0)
    expect(evidence.restoreProvenance).toBe('genesis')
    // Scanned block count (boundary index + 1).
    expect(evidence.walletHeight).toBe(BOUNDARY.height + 1)
    expect(evidence.balances).toEqual({
      totalPiconeros: '62',
      unlockedPiconeros: '52',
      accounts: { 0: '62', 1: '0', 2: '0', 3: '0', 4: '0', 5: '0' }
    })

    // Confirmed external revenue only; change/self arrivals stay classified.
    expect(evidence.incoming.map(row => row.txHash)).toEqual([
      TX.ROLLOVER, TX.INCOMING, TX.PAYOUT, TX.CONSOLIDATION
    ])
    const rollover = evidence.incoming.find(row => row.txHash === TX.ROLLOVER)
    expect(rollover).toMatchObject({
      accountIndex: 0,
      subaddressIndex: 0,
      amountPiconeros: '139',
      height: HEIGHT.ROLLOVER,
      inTxPool: false,
      isConfirmed: true,
      fromOwnTransaction: false,
      isSelfTransfer: false
    })
    const change = evidence.incoming.find(row => row.txHash === TX.PAYOUT)
    expect(change).toMatchObject({ fromOwnTransaction: true, isSelfTransfer: false, amountPiconeros: '5' })
    const self = evidence.incoming.find(row => row.txHash === TX.CONSOLIDATION)
    expect(self).toMatchObject({ fromOwnTransaction: true, isSelfTransfer: true })

    expect(evidence.outgoing.map(row => row.txHash)).toEqual([TX.PAYOUT, TX.CONSOLIDATION, TX.SWEEP])
    const payout = evidence.outgoing.find(row => row.txHash === TX.PAYOUT)
    expect(payout.feePiconeros).toBe('7')
    expect(payout.destinations).toEqual([
      { address: ADDRESS.CURATOR_ONE, amountPiconeros: '40' },
      { address: ADDRESS.CURATOR_TWO, amountPiconeros: '20' }
    ])
    expect(evidence.outgoing.find(row => row.txHash === TX.CONSOLIDATION).isSelfTransfer).toBe(true)

    // Pending bridge is recorded separately from the confirmed ledger.
    expect(evidence.bridge.pendingIncoming.map(row => row.txHash)).toEqual([TX.BRIDGE_INCOMING])
    expect(evidence.bridge.pendingOutgoing.map(row => row.txHash)).toEqual([TX.PENDING_PAYOUT])
    expect(evidence.bridge.pendingOutgoing[0]).toMatchObject({ relayState: 'pool', inTxPool: true, feePiconeros: '1' })

    // Complete derivation comparison, AVAILABLE minors included.
    expect(evidence.derivation.complete).toBe(true)
    expect(evidence.derivation.derived).toEqual(expect.arrayContaining([
      { majorIndex: 0, minorIndex: 0, address: ADDRESS.WALLET },
      { majorIndex: 1, minorIndex: 0, address: ADDRESS_FOR(ADDRESS.WALLET, 1, 0) },
      { majorIndex: 1, minorIndex: 1, address: ADDRESS_FOR(ADDRESS.WALLET, 1, 1) }
    ]))
    expect(wallet.created.subaddresses).toContainEqual({ major: 1, minor: 1 })

    // Escrow evidence: funded receiving subaddress + settlement history.
    expect(evidence.escrow.walletAddress).toBe(ADDRESS.ESCROW)
    expect(evidence.escrow.derivation.complete).toBe(true)
    expect(evidence.escrow.incoming.map(row => row.txHash)).toEqual([TX.FUNDING])
    expect(evidence.escrow.outgoing.map(row => row.txHash)).toEqual([TX.AWARD, TX.ROLLOVER].sort())
    const award = evidence.escrow.outgoing.find(row => row.txHash === TX.AWARD)
    expect(award.feePiconeros).toBe('3')
    expect(award.destinations).toEqual([
      { address: ADDRESS.CURATOR_ONE, amountPiconeros: '100' },
      { address: ADDRESS.COLD, amountPiconeros: '17' }
    ])

    // Scope is proven before any authoritative read.
    expect(log.indexOf('rewards:getPrimaryAddress')).toBeLessThan(log.indexOf('rewards:sync'))
    expect(log.indexOf('rewards:getPrimaryAddress')).toBeLessThan(log.indexOf('daemon:getHeight'))
    expect(log.indexOf('rewards:getPrimaryAddress')).toBeLessThan(log.indexOf('rewards:getIncomingTransfers'))

    // The audit has no send authority on any path (afterEach re-checks every
    // wallet, including rejection/retry paths).
    expectNoSendCalls(wallet)
    expectNoSendCalls(escrowWallet)
  })

  test('refuses a wallet whose primary address or network does not match the scope', async () => {
    const wrongAddress = makeHappyFixture({ wallet: { primaryAddress: '5SomeOtherWallet' } })
    await expect(collectRewardsWalletEvidence({
      models: wrongAddress.models, scope: SCOPE, wallet: wrongAddress.wallet, daemon: wrongAddress.daemon
    })).rejects.toThrow(/scope|address/i)
    expect(wrongAddress.wallet.getIncomingTransfers).not.toHaveBeenCalled()
    expect(wrongAddress.daemon.getHeight).not.toHaveBeenCalled()

    const wrongNetwork = makeHappyFixture({ wallet: { networkType: 0 } })
    await expect(collectRewardsWalletEvidence({
      models: wrongNetwork.models, scope: SCOPE, wallet: wrongNetwork.wallet, daemon: wrongNetwork.daemon
    })).rejects.toThrow(/network/i)
  })

  test('refuses a restore height above the verified first wallet activity', async () => {
    const noEvidence = makeHappyFixture()
    await expect(collectRewardsWalletEvidence({
      models: noEvidence.models,
      scope: SCOPE,
      wallet: noEvidence.wallet,
      escrowWallet: noEvidence.escrowWallet,
      daemon: noEvidence.daemon,
      restoreHeight: 100
    })).rejects.toThrow(/first.activity|genesis/i)

    const tooHigh = makeHappyFixture()
    await expect(collectRewardsWalletEvidence({
      models: tooHigh.models,
      scope: SCOPE,
      wallet: tooHigh.wallet,
      escrowWallet: tooHigh.escrowWallet,
      daemon: tooHigh.daemon,
      restoreHeight: 100,
      firstActivityEvidence: { verified: true, height: 50 }
    })).rejects.toThrow(/first.activity|restore/i)

    const verified = makeHappyFixture()
    const evidence = await collectRewardsWalletEvidence({
      models: verified.models,
      scope: SCOPE,
      wallet: verified.wallet,
      escrowWallet: verified.escrowWallet,
      daemon: verified.daemon,
      restoreHeight: 100,
      firstActivityEvidence: { verified: true, height: 150 }
    })
    expect(evidence.restoreHeight).toBe(100)
    expect(evidence.restoreProvenance).toBe('verified-first-activity')
  })

  test('refuses a requested historical boundary instead of claiming a sliced balance', async () => {
    const { wallet, escrowWallet, models, daemon } = makeHappyFixture()
    await expect(collectRewardsWalletEvidence({
      models,
      scope: SCOPE,
      wallet,
      escrowWallet,
      daemon,
      requestedBoundary: { height: BOUNDARY.height - 10 }
    })).rejects.toThrow(/historical|boundary/i)
  })

  test('refuses an incomplete account derivation against DB addresses', async () => {
    const rows = [
      ...REWARDS_SUB_ROWS,
      { accountId: 616, majorIndex: 2, minorIndex: 0, address: '5NotTheDerivedAddress', state: 'ASSIGNED' }
    ]
    const fixture = makeHappyFixture()
    const { models } = makeModels({ rewardSubRows: rows })
    await expect(collectRewardsWalletEvidence({
      models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/derivation|address/i)
  })

  test('derives and compares every recorded minor, including major-0 rows', async () => {
    const rows = [
      ...REWARDS_SUB_ROWS,
      { accountId: 616, majorIndex: 0, minorIndex: 2, address: '5NotTheDerivedAddress', state: 'ASSIGNED' }
    ]
    const fixture = makeHappyFixture({ models: { rewardSubRows: rows } })
    await expect(collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/derivation|address/i)
    // The (0,2) row was genuinely derived (minors 1 and 2 created on account 0)
    // before the comparison rejected the mismatch.
    expect(fixture.wallet.created.subaddresses)
      .toEqual(expect.arrayContaining([{ major: 0, minor: 1 }, { major: 0, minor: 2 }]))
  })

  test('automatically derived account addresses count as wallet-owned', async () => {
    const autoAddress = ADDRESS_FOR(ADDRESS.WALLET, 4, 0)
    const hash = 'ea'.repeat(32)
    const fixture = makeHappyFixture({
      extraOutgoing: [makeTransfer({
        hash,
        fee: 1n,
        accountIndex: 4,
        destinations: [{ address: autoAddress, amount: 9n }]
      })]
    })
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    // Account 4 exists only because ensureFeeAccounts derived it; its address is
    // absent from the DB rows but is wallet-owned, so this is a self transfer.
    expect(evidence.derivation.derived).toContainEqual({ majorIndex: 4, minorIndex: 0, address: autoAddress })
    expect(evidence.outgoing.find(entry => entry.txHash === hash)).toMatchObject({ isSelfTransfer: true })
  })

  test('refuses a wallet scan that does not cover the boundary block', async () => {
    // Scanned count == boundary index: block 3_000_000 itself is unscanned.
    const fixture = makeHappyFixture({ wallet: { height: BOUNDARY.height, syncedHeight: BOUNDARY.height } })
    await expect(collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/sync|scan|boundary/i)
  })

  test('requires scanned count >= boundary index + 1 (length/index probe)', async () => {
    // Daemon chain length 3 => boundary index 2; a wallet that scanned only 2
    // blocks has NOT scanned the boundary block itself.
    const fixture = makeHappyFixture({
      daemon: { topHeight: 2 },
      wallet: { height: 2, syncedHeight: 2 }
    })
    await expect(collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/sync|scan|boundary/i)
  })

  test('retries a moving chain boundary and refuses after the attempt budget', async () => {
    const moved = makeHappyFixture({ daemon: { blockHashes: ['dd'.repeat(32), BOUNDARY.blockHash, BOUNDARY.blockHash, BOUNDARY.blockHash] } })
    const evidence = await collectRewardsWalletEvidence({
      models: moved.models,
      scope: SCOPE,
      wallet: moved.wallet,
      escrowWallet: moved.escrowWallet,
      daemon: moved.daemon
    })
    expect(evidence.boundary.blockHash).toBe(BOUNDARY.blockHash)
    expect(moved.wallet.getIncomingTransfers.mock.calls.length).toBeGreaterThanOrEqual(2)

    const neverStable = makeHappyFixture({ daemon: { blockHashes: ['dd'.repeat(32), 'ee'.repeat(32)] } })
    await expect(collectRewardsWalletEvidence({
      models: neverStable.models,
      scope: SCOPE,
      wallet: neverStable.wallet,
      escrowWallet: neverStable.escrowWallet,
      daemon: neverStable.daemon,
      maxBoundaryAttempts: 2
    })).rejects.toThrow(/boundary|rerun/i)
  })

  test('verifies wallet history presence through batched daemon hash queries (<=50)', async () => {
    const transfers = []
    for (let i = 0; i < 120; i++) {
      transfers.push(makeTransfer({
        hash: i.toString(16).padStart(64, '0'),
        amount: 1n,
        height: HEIGHT.INCOMING + i
      }))
    }
    const fixture = makeHappyFixture({ wallet: { incoming: transfers } })
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    expect(evidence.incoming).toHaveLength(120)
    const batches = fixture.daemon.getTransactions.mock.calls.map(call => call[0].length)
    expect(batches.length).toBeGreaterThan(1)
    expect(Math.max(...batches)).toBeLessThanOrEqual(50)
  })

  test('refuses when a confirmed wallet transaction is unknown to the daemon', async () => {
    const fixture = makeHappyFixture({ daemon: { missing: new Set([TX.SWEEP]) } })
    await expect(collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/daemon|chain/i)
  })

  test('a built-but-unrelayed cached transaction is a bridge item, not chain evidence', async () => {
    const unrelayedHash = 'e9'.repeat(32)
    const fixture = makeHappyFixture({
      extraOutgoing: [makeTransfer({
        hash: unrelayedHash,
        fee: 1n,
        destinations: [{ address: ADDRESS.CURATOR_ONE, amount: 3n }],
        inTxPool: false,
        isConfirmed: false,
        isRelayed: false
      })],
      // If presence verification wrongly checked this hash, the collection would throw.
      daemon: { missing: new Set([unrelayedHash]) }
    })
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    const bridged = evidence.bridge.pendingOutgoing.find(entry => entry.txHash === unrelayedHash)
    expect(bridged).toMatchObject({ relayState: 'unrelayed', isRelayed: false, isConfirmed: false, inTxPool: false })
    expect(evidence.outgoing.some(entry => entry.txHash === unrelayedHash)).toBe(false)
  })

  test('records no escrow evidence when no escrow wallet is registered', async () => {
    const log = []
    const { wallet } = makeHappyFixture({ wallet: { log } })
    const { models } = makeModels({ registerEscrow: false })
    const daemon = makeDaemon({ log })
    const evidence = await collectRewardsWalletEvidence({ models, scope: SCOPE, wallet, daemon })
    expect(evidence.escrow).toBeNull()
    expect(evidence.incoming.length).toBeGreaterThan(0)
  })

  test('refuses an escrow wallet whose identity does not match the registered account', async () => {
    const fixture = makeHappyFixture({ escrowWallet: { primaryAddress: '5SomeOtherEscrow' } })
    await expect(collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })).rejects.toThrow(/escrow|scope|address/i)
  })

  test('never serializes wallet objects, keys or signed blobs', async () => {
    const { wallet, escrowWallet, models, daemon } = makeHappyFixture()
    const evidence = await collectRewardsWalletEvidence({ models, scope: SCOPE, wallet, escrowWallet, daemon })
    const seen = new Set()
    const walk = value => {
      if (value == null || typeof value !== 'object') return
      if (seen.has(value)) return
      seen.add(value)
      for (const key of Object.keys(value)) {
        expect(['getTx', 'getHash', 'getFee']).not.toContain(key)
        walk(value[key])
      }
    }
    walk(evidence)
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(/privateSpendKey|privateViewKey|mnemonic|seed/i)
  })

  // --- Task 5: evidence v2, verification union, readability, sentinels ------

  const V2_HASHES = {
    LEGACY_JOURNAL: 'd1'.repeat(32),
    CAPTURED_JOURNAL: 'd5'.repeat(32),
    PAYOUT: TX.PAYOUT,
    SWEEP: 'd2'.repeat(32),
    AWARD: TX.AWARD,
    FEE: 'd3'.repeat(32),
    OUTGOING_ONLY: 'd4'.repeat(32)
  }

  function v2Fixture (overrides = {}) {
    const uuid = seed => `00000000-0000-4000-8000-${seed.padStart(12, '0')}`
    return makeHappyFixture({
      extraOutgoing: [makeTransfer({
        hash: V2_HASHES.OUTGOING_ONLY,
        fee: 1n,
        destinations: [{ address: ADDRESS.CURATOR_ONE, amount: 3n }]
      })],
      models: {
        rewardJournalRows: [
          { id: 501, txHash: V2_HASHES.LEGACY_JOURNAL, dispatchId: null, captureContractVersion: null },
          { id: 502, txHash: V2_HASHES.CAPTURED_JOURNAL, dispatchId: uuid('a'), captureContractVersion: 1 },
          ...(overrides.rewardJournalRows ?? [])
        ],
        payoutRows: [{ txHash: V2_HASHES.PAYOUT }],
        distributionRows: [{ opsSweepTxHash: V2_HASHES.SWEEP }],
        bountyRows: [{ txHash: V2_HASHES.AWARD, feeTxHash: V2_HASHES.FEE }]
      },
      ...overrides.fixture
    })
  }

  test('collects evidence v2 with payment verification results for the whole hash union', async () => {
    const fixture = v2Fixture()
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    expect(evidence.evidenceVersion).toBe(2)
    expect(typeof evidence.collectionStartedAt).toBe('string')
    expect(typeof evidence.observedAt).toBe('string')

    const rewardsByHash = Object.fromEntries(
      evidence.paymentVerifications.map(result => [result.txHash, result]))
    // The union: journal hashes + recorded payout/sweep hashes + wallet
    // outgoing hashes — including hashes absent from the wallet history.
    for (const hash of [V2_HASHES.LEGACY_JOURNAL, V2_HASHES.CAPTURED_JOURNAL, V2_HASHES.PAYOUT, V2_HASHES.SWEEP, V2_HASHES.OUTGOING_ONLY]) {
      expect(rewardsByHash[hash]).toBeDefined()
    }
    // Legacy journal identity: unresolved, never a synthetic proof-era owner.
    expect(rewardsByHash[V2_HASHES.LEGACY_JOURNAL]).toMatchObject({
      status: 'unresolved',
      captureMode: 'LEGACY_SURVIVING_PROOF',
      journalRole: 'REWARDS',
      journalId: '501',
      dispatchId: null,
      proofInventory: null
    })
    expect(rewardsByHash[V2_HASHES.LEGACY_JOURNAL].issues).toContain('LEGACY_PROOF_MISSING')
    // A captured journal row the audit wallet cannot build a chain session
    // for stays an explicit unresolved result — never a fabricated pass.
    expect(rewardsByHash[V2_HASHES.CAPTURED_JOURNAL]).toMatchObject({
      status: 'unresolved',
      journalRole: 'REWARDS',
      journalId: '502'
    })
    expect(rewardsByHash[V2_HASHES.CAPTURED_JOURNAL].issues).toContain('CHAIN_EVIDENCE_UNAVAILABLE')
    // Recorded payout/sweep hashes and outgoing-only hashes with no journal
    // identity get explicit unresolved results.
    for (const hash of [V2_HASHES.PAYOUT, V2_HASHES.SWEEP, V2_HASHES.OUTGOING_ONLY]) {
      expect(rewardsByHash[hash]).toMatchObject({
        status: 'unresolved',
        captureMode: null,
        journalRole: null,
        journalId: null,
        dispatchId: null
      })
      expect(rewardsByHash[hash].issues).toContain('UNIDENTIFIED_HASH')
    }

    const escrowByHash = Object.fromEntries(
      evidence.escrow.paymentVerifications.map(result => [result.txHash, result]))
    for (const hash of [V2_HASHES.AWARD, V2_HASHES.FEE]) {
      expect(escrowByHash[hash]).toMatchObject({ status: 'unresolved', journalId: null })
      expect(escrowByHash[hash].issues).toContain('UNIDENTIFIED_HASH')
    }

    // Every per-verification observation sits inside the collection interval.
    for (const result of [...evidence.paymentVerifications, ...evidence.escrow.paymentVerifications]) {
      expect(result.observedAt >= evidence.collectionStartedAt).toBe(true)
      expect(result.observedAt <= evidence.observedAt).toBe(true)
    }
    expect(evidence.paymentVerifications.map(result => result.txHash))
      .toEqual([...evidence.paymentVerifications.map(result => result.txHash)].sort())
  })

  test('preserves unreadable outgoing sources and amounts instead of defaulting to zero', async () => {
    const unreadable = 'ea'.repeat(32)
    const fixture = makeHappyFixture({
      extraOutgoing: [{
        getTx: () => ({
          getHash: () => unreadable,
          getHeight: () => HEIGHT.SWEEP,
          getFee: () => 2n,
          getNumConfirmations: () => 10,
          getInTxPool: () => false,
          getIsConfirmed: () => true,
          getIsRelayed: () => true
        }),
        getAccountIndex: () => 0,
        getDestinations: () => [
          { getAddress: () => { throw new Error('unreadable destination') }, getAmount: () => 5n },
          { getAddress: () => ADDRESS.OPS, getAmount: () => { throw new Error('unreadable amount') } }
        ]
      }]
    })
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    const row = evidence.outgoing.find(entry => entry.txHash === unreadable)
    expect(row.destinationsReadable).toBe(false)
    // Readable fields are preserved exactly; unreadable ones stay explicit
    // null — never a defaulted zero.
    expect(row.destinations).toEqual([
      { address: null, amountPiconeros: '5' },
      { address: ADDRESS.OPS, amountPiconeros: null }
    ])
    expect(row.feePiconeros).toBe('2')
    // It also enters the verification union as an explicit unresolved hash.
    const verification = evidence.paymentVerifications.find(result => result.txHash === unreadable)
    expect(verification.issues).toContain('UNIDENTIFIED_HASH')
  })

  test('an unreadable outgoing source account is explicit null, never 0 (I3)', async () => {
    const absentGetter = 'eb'.repeat(32)
    const throwingGetter = 'ec'.repeat(32)
    const txShape = hash => ({
      getHash: () => hash,
      getHeight: () => HEIGHT.SWEEP,
      getFee: () => 2n,
      getNumConfirmations: () => 10,
      getInTxPool: () => false,
      getIsConfirmed: () => true,
      getIsRelayed: () => true
    })
    const fixture = makeHappyFixture({
      extraOutgoing: [
        {
          // getAccountIndex is absent entirely.
          getTx: () => txShape(absentGetter),
          getDestinations: () => [{ getAddress: () => ADDRESS.OPS, getAmount: () => 5n }]
        },
        {
          // getAccountIndex exists but throws.
          getTx: () => txShape(throwingGetter),
          getAccountIndex: () => { throw new Error('unreadable account') },
          getDestinations: () => [{ getAddress: () => ADDRESS.OPS, getAmount: () => 6n }]
        }
      ]
    })
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    const absent = evidence.outgoing.find(entry => entry.txHash === absentGetter)
    const throwing = evidence.outgoing.find(entry => entry.txHash === throwingGetter)
    for (const row of [absent, throwing]) {
      expect(row.accountIndex).toBeNull()
      expect(row.destinationsReadable).toBe(false)
      expect(row.isSelfTransfer).toBe(false)
      expect(row.feePiconeros).toBe('2')
    }
    // A readable control row keeps its real account index and readability.
    expect(evidence.outgoing.find(entry => entry.txHash === TX.SWEEP)).toMatchObject({
      accountIndex: 0,
      destinationsReadable: true
    })
    // Both enter the verification union as explicit unresolved hashes.
    for (const hash of [absentGetter, throwingGetter]) {
      expect(evidence.paymentVerifications.find(result => result.txHash === hash).issues)
        .toContain('UNIDENTIFIED_HASH')
    }
  })

  test('collected evidence and verification results leak no key, nonce, ciphertext or key-image material', async () => {
    const fixture = v2Fixture()
    const evidence = await collectRewardsWalletEvidence({
      models: fixture.models,
      scope: SCOPE,
      wallet: fixture.wallet,
      escrowWallet: fixture.escrowWallet,
      daemon: fixture.daemon
    })
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(
      /privateSpendKey|privateViewKey|mnemonic|seed|ciphertext|dataNonce|dataTag|wrapNonce|wrapTag|wrappedDek|keyBundleHex|keyImage|stealthPublicKey|paymentClaims|bindingDigest/i)
    for (const result of [...evidence.paymentVerifications, ...evidence.escrow.paymentVerifications]) {
      expect(Object.keys(result)).not.toContain('keyBundleHex')
      expect(Object.keys(result)).not.toContain('envelope')
      expect(Object.keys(result)).not.toContain('payload')
    }
  })

  test('absorbs the SDK daemon-height cache with a bounded resync before refusing', async () => {
    // First getHeight answers with the stale cached count; a resync later
    // covers the boundary. The collection must tolerate it (bounded) instead
    // of refusing, and never weaken count >= boundary + 1.
    let heightCalls = 0
    const stale = makeHappyFixture()
    stale.wallet.getHeight = jest.fn(async () => {
      heightCalls += 1
      return heightCalls <= 2 ? BOUNDARY.height : BOUNDARY.height + 1
    })
    const evidence = await collectRewardsWalletEvidence({
      models: stale.models,
      scope: SCOPE,
      wallet: stale.wallet,
      escrowWallet: stale.escrowWallet,
      daemon: stale.daemon
    })
    expect(evidence.walletHeight).toBe(BOUNDARY.height + 1)
    expect(stale.wallet.sync.mock.calls.length).toBeGreaterThanOrEqual(2)

    // A scan that never covers the boundary still refuses.
    const never = makeHappyFixture({ wallet: { height: BOUNDARY.height, syncedHeight: BOUNDARY.height } })
    await expect(collectRewardsWalletEvidence({
      models: never.models,
      scope: SCOPE,
      wallet: never.wallet,
      escrowWallet: never.escrowWallet,
      daemon: never.daemon
    })).rejects.toThrow(/sync|scan|boundary/i)
  })
})
