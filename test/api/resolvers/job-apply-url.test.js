/* eslint-env jest */

// createItem stores job apply urls. Bare domains ("x.com") must be normalized
// to absolute hrefs ("http://x.com") so the apply button is not treated as a
// relative link, while email apply addresses must be left untouched (the
// shared ensureProtocol would mangle "hire@me.com" into "http://hire@me.com").
// Real DB for user creation; pay() is mocked, so the assertion is on what
// createItem hands to pay rather than a persisted row (mirrors the fixture
// discipline of test/api/resolvers/statistics.test.js).

import { PrismaClient } from '@prisma/client'
import { createItem } from '@/api/resolvers/item'
import pay from '@/api/payIn'

// Break the ESM-only node_modules chain pulled in by api/resolvers/item
// (see test/api/resolvers/statistics.test.js for the identical mocks).
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => null)
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const prisma = new PrismaClient()

const created = { users: [] }

async function cleanupTracked () {
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  for (const key of Object.keys(created)) created[key].length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  await cleanupTracked()
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createJob (url) {
  const userId = await createUser()
  return createItem(
    null,
    { title: 'job', text: 'some text', company: 'ACME', url, subNames: ['jobs'] },
    { me: { id: userId, apiKey: null }, models: prisma }
  )
}

describe('createItem job apply url normalization', () => {
  beforeEach(() => {
    pay.mockClear()
  })

  it('normalizes a bare-domain apply url so it is not stored relative', async () => {
    await createJob('x.com')

    expect(pay).toHaveBeenCalledWith(
      'ITEM_CREATE',
      expect.objectContaining({ url: 'http://x.com' }),
      expect.anything()
    )
  })

  it('leaves a fully qualified apply url unchanged', async () => {
    await createJob('https://example.com/apply')

    expect(pay).toHaveBeenCalledWith(
      'ITEM_CREATE',
      expect.objectContaining({ url: 'https://example.com/apply' }),
      expect.anything()
    )
  })

  it('leaves an email apply address untouched (ensureProtocol would mangle it)', async () => {
    await createJob('hireme@example.com')

    expect(pay).toHaveBeenCalledWith(
      'ITEM_CREATE',
      expect.objectContaining({ url: 'hireme@example.com' }),
      expect.anything()
    )
  })
})
