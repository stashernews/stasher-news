/* eslint-env jest */
// indexAllItems reads items straight from the DB (unlike the incremental
// indexItem, which goes through the GraphQL item resolver and its activeOrMine
// PENDING_FEE filter). It must skip PENDING_FEE items, or an unpaid reply gets
// indexed and surfaces in search results.
//
// BigInt regression: Prisma returns BigInt piconero columns, and the OpenSearch
// client serializer (JSON.stringify semantics) throws "Do not know how to
// serialize a BigInt" on any doc carrying one — aborting the WHOLE bulk batch.
// The indexed docs must be JSON-safe: money fields stripped (they are unmapped
// and unused by queries), and the bulk send must degrade to per-doc indexing
// when the wholesale request fails.
import search from '../../api/search/index'
import { indexItem, indexAllItems } from '@/worker/search'

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

function bulkDoc (body, i) {
  return body[i * 2 + 1].doc
}

function findManyBatches (...batches) {
  let call = 0
  return async () => batches[Math.min(call++, batches.length - 1)]
}

// shape mirrors the indexAllItems select, with BigInt money fields like prod
function mkItem (id, overrides = {}) {
  return {
    id,
    parentId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    title: `item ${id}`,
    text: 'body text',
    url: null,
    userId: 616,
    subNames: [],
    status: 'ACTIVE',
    company: null,
    location: null,
    remote: null,
    upvotes: 1,
    boost: 0n,
    lastCommentAt: null,
    ncomments: 0,
    rootId: null,
    piconeros: 0n,
    credits: 0n,
    commentPiconeros: 0n,
    commentCredits: 0n,
    commentBoost: 0n,
    cost: 1000,
    commentCost: 1000,
    weightedVotes: 2.5,
    weightedDownVotes: 0.5,
    ranktop: 1.25,
    user: { name: 'stasher' },
    root: { subNames: [] },
    Bookmark: [],
    ...overrides
  }
}

test('indexAllItems sends a JSON-safe bulk body (BigInt money fields stripped)', async () => {
  stubSearch()
  const bulkBodies = []
  search.bulk = async ({ body }) => {
    // mirrors @opensearch-project/opensearch Serializer: JSON.stringify
    // semantics throw "Do not know how to serialize a BigInt"
    JSON.stringify(body)
    bulkBodies.push(body)
    return { body: { errors: false, items: [] } }
  }
  const models = {
    item: {
      count: async () => 1,
      findMany: findManyBatches([
        mkItem(349, {
          piconeros: 1000000000n,
          credits: 2000000000n,
          commentPiconeros: 3000000000n,
          commentCredits: 4000000000n,
          boost: 5000000000n,
          commentBoost: 6000000000n
        })
      ])
    }
  }
  await indexAllItems({ models, boss: { send: jest.fn() } })

  expect(bulkBodies).toHaveLength(1)
  expect(bulkBodies[0]).toHaveLength(2) // one action + one doc
  // update actions must wrap the source in { doc } — a bare doc makes the
  // UpdateRequest parser reject the whole batch (unknown field [id])
  expect(bulkBodies[0][0].update._id).toBe(349)
  expect(Object.keys(bulkBodies[0][1])).toEqual(['doc'])
  const doc = bulkDoc(bulkBodies[0], 0)
  // money columns are unmapped (dynamic: false) and unused by every query —
  // they must not reach the client at all
  expect(doc.piconeros).toBeUndefined()
  expect(doc.credits).toBeUndefined()
  expect(doc.commentPiconeros).toBeUndefined()
  expect(doc.commentCredits).toBeUndefined()
  expect(doc.boost).toBeUndefined()
  expect(doc.commentBoost).toBeUndefined()
  expect(doc.cost).toBeUndefined()
  expect(doc.commentCost).toBeUndefined()
  // fields the index actually uses survive
  expect(doc.wvotes).toBe(2)
  expect(doc.docType).toBe('post')
  expect(doc.textLength).toBeGreaterThan(0)
})

test('indexAllItems falls back to per-doc indexing when the wholesale bulk fails', async () => {
  stubSearch()
  const indexedIds = []
  search.bulk = async ({ body }) => {
    if (body.length > 2) {
      // wholesale failure (e.g. one poison doc aborted the whole request)
      throw new Error('Do not know how to serialize a BigInt')
    }
    const id = body[0].update._id
    if (id === 2) throw new Error('Do not know how to serialize a BigInt')
    indexedIds.push(id)
    return { body: { errors: false, items: [{ update: { status: 200 } }] } }
  }
  const models = {
    item: {
      count: async () => 3,
      findMany: findManyBatches([mkItem(1), mkItem(2), mkItem(3)])
    }
  }
  // must not throw: the poison doc is skipped, the batch is not lost
  await indexAllItems({ models, boss: { send: jest.fn() } })
  expect(indexedIds).toEqual([1, 3])
})

test('indexItem drops BigInt money fields before search.index', async () => {
  stubSearch()
  search.getSource = async () => { throw new Error('document_missing_exception') }
  const bodies = []
  search.index = async ({ body }) => {
    JSON.stringify(body)
    bodies.push(body)
    return {}
  }
  const item = mkItem(338453, {
    text: 'text',
    parentId: 1,
    root: { subNames: ['money'] },
    piconeros: 1000000000n,
    credits: 1420000000n,
    commentPiconeros: 1000000000n
  })
  const apollo = { query: async () => ({ data: { item } }) }
  const models = {
    item: { findUnique: async () => ({ weightedVotes: 1, weightedDownVotes: 0, ranktop: 0 }) },
    bookmark: { findMany: async () => [] }
  }
  await indexItem({ data: { id: 338453 }, apollo, models })

  expect(bodies).toHaveLength(1)
  expect(bodies[0].piconeros).toBeUndefined()
  expect(bodies[0].credits).toBeUndefined()
  expect(bodies[0].commentPiconeros).toBeUndefined()
  expect(bodies[0].commentCredits).toBeUndefined()
  expect(bodies[0].boost).toBeUndefined()
  expect(bodies[0].docType).toBe('comment')
})
