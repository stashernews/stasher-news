/* eslint-env jest */
import { gql } from '@apollo/client'
import { createAdminClient } from '@/components/admin/client'

test('private Apollo traffic uses only the admin endpoint and client marker, never account cookies or persistent cache', async () => {
  const fetch = jest.fn(async () => new Response(JSON.stringify({ data: { adminEnvironment: [] } }), { headers: { 'content-type': 'application/json' } }))
  const client = createAdminClient(fetch)
  try {
    const result = await client.query({ query: gql`query { adminEnvironment { key value } }` })
    expect(result.data.adminEnvironment).toEqual([])
    expect(fetch.mock.calls[0][0]).toBe('/api/admin/graphql')
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', headers: expect.objectContaining({ 'x-admin-client': '1' }) })
    expect(client.extract()).toEqual({})
  } finally { client.stop() }
})
