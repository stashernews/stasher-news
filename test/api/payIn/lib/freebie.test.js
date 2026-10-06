/* eslint-env jest */
import { Prisma } from '@prisma/client'
import { incrementFreeCommentCount, incrementFreePostCount, getNextWeekStart, consumeQuotaForFlippedItem, consumeStreakReward } from '@/api/payIn/lib/freebie'

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
      // consumeQuotaForFlippedItem takes the universal reward-write user lock
      // (api/quests/boost-credit lockRewardUser) before reading quota state.
      if (sql.includes('FROM users')) return user ? [{ id: 5 }] : []
      if (sql.includes('ObservedTip')) return tips
      if (sql.includes('StreakReward')) return credits
      return []
    })
  }
}

// $queryRaw calls whose SQL touches StreakReward (the credit consume), in order.
function streakRewardSql (tx) {
  return tx.$queryRaw.mock.calls.map(c => String(c[0].join(''))).filter(sql => sql.includes('StreakReward'))
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

test('incrementFreeCommentCount increments within the flat weekly quota', async () => {
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  // one tier: every user's increment guard is the flat quota of 1
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 1 } }) }))
})

test('the weekly quota is flat: a recent tip does not raise the increment guard', async () => {
  const tx = mkTx(
    { freeCommentCount: 0, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null },
    { tips: [{ n: 1 }] }
  )
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  // rev 3: quest completions bank REPLY credits instead of raising the quota
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 1 } }) }))
})

test('the weekly quota is flat: a day-3 streak does not raise the increment guard', async () => {
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

test('incrementFreeCommentCount consumes a banked REPLY credit when the weekly base is exhausted', async () => {
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

test('incrementFreeCommentCount rejects when the base is exhausted and no REPLY credit is left (no fail-open freebie)', async () => {
  const user = { freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null }
  const tx = {
    user: { findUnique: async () => user, update: jest.fn(async () => ({})) },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) },
    $queryRaw: jest.fn(async () => [])
  }
  // A freebie the credit-aware gate granted off a stale prospect (the credit
  // was spent on a concurrent creation) must not commit for free: consume
  // fails closed, the caller's payIn transaction rolls the item back.
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })).rejects.toThrow('no free comments left')
    expect(tx.user.update).not.toHaveBeenCalled()
    // expected quota exhaustion is not logged as an unexpected failure
    expect(errorSpy).not.toHaveBeenCalled()
  } finally {
    errorSpy.mockRestore()
  }
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

test('getNextWeekStart returns the next Monday 00:00 UTC from any weekday', () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 12, 10, 30, 0))) // Saturday
  try {
    expect(getNextWeekStart()).toEqual(new Date(Date.UTC(2026, 8, 14, 0, 0, 0, 0))) // Sat -> Mon
    jest.setSystemTime(new Date(Date.UTC(2026, 8, 13, 23, 59, 59, 999))) // Sunday
    expect(getNextWeekStart()).toEqual(new Date(Date.UTC(2026, 8, 14, 0, 0, 0, 0))) // Sun -> Mon (+1d)
    // exactly Monday 00:00, the window that just opened is "current" — the next
    // reset is the FOLLOWING Monday, a full week out (never a same-day reset)
    jest.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 0, 0, 0)))
    expect(getNextWeekStart()).toEqual(new Date(Date.UTC(2026, 8, 21, 0, 0, 0, 0)))
    jest.setSystemTime(new Date(Date.UTC(2026, 8, 17, 12, 0, 0))) // mid-week Thursday
    expect(getNextWeekStart()).toEqual(new Date(Date.UTC(2026, 8, 21, 0, 0, 0, 0)))
  } finally {
    jest.useRealTimers()
  }
})

test('incrementFreeCommentCount rolls a stale counter over to a fresh weekly window (never accumulating)', async () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 12, 10, 30, 0))) // Saturday
  try {
    const stale = new Date(Date.UTC(2026, 8, 11, 0, 0, 0, 0))
    const tx = mkTx({ freeCommentCount: 2, freeCommentResetAt: stale, stackedPiconeros: 0n, createdAt: new Date(Date.UTC(2026, 8, 12)) })
    await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
    // the stale count (2) re-baselines to exactly 1, and the window runs to next Monday
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 5, freeCommentResetAt: stale },
      data: { freeCommentCount: 1, freeCommentResetAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0, 0)) }
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

test('consumeQuotaForFlippedItem opens a fresh weekly window for a comment when none is open', async () => {
  jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 15, 10, 30, 0))) // Tuesday
  try {
    const tx = mkTx({ freeCommentCount: 4, freeCommentResetAt: null })
    await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })
    expect(tx.user.update).toHaveBeenCalledWith({
      // same optimistic reset guard incrementFreeCommentCount uses (belt and
      // braces under the user lock)
      where: { id: 5, freeCommentResetAt: null },
      data: { freeCommentCount: 1, freeCommentResetAt: new Date(Date.UTC(2026, 8, 21, 0, 0, 0, 0)) }
    })
  } finally {
    jest.useRealTimers()
  }
})

test('consumeQuotaForFlippedItem is base-first: past the base it consumes a banked REPLY credit instead of force-incrementing', async () => {
  // count 9 (over any quota) must NOT force-increment: the credit-aware
  // creation gate priced this upload-fee reply off a banked credit, so the
  // flip spends that credit and leaves the counter alone.
  const tx = mkTx({ freeCommentCount: 9, freeCommentResetAt: new Date(Date.now() + 86_400_000) })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1, id: 99 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
  const consumed = streakRewardSql(tx)
  expect(consumed).toHaveLength(1)
  expect(consumed[0]).toContain('FOR UPDATE SKIP LOCKED')
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

test('consumeQuotaForFlippedItem surfaces a failed bookkeeping update to its caller (the flip already committed)', async () => {
  // The caller (flipPendingToLive) runs this in its OWN post-flip transaction
  // and guards it: a reject logs + alerts, can neither roll the flip back nor
  // wedge the observer cursor. Swallowing the failure here would hide it.
  const tx = mkTx({ freeCommentCount: 0, freeCommentResetAt: null })
  tx.user.update = jest.fn(async () => { throw new Error('db blip') })
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1 }, userId: 5 })).rejects.toThrow('db blip')
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

test('consumeQuotaForFlippedItem surfaces a DB failure at the flip to its caller (never a silent swallow)', async () => {
  const tx = {
    user: { findUnique: async () => { throw new Error('db gone') }, update: jest.fn() },
    platformFeeConfig: { findUnique: async () => { throw new Error('db gone') } },
    $queryRaw: jest.fn(async () => { throw new Error('db gone') })
  }
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null, id: 9 }, userId: 5 })).rejects.toThrow('db gone')
})

test('consumeQuotaForFlippedItem never rejects a post flip: a missing banked POST credit is a no-op (POST semantics intact)', async () => {
  const user = { freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null }
  const tx = mkTx(user, { credits: [] })
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null, id: 9 }, userId: 5 })).resolves.toBeUndefined()
  expect(tx.user.update).not.toHaveBeenCalled()
})

test('consumeQuotaForFlippedItem consumes a banked reward when the post base quota is exhausted at the flip', async () => {
  const tx = mkTx({ freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000), streak: null })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: null, id: 9 }, userId: 5 })
  expect(tx.user.update).not.toHaveBeenCalled()
  expect(streakRewardSql(tx)).toHaveLength(1)
})

// --- finding 6: serialized, base-first, fail-closed flip consumption ---

test('consumeQuotaForFlippedItem locks the user row BEFORE reading quota state (no stale pre-lock snapshot)', async () => {
  const calls = []
  const user = { freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null }
  const tx = {
    user: {
      findUnique: async () => { calls.push('user.findUnique'); return user },
      update: jest.fn(async () => { calls.push('user.update'); return {} })
    },
    platformFeeConfig: { findUnique: async () => null },
    $queryRaw: jest.fn(async (strings) => {
      const sql = String(strings.join(''))
      if (sql.includes('FROM users')) { calls.push('lock-user'); return [{ id: 5 }] }
      if (sql.includes('StreakReward')) { calls.push('consume-reward'); return [{ id: 11 }] }
      return []
    })
  }
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1, id: 99 }, userId: 5 })
  expect(calls[0]).toBe('lock-user')
  expect(calls).toContain('consume-reward')
})

test('consumeQuotaForFlippedItem spends a fresh weekly base before any banked REPLY credit', async () => {
  // a stale window resets to a fresh one; the held credit must survive
  const user = { freeCommentCount: 3, freeCommentResetAt: new Date(Date.now() - 60_000), stackedPiconeros: 0n, createdAt: new Date(), streak: null }
  const tx = mkTx(user, { credits: [{ id: 11 }] })
  await consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1, id: 99 }, userId: 5 })
  expect(streakRewardSql(tx)).toHaveLength(0)
  expect(tx.user.update).toHaveBeenCalledWith({
    where: { id: 5, freeCommentResetAt: user.freeCommentResetAt },
    data: { freeCommentCount: 1, freeCommentResetAt: expect.any(Date) }
  })
})

test('consumeQuotaForFlippedItem rejects when the base is exhausted and no valid REPLY credit remains', async () => {
  // e.g. the credit expired while the upload fee was in flight. The caller
  // surfaces this (log + alert); the already-paid item still goes live.
  const tx = mkTx({ freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000) }, { credits: [] })
  await expect(consumeQuotaForFlippedItem(tx, { item: { feeQuotaEligible: true, parentId: 1, id: 7 }, userId: 5 })).rejects.toThrow('no free comments left')
  expect(tx.user.update).not.toHaveBeenCalled()
})
