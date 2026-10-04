import { deleteObjects } from '@/api/s3'
import { alert } from '@/lib/alert'
import { BOSS_RETRY, PUBLIC_MEDIA_URL, UPLOAD_FREE_BYTES_MAX, USER_ID } from '@/lib/constants'
import { logError } from '@/lib/logger'

// The /uploads/ shape is host-free so desc pins survive domain changes; the
// configured PUBLIC_MEDIA_URL prefix is matched too for deployments that serve
// media at the domain root (real-AWS mainnet config).
export function mediaUrlRegexPrefix (mediaUrl) {
  return mediaUrl.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MEDIA_URL_REGEX_PREFIX = mediaUrlRegexPrefix(PUBLIC_MEDIA_URL)

export async function deleteUnusedImages ({ models, boss }) {
  // delete unused media in database and S3 24 hours after upload, for stackers
  // and anons alike. "Unused" = attached to no LIVE content: attachments via a
  // soft-deleted (abandoned) item no longer pin the upload, so media from
  // fee-abandoned or deleted posts is reaped too. Uploads pinned by a
  // server-side draft (draft_upload) are spared unconditionally — deleting a
  // stale draft drops its pins and the next sweep reaps. Paid flag is irrelevant —
  // unattached media has no content to protect. A /uploads/<id> or
  // PUBLIC_MEDIA_URL/<id> URL in a turf description (Sub.desc) is a live
  // reference too — turf descs render their media, so the match mirrors the
  // URL shapes uploadIdsFromText extracts: the host-free /uploads/ shape so
  // pins survive domain changes, plus the configured prefix for deployments
  // that serve media at the domain root (real-AWS mainnet config). Sub.desc is
  // canonicalized server-side before storage (signed imgproxy URLs decoded), so
  // the /uploads/<id> pin sees plaintext sources.
  const unpaidImages = await models.$queryRaw`
    SELECT id
    FROM "Upload"
    WHERE NOT EXISTS (SELECT * FROM users WHERE "photoId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "Item" WHERE "uploadId" = "Upload".id AND "deletedAt" IS NULL)
      AND NOT EXISTS (
        SELECT *
        FROM "ItemUpload"
        JOIN "Item" ON "Item".id = "ItemUpload"."itemId"
        WHERE "ItemUpload"."uploadId" = "Upload".id AND "Item"."deletedAt" IS NULL)
      -- an addendum pins its reused media only when no upload fee is
      -- outstanding: paid uploads, and free-tier uploads (≤ UPLOAD_FREE_BYTES_MAX
      -- from a registered user — anonymous uploads always owe a fee). Unlike
      -- ItemUpload rows (which only exist post-fee-settlement, so their pin
      -- needs no paid check), an ItemAddendumUpload row can be created while a
      -- fee-bearing upload's fee is still unsettled — and a fee whose parent
      -- edit never settles keeps its existing abandonment → sweep lifecycle,
      -- so the addendum degrades to text plus a dead link instead of hosting
      -- the file for free. Mirrors the fee-liability predicate in uploadFees.
      AND NOT (
        ("Upload"."paid" = true
          OR ("Upload".size <= ${UPLOAD_FREE_BYTES_MAX}::INTEGER
            AND "Upload"."userId" <> ${USER_ID.anon}::INTEGER))
        AND EXISTS (
          SELECT 1
          FROM "ItemAddendumUpload"
          JOIN "Item" ON "Item".id = "ItemAddendumUpload"."itemId"
          WHERE "ItemAddendumUpload"."uploadId" = "Upload".id
            AND "Item"."deletedAt" IS NULL))
      -- pinned by a server-side draft (2026-09-22 spec): pins are derived from
      -- the draft text's media URLs; stale drafts (90d) are deleted by
      -- abandonStaleDrafts, which drops the pins and lets the next sweep reap.
      AND NOT EXISTS (SELECT * FROM draft_upload WHERE draft_upload.upload_id = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "logoId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "faviconId" = "Upload".id)
      AND NOT EXISTS (
        SELECT 1 FROM "Sub"
        WHERE "Sub".desc ~ ('/uploads/' || "Upload".id || '([^0-9]|$)')
          OR "Sub".desc ~ (${MEDIA_URL_REGEX_PREFIX} || '/' || "Upload".id || '([^0-9]|$)'))
      -- a >10MB upload whose fee is still unpaid is pinned ONLY while a deferred
      -- edit is waiting on that fee payIn (UploadPayIn -> its MEDIA_UPLOAD
      -- beneficiary's payIn -> benefactor ITEM_UPDATE -> PendingItemUpdate): a
      -- deferred edit has not attached it yet (no ItemUpload pin), and reaping
      -- it before the fee lands would make the observed fee attach a missing
      -- upload. Pay-ins with no pending edit (legacy unpaid edits, abandoned
      -- creates) do NOT pin — those uploads are swept as before.
      AND NOT (
        "Upload"."paid" = false
        AND "Upload".size > ${UPLOAD_FREE_BYTES_MAX}::INTEGER
        AND EXISTS (
          SELECT 1
          FROM "UploadPayIn"
          JOIN "PayIn" ON "PayIn"."id" = "UploadPayIn"."payInId"
          JOIN "PendingItemUpdate" ON "PendingItemUpdate"."payInId" = COALESCE("PayIn"."benefactorId", "PayIn"."id")
          WHERE "UploadPayIn"."uploadId" = "Upload"."id"))
      AND created_at < date_trunc('hour', now() - interval '24 hours')`

  const s3Keys = unpaidImages.map(({ id }) => id)
  if (s3Keys.length === 0) {
    console.log('no images to delete.')
  } else {
    console.log('deleting images:', s3Keys)
    const deleted = await deleteObjects(s3Keys)
    console.log('deleted images:', deleted)
    await models.upload.deleteMany({ where: { id: { in: deleted } } })
  }
  // self-requeue on a 24h startAfter so the sweep runs daily — success-path
  // only: a requeue sent from a FAILED run forks the chain (pg-boss retries
  // this same job, whose success sends another requeue). On a run error just
  // rethrow — the retry carries BOSS_RETRY, so a transient failure retries
  // instead of killing the daily chain; it re-executes the whole handler,
  // which re-sends on eventual success.
  try {
    await boss.send('deleteUnusedImages', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
  } catch (e) {
    logError('deleteUnusedImages requeue send failed', e)
    alert('critical', 'deleteUnusedImages requeue failed', String(e), { dedupeKey: 'deleteUnusedImages-requeue' })
    throw e // rethrow so pg-boss retries THIS run and the chain survives
  }
}
