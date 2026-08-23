/* eslint-env jest */
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'

// The verified badge is hard-off pending the award/pay redesign; these legacy
// tests mock the flag ON so the grant logic stays covered as documentation.
// var, not let/const: jest.mock factories may only reference out-of-scope
// names prefixed with "mock", and const/let here would be in TDZ when the
// hoisted jest.mock call runs.
jest.mock('../../lib/verified-badge-flag', () => ({
  __esModule: true,
  isVerifiedBadgeEnabled: () => mockFlag
}))

var mockFlag = true

beforeEach(() => {
  mockFlag = true
})

const DAY = 86_400_000
const CONFIG = {
  id: 1,
  freePostThresholdPiconeros: 10_000_000_000n,
  freePostMinAgeDays: 7,
  postingFeeFloorPiconeros: 1_000_000_000n
}
const establishedUser = { id: 42, stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * DAY) }
const lowRepUser = { id: 43, stackedPiconeros: 0n, createdAt: new Date() }

describe('maybeGrantVerifiedBadge', () => {
  test('grants when wallet + gate met + no prior streak', async () => {
    const inserted = []
    const models = {
      platformFeeConfig: { findUnique: async () => CONFIG },
      user: { findUnique: async () => establishedUser },
      moneroAccount: { findFirst: async () => ({ id: 1 }) },
      $queryRaw: async (strings, ...vals) => {
        // The INSERT ... RETURNING query: return a synthetic row to signal inserted.
        if (strings.join('').includes('INSERT INTO "Streak"')) {
          inserted.push(vals)
          return [{ id: 7, userId: 42, type: 'VERIFIED' }]
        }
        // The NOT EXISTS subquery / SELECT: no prior streak.
        return []
      }
    }
    const result = await maybeGrantVerifiedBadge(models, 42)
    expect(result).toBe(true)
    expect(inserted).toHaveLength(1)
  })

  test('no-op when no wallet', async () => {
    const models = {
      platformFeeConfig: { findUnique: async () => CONFIG },
      user: { findUnique: async () => establishedUser },
      moneroAccount: { findFirst: async () => null },
      $queryRaw: jest.fn()
    }
    const result = await maybeGrantVerifiedBadge(models, 42)
    expect(result).toBe(false)
    expect(models.$queryRaw).not.toHaveBeenCalled()
  })

  test('no-op when gate not met (low rep)', async () => {
    const models = {
      platformFeeConfig: { findUnique: async () => CONFIG },
      user: { findUnique: async () => lowRepUser },
      moneroAccount: { findFirst: async () => ({ id: 1 }) },
      $queryRaw: jest.fn()
    }
    const result = await maybeGrantVerifiedBadge(models, 43)
    expect(result).toBe(false)
    expect(models.$queryRaw).not.toHaveBeenCalled()
  })

  test('no-op when a VERIFIED streak already exists', async () => {
    const models = {
      platformFeeConfig: { findUnique: async () => CONFIG },
      user: { findUnique: async () => establishedUser },
      moneroAccount: { findFirst: async () => ({ id: 1 }) },
      $queryRaw: async (strings) => {
        if (strings.join('').includes('INSERT INTO "Streak"')) return [] // WHERE NOT EXISTS matched
        return [{ id: 99 }]
      }
    }
    const result = await maybeGrantVerifiedBadge(models, 42)
    expect(result).toBe(false)
  })

  test('no-op when the badge is disabled (never queries the DB)', async () => {
    mockFlag = false
    const models = {
      platformFeeConfig: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      moneroAccount: { findFirst: jest.fn() },
      $queryRaw: jest.fn()
    }
    const result = await maybeGrantVerifiedBadge(models, 42)
    expect(result).toBe(false)
    expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
    expect(models.$queryRaw).not.toHaveBeenCalled()
  })
})
