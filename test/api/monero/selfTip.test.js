/* eslint-env jest */
import { isSelfSend, shouldExcludeTip, resolveItemSubName, lookupTipTx, chainMismatch, recheckDetectedTip } from '@/api/monero/selfTip'
import { reverseTip } from '@/api/monero/ranking'
// ranking's reverseTip is mocked at the module boundary (process.cwd()-absolute,
// same pattern as webhook.test.js) so the exclusion transaction is assertable
// without the ranking SQL graph. babel hoists jest.mock above the imports.
jest.mock(`${process.cwd()}/api/monero/ranking`, () => ({ reverseTip: jest.fn() }))

const ACCT = { id: 7, subaddresses: [{ majorIndex: 0, minorIndex: 1 }, { majorIndex: 0, minorIndex: 5 }] }

// lws spent_outputs subaddress shape (verified on dev lws 2026-08-23):
// indices arrive nested under `sender` — the subaddress of the scanned
// account that owned the spent output.
const so = (maj, min) => ({ sender: { maj_i: maj, min_i: min } })

describe('isSelfSend', () => {
  test('true when a spent output matches the primary subaddress (0,0)', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 0), so(4, 2)] })).toBe(true)
  })
  test('true when a spent output matches a registered SubaddressIndex row', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 5)] })).toBe(true)
  })
  test('true for the sender shape', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [so(0, 1)] })).toBe(true)
  })
  test('false when spent outputs are foreign subaddresses (candidate false-match guard)', () => {
    // a foreign wallet's primary is also (0,0) — but lws only attaches indices
    // decoded against the SCANNED account, so (4,2)/(9,9) are foreign indices
    expect(isSelfSend(ACCT, { spent_outputs: [so(4, 2), so(9, 9)] })).toBe(false)
  })
  test('false when the account has subaddresses but none match', () => {
    const acct = { subaddresses: [{ majorIndex: 1, minorIndex: 0 }] }
    expect(isSelfSend(acct, { spent_outputs: [so(2, 3)] })).toBe(false)
  })
  test('false for empty or missing spent_outputs', () => {
    expect(isSelfSend(ACCT, { spent_outputs: [] })).toBe(false)
    expect(isSelfSend(ACCT, {})).toBe(false)
  })
  test('false for a null tx (payment not found in the scan)', () => {
    expect(isSelfSend(ACCT, null)).toBe(false)
  })
})

describe('shouldExcludeTip', () => {
  const external = { spent_outputs: [so(4, 2)] }
  test('true when tipperId === postUserId (direct self-tip)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: external })).toBe(true)
  })
  test('true when isSelfSend (logged-out self-send from the registered wallet)', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: { spent_outputs: [so(0, 0)] } })).toBe(true)
  })
  test('true when both conditions hold (direct wins as the reason)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: { spent_outputs: [so(0, 0)] } })).toBe(true)
  })
  test('false for a normal attributed tip', () => {
    expect(shouldExcludeTip({ tipperId: 6, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
  test('false for a normal anonymous tip', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
})

describe('resolveItemSubName', () => {
  test('COALESCEs root.subNames[1] over item.subNames[1], null when absent', async () => {
    const queue = [
      [{ subName: 'stasher' }], // first call: root lookup hit
      [{}], // second call: no subNames anywhere (undefined -> null)
      [] // third call: item not found
    ]
    const handle = { $queryRaw: async () => queue.shift() ?? [] }
    expect(await resolveItemSubName(1, handle)).toBe('stasher')
    expect(await resolveItemSubName(2, handle)).toBe(null)
    expect(await resolveItemSubName(3, handle)).toBe(null)
  })
})

describe('lookupTipTx cursor invariant (audit 2026-09-11 finding 1)', () => {
  const txs = [
    { id: 101, hash: 'a', payment_id: 'feeleg', piconeros: 1n },
    { id: 102, hash: 'b', payment_id: 'dvx', piconeros: 2n }
  ]
  const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs }) }

  test('NEVER advances lastTxId on the platform rewards account (observer watermark)', async () => {
    const rewards = { id: 7, label: 'platform_rewards', lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    const tx = await lookupTipTx(models, monero, rewards, 'dvx')
    expect(tx.hash).toBe('b')
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })

  test('still advances lastTxId forward-only on non-rewards accounts', async () => {
    const author = { id: 8, label: null, lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    await lookupTipTx(models, monero, author, 'dvx')
    expect(models.moneroAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 8, OR: [{ lastTxId: null }, { lastTxId: { lt: 102n } }] },
      data: { lastTxId: 102n }
    })
  })
})

describe('chainMismatch (audit 2026-09-11 finding 2)', () => {
  const tip = { piconeros: 1000n, txHash: 'AA11' }
  test('true when the stored amount disagrees with the chain tx', () => {
    expect(chainMismatch(tip, { piconeros: 999n, hash: 'aa11' })).toBe(true)
  })
  test('true when both hashes are present and differ', () => {
    expect(chainMismatch(tip, { piconeros: 1000n, hash: 'ff22' })).toBe(true)
  })
  test('false when amount and (case-insensitive) hash match', () => {
    expect(chainMismatch(tip, { piconeros: 1000n, hash: 'aa11' })).toBe(false)
  })
  test('false when the stored hash is null (callbacks may omit tx_hash)', () => {
    expect(chainMismatch({ piconeros: 1000n, txHash: null }, { piconeros: 1000n, hash: 'aa11' })).toBe(false)
  })
  test('false for a null tx (not found — caller fails open)', () => {
    expect(chainMismatch(tip, null)).toBe(false)
  })
})

describe('recheckDetectedTip', () => {
  const account = { id: 7, label: 'author_acct', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  const baseTip = {
    id: 42n,
    postId: 3,
    tipperId: 5,
    post: { userId: 9 },
    piconeros: 1000n,
    txHash: 'aa11',
    paymentId: 'abc',
    rankPiconeros: 700n,
    recipientAccount: account
  }
  let txHandle
  function modelsWithClaim (claimed = 1) {
    txHandle = null
    return {
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(async (fn) => {
        txHandle = {
          $executeRaw: jest.fn().mockResolvedValue(claimed),
          $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]),
          abuseSignal: { create: jest.fn().mockResolvedValue({}) }
        }
        return fn(txHandle)
      })
    }
  }
  const lws = (tx) => ({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: tx == null ? [] : [tx] }) })

  beforeEach(() => jest.clearAllMocks())

  test('excludes CHAIN_MISMATCH, reverses the delta, and signals when the stored amount is forged', async () => {
    const models = modelsWithClaim()
    const ok = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 999n, spent_outputs: [] }),
      tip: baseTip,
      confirmations: 10
    })
    expect(ok).toBe(true)
    expect(reverseTip).toHaveBeenCalledWith(3, 5, 1000n, 700n, txHandle)
    expect(txHandle.abuseSignal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'CHAIN_MISMATCH_EXCLUDED',
        piconeros: 1000n,
        details: expect.objectContaining({
          lateRecheck: true,
          storedPiconeros: '1000',
          onChainPiconeros: '999',
          storedTxHash: 'aa11',
          onChainTxHash: 'aa11'
        })
      })
    })
  })

  test('passes (returns false) when stored amount and hash match the chain', async () => {
    const models = modelsWithClaim()
    const ok = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 1000n, spent_outputs: [] }),
      tip: baseTip,
      confirmations: 10
    })
    expect(ok).toBe(false)
    expect(models.$transaction).not.toHaveBeenCalled()
  })

  test('fails open when the tx cannot be found (retries next run)', async () => {
    const models = modelsWithClaim()
    const ok = await recheckDetectedTip({ models, monero: lws(null), tip: baseTip, confirmations: 10 })
    expect(ok).toBe(false)
    expect(models.$transaction).not.toHaveBeenCalled()
  })

  test('still excludes SELF_SEND when the spent outputs prove a wash tip', async () => {
    const models = modelsWithClaim()
    const ok = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 1000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }),
      tip: baseTip,
      confirmations: 10
    })
    expect(ok).toBe(true)
    expect(txHandle.abuseSignal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'SELF_SEND_EXCLUDED' })
    })
  })

  test('still excludes DIRECT_SELF_TIP with no lws lookup', async () => {
    const moneroFake = { getAddressTxs: jest.fn() }
    const ok = await recheckDetectedTip({ models: modelsWithClaim(), monero: moneroFake, tip: { ...baseTip, tipperId: 9 }, confirmations: 10 })
    expect(ok).toBe(true)
    expect(moneroFake.getAddressTxs).not.toHaveBeenCalled()
  })

  test('skips unscannable accounts entirely (documented fail-open posture)', async () => {
    const moneroFake = { getAddressTxs: jest.fn() }
    const ok = await recheckDetectedTip({
      models: modelsWithClaim(),
      monero: moneroFake,
      tip: { ...baseTip, recipientAccount: { ...account, viewKey: null } },
      confirmations: 10
    })
    expect(ok).toBe(false)
    expect(moneroFake.getAddressTxs).not.toHaveBeenCalled()
  })

  test('returns false when another claimer won the EXCLUDED transition', async () => {
    const models = modelsWithClaim(0)
    const ok = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 999n, spent_outputs: [] }),
      tip: baseTip,
      confirmations: 10
    })
    expect(ok).toBe(false)
    expect(reverseTip).not.toHaveBeenCalled()
  })
})
