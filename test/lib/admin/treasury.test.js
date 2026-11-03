/* eslint-env jest */

jest.mock('../../../api/monero/rewardsWalletReport', () => ({
  readRewardsWalletInfo: jest.fn(async () => ({
    balancePiconeros: 23n,
    nextPoolPiconeros: 96n,
    sweptToOpsPiconeros: 10n,
    reconciliationCheckedAt: new Date('2026-11-01T14:02:00.000Z')
  })),
  readRewardDistributions: jest.fn(async () => [{
    id: 31,
    poolPiconeros: 5000n,
    rolledOverPiconeros: 1000n,
    payouts: [{ id: 7, curatorId: 42, curatorNym: 'satoshi', curator: { name: 'satoshi' }, recipientAddress: '5AW…', piconeros: 4000n, amountXmr: '0.000000004', txHash: 'cd', state: 'SENT' }]
  }])
}))

const { adminTreasury } = require('../../../lib/admin/treasury')
const report = require('../../../api/monero/rewardsWalletReport')

test('serves the exact ledger and the last ten runs as JSON-safe values', async () => {
  const models = {}
  const treasury = await adminTreasury(models)

  expect(report.readRewardDistributions).toHaveBeenCalledWith(models, { limit: 10 })
  expect(treasury.wallet).toEqual({
    balancePiconeros: '23',
    nextPoolPiconeros: '96',
    sweptToOpsPiconeros: '10',
    reconciliationCheckedAt: '2026-11-01T14:02:00.000Z'
  })
  expect(treasury.distributions[0]).toMatchObject({ id: 31, poolPiconeros: '5000', rolledOverPiconeros: '1000' })
})

test('payout rows keep what the log needs and drop recipient addresses', async () => {
  const { distributions: [row] } = await adminTreasury({})
  expect(row.payouts).toEqual([{ id: 7, curatorId: 42, curatorNym: 'satoshi', piconeros: '4000', txHash: 'cd', state: 'SENT' }])
})
