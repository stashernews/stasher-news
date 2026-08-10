/* eslint-env jest */

// Unit tests for the lws tx-confirmation webhook receiver (spec §4.4).
//
// The receiver is a Next.js API route whose core logic is exported as
// `handleWebhook(req, res, models, monero)` so it can be tested with mocked
// prisma + lwsClient (the two network/DI seams), without touching the DB or
// the network. The real applyTipDetected runs against a fake transaction
// client that provides $executeRaw (the only method it calls when a tx is
// passed), so the ranking side-effect path is exercised end-to-end.

import { handleWebhook } from '@/pages/api/monero/webhook'

function mockModels (overrides = {}) {
  const txUpdate = overrides.txUpdate || jest.fn().mockResolvedValue({})
  const userUpdate = overrides.userUpdate || jest.fn().mockResolvedValue({})
  const execRaw = overrides.execRaw || jest.fn().mockResolvedValue(1)
  // applyTipDetected reads the tipped item's parentId (to pick zapPostTrust vs
  // zapCommentTrust) via a $queryRaw on the tx; default to no rows so isComment
  // resolves false (a post) in these unit tests.
  const queryRaw = overrides.queryRaw || jest.fn().mockResolvedValue([])
  return {
    observedTip: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.observedTip
    },
    // Bounty branch models (A-13): default to "no matching bounty payment id"
    // so tip-only tests exercise the fall-through as a 200 no-op. The pid-map
    // lookup is findFirst with the live-guard (consumedAt: null, expiresAt in
    // the future) — stale/consumed pids are unconsumable.
    bountyPidMap: {
      findFirst: jest.fn().mockResolvedValue(null),
      ...overrides.bountyPidMap
    },
    observedBounty: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.observedBounty
    },
    $transaction: jest.fn(async (fn) => fn({
      observedTip: { update: txUpdate },
      user: { update: userUpdate },
      observedBounty: { update: overrides.txBountyUpdate || jest.fn().mockResolvedValue({}) },
      bountyPidMap: { update: overrides.txPidMapUpdate || jest.fn().mockResolvedValue({}) },
      item: { update: overrides.txItemUpdate || jest.fn().mockResolvedValue({}) },
      platformFeeConfig: { findUnique: overrides.txConfigFind || jest.fn().mockResolvedValue({ bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }) },
      $executeRaw: execRaw,
      $queryRaw: queryRaw
    }))
  }
}

function mockMonero (overrides = {}) {
  return {
    deleteWebhook: jest.fn().mockResolvedValue({}),
    ...overrides
  }
}

function mockRes () {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis()
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.LWS_WEBHOOK_TOKEN
})

test('returns 200 for an unknown payment ID (not our tip)', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown123', event: 'tx-confirmation', confirmations: 0 } }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { paymentId: 'unknown123' } }))
  expect(models.$transaction).not.toHaveBeenCalled()
})

test('returns 200 when payment_id is missing', async () => {
  const res = mockRes()
  await handleWebhook({ body: { event: 'tx-confirmation', confirmations: 0 } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('flips PENDING -> DETECTED at 0 confirmations and runs the ranking delta', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 } }
  const txUpdate = jest.fn().mockResolvedValue({ ...tip, state: 'DETECTED' })
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The PENDING branch now uses an atomic conditional UPDATE via $executeRaw,
  // NOT tx.observedTip.update (the claim mirrors reconcilePendingTips).
  expect(txUpdate).not.toHaveBeenCalled()
  // The conditional claim ran ($executeRaw); applyTipDetected then runs inside
  // the same transaction and also calls $executeRaw on the tx, so execRaw is
  // invoked one or more times (>= 1 = at least the claim).
  expect(execRaw.mock.calls.length).toBeGreaterThanOrEqual(1)
})

test('does NOT apply ranking delta when the conditional claim loses (race with reconcile sweep)', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 } }
  const txUpdate = jest.fn().mockResolvedValue({})
  // The sweep already flipped the row DETECTED, so the conditional UPDATE
  // matches 0 rows -> the webhook loses the claim and must NOT apply the delta.
  const execRaw = jest.fn().mockResolvedValue(0)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // Exactly one $executeRaw call: the claim. applyTipDetected never ran
  // (claimed === 0), so there is no second apply call -> no double-count.
  expect(execRaw).toHaveBeenCalledTimes(1)
  expect(txUpdate).not.toHaveBeenCalled()
})

test('flips DETECTED -> CONFIRMED at REQUIRED_CONFIRMATIONS, bumps stackedPiconeros, deletes webhook', async () => {
  const tip = { id: 1, postId: 10, state: 'DETECTED', paymentId: 'abc123', piconeros: 1000000000n, height: 2172600, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { label: 'author' } }
  const txUpdate = jest.fn().mockResolvedValue({})
  const userUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'CONFIRMED' }) }))
  expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 99 },
    data: { stackedPiconeros: { increment: 1000000000n } }
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
})

test('does NOT bump author stackedPiconeros when the recipient is the rewards wallet (wallet-less tip)', async () => {
  const tip = {
    id: 1,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'abc123',
    piconeros: 1000000000n,
    height: 2172600,
    webhookEventId: 'evt-1',
    post: { userId: 99 },
    recipientAccount: { label: 'platform_rewards' }
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const txUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // the tip row still flips to CONFIRMED ...
  expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'CONFIRMED' }) }))
  // ... but the author stackedPiconeros bump is SKIPPED (nobody was paid)
  expect(userUpdate).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
})

test('updates confirmations count for intermediate DETECTED callbacks (< REQUIRED_CONFIRMATIONS)', async () => {
  const tip = { id: 1, postId: 10, state: 'DETECTED', paymentId: 'abc123', piconeros: 1000000000n, height: 2172600, webhookEventId: 'evt-1', post: { userId: 99 } }
  const models = mockModels({
    observedTip: {
      findFirst: jest.fn().mockResolvedValue(tip),
      update: jest.fn().mockResolvedValue({})
    }
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 5, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.update).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 1 },
    data: expect.objectContaining({ confirmations: 5, height: 2172600, txHash: 'deadbeef' })
  }))
})

test('is idempotent — a callback when already CONFIRMED is a no-op', async () => {
  const tip = { id: 1, postId: 10, state: 'CONFIRMED', paymentId: 'abc123', piconeros: 1000000000n, post: { userId: 99 } }
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip), update: jest.fn() }
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.update).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
})

test('rejects requests with a wrong webhook token when LWS_WEBHOOK_TOKEN is set', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'abc' }, headers: { 'x-lws-token': 'wrong' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(401)
})

test('accepts requests with the correct webhook token', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown' }, headers: { 'x-lws-token': 'test-secret' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('skips token check when LWS_WEBHOOK_TOKEN is not set (dev default)', async () => {
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('enqueues a checkStreak job for the recipient when a PENDING tip is claimed', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, tipperId: 5, webhookEventId: 'evt-1', post: { userId: 999 }, recipientAccount: { ownerUserId: 99 } }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('checkStreak'))).toBe(true)
  expect(sqls.some(sql => sql.includes('jsonb_build_object'))).toBe(true)
  // The checkStreak job must target the wallet OWNER (99), not the tipper (5)
  // or the post author (999): the bound id is in $executeRaw's value args
  // (jsonb_build_object('id', 99, 'type', 'FLAME')).
  const streakCall = execRaw.mock.calls.find(call => sqlOf(call).includes('checkStreak'))
  expect(streakCall).toBeDefined()
  const boundValues = [...streakCall].slice(1).flat()
  expect(boundValues).toContain(99)
  expect(boundValues).not.toContain(5)
  expect(boundValues).not.toContain(999)
})

test('does NOT enqueue checkStreak when the recipient has no wallet owner', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, tipperId: 5, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { ownerUserId: null } }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqls = execRaw.mock.calls.map(call => Array.isArray(call[0]) ? call[0].join('') : call[0].text)
  expect(sqls.some(sql => sql.includes('checkStreak'))).toBe(false)
})

test('enqueues a checkStreak job for the recipient but no COIN streak for an anonymous tip to an owned wallet', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, tipperId: null, webhookEventId: 'evt-1', post: { userId: 999 }, recipientAccount: { ownerUserId: 99 } }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    queryRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  // The FLAME checkStreak job still targets the wallet owner (99) for anon tips.
  const streakCall = execRaw.mock.calls.find(call => sqlOf(call).includes('checkStreak'))
  expect(streakCall).toBeDefined()
  expect([...streakCall].slice(1).flat()).toContain(99)
  // The COIN grant is tipper-only (`if (tip.tipperId != null)`): an anon tipper
  // must NOT mint a COIN streak. The grant is a $queryRaw INSERT whose SQL text
  // contains 'COIN'::"StreakType", so check those captured calls too.
  const allSql = [...execRaw.mock.calls, ...queryRaw.mock.calls].map(sqlOf)
  expect(allSql.some(sql => sql.includes('COIN'))).toBe(false)
})

test('bounty branch: claims a PENDING ObservedBounty via the conditional UPDATE and consumes its BountyPidMap', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The claim is the atomic conditional UPDATE (mirrors the tip branch).
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "ObservedBounty"') && sql.includes("state = 'PENDING'"))).toBe(true)
  // The pid map is consumed only when the claim won.
  expect(txPidMapUpdate).toHaveBeenCalledWith({
    where: { paymentId: 'bn123' },
    data: expect.objectContaining({ consumedAt: expect.any(Date) })
  })
  // No ranking delta / streak side effects ran for a bounty.
  expect(sqls.some(sql => sql.includes('checkStreak'))).toBe(false)
})

test('bounty branch: a DETECTED bounty at REQUIRED_CONFIRMATIONS runs the funding side effects and deletes the webhook', async () => {
  const bounty = { id: 7, postId: 5, state: 'DETECTED', paymentId: 'bn123', txHash: 'deadbeef', webhookEventId: 'evt-b' }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'beefbeef', block: 2172610, amount: 11000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // ObservedBounty -> CONFIRMED with the callback's height/confirmations.
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 7 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10, height: 2172610 })
  }))
  // Item -> FUNDED with the observed amount NET of the platform fee (11e9
  // observed − 10e9 floor fee = 1e9), so dispositions can zero the escrow.
  expect(txItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 5 },
    data: expect.objectContaining({ bountyStatus: 'FUNDED', bountyPiconeros: 1000000000n, bountyConfirmedAt: expect.any(Date) })
  }))
  // BOUNTY_FEE ledger row booked born-CONFIRMED inside the same transaction.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = queryRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('BOUNTY_FEE') && sql.includes('CONFIRMED'))).toBe(true)
  // The lws webhook is torn down after the transaction commits.
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-b')
})

test('bounty branch: does NOT consume the BountyPidMap when the conditional claim loses (race with another claimer)', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', txHash: 'pending-bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(0)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate,
    txBountyUpdate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "ObservedBounty"') && sql.includes("state = 'PENDING'"))).toBe(true)
  // A lost claim means the pid map is NOT consumed and no CONFIRMED side
  // effects run (the row stays PENDING; the winner owns the transitions).
  expect(txPidMapUpdate).not.toHaveBeenCalled()
  expect(txBountyUpdate).not.toHaveBeenCalled()
})

test('bounty branch: an EXPIRED BountyPidMap is unconsumable — a late callback is a 200 no-op', async () => {
  // A stale PENDING ObservedBounty still exists for this payment id (the
  // author re-minted a fresh address after the 24h pid-map expiry), but the
  // live-guarded pid-map lookup matches nothing, so the branch must bail
  // before it can claim/consume anything.
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', txHash: 'pending-bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The lookup carried the live-guard (consumedAt null + expiresAt in future).
  expect(models.bountyPidMap.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ paymentId: 'bn123', consumedAt: null, expiresAt: expect.any(Object) })
  }))
  // No state change: no claim, no pid-map consumption, no transaction at all.
  expect(execRaw).not.toHaveBeenCalled()
  expect(models.$transaction).not.toHaveBeenCalled()
})
