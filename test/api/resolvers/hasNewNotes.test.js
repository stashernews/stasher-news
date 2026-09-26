/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

const { Query: { hasNewNotes } } = userResolvers

// A models stub for the hasNewNotes source checks: every EXISTS query returns
// not-exists unless the SQL targets the given table.
function mkModels ({ tripTable, streakRow } = {}) {
  const hit = (sql) => tripTable && String(sql).includes(tripTable)
  return {
    $queryRaw: async (strings, ...params) => [{ exists: hit(strings.join('')) }],
    $queryRawUnsafe: async (sql, ...params) => [{ exists: hit(sql) }],
    earn: { findFirst: async () => null },
    user: { findFirst: async () => null },
    streak: { findFirst: async ({ where } = {}) => (streakRow && streakWhereMatches(streakRow, where) ? streakRow : null) },
    sub: { findFirst: async () => null },
    reminder: { findFirst: async () => null }
  }
}

// Minimal Prisma-where matcher for the streak findFirst the bell issues:
// supports userId, updatedAt.gt, type, endedAt (null / { not: null }), and OR.
// Doubles as the spec of the predicate the resolver must send.
function streakWhereMatches (row, where = {}) {
  if (where.userId !== undefined && where.userId !== row.userId) return false
  if (where.updatedAt?.gt !== undefined && !(row.updatedAt > where.updatedAt.gt)) return false
  if (where.type !== undefined && where.type !== row.type) return false
  if (where.endedAt === null && row.endedAt != null) return false
  if (where.endedAt?.not === null && row.endedAt == null) return false
  if (Array.isArray(where.OR)) return where.OR.some(sub => streakWhereMatches(row, sub))
  return true
}

const LAST_CHECKED = new Date('2026-09-26T07:50:16.000Z')

function mkCtx ({ tripTable, noteQuests = true, streakRow } = {}) {
  return {
    me: { id: 616 },
    models: mkModels({ tripTable, streakRow }),
    userLoader: {
      load: async () => ({
        id: 616,
        checkedNotesAt: LAST_CHECKED,
        foundNotesAt: null,
        noteItemPiconeros: null,
        noteBadges: true,
        noteQuests
      })
    }
  }
}

test('a quest completion since lastChecked trips the bell', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ tripTable: 'QuestCompletion' }))).resolves.toBe(true)
})

// M5 (2026-09-26 review): the bell must respect the same noteQuests setting
// the notifications dropdown gates on — otherwise it rings for entries the
// dropdown then hides.
test('a quest completion is silent when noteQuests is off', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ tripTable: 'QuestCompletion', noteQuests: false }))).resolves.toBe(false)
})

test('no new sources leaves the bell quiet', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({}))).resolves.toBe(false)
})

// M5 residual (2026-09-26 review): the noteBadges bell branch must mirror the
// notifications list's badge surface (api/resolvers/notifications.js) — ended
// flames and verified badges only. An ACTIVE flame's updatedAt bumps on every
// day-clear advance, but the advance chronicle is noteQuests-gated, so
// matching those rows rings the bell for entries the dropdown then hides.
const RECENT = new Date(LAST_CHECKED.getTime() + 60_000)
const ACTIVE_FLAME = { userId: 616, type: 'FLAME', endedAt: null, updatedAt: RECENT }
const ENDED_FLAME = { userId: 616, type: 'FLAME', endedAt: RECENT, updatedAt: RECENT }
const VERIFIED_BADGE = { userId: 616, type: 'VERIFIED', endedAt: null, updatedAt: RECENT }

test('an active flame advancing does not trip the badge bell', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ streakRow: ACTIVE_FLAME }))).resolves.toBe(false)
})

test('a flame ending trips the badge bell', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ streakRow: ENDED_FLAME }))).resolves.toBe(true)
})

test('a verified badge update trips the badge bell', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ streakRow: VERIFIED_BADGE }))).resolves.toBe(true)
})
