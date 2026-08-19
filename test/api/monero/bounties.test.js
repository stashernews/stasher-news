/* eslint-env jest */

import { bountyFeePiconeros, getBountyEscrowTxHeight, resolveBountyEscrowRestoreHeight } from '@/api/monero/bounties'

const config = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }

test('bounty fee = flat 0.01 XMR below the 1% threshold', () => {
  expect(bountyFeePiconeros(1_000_000_000_000n, config)).toBe(10_000_000_000n) // exactly 1 XMR -> 0.01
  expect(bountyFeePiconeros(500_000_000_000n, config)).toBe(10_000_000_000n) // 0.5 XMR -> 0.01
})

test('bounty fee = 1% above the 1% threshold', () => {
  expect(bountyFeePiconeros(3_000_000_000_000n, config)).toBe(30_000_000_000n) // 1% of 3 XMR
})

test('bounty fee is capped at 20% of the bounty for small bounties', () => {
  expect(bountyFeePiconeros(10_000_000_000n, config)).toBe(2_000_000_000n) // min bounty 0.01 -> 20% = 0.002
  expect(bountyFeePiconeros(50_000_000_000n, config)).toBe(10_000_000_000n) // 0.05 -> 20% = 0.01 (cap meets floor)
  expect(bountyFeePiconeros(5_000_000_000n, config)).toBe(1_000_000_000n) // below min bounty but math still caps
})

test('bounty fee never exceeds 20% even when the flat floor applies', () => {
  expect(bountyFeePiconeros(1_000_000_000n, config)).toBe(200_000_000n) // 20% of 0.001
})

test('getBountyEscrowTxHeight returns the mined height of a payout tx from lws get_address_txs', async () => {
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [
        { hash: '070bb1', height: 2185142 },
        { hash: '9f4a28fa', height: 2188338 }
      ]
    })
  }
  const models = { moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1, address: '5E', viewKey: {} }) } }

  await expect(getBountyEscrowTxHeight('9f4a28fa', { models, lws })).resolves.toBe(2188338)
  expect(models.moneroAccount.findFirst).toHaveBeenCalledWith({
    where: { label: 'bounty_escrow', network: 'STAGENET' },
    include: { viewKey: true },
    orderBy: { id: 'asc' }
  })
})

test('getBountyEscrowTxHeight returns null when the tx is unknown to lws (not yet mined/indexed)', async () => {
  const lws = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [{ hash: '070bb1', height: 2185142 }] }) }
  const models = { moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1, address: '5E', viewKey: {} }) } }

  await expect(getBountyEscrowTxHeight('9f4a28fa', { models, lws })).resolves.toBeNull()
})

test('getBountyEscrowTxHeight returns null while the tx is unconfirmed (mempool, no height)', async () => {
  const lws = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [{ hash: '9f4a28fa', height: null }] }) }
  const models = { moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 1, address: '5E', viewKey: {} }) } }

  await expect(getBountyEscrowTxHeight('9f4a28fa', { models, lws })).resolves.toBeNull()
})

test('getBountyEscrowTxHeight returns null when no escrow account row exists (never queries lws)', async () => {
  const lws = { getAddressTxs: jest.fn() }
  const models = { moneroAccount: { findFirst: jest.fn().mockResolvedValue(null) } }

  await expect(getBountyEscrowTxHeight('9f4a28fa', { models, lws })).resolves.toBeNull()
  expect(lws.getAddressTxs).not.toHaveBeenCalled()
})

test('restore height = env BOUNTY_ESCROW_SCAN_FROM_HEIGHT when set (source env)', () => {
  expect(resolveBountyEscrowRestoreHeight({ envHeight: 2180000, earliestFundingHeight: 2185142, daemonHeight: 2200000 }))
    .toEqual({ restoreHeight: 2180000, source: 'env' })
})

test('restore height derives from the earliest funding height minus margin when env is unset', () => {
  expect(resolveBountyEscrowRestoreHeight({ envHeight: 0, earliestFundingHeight: 2185142, daemonHeight: 2200000 }))
    .toEqual({ restoreHeight: 2184142, source: 'earliest-funding' })
})

test('falls back to daemon height minus margin when there is no funding history', () => {
  expect(resolveBountyEscrowRestoreHeight({ envHeight: 0, earliestFundingHeight: null, daemonHeight: 2200000 }))
    .toEqual({ restoreHeight: 2199000, source: 'daemon-margin' })
})

test('returns genesis (0) when nothing is available (env unset, no funding, daemon down)', () => {
  expect(resolveBountyEscrowRestoreHeight({ envHeight: 0, earliestFundingHeight: null, daemonHeight: null }))
    .toEqual({ restoreHeight: 0, source: 'genesis' })
})

test('clamps at 0 when the earliest funding height is below the margin', () => {
  expect(resolveBountyEscrowRestoreHeight({ envHeight: 0, earliestFundingHeight: 500, daemonHeight: 2200000 }))
    .toEqual({ restoreHeight: 0, source: 'earliest-funding' })
})
