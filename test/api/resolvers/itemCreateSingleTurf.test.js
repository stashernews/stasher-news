/* eslint-env jest */

// Turf repost (2026-09-24): creation is single-turf. The guard is pure input
// validation and must fire before any DB or payIn work.
import { createItem } from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy transitive deps (the api/payIn type
// registry pulls the ESM-only mdast mention parser, which jest's CJS sandbox
// cannot require); mirror test/api/resolvers/item-auth.test.js and stub the
// pieces irrelevant to the input-validation guard.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

describe('createItem single-turf guard', () => {
  test('rejects a post targeting more than one turf', async () => {
    await expect(
      createItem(null, { subNames: ['monero', 'tech'], title: 'x', text: '' }, { me: { id: 7 }, models: {}, headers: {} })
    ).rejects.toThrow('one territory')
  })

  test('does not trip for comments (no subNames)', async () => {
    // comments have no subNames; the guard must not throw the creation error
    await expect(
      createItem(null, { parentId: '1', text: 'hi' }, { me: { id: 7 }, models: {}, headers: {} })
    ).rejects.not.toThrow('one territory')
  })
})
