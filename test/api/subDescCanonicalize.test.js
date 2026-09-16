/* eslint-env jest */

// Turf descriptions must be canonicalized server-side before storage, exactly
// like item text (itemCreate/itemUpdate onBegin): a signed imgproxy URL — what
// a user copies from the rendered page — hides the upload id inside its base64
// tail, so a raw paste would evade both upload-id extraction and the sweep's
// /uploads/<id> desc pin.

import subResolvers from '@/api/resolvers/sub'
import pay from '../../api/payIn'

// sub.js statically imports @/lib/lexical/server/html (ESM-only); stub it like
// test/api/subWalletGate.test.js
jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: () => ({ html: '', text: '' })
}))

// relative path per repo convention: jest.mock cannot resolve the @/ alias
jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ id: 1 }))
}))

// territorySchema's availability checks hit models.sub with the real Prisma
// shape; no-op validateSchema only (mirrors subWalletGate.test.js)
jest.mock('../../lib/validate', () => {
  const actual = jest.requireActual('../../lib/validate')
  return { ...actual, validateSchema: async () => {} }
})

const gqlMe = { id: 7 }
const SOURCE = 'http://minio:9000/uploads/274'
const SIGNED = `https://imgprxy.test/sig/rs:fit:1920:1080/${Buffer.from(SOURCE, 'utf-8').toString('base64url')}`

beforeEach(() => {
  process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test'
  // the dev container exports TURF_OWNER_FEES=1 from .env.local; the first
  // test exercises the gate-OFF create path (models: {} has no moneroAccount),
  // so clear it here. The unarchive test sets it itself.
  delete process.env.TURF_OWNER_FEES
})

afterEach(() => {
  delete process.env.NEXT_PUBLIC_IMGPROXY_URL
  delete process.env.TURF_OWNER_FEES
  pay.mockClear()
})

const createArgs = {
  name: 'x',
  desc: `see ![](${SIGNED})`,
  postTypes: ['LINK'],
  billingType: 'MONTHLY',
  billingAutoRenew: false,
  nsfw: false
}

test('upsertSub decodes signed imgproxy urls in the desc before pay', async () => {
  await subResolvers.Mutation.upsertSub(null, createArgs, { me: gqlMe, models: {} })
  expect(pay.mock.calls.at(-1)[1].desc).toBe(`see ![](${SOURCE})`)
})

test('unarchiveTerritory decodes signed imgproxy urls in the desc before pay', async () => {
  process.env.TURF_OWNER_FEES = '1'
  const models = {
    sub: { findUnique: async () => ({ name: 't', userId: gqlMe.id, status: 'STOPPED', billingType: 'MONTHLY' }) },
    moneroAccount: { findFirst: async () => ({ id: 1 }) }
  }
  await subResolvers.Mutation.unarchiveTerritory(null, createArgs, { me: gqlMe, models })
  expect(pay.mock.calls.at(-1)[1].desc).toBe(`see ![](${SOURCE})`)
})
