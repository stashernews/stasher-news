/* eslint-env jest */

// Turf repost (2026-09-24): content edits never change turfs — the repost
// action is the only turf-addition path. The guard fires after ownership and
// before any edit prep, so it rejects a turf change on a stale/out-of-window
// edit with the actionable message rather than "can no longer be edited".
import { updateItem } from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy transitive deps (the api/payIn type
// registry pulls the ESM-only mdast mention parser and the lexical server
// HTML generator pulls the ESM-only github-slugger, which jest's CJS sandbox
// cannot require); mirror test/api/resolvers/itemCreateSingleTurf.test.js and
// test/api/resolvers/repostItem.test.js and stub the pieces irrelevant to the
// input-validation guard.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ id: 42, payIn: { id: 1 } }))
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const baseOld = { id: 1, userId: 7, subNames: ['monero'], deletedAt: null, itemPayIns: [] }
const models = (old = baseOld) => ({
  item: { findUnique: async () => old },
  user: { findUnique: async () => ({ id: 7, bioId: null }) }
})

test('rejects a turf change on a content edit', async () => {
  await expect(
    updateItem(null, { id: 1, text: 'x', subNames: ['monero', 'tech'] }, { me: { id: 7 }, models: models() })
  ).rejects.toThrow('repost')
})

test('allows a content edit with an unchanged turf list', async () => {
  await expect(
    updateItem(null, { id: 1, text: 'x', subNames: ['monero'] }, { me: { id: 7 }, models: models() })
  ).resolves.toBeTruthy()
})

test('allows reordering-equivalent turf lists (set comparison)', async () => {
  const old = { ...baseOld, subNames: ['a', 'b'] }
  await expect(
    updateItem(null, { id: 1, text: 'x', subNames: ['b', 'a'] }, { me: { id: 7 }, models: models(old) })
  ).resolves.toBeTruthy()
})
