import { deleteObjects } from '@/api/s3'
import { alert } from '@/lib/alert'
import { BOSS_RETRY } from '@/lib/constants'
import { logError } from '@/lib/logger'

export async function deleteUnusedImages ({ models, boss }) {
  // delete unused media in database and S3 24 hours after upload, for stackers
  // and anons alike. "Unused" = attached to no LIVE content: attachments via a
  // soft-deleted (abandoned) item no longer pin the upload, so media from
  // fee-abandoned or deleted posts is reaped too. Paid flag is irrelevant —
  // unattached media has no content to protect.
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
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "logoId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "faviconId" = "Upload".id)
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
