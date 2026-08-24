/* eslint-env jest */

// Resolver-level tests for the bounty-award notification surface (A-13 escrow
// flow): the BountyPayment notification-union branch surfaces AWARD payouts to
// the winner once the payout tx has actually gone out (SENT/CONFIRMED).
// Mocked $queryRawUnsafe — no live DB (harness pattern:
// test/api/monero/topSubsRevenue.test.js).

import notifications from '@/api/resolvers/notifications'
import userResolvers from '@/api/resolvers/user'

// api/resolvers/notifications.js transitively imports ESM-only lexical +
// payIn deps. Mirror the mocks in test/api/monero/topSubsRevenue.test.js.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const meFull = {
  id: 8323,
  noteEarning: true,
  noteMentions: false,
  noteItemMentions: false,
  noteItemPiconeros: false,
  noteInvites: false,
  noteBadges: false,
  noteAllDescendants: false,
  checkedNotesAt: null
}

function captureNotificationsModels (rows) {
  return {
    $queryRawUnsafe: jest.fn(async () => rows),
    user: { update: jest.fn(async () => ({})) }
  }
}

describe('BOUNTY award notifications branch', () => {
  test('awarded users get a BountyPayment union branch over escrow payouts', async () => {
    const models = captureNotificationsModels(
      [{ id: '1638', sortTime: new Date(), earnedPiconeros: 10000000000n, type: 'BountyPayment', minSortTime: new Date() }])

    const res = await notifications.Query.notifications(
      null, {}, { me: { id: 8323 }, models, userLoader: { load: async () => meFull } })

    const sql = models.$queryRawUnsafe.mock.calls[0][0]
    expect(sql).toContain('FROM "BountyPayment"')
    expect(sql).toContain('"BountyPayment"."winnerUserId" = $1')
    expect(sql).toContain("kind = 'AWARD'")
    expect(sql).toContain("state IN ('SENT', 'CONFIRMED')")
    expect(sql).toContain("'BountyPayment' AS type")
    expect(sql).toContain('"BountyPayment".piconeros AS "earnedPiconeros"')
    expect(sql).toContain('COALESCE("BountyPayment"."confirmedAt", "BountyPayment"."sentAt")')
    expect(res.notifications[0].type).toBe('BountyPayment')
    expect(res.notifications[0].earnedPiconeros).toBe(10000000000n)
  })

  test('the branch is omitted when noteEarning is off', async () => {
    const models = captureNotificationsModels([])

    await notifications.Query.notifications(
      null, {}, { me: { id: 8323 }, models, userLoader: { load: async () => ({ ...meFull, noteEarning: false }) } })

    const sql = models.$queryRawUnsafe.mock.calls[0][0]
    expect(sql).not.toContain('FROM "BountyPayment"')
    expect(sql).not.toContain("'BountyPayment' AS type")
  })

  test('BountyPayment.item resolves from the escrow payout row', async () => {
    const models = {
      bountyPayment: {
        findUnique: jest.fn(async () => ({ itemId: 24551 }))
      },
      $queryRawUnsafe: jest.fn(async () => [{ id: 24551, userId: 860 }])
    }

    const item = await notifications.BountyPayment.item({ id: '1638' }, {}, { models, me: { id: 8323 } })

    expect(models.bountyPayment.findUnique).toHaveBeenCalledWith({ where: { id: 1638 } })
    expect(item.id).toBe(24551)
  })
})

describe('hasNewNotes bounty-award EXISTS', () => {
  // hasNewNotes runs its EXISTS checks in order: bulletin, thread-sub reply,
  // user subs, sub posts, then (noteEarning) Earn.findFirst, then the new
  // BountyPayment EXISTS. The 5th $queryRawUnsafe call is the bounty check.
  function hasNewNotesModels (existsSequence) {
    const calls = existsSequence.map(exists => [{ exists }])
    return {
      $queryRawUnsafe: jest.fn(async () => calls.shift() ?? [{ exists: false }]),
      $queryRaw: jest.fn(async () => [{ exists: false }]),
      earn: { findFirst: jest.fn(async () => null) },
      sub: { findFirst: jest.fn(async () => null) },
      reminder: { findFirst: jest.fn(async () => null) }
    }
  }

  test('true when a SENT/CONFIRMED AWARD payout landed after checkedNotesAt', async () => {
    const models = hasNewNotesModels([false, false, false, false, true])

    const result = await userResolvers.Query.hasNewNotes(
      null, {}, {
        me: { id: 8323 },
        models,
        userLoader: { load: async () => ({ ...meFull, checkedNotesAt: new Date('2026-08-24T00:00:00Z') }) }
      })

    expect(result).toBe(true)
    const bountyCall = models.$queryRawUnsafe.mock.calls
      .find(call => call[0].includes('FROM "BountyPayment"'))
    expect(bountyCall).toBeTruthy()
    expect(bountyCall[0]).toContain('"BountyPayment"."winnerUserId" = $1')
    expect(bountyCall[0]).toContain("state IN ('SENT', 'CONFIRMED')")
  })

  test('false when no bounty payout exists', async () => {
    const models = hasNewNotesModels([])

    const result = await userResolvers.Query.hasNewNotes(
      null, {}, {
        me: { id: 8323 },
        models,
        userLoader: { load: async () => ({ ...meFull, checkedNotesAt: new Date('2026-08-24T00:00:00Z') }) }
      })

    expect(result).toBe(false)
  })
})
