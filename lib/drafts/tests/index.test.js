/* eslint-env jest */
import { draftUploadIds, assertDraftCaps } from '@/lib/drafts'
import { PUBLIC_MEDIA_URL } from '@/lib/constants'

// fixture URLs must match AWS_S3_URL_REGEXP, which is env-derived — build them
// from the same constant the regex base (and the extraction code) reads
const url = id => `${PUBLIC_MEDIA_URL}/${id}`

test('draftUploadIds extracts unique ids from media URLs', () => {
  const text = `a ![x](${url(12)}) b ${url(12)} c ![y](${url(34)})`
  expect(draftUploadIds(text)).toEqual([12, 34])
})

const fakeModels = ({ count = 0, uploads = [], ownDrafts = [] } = {}) => ({
  draft: {
    count: jest.fn().mockResolvedValue(count),
    // minimal where support: assertDraftCaps excludes the draft being replaced
    // via id: { not } and the fake must honor it, else its own pins are
    // double-counted against the media cap
    findMany: jest.fn().mockImplementation(({ where } = {}) =>
      Promise.resolve(where?.id?.not == null
        ? ownDrafts
        : ownDrafts.filter(d => d.id !== where.id.not)))
  },
  upload: { findMany: jest.fn().mockResolvedValue(uploads) }
})

test('assertDraftCaps returns pin ids for owned uploads under the caps', async () => {
  const models = fakeModels({
    count: 5,
    uploads: [{ id: 12, size: 5 * 1024 * 1024 }, { id: 34, size: 5 * 1024 * 1024 }]
  })
  const ids = await assertDraftCaps({ models, meId: 7, text: `x ${url(12)} y ${url(34)}` })
  expect(ids).toEqual([12, 34])
})

test('rejects creating an 11th draft', async () => {
  const models = fakeModels({ count: 10, uploads: [] })
  await expect(assertDraftCaps({ models, meId: 7, text: '' }))
    .rejects.toThrow(/draft limit/)
})

test('rejects pinned media past 20MB, counting other drafts but not the draft being replaced', async () => {
  const models = fakeModels({
    count: 1,
    ownDrafts: [{ id: 1, uploads: [{ uploadId: 50, upload: { size: 15 * 1024 * 1024 } }] }],
    uploads: [{ id: 12, size: 6 * 1024 * 1024 }]
  })
  // new pins 6MB + other drafts 15MB = 21MB > 20MB (toMb renders toFixed(1) — "20.0 MB")
  await expect(assertDraftCaps({ models, meId: 7, text: url(12) }))
    .rejects.toThrow(/20(\.\d)? MB/)
  // the same draft replacing its own pins: 6MB alone, fine
  const ids = await assertDraftCaps({ models, meId: 7, draftId: 1, text: url(12) })
  expect(ids).toEqual([12])
})

test('ignores uploads the user does not own', async () => {
  const models = fakeModels({ count: 0, uploads: [] }) // findMany returns none -> foreign id not pinned
  const ids = await assertDraftCaps({ models, meId: 7, text: url(999) })
  expect(ids).toEqual([])
})
