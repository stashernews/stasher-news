import { deleteObjects } from '@/api/s3'
import { USER_ID } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'

export async function deleteUnusedImages ({ models, boss }) {
  // delete unused images in database and S3 after 7 days for stackers or 24 hours for anons
  const unpaidImages = await models.$queryRaw`
    SELECT id
    FROM "Upload"
    WHERE NOT EXISTS (SELECT * FROM users WHERE "photoId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "Item" WHERE "uploadId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "ItemUpload" WHERE "uploadId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "logoId" = "Upload".id)
      AND NOT EXISTS (SELECT * FROM "SubBranding" WHERE "faviconId" = "Upload".id)
      AND created_at < date_trunc('hour', now() - CASE WHEN "userId" = ${USER_ID.anon} THEN interval '24 hours' ELSE interval '7 days' END)`

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
  // rethrow — the retry re-executes the whole handler, which re-sends on
  // eventual success.
  try {
    await boss.send('deleteUnusedImages', {}, { startAfter: 24 * 60 * 60 })
  } catch (e) {
    logError('deleteUnusedImages requeue send failed', e)
    alert('critical', 'deleteUnusedImages requeue failed', String(e), { dedupeKey: 'deleteUnusedImages-requeue' })
    throw e // rethrow so pg-boss retries THIS run and the chain survives
  }
}
