// lib/drafts.js
// Server-side draft helpers: pin derivation from draft text and the
// user-set caps (DRAFT_MAX_COUNT / DRAFT_MEDIA_CAP_BYTES). Pure read paths —
// pin rows are written by the resolver (syncDraftPins).
import { AWS_S3_URL_REGEXP, DRAFT_MAX_COUNT, DRAFT_MEDIA_CAP_BYTES } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'

// Same extraction rule as api/resolvers/upload.js uploadIdsFromText — kept
// local to avoid importing the resolver module (and its s3/rate-limit deps)
// into lib code.
export function draftUploadIds (text) {
  if (!text) return []
  return [...new Set([...text.matchAll(AWS_S3_URL_REGEXP)].map(m => Number(m[1])))]
}

function toMb (bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(1)
}

/**
 * Enforce the draft caps and derive the pin set for a draft's text.
 * Throws GqlInputError on cap violations. Only uploads owned by the user are
 * pinned (foreign ids in text are ignored — they pin nothing).
 *
 * @returns {Promise<number[]>} the upload ids to pin for this draft
 */
export async function assertDraftCaps ({ models, meId, draftId = null, text }) {
  if (draftId == null) {
    const count = await models.draft.count({ where: { userId: Number(meId) } })
    if (count >= DRAFT_MAX_COUNT) {
      throw new GqlInputError(`draft limit reached (${DRAFT_MAX_COUNT}) — delete one first`)
    }
  }

  const wanted = draftUploadIds(text)
  const uploads = wanted.length > 0
    ? await models.upload.findMany({
      where: { id: { in: wanted }, userId: Number(meId) },
      select: { id: true, size: true }
    })
    : []
  const pins = uploads.map(u => ({ id: u.id, bytes: BigInt(u.size ?? 0) }))

  // other drafts' pinned bytes (this draft's own pins are being replaced)
  const other = await models.draft.findMany({
    where: { userId: Number(meId), ...(draftId != null ? { id: { not: Number(draftId) } } : {}) },
    select: { uploads: { select: { upload: { select: { size: true } } } } }
  })
  const otherBytes = other.reduce((acc, d) =>
    acc + d.uploads.reduce((a, u) => a + BigInt(u.upload?.size ?? 0), 0n), 0n)
  const newBytes = pins.reduce((acc, p) => acc + p.bytes, 0n)
  if (otherBytes + newBytes > BigInt(DRAFT_MEDIA_CAP_BYTES)) {
    throw new GqlInputError(
      `drafts are limited to ${toMb(DRAFT_MEDIA_CAP_BYTES)} MB of saved media ` +
      `(would be ${toMb(otherBytes + newBytes)} MB) — remove some files or publish first`)
  }
  return pins.map(p => p.id)
}

/** Replace a draft's pin rows inside the caller's transaction. */
export async function syncDraftPins (tx, draftId, uploadIds) {
  await tx.draftUpload.deleteMany({ where: { draftId } })
  if (uploadIds.length > 0) {
    await tx.draftUpload.createMany({
      data: uploadIds.map(uploadId => ({ draftId, uploadId }))
    })
  }
}
