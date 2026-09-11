/* eslint-env jest */
import { parsePiconeros, verifyReceiptAmount, ReceiptLookupError } from '@/api/monero/receiptVerification'

describe('parsePiconeros', () => {
  test('accepts positive integer strings and numbers', () => {
    expect(parsePiconeros('1000')).toBe(1000n)
    expect(parsePiconeros(1000)).toBe(1000n)
  })

  test('rejects zero, negatives, garbage, null and undefined', () => {
    expect(parsePiconeros('0')).toBeNull()
    expect(parsePiconeros('-1')).toBeNull()
    expect(parsePiconeros('-1000')).toBeNull()
    expect(parsePiconeros('abc')).toBeNull()
    expect(parsePiconeros('1.5')).toBeNull()
    expect(parsePiconeros(null)).toBeNull()
    expect(parsePiconeros(undefined)).toBeNull()
    expect(parsePiconeros('')).toBeNull()
  })
})

const ACTIVE_ACCOUNT = {
  id: 7,
  address: 'ADDR',
  status: 'ACTIVE',
  viewKey: { ciphertext: Buffer.alloc(0) },
  lastTxId: null,
  subaddresses: []
}

function lwsWith (txs) {
  return { getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs }) }
}
const MODELS = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }

describe('verifyReceiptAmount', () => {
  test('accepts when the on-chain amount and hash match', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: true })
  })

  test('rejects on amount mismatch', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 999n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'amount_mismatch' })
  })

  test('rejects when the callback hash does not match the chain tx (anti-replay binding)', async () => {
    const monero = lwsWith([{ hash: 'aaaa', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'bbbb' }))
      .resolves.toMatchObject({ ok: false, reason: 'hash_mismatch' })
  })

  test('rejects when the chain tx carries no hash (fail closed)', async () => {
    const monero = lwsWith([{ payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'hash_unavailable' })
  })

  test('rejects when the tx is not found', async () => {
    const monero = lwsWith([])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'missing', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'tx_not_found' })
  })

  test('throws ReceiptLookupError on lws failure', async () => {
    const monero = { getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) }
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .rejects.toBeInstanceOf(ReceiptLookupError)
  })

  test('skips verification for an unscannable account (existing fail-open posture)', async () => {
    await expect(verifyReceiptAmount({ models: {}, monero: {}, account: { id: 9, status: 'INACTIVE', viewKey: null }, paymentId: 'abc', piconeros: 1n, txHash: 'x' }))
      .resolves.toMatchObject({ ok: true, skipped: true })
  })

  test('reuses a pre-fetched tx and does not call lws again', async () => {
    const monero = { getAddressTxs: jest.fn() }
    await expect(verifyReceiptAmount({
      models: {},
      monero,
      account: ACTIVE_ACCOUNT,
      paymentId: 'abc',
      piconeros: 1000n,
      txHash: 'deadbeef',
      tx: { hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }
    })).resolves.toMatchObject({ ok: true })
    expect(monero.getAddressTxs).not.toHaveBeenCalled()
  })

  test('does not advance the cursor when verifying against the rewards account (C6 downvote path)', async () => {
    const monero = lwsWith([{ id: 5, hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const rewards = { ...ACTIVE_ACCOUNT, label: 'platform_rewards' }
    await expect(verifyReceiptAmount({ models, monero, account: rewards, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: true })
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })
})
