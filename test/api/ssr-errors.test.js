/* eslint-env jest */
// getGetServerSideProps must distinguish backend/transient errors (page EXISTS,
// degrade to ssrData: null + logError) from genuinely-not-found results
// (302 -> /404 + logWarn, and NO fall-through props after ending the response).
//
// Harness (no existing ssrApollo harness in test/api/): api/ssrApollo.js itself
// stays REAL; only its leaf dependencies are mocked so the import graph is
// hermetic (no Prisma, no OpenSearch, no next-auth, no lws):
//   - '@apollo/client' is ESM-only, so per test/components/header-merged.test.js:79
//     we fully mock it — gql comes from the CJS graphql-tag so the imported
//     fragments/typeDefs parse to real DocumentNodes — and ApolloClient becomes
//     a jest.fn constructor returning a controllable stub ({ query, clearStore }).
//     Its subpaths (local-state, link/schema) get inert class stubs.
//   - resolvers/models/search/loaders/lwsClient/lexical-loader/domains/
//     next-auth/auth-options/lib-auth/logger are stubbed.
// The stub client answers ME/PRICE/BLOCK_HEIGHT trivially (matched by document
// identity — the same module instances ssrApollo imports) and replays a
// branch-specific outcome for the page query under test.
import { gql } from 'graphql-tag'
import { print } from 'graphql'
import { getGetServerSideProps } from '../../api/ssrApollo'
import { ME } from '../../fragments/users'
import { PRICE } from '../../fragments/price'
import { BLOCK_HEIGHT } from '../../fragments/blockHeight'
import { logWarn, logError } from '../../lib/logger'

jest.mock('@apollo/client', () => {
  const { gql } = require('graphql-tag')
  return {
    __esModule: true,
    gql,
    InMemoryCache: jest.fn(() => ({})),
    ApolloClient: jest.fn(() => mockApolloClient)
  }
})
jest.mock('@apollo/client/local-state', () => ({ LocalState: jest.fn(() => ({})) }))
jest.mock('@apollo/client/link/schema', () => ({ SchemaLink: jest.fn(() => ({})) }))
jest.mock('../../api/resolvers', () => ({ __esModule: true, default: {} }))
jest.mock('../../api/models', () => ({ __esModule: true, default: {} }))
jest.mock('../../api/search', () => ({ __esModule: true, default: {} }))
jest.mock('../../api/loaders', () => ({
  createUserLoader: jest.fn(() => ({})),
  createSubLoader: jest.fn(() => ({}))
}))
jest.mock('../../api/monero/lwsClient', () => ({ lwsClient: {} }))
jest.mock('../../lib/lexical/server/loader', () => ({ lexicalStateLoader: jest.fn(() => () => ({})) }))
jest.mock('../../lib/domains', () => ({
  getDomainBranding: jest.fn(async () => null),
  SN_MAIN_DOMAIN: new URL('https://stasher.news')
}))
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }))
jest.mock('../../pages/api/auth/[...nextauth]', () => ({ getAuthOptions: jest.fn(() => ({})) }))
jest.mock('../../lib/auth', () => ({
  MULTI_AUTH_ANON: 'anonymous',
  MULTI_AUTH_LIST: 'multi_auth',
  MULTI_AUTH_POINTER: 'multi_auth.user-id',
  multiAuthMiddleware: jest.fn(async req => req)
}))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logger: {},
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// let (mock-prefixed): jest.mock factories may only reference out-of-scope
// names prefixed with "mock". The closures below only dereference these at
// test time (when the mocked ApolloClient constructor / query run), well
// after these declarations are initialized — no TDZ hazard.
let mockApolloClient = null
let mockPageQueryImpl = async () => ({ data: { item: { id: 1 } }, error: null })

const PAGE_QUERY = gql`
  query Item($id: ID!) {
    item(id: $id) {
      id
      title
    }
  }
`

function makeStubClient () {
  mockApolloClient = {
    clearStore: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async ({ query }) => {
      if (query === ME) return { data: { me: null } }
      if (query === PRICE) return { data: { price: null } }
      if (query === BLOCK_HEIGHT) return { data: { blockHeight: 0 } }
      return mockPageQueryImpl({ query })
    })
  }
}

async function runGssp (opts = {}) {
  const end = jest.fn()
  const writeHead = jest.fn(() => ({ end }))
  const req = { url: '/items/1', headers: { host: 'localhost:3000' }, cookies: {} }
  const res = { writeHead, end }
  const gssp = getGetServerSideProps({ query: PAGE_QUERY, variables: { id: 1 }, ...opts })
  const result = await gssp({ req, res, query: { id: '1' } })
  return { result, res }
}

beforeEach(() => {
  jest.clearAllMocks()
  makeStubClient()
  mockPageQueryImpl = async () => ({ data: { item: { id: 1 } }, error: null })
})

test('backend error: client.query rejects -> NO 404 redirect, props degrade to ssrData null', async () => {
  mockPageQueryImpl = async () => { throw new Error('backend exploded') }

  const { result, res } = await runGssp()

  expect(res.writeHead).not.toHaveBeenCalled()
  expect(res.end).not.toHaveBeenCalled()
  expect(result).toEqual({ props: expect.objectContaining({ ssrData: null }) })
  expect(logError).toHaveBeenCalledTimes(1)
})

test('genuine not-found: resolves { data: undefined, error: null } -> 302 to /404 and returns without fall-through props', async () => {
  mockPageQueryImpl = async () => ({ data: undefined, error: null })

  const { result, res } = await runGssp()

  expect(res.writeHead).toHaveBeenCalledWith(302, { Location: '/404' })
  expect(res.end).toHaveBeenCalled()
  expect(result).toBeUndefined()
  expect(logWarn).toHaveBeenCalledTimes(1)
})

test('caller-defined notFound: truthy data that fails the predicate still 302s to /404 without fall-through props', async () => {
  mockPageQueryImpl = async () => ({ data: { item: null }, error: null })

  const { result, res } = await runGssp({ notFound: data => !data.item })

  expect(res.writeHead).toHaveBeenCalledWith(302, { Location: '/404' })
  expect(result).toBeUndefined()
})

test('notFound callback is never invoked on falsy data (callbacks like data => !data.item throw on null)', async () => {
  mockPageQueryImpl = async () => ({ data: undefined, error: null })
  const notFound = jest.fn(data => !data.item)

  await runGssp({ notFound })

  expect(notFound).not.toHaveBeenCalled()
})

// --- Task: SSR fast-path characterization + concurrency tests ----------------
// The refactor (schema hoist + Promise concurrency) must not change ANY output
// prop, redirect, or degradation behavior — only the issue order/timing of the
// underlying queries.

function makeReqRes () {
  const end = jest.fn()
  const writeHead = jest.fn(() => ({ end }))
  const req = { url: '/items/1', headers: { host: 'localhost:3000' }, cookies: {} }
  const res = { writeHead, end }
  return { req, res }
}

test('characterization: happy path returns the full SSR props shape', async () => {
  const { result, res } = await runGssp()

  expect(res.writeHead).not.toHaveBeenCalled()
  expect(result).toEqual({
    props: expect.objectContaining({
      me: null,
      price: null,
      blockHeight: 0,
      ssrData: { item: { id: 1 } },
      apollo: { query: print(PAGE_QUERY), variables: { id: 1 } }
    })
  })
})

test('perf: BLOCK_HEIGHT is issued before ME resolves (independent lookups run concurrently)', async () => {
  makeStubClient()
  let resolveMe
  mockApolloClient.query = jest.fn(async ({ query }) => {
    if (query === ME) return new Promise(resolve => { resolveMe = resolve })
    if (query === PRICE) return { data: { price: null } }
    if (query === BLOCK_HEIGHT) return { data: { blockHeight: 0 } }
    return mockPageQueryImpl({ query })
  })

  const { req, res } = makeReqRes()
  const gssp = getGetServerSideProps({ query: PAGE_QUERY, variables: { id: 1 } })({ req, res, query: { id: '1' } })
  await new Promise(resolve => setImmediate(resolve)) // flush the sync issue chain up to the ME await

  const issued = mockApolloClient.query.mock.calls.map(([a]) => a.query)
  expect(issued).toContain(BLOCK_HEIGHT) // fired although ME is still pending

  resolveMe({ data: { me: null } })
  const result = await gssp
  expect(result.props.blockHeight).toBe(0)
})

test('perf: page query is issued before PRICE resolves (post-ME queries run concurrently)', async () => {
  makeStubClient()
  let resolvePrice
  mockApolloClient.query = jest.fn(async ({ query }) => {
    if (query === ME) return { data: { me: null } }
    if (query === PRICE) return new Promise(resolve => { resolvePrice = resolve })
    if (query === BLOCK_HEIGHT) return { data: { blockHeight: 0 } }
    return mockPageQueryImpl({ query })
  })

  const { req, res } = makeReqRes()
  const gssp = getGetServerSideProps({ query: PAGE_QUERY, variables: { id: 1 } })({ req, res, query: { id: '1' } })
  await new Promise(resolve => setImmediate(resolve))

  const issued = mockApolloClient.query.mock.calls.map(([a]) => a.query)
  expect(issued).toContain(PAGE_QUERY) // fired although PRICE is still pending

  resolvePrice({ data: { price: null } })
  const result = await gssp
  expect(result.props.ssrData).toEqual({ item: { id: 1 } })
})
