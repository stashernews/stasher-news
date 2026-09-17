/* eslint-env jest */

// Job identity is name-based (lib/item.js isJob), so jobs posted anywhere but
// the `jobs` turf are stored as ordinary items (email coerced to http://…,
// missing from the jobs feed, no forever-edit). The resolver must reject them.

import resolvers from '@/api/resolvers/item'
import pay from '../../api/payIn'

// mirror test/api/resolvers/item-auth.test.js mocks for item.js's heavy deps
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))
jest.mock('../../api/payIn/itemCreateAllowance', () => ({
  __esModule: true,
  assertItemCreateAllowance: async () => {}
}))
jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ id: 1 }))
}))

beforeEach(() => {
  pay.mockClear()
})

const me = { id: 7 }
const job = { title: 'test job posting', company: 'acme', text: 'x', url: 'https://example.test/apply', remote: true }

test('upsertJob rejects targets outside the jobs turf', async () => {
  await expect(resolvers.Mutation.upsertJob(null, { ...job, subNames: ['bitcoin'] }, { me, models: {} }))
    .rejects.toThrow('jobs can only be posted in the jobs turf')
})

test('upsertJob rejects a sub-less job', async () => {
  await expect(resolvers.Mutation.upsertJob(null, { ...job }, { me, models: {} }))
    .rejects.toThrow('jobs can only be posted in the jobs turf')
})

test('upsertJob proceeds for the jobs turf', async () => {
  await expect(resolvers.Mutation.upsertJob(null, { ...job, subNames: ['jobs'] }, { me, models: {} }))
    .resolves.toEqual({ id: 1 })
  expect(pay.mock.calls.at(-1)[1].subNames).toEqual(['jobs'])
})
