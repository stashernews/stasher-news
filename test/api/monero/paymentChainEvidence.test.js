/* eslint-env jest */

// Strict raw-chain and restored-ownership adapter (Finding #1, Task 4).
//
// The tests drive the REAL collector against the Task 1 chain fixture: an
// unfiltered fake wallet scan (spent rows included, SDK getIndex() deliberately
// the GLOBAL index), a fake daemon serving validated raw records, and an
// independent view-only wallet. Every refusal below pins a fixed error code so
// the verifier (Task 5) can branch on exact failure classes.

import { collectPaymentChainEvidence } from '@/api/monero/paymentChainEvidence'
import { paymentChainFixture } from '../../fixtures/payment-proof'

// Test-local SDK-shaped row wrapper (the fixture keeps its own private one).
const sdkRow = row => ({
  getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
  getAccountIndex: () => row.accountIndex,
  getSubaddressIndex: () => row.subaddressIndex,
  getIndex: () => row.globalIndex,
  getAmount: () => row.amountPiconeros,
  getStealthPublicKey: () => row.stealthPublicKey,
  getKeyImage: () => ({ getHex: () => row.keyImage }),
  getIsSpent: () => row.isSpent,
  getIsFrozen: () => false,
  getIsLocked: () => false
})

const expectReject = async (promise, code) => {
  let caught = null
  try { await promise } catch (e) { caught = e }
  expect(caught).not.toBeNull()
  expect(caught.name).toBe('PaymentChainEvidenceError')
  expect(caught.code).toBe(code)
}

const expectThrow = (fn, code) => {
  let caught = null
  try { fn() } catch (e) { caught = e }
  expect(caught).not.toBeNull()
  expect(caught.code).toBe(code)
}

// ---- happy path: joins, sessions, spent retention ------------------------------

describe('collectPaymentChainEvidence — restored ownership session', () => {
  test.each(['record', 'daemon-refusal'])('pending audited candidate isolated from confirmed ownership (%s)', async mode => {
    const f = paymentChainFixture()
    const pending = 'b1'.repeat(32)
    const original = f.daemon.getPaymentTransactions.getMockImplementation()
    f.daemon.getPaymentTransactions.mockImplementation(async hashes => {
      if (hashes.includes(pending) && mode === 'daemon-refusal') {
        const err = new Error('synthetic pool refusal')
        err.code = 'RAW_TX_IN_POOL'
        throw err
      }
      const records = await original(hashes)
      return hashes.includes(pending) ? [...records, { txHash: pending, inTxPool: true }] : records
    })
    const session = await collectPaymentChainEvidence({ ...f.collectOptions, auditedHashes: [f.txHash, pending] })
    expect(session.ownershipFor(f.txHash).owned).toHaveLength(1)
    expect(() => session.ownershipFor(pending)).toThrow('RAW_TX_IN_POOL')
  })
  test('account-0-only escrow domain is accepted without weakening rewards requirements', async () => {
    const f = paymentChainFixture()
    const derivation = { ...f.collectOptions.derivation, derived: f.collectOptions.derivation.derived.filter(row => row.majorIndex === 0) }
    const session = await collectPaymentChainEvidence({ ...f.collectOptions, derivation, journalRole: 'ESCROW' })
    expect(session.ownershipFor(f.txHash).owned).toHaveLength(1)
    await expect(collectPaymentChainEvidence({ ...f.collectOptions, derivation, journalRole: 'REWARDS' })).rejects.toMatchObject({ code: 'DERIVATION_INVALID' })
  })
  test('retains authoritative collection scope and boundary', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    expect(session.scope).toEqual(f.collectOptions.scope)
    expect(session.boundary).toEqual(f.collectOptions.boundary)
  })
  test('joins by stealth key, not SDK global index or unspent filter', async () => {
    const f = paymentChainFixture({ globalIndex: 918, localIndex: 1, spentOwnedOutput: true })
    const session = await collectPaymentChainEvidence(f.collectOptions)
    const facts = session.ownershipFor(f.txHash)
    expect(f.wallet.getOutputs).toHaveBeenCalledWith()
    expect(facts.owned[0].outputIndex).toBe(1)
    expect(facts.owned[0].amountPiconeros).toBe(33n)
  })

  test('scans the wallet unfiltered and independently re-scans via the view wallet', async () => {
    const f = paymentChainFixture()
    await collectPaymentChainEvidence(f.collectOptions)
    expect(f.wallet.getOutputs).toHaveBeenCalledWith()
    expect(f.viewWallet.getOutputs).toHaveBeenCalledWith()
    // All raw facts arrive through one daemon call carrying the complete
    // scanned-hash set (the injected client owns the ≤50 batching).
    expect(f.daemon.getPaymentTransactions).toHaveBeenCalledTimes(1)
    expect(f.daemon.getPaymentTransactions).toHaveBeenCalledWith(
      [f.chain.source.txHash, f.txHash].sort()
    )
  })

  test('exposes validated raw facts and coinbase input-source ownership', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    const facts = session.ownershipFor(f.txHash)

    expect(facts.raw.txHash).toBe(f.txHash)
    expect(facts.raw.feePiconeros).toBe(7n)
    expect(facts.raw.isCoinbase).toBe(false)
    expect(facts.raw.inputKeyImages).toEqual([f.chain.keyImages.source])
    expect(facts.raw.blockHeight).toBe(f.chain.audited.blockHeight)
    expect(facts.raw.inTxPool).toBe(false)

    expect(facts.owned).toHaveLength(1)
    expect(facts.owned[0]).toMatchObject({
      txHash: f.txHash,
      outputIndex: 1,
      globalIndex: 918,
      accountIndex: 0,
      subaddressIndex: 0,
      amountPiconeros: 33n,
      isSpent: false
    })

    // The audited tx's single input key image restores the wallet's spent
    // 100n source output; its own raw record (a coinbase) is present and is
    // accepted as an input SOURCE only.
    expect(facts.inputSources).toHaveLength(1)
    expect(facts.inputSources[0].keyImage).toBe(f.chain.keyImages.source)
    expect(facts.inputSources[0].prior).toMatchObject({
      txHash: f.chain.source.txHash,
      outputIndex: 0,
      globalIndex: 690,
      amountPiconeros: 100n,
      isSpent: true
    })
    expect(facts.inputSources[0].priorRaw.isCoinbase).toBe(true)
    expect(facts.inputSources[0].priorRaw.feePiconeros).toBe(0n)
    expect(facts.inputSources[0].priorRaw.inputKeyImages).toEqual([])
  })

  test('retains owned outputs spent after the audited send (never filtered from O)', async () => {
    const f = paymentChainFixture({ spentOwnedOutput: true })
    const session = await collectPaymentChainEvidence(f.collectOptions)
    const facts = session.ownershipFor(f.txHash)
    expect(facts.owned[0].isSpent).toBe(true)
    expect(facts.owned[0].outputIndex).toBe(1)
    expect(facts.owned[0].amountPiconeros).toBe(33n)
    // The complete restored universe keeps the spent change row AND the spent
    // 100n source row (both are owned history).
    expect(session.ownedOutputs).toHaveLength(2)
    const spentChange = session.ownedOutputs.find(row => row.txHash === f.txHash)
    expect(spentChange.isSpent).toBe(true)
  })

  test('session.ownedOutputs is the full unfiltered restored universe incl. spent rows', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    expect(session.ownedOutputs).toHaveLength(2)
    const source = session.ownedOutputs.find(row => row.isSpent)
    expect(source.txHash).toBe(f.chain.source.txHash)
    expect(source.amountPiconeros).toBe(100n)
    expect(source.outputIndex).toBe(0)
  })

  test('deriveOwnedIndexes maps a raw tx to its owned domain rows (raw object or hash)', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    const expected = [{
      outputIndex: 1,
      globalIndex: 918,
      accountIndex: 0,
      subaddressIndex: 0,
      amountPiconeros: 33n,
      stealthPublicKey: f.chain.ownedScan[0].stealthPublicKey
    }]
    expect(session.deriveOwnedIndexes(session.rawByHash.get(f.txHash))).toEqual(expected)
    expect(session.deriveOwnedIndexes(f.txHash)).toEqual(expected)
    expectThrow(() => session.deriveOwnedIndexes('ab'.repeat(32)), 'RAW_TX_MISSING')
  })

  test('rawByHash is a private Map — the session return value is never serializable', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    expect(session.rawByHash).toBeInstanceOf(Map)
    expect(session.rawByHash.get(f.txHash).voutKeys).toEqual(f.chain.audited.voutKeys)
    expect(JSON.stringify(session.rawByHash)).toBe('{}')
  })

  test('carries the daemon-supplied blockHash through the raw records (I1 passthrough)', async () => {
    const f = paymentChainFixture()
    const session = await collectPaymentChainEvidence(f.collectOptions)
    // The fixture daemon resolves the header hash per distinct height exactly
    // like the real daemonClient; the session must pass it through untouched
    // so the verifier can report confirmation.blockHash.
    expect(session.rawByHash.get(f.txHash).blockHash).toBe('d4'.repeat(32))
    expect(session.rawByHash.get(f.chain.source.txHash).blockHash).toBe('d4'.repeat(32))
  })

  test('works without the optional independent view wallet', async () => {
    const f = paymentChainFixture()
    const { viewWallet, ...withoutView } = f.collectOptions
    const session = await collectPaymentChainEvidence(withoutView)
    expect(session.ownershipFor(f.txHash).owned[0].amountPiconeros).toBe(33n)
  })
})

// ---- refusals: scope / derivation / boundary -----------------------------------

describe('collectPaymentChainEvidence — scope, derivation and boundary refusals', () => {
  test('refuses a scope wallet address that does not match the scanned wallet', async () => {
    const f = paymentChainFixture()
    const wrongScope = { ...f.collectOptions, scope: { ...f.collectOptions.scope, walletAddress: 'synthetic-wrong-scope-address' } }
    await expectReject(collectPaymentChainEvidence(wrongScope), 'SCOPE_MISMATCH')
  })

  test('refuses a scope network that does not match the wallet network type', async () => {
    const f = paymentChainFixture()
    const wrongNetwork = { ...f.collectOptions, scope: { ...f.collectOptions.scope, network: 'MAINNET' } }
    await expectReject(collectPaymentChainEvidence(wrongNetwork), 'SCOPE_MISMATCH')
  })

  test('refuses an incomplete or mismatched SDK derivation', async () => {
    const f = paymentChainFixture()
    await expectReject(
      collectPaymentChainEvidence({ ...f.collectOptions, derivation: { ...f.collectOptions.derivation, complete: false } }),
      'DERIVATION_INVALID'
    )
    await expectReject(
      collectPaymentChainEvidence({ ...f.collectOptions, derivation: { ...f.collectOptions.derivation, mismatches: ['0/1'] } }),
      'DERIVATION_INVALID'
    )
  })

  test('refuses a narrowed derivation domain when a discovered owned index lies outside it', async () => {
    const f = paymentChainFixture({ ownedAmount: 22n })
    const hidden = f.chain.hiddenExtra
    const outsideRow = {
      txHash: f.txHash,
      accountIndex: 0,
      subaddressIndex: 1,
      outputIndex: 3,
      blockHeight: f.chain.audited.blockHeight,
      globalIndex: hidden.globalIndex,
      amountPiconeros: hidden.amountPiconeros,
      stealthPublicKey: hidden.stealthPublicKey,
      keyImage: null,
      isSpent: false
    }
    f.wallet.getOutputs.mockImplementation(async () => [
      sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(outsideRow)
    ])
    f.viewWallet.getOutputs.mockImplementation(async () => [
      sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(outsideRow)
    ])
    // derivation.derived only carries (0,0) and the scope primary covers (0,0);
    // an SDK-discovered owned output at subaddress 1 proves the domain was
    // narrowed — refuse, never silently pass a finite probe domain.
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'DERIVATION_DOMAIN_INCOMPLETE')
  })

  test('refuses malformed audit boundaries', async () => {
    const f = paymentChainFixture()
    await expectReject(
      collectPaymentChainEvidence({ ...f.collectOptions, boundary: { height: 2 ** 53, blockHash: 'd4'.repeat(32) } }),
      'BOUNDARY_INVALID'
    )
    await expectReject(
      collectPaymentChainEvidence({ ...f.collectOptions, boundary: { height: 3000000, blockHash: 'zz' } }),
      'BOUNDARY_INVALID'
    )
  })
})

// ---- refusals: joins and restored inputs ----------------------------------------

describe('collectPaymentChainEvidence — index and input join refusals', () => {
  test('refuses a global/local index disagreement (GLOBAL_LOCAL_INDEX_MISMATCH)', async () => {
    const f = paymentChainFixture()
    f.session.rawByHash[f.txHash].outputIndices = [917, 919, 920]
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'GLOBAL_LOCAL_INDEX_MISMATCH')
  })

  test('cross-checks global indexes only when the daemon supplied output_indices', async () => {
    const f = paymentChainFixture()
    delete f.session.rawByHash[f.txHash].outputIndices
    const session = await collectPaymentChainEvidence(f.collectOptions)
    const facts = session.ownershipFor(f.txHash)
    expect(facts.owned[0].outputIndex).toBe(1)
    expect(facts.owned[0].globalIndex).toBe(918)
  })

  test('refuses an ambiguous stealth-key join (duplicate position in raw vout)', async () => {
    const f = paymentChainFixture()
    const raw = f.session.rawByHash[f.txHash]
    raw.voutKeys = [raw.voutKeys[0], raw.voutKeys[1], raw.voutKeys[1]]
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'OWNED_OUTPUT_JOIN_FAILED')
  })

  test('refuses duplicate global indexes across the restored scan', async () => {
    const f = paymentChainFixture()
    // With the daemon-supplied output_indices removed, the cross-check cannot
    // pin globals; two restored rows then claiming one global index is the
    // detectable corruption.
    delete f.session.rawByHash[f.txHash].outputIndices
    const shadow = {
      ...f.chain.ownedScan[0],
      stealthPublicKey: f.chain.audited.voutKeys[0],
      keyImage: 'cd'.repeat(32),
      amountPiconeros: 1n,
      globalIndex: 918
    }
    f.wallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(shadow)])
    f.viewWallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(shadow)])
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'DUPLICATE_GLOBAL_INDEX')
  })

  test('refuses duplicate local owned indexes within one transaction', async () => {
    const f = paymentChainFixture()
    const shadow = {
      ...f.chain.ownedScan[0],
      keyImage: 'ef'.repeat(32),
      globalIndex: 919,
      amountPiconeros: 1n
    }
    f.wallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(shadow)])
    f.viewWallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow({ ...f.chain.ownedScan[0] }), sdkRow(shadow)])
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'DUPLICATE_OWNED_OUTPUT_INDEX')
  })

  test('refuses duplicate owned key images across the scan', async () => {
    const f = paymentChainFixture()
    const shadow = {
      ...f.chain.ownedScan[0],
      keyImage: f.chain.sourceScan.keyImage,
      globalIndex: 919
    }
    f.wallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow(shadow)])
    f.viewWallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan }), sdkRow(shadow)])
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'DUPLICATE_KEY_IMAGE')
  })

  test('refuses an input key image that restores no owned prior output', async () => {
    const f = paymentChainFixture()
    // The scan deliberately keeps only the owned change row: the audited tx's
    // input key image then restores no owned prior output. Ownership facts are
    // produced for the requested transaction — the refusal fires there.
    f.wallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.ownedScan[0] })])
    f.viewWallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.ownedScan[0] })])
    const session = await collectPaymentChainEvidence(f.collectOptions)
    expectThrow(() => session.ownershipFor(f.txHash), 'INPUT_NOT_OWNED_OR_MISSING')
  })

  test('refuses when the prior transaction of an input source has no raw record', async () => {
    const f = paymentChainFixture()
    delete f.session.rawByHash[f.chain.source.txHash]
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'RAW_TX_MISSING')
  })
})

// ---- refusals: raw record validation ---------------------------------------------

describe('collectPaymentChainEvidence — raw record refusals', () => {
  test('refuses a scanned transaction the daemon did not return', async () => {
    const f = paymentChainFixture()
    delete f.session.rawByHash[f.txHash]
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'RAW_TX_MISSING')
  })

  test('refuses daemon records for hashes that were never requested', async () => {
    const f = paymentChainFixture()
    const original = f.daemon.getPaymentTransactions.getMockImplementation()
    f.daemon.getPaymentTransactions.mockImplementation(async hashes => {
      const base = await original(hashes)
      return [...base, {
        txHash: 'ab'.repeat(32),
        isCoinbase: false,
        inputKeyImages: ['11'.repeat(32)],
        voutKeys: ['22'.repeat(32)],
        outputIndices: [1],
        feePiconeros: 1n,
        blockHeight: 2999990,
        inTxPool: false
      }]
    })
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'RAW_HASH_MISMATCH')
  })

  test('refuses an in-pool transaction for the confirmed-only adapter', async () => {
    const f = paymentChainFixture()
    f.session.rawByHash[f.txHash].inTxPool = true
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'RAW_TX_IN_POOL')
  })

  test('refuses an inconsistent coinbase record (fee or key inputs)', async () => {
    const f = paymentChainFixture()
    f.session.rawByHash[f.chain.source.txHash].feePiconeros = 7n
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'RAW_COINBASE_INVALID')
    const g = paymentChainFixture()
    g.session.rawByHash[g.chain.source.txHash].inputKeyImages = ['11'.repeat(32)]
    await expectReject(collectPaymentChainEvidence(g.collectOptions), 'RAW_COINBASE_INVALID')
  })

  test('refuses full-scan vs view-scan disagreement on the safe projection', async () => {
    const f = paymentChainFixture()
    f.viewWallet.getOutputs.mockImplementation(async () => [sdkRow({ ...f.chain.sourceScan })])
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'OWNED_SCAN_DISAGREEMENT')
  })

  test('refuses view-scan rows that disagree on amount (not just membership)', async () => {
    const f = paymentChainFixture()
    f.viewWallet.getOutputs.mockImplementation(async () => [
      sdkRow({ ...f.chain.sourceScan }),
      sdkRow({ ...f.chain.ownedScan[0], amountPiconeros: 32n })
    ])
    await expectReject(collectPaymentChainEvidence(f.collectOptions), 'OWNED_SCAN_DISAGREEMENT')
  })
})
