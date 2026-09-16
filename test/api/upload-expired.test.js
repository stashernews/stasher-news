/* eslint-env jest */

// Expired uploads must surface as a user-actionable input error, not a masked
// internal error: formatGraphqlError only passes messages through when the
// error carries a deliberate extensions.code (GqlInputError -> E_BAD_INPUT).
// Hermetic media URL so the message assertion does not depend on container env
// (mirrors test/lib/lexical/media-canonical.test.js).

import { GqlInputError, E_BAD_INPUT } from '@/lib/error'

// env-before-import: the resolver is imported dynamically inside each test, so
// lib/constants captures the beforeAll-set value (static imports would be hoisted first).

const ORIGINAL_MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL

beforeAll(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = 'https://media.test/uploads'
})

afterAll(() => {
  if (ORIGINAL_MEDIA_URL === undefined) {
    delete process.env.NEXT_PUBLIC_MEDIA_URL
  } else {
    process.env.NEXT_PUBLIC_MEDIA_URL = ORIGINAL_MEDIA_URL
  }
})

const modelsWithExisting = (existingIds) => ({
  upload: {
    findMany: async ({ where }) => where.id.in.filter(id => existingIds.includes(id)).map(id => ({ id }))
  }
})

test('expired uploads throw an actionable GqlInputError listing the missing ids', async () => {
  const { throwOnExpiredUploads } = await import('@/api/resolvers/upload')

  let error
  try {
    await throwOnExpiredUploads([1, 2], { tx: modelsWithExisting([1]) })
  } catch (e) {
    error = e
  }

  expect(error).toBeInstanceOf(GqlInputError)
  expect(error.extensions.code).toBe(E_BAD_INPUT)
  expect(error.message).toContain('https://media.test/uploads/2')
  expect(error.message).toContain('expired')
  // never leak the docker-internal media host to users
  expect(error.message).not.toContain('minio')
})

test('a fully existing id list resolves without throwing', async () => {
  const { throwOnExpiredUploads } = await import('@/api/resolvers/upload')
  await expect(throwOnExpiredUploads([1], { tx: modelsWithExisting([1]) })).resolves.toBeUndefined()
})
