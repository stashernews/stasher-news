/* eslint-env jest */
import { payInPrismaCreate } from '@/api/payIn/lib/payInPrisma'

// Regression test for the "Unknown argument: payInCustodialTokens" /
// "relation does not exist" crashes that blocked every StasherNews fee payIn.
// The Prisma schema removed the custodial/Lightning tables, so payInPrismaCreate
// must NOT emit keys referencing them for an piconeros:0 fee prospect.

const GHOST = ['payInCustodialTokens', 'payOutCustodialTokens', 'payInBolt11', 'payOutBolt11', 'pessimisticEnv']

describe('payInPrismaCreate', () => {
  test('emits no custodial/bolt/pessimistic keys for an piconeros:0 fee prospect', () => {
    // Mirrors payInCreate's real fullProspect for an piconeros:0 fee: getPayInCosts
    // unconditionally sets payInCustodialTokens=[] (mCustodialCost<=0n short-circuits
    // to []) and the caller's payOutCustodialTokens flows through. These empty ghost
    // arrays are what payInPrismaCreate wraps as { create: [] }, crashing Prisma.
    const prospect = {
      payInType: 'TERRITORY_CREATE',
      userId: 7,
      piconeros: 0n,
      payInState: 'PAID',
      payInCustodialTokens: [],
      payOutCustodialTokens: [],
      moneroUri: 'monero:...',
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: 1,
      beneficiaries: []
    }

    const data = payInPrismaCreate(prospect)

    for (const key of GHOST) {
      expect(data).not.toHaveProperty(key)
    }
  })

  test('carries the real scalar fields through unchanged', () => {
    const prospect = {
      payInType: 'ITEM_CREATE',
      userId: 9,
      piconeros: 0n,
      payInState: 'PAID',
      moneroUri: 'monero:...'
    }
    const data = payInPrismaCreate(prospect)
    expect(data.payInType).toBe('ITEM_CREATE')
    expect(data.userId).toBe(9)
    expect(data.piconeros).toBe(0n)
    expect(data.payInState).toBe('PAID')
  })
})
