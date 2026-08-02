/* eslint-env jest */
import resolvers from '@/api/resolvers/monero'

describe('Query.tipStatus', () => {
  const tipStatus = resolvers.Query.tipStatus

  it('returns state/piconeros/confirmations for a known paymentId', async () => {
    const models = {
      observedTip: {
        findFirst: jest.fn(async ({ where }) =>
          where.paymentId === 'pid-1'
            ? { state: 'DETECTED', piconeros: 1_000_000_000n, confirmations: 0 }
            : null)
      }
    }
    const result = await tipStatus(null, { paymentId: 'pid-1' }, { models })
    expect(result).toEqual({ state: 'DETECTED', piconeros: 1_000_000_000n, confirmations: 0 })
    expect(models.observedTip.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: 'pid-1' }
    }))
  })

  it('returns null for an unknown paymentId (modal treats null as still PENDING)', async () => {
    const models = { observedTip: { findFirst: jest.fn(async () => null) } }
    const result = await tipStatus(null, { paymentId: 'nope' }, { models })
    expect(result).toBeNull()
  })

  it('uses findFirst (paymentId is not unique-constrained on ObservedTip)', async () => {
    const models = { observedTip: { findFirst: jest.fn(async () => null) } }
    await tipStatus(null, { paymentId: 'x' }, { models })
    expect(models.observedTip.findFirst).toHaveBeenCalled()
  })
})
