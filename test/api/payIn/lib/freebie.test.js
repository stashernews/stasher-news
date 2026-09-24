/* eslint-env jest */
import { incrementFreeCommentCount, incrementFreePostCount, getNextDayStart, consumeQuotaForFlippedItem } from '@/api/payIn/lib/freebie'

// A mock tx whose user.update is a jest.fn; config always resolves so the helpers
// proceed to the quota/branch logic. We assert which calls reach `update`.
function mkTx (user) {
  return {
    user: {
      findUnique: async () => user,
      update: jest.fn(async () => ({}))
    },
    platformFeeConfig: { findUnique: async () => ({ freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7 }) }
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

test('incrementFreeCommentCount increments within the established daily quota', async () => {
  const tx = mkTx({ freeCommentCount: 1, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreeCommentCount(tx, { item: { freebie: true, parentId: 1 }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freeCommentCount: { lt: 3 } }) }))
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

test('incrementFreePostCount increments for an established free post within quota', async () => {
  const tx = mkTx({ freePostCount: 2, freePostResetAt: new Date(Date.now() + 30 * 86_400_000), stackedPiconeros: 10_000_000_000n, createdAt: new Date(Date.now() - 8 * 86_400_000) })
  await incrementFreePostCount(tx, { item: { freebie: false, parentId: null, feeStatus: 'FEE_NOT_REQUIRED' }, userId: 5 })
  expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 5, freePostCount: { lt: 5 } }) }))
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

test('consumeQuotaForFlippedItem force-increments the post counter for a top-level item', async () => {
  const tx = mkTx({ freePostCount: 5, freePostResetAt: new Date(Date.now() + 30 * 86_400_000) })
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
    const tx = mkTx({ freePostCount: 5, freePostResetAt: stale })
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
