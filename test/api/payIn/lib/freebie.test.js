/* eslint-env jest */
import { Prisma } from '@prisma/client'
import { incrementFreeCommentCount, incrementFreePostCount, getNextDayStart, consumeQuotaForFlippedItem, consumeStreakReward } from '@/api/payIn/lib/freebie'

// A mock tx whose user.update is a jest.fn; config always resolves so the helpers
// proceed to the quota/branch logic. $queryRaw dispatches on the SQL text: the
// ObservedTip quest check returns the given tips, the StreakReward consume
// returns the given credits (default: one available), and the first-responder
// scan returns nothing. resolveDraw's turf lookup returns no turfs.
function mkTx (user, { tips = [], credits = [{ id: 11 }] } = {}) {
  return {
    user: {
      findUnique: async () => user,
      update: jest.fn(async () => ({}))
    },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    sub: { findMany: async () => [] },
    payIn: { findFirst: async () => null },
    item: { findFirst: async () => null },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('ObservedTip')) return tips
      if (sql.includes('StreakReward')) return credits
      return []
    })
  }
}

const ANON = 27

test('incrementFreeCommentCount is a no-op for posts (no parentId)', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() })
  await incrementFreeCommentCount(tx, { item: { freebie: false, parentId: null }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreeCommentCount is a no-op for a non-freebie item', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() })
  await incrementFreeCommentCount(tx, { item: { freebie: false, parentId: 1 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreeCommentCount is a no-op for anon', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null, stackedPiconeros: 0n, createdAt: new Date() })
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: ANON })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreeCommentCount increments within the flat daily quota', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  // one tier: every user's increment guard is the flat quota of 1
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 1 } }) }))
})

test('the daily quota is flat: a recent tip does not raise the increment guard', async () => {
  const tx = mkTx(
    { freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null },
    { tips: [{ n: 1 }] }
  )
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  // rev 3: quest completions bank REPLY credits instead of raising the quota
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 1 } }) }))
})

test('the daily quota is flat: a day-3 streak does not raise the increment guard', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: 3 })
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 1 } }) }))
})

test('a P2025 lost race at the quota guard fails loudly (genuine exhaustion or a concurrent freebie)', async () => {
  // rev 3: quest completions no longer influence the quota (they bank REPLY
  // credits instead), so a P2025 from the guarded increment can only mean the
  // base was genuinely exhausted in a race or another freebie snuck in past
  // the gate. The translation to 'no free comments left' must stand.
  const tx = mkTx(
    { freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null },
    { credits: [] } // no banked credits either; irrelevant on this path anyway
  )
  // a real PrismaClientKnownRequestError: incrementFreeCommentCount's catch
  // translates the quota-guard P2025 only for genuine Prisma errors (instanceof)
  tx.user.update = jest.fn(async () => { throw new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2025', clientVersion: '5.20.0' }) })
  await expect(incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 }))
    .rejects.toThrow('no free comments left')
})

test('incrementFreeCommentCount consumes a banked REPLY credit when the daily base is exhausted', async () => {
  const user = { freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null }
  const consumed = []
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => ({})) },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('StreakReward')) { consumed.push(sql); return [{ id: 11 }] }
      return []
    })
  }
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1, id: 888 }, userId: 5 })
  expect(consumed.length).toBe(1)
  expect(consumed[0]).toContain('StreakReward')
  // base-first: the counter is left alone, the credit takes the spend
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreeCommentCount leaves the counter alone with no credit left (the gate should not have granted the freebie)', async () => {
  const user = { freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null }
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => ({})) },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    $queryRaw: jest.fn(async () => [])
  }
  // No throw: an over-base freebie without credits is inert bookkeeping here;
  // the credit-aware gate (commentQuotaFor) is what should have priced it.
  await expect(incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })).resolves.toBeUndefined()
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreePostCount is a no-op for comments and bios (freebie=true or parentId set)', async () => {
  const tx = mkTx({ freePostCount: 0, freePostResetAt: null, stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreePostCount(tx, { item: { freebie: true, parentId: null, feeStatus: 'FEE_NOT_REQUIRED' }, userId: 5 })
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: 1, feeStatus: 'FEE_NOT_REQUIRED' }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreePostCount is a no-op for paid posts (PENDING_FEE)', async () => {
  const tx = mkTx({ freePostCount: 0, freePostResetAt: null, stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'PENDING_FEE' }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreePostCount increments for a low-rep user within the 1-post quota', async () => {
  const tx = mkTx({ freePostCount: 0, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 0n, createdAt: new Date() })
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'FEE_NOT_REQUIRED' }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freePostCount: { lt: 1 } }) }))
})

test('incrementFreePostCount increments for a free post within the flat monthly quota', async () => {
  const tx = mkTx({ freePostCount: 0, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'FEE_NOT_REQUIRED' }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freePostCount: { lt: 1 } }) }))
})

test('getNextDayStart returns the next 00:00 UTC midnight', () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 12, 23, 59, 59, 999)))
  try {
    expect(getNextDayStart()).toEqual(new Date(Date.UTC(2026, 8, 13, 0, 0, 0, 0)))
    // exactly at midnight, the window that just opened is "current" — next reset is the following midnight
    jest.setSystemTime(new Date(Date.UTC(2026, 8, 12, 0, 0, 0, 0)))
    expect(getNextDayStart()).toEqual(new Date(Date.UTC(2026, 8, 13, 0, 0, 0, 0)))
  } finally {
    jest.useRealTimers()
  }
})

test('incrementFreeCommentCount rolls a stale counter over to a fresh daily window', async () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 12, 10, 30, 0)))
  try {
    const stale = new Date(Date.UTC(2026, 8, 11, 0, 0, 0, 0))
    const tx = mkTx({ freeCommentCount: 2, freeCommentResetAt: stale, stackedPiconeros: 0n, createdAt: new Date(Date.UTC(2026, 8, 12)) })
    await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 5, freeCommentResetAt: stale },
      data: { freeCommentCount: 1, freeCommentResetAt: new Date(Date.UTC(2026, 8, 13, 0, 0, 0, 0)) }
    })
  } finally {
    jest.useRealTimers()
  }
})

// --- consumeQuotaForFlippedItem (R01: flip-time quota consumption) ---

test('consumeQuotaForFlippedItem is a no-op without the feeQuotaEligible marker', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: false, parentId: 1 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('consumeQuotaForFlippedItem is a no-op for anon', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: ANON })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('consumeQuotaForFlippedItem is a no-op when the user row is missing', async () => {
  const tx = mkTx(null)
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('consumeQuotaForFlippedItem opens a fresh daily window for a comment when none is open', async () => {
  const tx = mkTx({ freeCommentCount: 4, freeCommentResetAt: null })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith({
    where: { id: 5 },
    data: { freeCommentCount: 1, freeCommentResetAt: expect.any(Date) }
  })
})

test('consumeQuotaForFlippedItem force-increments the comment counter with NO quota precondition', async () => {
  // count 9 (over any quota) still increments — the flip must never be rejected
  const tx = mkTx({ freeCommentCount: 9, freeCommentResetAt: new Date(Date.now() + 86_400_000) })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith({
    where: { id: 5 },
    data: { freeCommentCount: { increment: 1 } }
  })
})

test('consumeQuotaForFlippedItem increments the post counter within quota for a top-level item', async () => {
  const tx = mkTx({ freePostCount: 0, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith({
    where: { id: 5 },
    data: { freePostCount: { increment: 1 } }
  })
})

test('consumeQuotaForFlippedItem rolls a stale post window over to a fresh month', async () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 21, 10, 30, 0)))
  try {
    const stale = new Date(Date.UTC(2026, 8, 1, 0, 0, 0))
    const tx = mkTx({ freePostCount: 5, freePostResetAt: stale, stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.UTC(2026, 8, 12)) })
    await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null }, userId: 5 })
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { freePostCount: 1, freePostResetAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0)) }
    })
  } finally {
    jest.useRealTimers()
  }
})

test('consumeQuotaForFlippedItem NEVER throws — a failed update is swallowed (the flip must proceed)', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null })
  tx.user.update = jest.fn(async () => { throw new Error('db blip') })
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })).resolves.toBeUndefined()
})

// --- consumeStreakReward (typed banked rewards: soonest-expiring first) ---

describe('consumeStreakReward', () => {
  test('consumes exactly one soonest-expiring reward; a second call finds none', async () => {
    const updates = []
    const tx = {
      $queryRaw: jest.fn(async () => updates.shift() ?? [])
    }
    updates.push([{ id: 11 }])
    await expect(consumeStreakReward(tx, 5, 'POST', 4242)).resolves.toBe(true)
    await expect(consumeStreakReward(tx, 5)).resolves.toBe(false)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
  })

  test('the UPDATE targets the soonest-expiring unconsumed typed row with SKIP LOCKED', async () => {
    const tx = { $queryRaw: jest.fn(async () => [{ id: 11 }]) }
    await consumeStreakReward(tx, 5, 'POST', 99)
    const strings = String(tx.$queryRaw.mock.calls[0][0].join(''))
    expect(strings).toContain('StreakReward')
    expect(strings).toContain('"type" = ')
    expect(strings).toContain('ORDER BY "expiresAt" ASC, id ASC')
    expect(strings).toContain('FOR UPDATE SKIP LOCKED')
    expect(strings).toContain('"expiresAt" > now_utc()')
  })
})

test('incrementFreePostCount consumes a banked reward when the base quota is exhausted', async () => {
  const user = { freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null }
  const consumed = []
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => ({})) },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('StreakReward')) { consumed.push(sql); return [{ id: 11 }] }
      return []
    })
  }
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'FEE_NOT_REQUIRED', id: 777 }, userId: 5 })
  expect(consumed.length).toBe(1)
  expect(consumed[0]).toContain('StreakReward')
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('incrementFreePostCount throws no free posts left when base and rewards are exhausted', async () => {
  const user = { freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null }
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => ({})) },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    $queryRaw: jest.fn(async () => [])
  }
  await expect(incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'FEE_NOT_REQUIRED', id: 778 }, userId: 5 }))
    .rejects.toThrow('no free posts left')
})

test('consumeQuotaForFlippedItem never throws and falls back to rewards at the flip', async () => {
  const user = { freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null }
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => { throw new Error('db gone') }) },
    platformFeeConfig: { findUnique: async () => { throw new Error('db gone') } },
    $queryRaw: jest.fn(async () => { throw new Error('db gone') })
  }
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null, id: 9 }, userId: 5 })).resolves.toBeUndefined()
})

test('consumeQuotaForFlippedItem consumes a banked reward when the post base quota is exhausted at the flip', async () => {
  const tx = mkTx({ freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null, id: 9 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
  const sql = String(tx.$queryRaw.mock.calls[0][0].join(''))
  expect(sql).toContain('StreakReward')
})
