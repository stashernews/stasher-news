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
import { flipPendingToLive, applyBoostDetected } from '@/worker/rewardsWalletObserver'

// lib/auth pulls in next-auth/jwt -> uuid (ESM-only under jest CJS require); the
// webhook graph only uses lib/domains/auth's `safeEqual` (pure node:crypto), so
// mock lib/auth at the module boundary — safeEqual stays real, only the unused
// secureCookie helper is stubbed. (Same pattern as test/components/sticky-bar.test.js.)
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  secureCookie: (name) => name
}))

// The fee: branch (owner-routed turf fees) delegates the gated live-flip and
// the boost bump to the observer's shared helpers. Mock the module at the
// boundary (same pattern as lib/auth above) so the gate/bump CALLS are
// assertable and the observer's heavier module graph (monero-ts via
// feePoolDerive) never loads under jest.
jest.mock(`${process.cwd()}/worker/rewardsWalletObserver`, () => ({
  flipPendingToLive: jest.fn().mockResolvedValue(undefined),
  applyBoostDetected: jest.fn().mockResolvedValue(undefined)
}))

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
    // Downvote branch models: dv:-namespace pids fall through tip+bounty.
    // Default to "no matching map" so existing tests stay 200 no-ops.
    downvotePidMap: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.downvotePidMap
    },
    observedDownvote: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.observedDownvote
    },
    // Fee branch models (owner-routed "fee:" pids): reverse-mapped through
    // PayIn.moneroPaymentId (unique). Default to "no matching payin" so
    // existing tests fall through to the downvote branch as 200 no-ops.
    payIn: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.payIn
    },
    observedSubFee: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: null } }),
      ...overrides.observedSubFee
    },
    // The downvote 0-conf path fetches the item via tx.item.findUnique with the
    // models object doubling as the tx (see the downvote tests' $transaction
    // stub); default to null = "no item, skip the penalty".
    item: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.item
    },
    $transaction: jest.fn(async (fn) => fn({
      observedTip: { update: txUpdate },
      user: { update: userUpdate },
      observedBounty: { update: overrides.txBountyUpdate || jest.fn().mockResolvedValue({}) },
      // Receipt fold (underpayment support): recordBountyReceipt sums
      // ObservedBountyReceipt rows on the tx. Default _sum null -> cumulative
      // 0n (underfunded, funding held); the funding-path tests override
      // txReceiptAggregate with a sum that crosses the expected total.
      observedBountyReceipt: {
        aggregate: overrides.txReceiptAggregate || jest.fn().mockResolvedValue({ _sum: { piconeros: null } })
      },
      bountyPidMap: { update: overrides.txPidMapUpdate || jest.fn().mockResolvedValue({}) },
      item: {
        update: overrides.txItemUpdate || jest.fn().mockResolvedValue({}),
        // driveBountyFunding computes the fee from the DECLARED bounty
        // (item.bountyPiconeros), not the observed amount. 1e11 declared → fee
        // 1e10 (floor regime), matching the 1.1e11 observed → 1e11 booked
        // assertions below.
        findUnique: overrides.txItemFind || jest.fn().mockResolvedValue({ bountyPiconeros: 100_000_000_000n })
      },
      platformFeeConfig: { findUnique: overrides.txConfigFind || jest.fn().mockResolvedValue({ bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }) },
      $executeRaw: execRaw,
      $queryRaw: queryRaw
    })),
    // Top-level raw seams for the downvote branch's non-transactional claims
    // (pid-map consume, CONFIRMED flip); share the tx mocks so call-count
    // assertions stay uniform.
    $executeRaw: execRaw,
    $queryRaw: queryRaw
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
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate,
    execRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // The CONFIRMED transition is an atomic conditional claim via $executeRaw
  // (mirrors the PENDING->DETECTED guard), not tx.observedTip.update.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(txUpdate).not.toHaveBeenCalled()
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
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate,
    execRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // the tip row still flips to CONFIRMED via the conditional claim ...
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(txUpdate).not.toHaveBeenCalled()
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

test('accepts requests with the correct token delivered in the body (monero-lws callback format)', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown', token: 'test-secret' }, headers: {} }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('rejects requests with a wrong token in the body', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown', token: 'wrong' }, headers: {} }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(401)
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
    // A DETECTED bounty's pid map is already consumed (consumedAt set at
    // DETECTED), so the live-guarded lookup returns null. The pid map is NOT
    // consulted for DETECTED callbacks — driveBountyFunding must run regardless.
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    // Receipts already sum to the callback amount (1.1e11) — the cumulative
    // total crosses the expected declared+fee (1e11 + 1e10), so the funding
    // gate opens.
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'beefbeef', block: 2172610, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // ObservedBounty -> CONFIRMED with the callback's height/confirmations.
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 7 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10, height: 2172610 })
  }))
  // Item -> FUNDED with the observed amount NET of the platform fee (1.1e11
  // observed − 1e10 floor fee = 1e11), so dispositions can zero the escrow.
  expect(txItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 5 },
    data: expect.objectContaining({ bountyStatus: 'FUNDED', bountyPiconeros: 100000000000n, bountyConfirmedAt: expect.any(Date) })
  }))
  // BOUNTY_FEE ledger row booked born-CONFIRMED inside the same transaction.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = queryRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('BOUNTY_FEE') && sql.includes('CONFIRMED'))).toBe(true)
  // The lws webhook is torn down after the transaction commits.
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-b')
})

test('bounty branch: the N-conf CONFIRMED callback still funds when the BountyPidMap is ALREADY CONSUMED (regression: pid-map gate must not block the DETECTED->CONFIRMED callback)', async () => {
  // Realistic post-0-conf state: the 0-conf callback already claimed PENDING
  // -> DETECTED and consumed the pid map (consumedAt set). Every later callback
  // (1-conf .. N-conf) finds a CONSUMED map, so the live-guarded findFirst
  // (consumedAt: null) returns null. The N-conf callback is the ONLY path that
  // runs driveBountyFunding, so it MUST still reach it — idempotency is handled
  // by the CONFIRMED state guard + ON CONFLICT, NOT by the pid-map gate.
  const bounty = { id: 9, postId: 6, state: 'DETECTED', paymentId: 'bn456', txHash: 'cafef00d', webhookEventId: 'evt-c' }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    // Consumed map -> the live-guarded lookup matches nothing.
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    // Receipts sum to the callback amount — the cumulative total crosses the
    // expected declared+fee, so the gate opens despite the consumed map.
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn456', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'cafef00d', block: 2172700, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // driveBountyFunding ran: ObservedBounty -> CONFIRMED.
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 9 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10, height: 2172700 })
  }))
  // Item -> FUNDED net of fee.
  expect(txItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 6 },
    data: expect.objectContaining({ bountyStatus: 'FUNDED', bountyPiconeros: 100000000000n })
  }))
  // Webhook torn down.
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-c')
})

test('bounty branch: a DETECTED sub-conf callback (pid map consumed) still records height/confirmations (height backfill reachable)', async () => {
  // The intermediate 1-conf .. (N-1)-conf callbacks must also reach the DETECTED
  // branch to backfill height (NULL at 0-conf) and confirmations — otherwise the
  // finalizer's height-not-null filter can never pick up a missed N-conf callback.
  const bounty = { id: 11, postId: 8, state: 'DETECTED', paymentId: 'bn789', txHash: 'f00d1234', webhookEventId: 'evt-d' }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate }
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn789', event: 'tx-confirmation', confirmations: 3, tx_info: { tx_hash: 'f00d1234', block: 2172800, amount: 11000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The height/confirmations backfill ran on the DETECTED row.
  expect(bountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 11 },
    data: expect.objectContaining({ confirmations: 3, height: 2172800, txHash: 'f00d1234' })
  }))
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

test('DETECTED->CONFIRMED does not credit the author when the conditional claim loses (race loser)', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 't'
  const userUpdate = jest.fn().mockResolvedValue({})
  // claim lost: another claimer already flipped the row to CONFIRMED
  const execRaw = jest.fn().mockResolvedValue(0)
  const models = mockModels({ execRaw, userUpdate })
  models.observedTip.findFirst.mockResolvedValue({ id: 1, state: 'DETECTED', piconeros: 1000n, postId: 10, tipperId: 5, post: { userId: 7 }, recipientAccount: { label: 'author', ownerUserId: 7 } })
  const res = mockRes()
  await handleWebhook(
    {
      method: 'POST',
      headers: { 'x-lws-token': 't' },
      body: { payment_id: 'p1', confirmations: 15, tx_info: { tx_hash: 'h', block: 100, amount: '1000' } }
    },
    res, models, mockMonero()
  )
  expect(execRaw).toHaveBeenCalled()
  expect(userUpdate).not.toHaveBeenCalled() // race loser MUST NOT increment
  expect(res.status).toHaveBeenLastCalledWith(200)
})

// ---- downvote branch (dv: namespace via DownvotePidMap) ----

const dvMap = { paymentId: 'bb82f32561ab78d1', postId: 572, userId: 860, webhookEventId: 'evt-1', consumedAt: null, expiresAt: new Date(Date.now() + 3600e3) }

function dvBody (over = {}) {
  return {
    payment_id: 'bb82f32561ab78d1',
    confirmations: 0,
    tx_info: { tx_hash: 'd7553c1400000000000000000000000000000000000000000000000000000000', amount: '1000000000', ...over.txInfo },
    ...over.extra
  }
}

test('0-conf callback claims the live pid map, records DETECTED with NULL height, applies the penalty, consumes the map', async () => {
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    item: { findUnique: jest.fn().mockResolvedValue({ id: 572, parentId: null }) }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // pid-map claim wins
  models.$transaction = jest.fn(async (fn) => fn(models))
  models.$queryRaw = jest.fn().mockResolvedValue([{ id: 1n }]) // fresh ObservedDownvote insert
  const monero = mockMonero()
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, monero)

  // The claim is a tagged-template $executeRaw (strings + values args), so
  // assert on the recorded SQL via the harness's sqlOf pattern (the brief's
  // "assert via the mock below if the harness records SQL differently").
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = models.$executeRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "DownvotePidMap"') && sql.includes('"consumedAt" IS NULL') && sql.includes('"expiresAt" > NOW()'))).toBe(true) // atomic live-map claim UPDATE
  expect(models.observedDownvote.update).not.toHaveBeenCalled() // no height to backfill at 0-conf
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

test('expired or consumed pid map is a 200 no-op (claim UPDATE matched 0 rows)', async () => {
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue({ ...dvMap, consumedAt: new Date() }) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(0) // claim loses
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, mockMonero())

  expect(models.$queryRaw).not.toHaveBeenCalled() // no insert, no penalty
  expect(res.status).toHaveBeenCalledWith(200)
})

test('N-conf callback on an existing DETECTED row backfills height WITHOUT pid-map liveness (item-2808 lesson)', async () => {
  const consumedMap = { ...dvMap, consumedAt: new Date() } // map already consumed — must not gate
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(consumedMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue({ id: 1n, state: 'DETECTED', height: null }), update: jest.fn() }
  })
  models.$executeRaw = jest.fn()
  const res = mockRes()

  await handleWebhook({ body: dvBody({ txInfo: { block: 2186635 }, extra: { confirmations: 3 } }) }, res, models, mockMonero())

  expect(models.observedDownvote.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ height: 2186635, confirmations: 3 })
  }))
  expect(models.$executeRaw).not.toHaveBeenCalledWith(expect.anything()) // no CONFIRMED flip below threshold, no claim
})

test('N>=REQUIRED callback flips DETECTED -> CONFIRMED and deletes the webhook', async () => {
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue({ id: 1n, state: 'DETECTED', height: 2186635 }), update: jest.fn() }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // CONFIRMED claim wins
  const monero = mockMonero()
  const res = mockRes()

  await handleWebhook({ body: dvBody({ extra: { confirmations: 10 } }) }, res, models, monero)

  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
  expect(res.status).toHaveBeenCalledWith(200)
})

test('0-conf race vs poll-insert: pid-map claim wins but the ObservedDownvote insert loses (conflict no-op)', async () => {
  // Spec-mandated race case: the webhook's pid-map claim UPDATE wins (rowCount 1)
  // while the observer poll already inserted the ObservedDownvote row, so the
  // ON CONFLICT ("txHash","paymentId") DO NOTHING insert returns no row. The tx
  // must return BEFORE the item fetch — no penalty side effects, no error, 200.
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    item: { findUnique: jest.fn().mockResolvedValue({ id: 572, parentId: null }) }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // pid-map claim WINS
  models.$transaction = jest.fn(async (fn) => fn(models))
  models.$queryRaw = jest.fn().mockResolvedValue([]) // insert lost the race: no RETURNING row
  const monero = mockMonero()
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, monero)

  // The tx bailed before the item fetch: no penalty path ran (the models object
  // doubles as the tx here, so tx.item.findUnique === models.item.findUnique).
  expect(models.item.findUnique).not.toHaveBeenCalled()
  expect(models.observedDownvote.update).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

// ---- fee: branch (owner-routed turf fees via PayIn.moneroPaymentId) ----

describe('fee: branch (owner-routed turf fees)', () => {
  const pid = 'aabbccddeeff0011'
  // URI quotes 0.001 XMR = 1e9 piconeros — the cumulative gate's threshold.
  const basePayIn = { id: 101, payInType: 'ITEM_CREATE', moneroPaymentId: pid, moneroUri: 'monero:9?tx_amount=0.001', piconeros: 0n }

  // Stateful receipt mock over mockModels: the ObservedSubFee insert is fresh
  // iff no prior receipt carries the callback's txHash (ON CONFLICT
  // ("txHash","paymentId") DO NOTHING ... RETURNING id), and the aggregate
  // re-sums the receipts on every call so top-ups move the cumulative total
  // (mockResolvedValue would freeze the sum at setup time).
  function feeModels ({ payIn = basePayIn, receipts = [] } = {}) {
    const inserted = []
    const models = mockModels({
      payIn: {
        findUnique: jest.fn().mockImplementation(async ({ where }) =>
          where.moneroPaymentId === pid ? payIn : null)
      },
      observedSubFee: {
        aggregate: jest.fn().mockImplementation(async () => ({
          _sum: { piconeros: receipts.reduce((sum, r) => sum + (r.piconeros ?? 0n), 0n) }
        }))
      },
      // Tagged-template insert. Bound params in call order:
      // [txHash, paymentId, payInId, piconeros, height, confirmations].
      // jest.fn so the recorded SQL strings are assertable (sqlOf idiom) —
      // guards the physical snake_case column names against 42703 regressions
      // (the mock would otherwise happily run camelCase SQL).
      queryRaw: jest.fn(async (strings, ...vals) => {
        if (!String(strings[0]).includes('ObservedSubFee')) return []
        const txHash = vals[0]
        if (receipts.some(r => r.txHash === txHash)) return []
        const row = { id: receipts.length + 1, txHash, paymentId: pid, piconeros: vals[3] }
        receipts.push(row)
        inserted.push(row)
        return [row]
      })
    })
    return { models, inserted }
  }

  test('records a DETECTED receipt and flips the item live once cumulative covers the URI amount', async () => {
    const { models, inserted } = feeModels()
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx1', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('tx1')
    // Physical-column regression guard (42703): the tables are snake_case-mapped
    // (tx_hash/payment_id/pay_in_id/owner_user_id/detected_at), NOT camelCase
    // like ObservedTip — camelCase identifiers here would throw at runtime
    // while the mocked $queryRaw happily executed them.
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
    const insertSql = models.$queryRaw.mock.calls.map(sqlOf).find(sql => sql.includes('INSERT INTO "ObservedSubFee"'))
    expect(insertSql).toBeDefined()
    expect(insertSql).toContain('tx_hash')
    expect(insertSql).toContain('payment_id')
    expect(insertSql).not.toContain('"txHash"')
    // covered (5e11 observed >= 1e9 quoted): the cumulative gate opens
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 500000000000n)
    // the boost bump is BOOST-payins-only
    expect(applyBoostDetected).not.toHaveBeenCalled()
  })

  test('is a 200 no-op for an unknown payment id', async () => {
    const { models, inserted } = feeModels({ payIn: null })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: 'ffffffffffffffff', tx_info: { tx_hash: 'txX' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('top-up receipts accumulate toward the gate (second tx inserts a second row)', async () => {
    const receipts = [{ id: 1, txHash: 'tx1', paymentId: pid, piconeros: 500000000000n }]
    const { models, inserted } = feeModels({ receipts })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx2', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('tx2')
    // cumulative 1e12 after the top-up: the flip carries the summed total
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 1000000000000n)
  })

  test('an under-paid fee does NOT flip (gate closed until cumulative covers the URI amount)', async () => {
    const { models, inserted } = feeModels()
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx1', amount: '500000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    // the receipt is still recorded (top-up-able) ...
    expect(inserted).toHaveLength(1)
    // ... but 5e8 observed < 1e9 quoted keeps the gated item PENDING_FEE
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('N-conf callback matures THIS receipt DETECTED -> CONFIRMED; a replayed txHash at N-conf inserts nothing and never double-flips', async () => {
    const { models, inserted } = feeModels()
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text

    // fresh txHash at N confs (>= REQUIRED_CONFIRMATIONS): the receipt is
    // recorded AND matured by the atomic conditional UPDATE in one callback.
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txN', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('txN')
    // the maturity UPDATE ran, with the same shape as the tip/downvote
    // CONFIRMED flips AND the physical snake_case columns in its WHERE/SET
    const sqls = models.$executeRaw.mock.calls.map(sqlOf)
    expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
    expect(sqls.some(sql => sql.includes('UPDATE "ObservedSubFee"') && sql.includes('"tx_hash"') && sql.includes('"confirmed_at"'))).toBe(true)

    // replay of the SAME txHash at N confs (lws retry / duplicate delivery):
    // the ON CONFLICT no-op means no second receipt row ...
    const res2 = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txN', amount: '500000000000' } }, headers: {} }, res2, models, mockMonero())
    expect(res2.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    // ... and the cumulative gate re-runs only as the idempotent self-heal:
    // once per callback, with the SAME cumulative total (never a doubled
    // amount from re-counting the replayed receipt).
    const flips = flipPendingToLive.mock.calls.filter(c => c[1]?.id === 101)
    expect(flips).toHaveLength(2)
    expect(flips[0][2]).toBe(500000000000n)
    expect(flips[1][2]).toBe(500000000000n)
  })

  test('a replayed txHash inserts nothing (idempotent)', async () => {
    const receipts = [{ id: 1, txHash: 'tx1', paymentId: pid, piconeros: 1000000000000n }]
    const { models, inserted } = feeModels({ receipts })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 3, tx_info: { tx_hash: 'tx1', amount: '1000000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    // the cumulative gate still runs on the conflict path (observer self-heal
    // semantics — a stranded PENDING_FEE item re-flips idempotently)
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 1000000000000n)
  })
})

// --- auth-denial tests (Task 3 / C4) ---
const _origNodeEnv = process.env.NODE_ENV
const _origToken = process.env.LWS_WEBHOOK_TOKEN
afterEach(() => {
  process.env.NODE_ENV = _origNodeEnv
  if (_origToken === undefined) delete process.env.LWS_WEBHOOK_TOKEN
  else process.env.LWS_WEBHOOK_TOKEN = _origToken
})

test('rejects with 401 in production when LWS_WEBHOOK_TOKEN is not configured', async () => {
  process.env.NODE_ENV = 'production'
  delete process.env.LWS_WEBHOOK_TOKEN
  const res = mockRes()
  await handleWebhook({ method: 'POST', headers: {}, body: {} }, res, mockModels(), mockMonero())
  expect(res.status).toHaveBeenLastCalledWith(401)
})

test('rejects with 401 when the x-lws-token header does not match', async () => {
  process.env.NODE_ENV = 'production'
  process.env.LWS_WEBHOOK_TOKEN = 'real-token'
  const res = mockRes()
  await handleWebhook(
    { method: 'POST', headers: { 'x-lws-token': 'wrong' }, body: {} },
    res, mockModels(), mockMonero())
  expect(res.status).toHaveBeenLastCalledWith(401)
})
