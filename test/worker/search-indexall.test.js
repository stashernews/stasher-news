/* eslint-env jest */
// indexAllItems reads items straight from the DB (unlike the incremental
// indexItem, which goes through the GraphQL item resolver and its activeOrMine
// PENDING_FEE filter). It must skip PENDING_FEE items, or an unpaid reply gets
// indexed and surfaces in search results.
import search from '../../api/search/index'
import { indexAllItems } from '@/worker/search'

jest.mock('../../api/search/index', () => ({ __esModule: true, default: {} }))

function stubSearch () {
  search.indices = {
    exists: async () => ({ body: true }),
    getSettings: async () => ({ body: { idx: { settings: { index: { default_pipeline: 'embed' } } } } }),
    putSettings: async () => ({}),
    refresh: async () => ({})
  }
  search.updateByQuery = async () => ({ body: { task: 'task-1' } })
  search.tasks = {
    get: async () => ({
      body: {
        completed: true,
        task: { status: { updated: 0, noops: 0, total: 0 } },
        response: { failures: [] }
      }
    })
  }
}

test('indexAllItems excludes PENDING_FEE items from the bulk findMany', async () => {
  stubSearch()
  const wheres = []
  const models = {
    item: {
      count: async () => 1,
      findMany: async ({ where }) => {
        wheres.push(where)
        return [] // empty batch ends the loop
      }
    }
  }
  await indexAllItems({ models, boss: { send: jest.fn() } })
  expect(wheres).toHaveLength(1)
  expect(wheres[0]).toEqual({ id: { gt: 0 }, feeStatus: { not: 'PENDING_FEE' } })
})
