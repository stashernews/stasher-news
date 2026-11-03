/* eslint-env jest */
import { graphql, getIntrospectionQuery } from 'graphql'
import { makeExecutableSchema } from '@graphql-tools/schema'
import publicTypeDefs from '@/api/typeDefs'
import handler, { adminServer } from '@/pages/api/admin/graphql'
import { adminEnvironment } from '@/api/admin/resolvers'

const env = { ...process.env }
afterEach(() => { process.env = { ...env } })
afterAll(() => adminServer.stop())

test('admin API ignores account cookies and API keys, returning a bare 404 before Apollo', async () => {
  process.env.ADMIN_GATE_SECRET = 'a'.repeat(32)
  for (const gate of [undefined, 'wrong']) {
    const response = { status: jest.fn().mockReturnThis(), end: jest.fn(), setHeader: jest.fn() }
    await handler({ method: 'POST', headers: { 'x-admin-gate': gate, cookie: 'next-auth.session-token=stasher', 'x-api-key': 'valid-or-not' } }, response)
    expect(response.status).toHaveBeenCalledWith(404)
    expect(response.end).toHaveBeenCalledWith()
  }
})

test('the separate endpoint disables introspection and rejects mutations without the client marker', async () => {
  const result = await adminServer.executeOperation({ query: '{ __schema { queryType { name } } }' })
  expect(result.body.singleResult.errors[0].message).toMatch(/introspection/i)
  const mutation = await adminServer.executeOperation({ query: 'mutation { adminApply(changes: [{key:"maxItemTurfs", expected:"5", value:"6"}], reason:"test") { applied } }' }, { contextValue: { models: {} } })
  expect(mutation.http.status).toBe(403)
  expect(mutation.body.singleResult.errors[0].extensions.code).toBe('FORBIDDEN')
})

test('real Apollo HTTP handling accepts guarded queries, preserves mutation errors and ignores account credentials', async () => {
  process.env.ADMIN_GATE_SECRET = 'a'.repeat(32)
  const request = async (query, client) => {
    let body
    const res = { setHeader: () => {}, send: text => { body = JSON.parse(text) }, end: () => {} }
    await handler({ method: 'POST', url: '/api/admin/graphql', query: {}, body: { query }, headers: { 'content-type': 'application/json', 'x-admin-gate': process.env.ADMIN_GATE_SECRET, 'x-admin-client': client, 'x-api-key': 'ignored', cookie: 'invalid-session' } }, res)
    return { status: res.statusCode, body }
  }
  const query = await request('{ adminEnvironment { key value } }')
  expect(query.status).toBe(200)
  expect(query.body.errors).toBeUndefined()
  const mutation = 'mutation { adminApply(changes: [], reason: "") { applied } }'
  expect((await request(mutation)).status).toBe(403)
  process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
  const marked = await request(mutation, '1')
  expect(marked.body.errors[0].extensions.code).toBe('VALIDATION_ERROR')
})

test('environment output never exposes sensitive values, including unknown secret names', async () => {
  const fake = {
    DATABASE_URL: 'postgres://secret:test@db/private',
    NEXTAUTH_SECRET: 'auth-canary',
    ADMIN_GATE_SECRET: 'gate-canary',
    LWS_WEBHOOK_TOKEN: 'token-canary',
    UNKNOWN_SECRET_KEY: 'unknown-canary',
    ALERT_WEBHOOK_URL: 'https://secret.invalid/hook',
    AWS_SECRET_ACCESS_KEY: 'aws-canary',
    MONERO_NETWORK: 'stagenet'
  }
  const rows = adminEnvironment(fake)
  const serialized = JSON.stringify(rows)
  for (const [key, value] of Object.entries(fake)) if (/SECRET|KEY|TOKEN|PASSWORD|URL/.test(key)) expect(serialized).not.toContain(value)
  expect(rows).toContainEqual(expect.objectContaining({ key: 'DATABASE_URL', value: 'set' }))
  expect(rows).toContainEqual(expect.objectContaining({ key: 'MONERO_NETWORK', value: 'stagenet' }))
  const result = await adminServer.executeOperation({ query: '{ adminEnvironment { key value } }' })
  expect(result.body.singleResult.errors).toBeUndefined()
})

test('the public GraphQL schema has none of the new admin queries or mutations', async () => {
  const schema = makeExecutableSchema({ typeDefs: publicTypeDefs })
  const result = await graphql({ schema, source: getIntrospectionQuery() })
  expect(result.errors).toBeUndefined()
  const types = result.data.__schema.types.filter(type => ['Query', 'Mutation'].includes(type.name))
  expect(types.flatMap(type => type.fields).filter(field => field.name.startsWith('admin'))).toEqual([])
})
