/* eslint-env jest */
import userResolvers from '@/api/resolvers/user'

jest.mock('../../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

const { Query: { hasNewNotes } } = userResolvers

// A models stub for the hasNewNotes source checks: every EXISTS query returns
// not-exists unless the SQL targets the given table.
function mkModels ({ tripTable } = {}) {
  const hit = (sql) => tripTable && String(sql).includes(tripTable)
  return {
    $queryRaw: async (strings, ...params) => [{ exists: hit(strings.join('')) }],
    $queryRawUnsafe: async (sql, ...params) => [{ exists: hit(sql) }],
    earn: { findFirst: async () => null },
    user: { findFirst: async () => null },
    streak: { findFirst: async () => null },
    sub: { findFirst: async () => null },
    reminder: { findFirst: async () => null }
  }
}

const LAST_CHECKED = new Date('2026-09-26T07:50:16.000Z')

function mkCtx ({ tripTable } = {}) {
  return {
    me: { id: 616 },
    models: mkModels({ tripTable }),
    userLoader: {
      load: async () => ({
        id: 616,
        checkedNotesAt: LAST_CHECKED,
        foundNotesAt: null,
        noteItemPiconeros: null,
        noteBadges: true
      })
    }
  }
}

test('a quest completion since lastChecked trips the bell', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({ tripTable: 'QuestCompletion' }))).resolves.toBe(true)
})

test('no new sources leaves the bell quiet', async () => {
  await expect(hasNewNotes(null, {}, mkCtx({}))).resolves.toBe(false)
})
