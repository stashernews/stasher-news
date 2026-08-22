/* eslint-env jest */
import subResolvers from '@/api/resolvers/sub'
import pay from '../../api/payIn'

// sub.js statically imports @/lib/lexical/server/html (ESM-only github-slugger
// via the headless editor); none of it runs in these tests, so stub it like
// test/api/paySub.test.js. jest.mock is hoisted above the imports.
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

// pay('TERRITORY_CREATE', ...) mints a real subaddress + PayIn row — stub the
// engine so the gate-off test proves the resolver resolves without it. The
// gate-on tests throw before pay is ever reached.
// NOTE: relative path (repo convention) — jest.mock with the '@/api/payIn' alias
// does not resolve the directory module and never intercepts sub.js's '../payIn'
// (see test/api/paySub.test.js).
jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ id: 1 }))
}))

// territorySchema's availability/username checks hit models.sub with the real
// Prisma shape; against the hand-rolled models below they would fail before the
// wallet gate is reached. No-op ONLY validateSchema, keep the rest real.
jest.mock('../../lib/validate', () => {
  const actual = jest.requireActual('../../lib/validate')
  return { ...actual, validateSchema: async () => {} }
})

const gqlMe = { id: 7 }
const transferee = { id: 42, name: 'bob' }

function models ({ meHasWallet = true, transfereeHasWallet = true, subStatus = 'STOPPED' } = {}) {
  return {
    moneroAccount: {
      findFirst: async ({ where }) => {
        if (where.ownerUserId === gqlMe.id) return meHasWallet ? { id: 1 } : null
        if (where.ownerUserId === transferee.id) return transfereeHasWallet ? { id: 2 } : null
        return null
      }
    },
    sub: { findUnique: async () => ({ name: 't', userId: gqlMe.id, status: subStatus, billingType: 'MONTHLY' }) },
    user: { findFirst: async () => transferee },
    territoryTransfer: { create: async () => ({}) },
    $transaction: async (ops) => Array.isArray(ops) ? await Promise.all(ops) : await ops
  }
}

const createArgs = { name: 'x', desc: 'd', postTypes: ['LINK'], billingType: 'MONTHLY', billingAutoRenew: false, nsfw: false }

describe('turf wallet gates (TURF_OWNER_FEES=1)', () => {
  beforeEach(() => { process.env.TURF_OWNER_FEES = '1' })
  afterEach(() => { delete process.env.TURF_OWNER_FEES })

  it('createSub requires a registered wallet', async () => {
    await expect(subResolvers.Mutation.upsertSub(null, createArgs, { me: gqlMe, models: models({ meHasWallet: false }) }))
      .rejects.toThrow('register your Monero wallet')
  })
  it('transferTerritory requires the transferee to have a wallet', async () => {
    await expect(subResolvers.Mutation.transferTerritory(null, { subName: 't', userName: 'bob' }, { me: gqlMe, models: models({ transfereeHasWallet: false }) }))
      .rejects.toThrow('recipient has no registered Monero wallet')
  })
  it('unarchiveTerritory requires a registered wallet', async () => {
    await expect(subResolvers.Mutation.unarchiveTerritory(null, createArgs, { me: gqlMe, models: models({ meHasWallet: false }) }))
      .rejects.toThrow('register your Monero wallet')
  })
})

describe('turf wallet gates (gate OFF = dormant)', () => {
  it('skips all wallet checks — createSub proceeds without a wallet', async () => {
    // no beforeEach: TURF_OWNER_FEES unset
    // pay() is stubbed (see mocks above), so a resolve means the gate let it through
    await expect(subResolvers.Mutation.upsertSub(null, createArgs, { me: gqlMe, models: models({ meHasWallet: false }) }))
      .resolves.toBeDefined()
  })
})

describe('turf premium server gate (dormant deployment must equal today\'s defaults)', () => {
  const premiumArgs = { ...createArgs, postPremiumPiconeros: 5_000_000_000n, commentPremiumPiconeros: 5_000_000_000n }
  const lastPayData = () => pay.mock.calls.at(-1)[1]

  describe('gate OFF (dormant): premiums forced to 0n before pay()', () => {
    it('createSub zeroes premiums', async () => {
      // walletless payer proves the dormant checks are skipped entirely
      await subResolvers.Mutation.upsertSub(null, premiumArgs, { me: gqlMe, models: models({ meHasWallet: false }) })
      expect(lastPayData().postPremiumPiconeros).toBe(0n)
      expect(lastPayData().commentPremiumPiconeros).toBe(0n)
    })
    it('updateSub (upsertSub with oldName) zeroes premiums', async () => {
      await subResolvers.Mutation.upsertSub(null, { oldName: 't', ...premiumArgs }, { me: gqlMe, models: models({ subStatus: 'ACTIVE' }) })
      expect(lastPayData().postPremiumPiconeros).toBe(0n)
      expect(lastPayData().commentPremiumPiconeros).toBe(0n)
    })
    it('unarchiveTerritory zeroes premiums', async () => {
      await subResolvers.Mutation.unarchiveTerritory(null, premiumArgs, { me: gqlMe, models: models({ meHasWallet: false }) })
      expect(lastPayData().postPremiumPiconeros).toBe(0n)
      expect(lastPayData().commentPremiumPiconeros).toBe(0n)
    })
  })

  describe('gate ON: premiums pass through unchanged', () => {
    beforeEach(() => { process.env.TURF_OWNER_FEES = '1'; pay.mockClear() })
    afterEach(() => { delete process.env.TURF_OWNER_FEES })

    it('createSub passes premiums through', async () => {
      await subResolvers.Mutation.upsertSub(null, premiumArgs, { me: gqlMe, models: models() })
      expect(lastPayData().postPremiumPiconeros).toBe(5_000_000_000n)
      expect(lastPayData().commentPremiumPiconeros).toBe(5_000_000_000n)
    })
    it('unarchiveTerritory passes premiums through', async () => {
      await subResolvers.Mutation.unarchiveTerritory(null, premiumArgs, { me: gqlMe, models: models() })
      expect(lastPayData().postPremiumPiconeros).toBe(5_000_000_000n)
      expect(lastPayData().commentPremiumPiconeros).toBe(5_000_000_000n)
    })
  })
})

describe('Sub.earnedPiconeros (owner-gated turf revenue readout)', () => {
  const turf = { name: 't', userId: gqlMe.id }
  const aggregate = jest.fn(async () => ({ _sum: { piconeros: 1234n } }))
  const earnedModels = { observedSubFee: { aggregate } }

  it('owner sees the CONFIRMED ObservedSubFee sum', async () => {
    await expect(subResolvers.Sub.earnedPiconeros(turf, null, { me: gqlMe, models: earnedModels }))
      .resolves.toBe(1234n)
    expect(aggregate).toHaveBeenCalledWith({
      _sum: { piconeros: true },
      where: { subName: 't', state: 'CONFIRMED' }
    })
  })
  it('non-owner sees null and no aggregate runs', async () => {
    await expect(subResolvers.Sub.earnedPiconeros(turf, null, { me: { id: 42 }, models: earnedModels }))
      .resolves.toBeNull()
    expect(aggregate).toHaveBeenCalledTimes(1)
  })
})
