import { DRAFT_TTL_DAYS } from '@/lib/constants'

// abandonStaleDrafts — hourly cron: delete drafts untouched for
// DRAFT_TTL_DAYS (90 days). Drafts are owner-only rows with no denormalized
// side effects, so a bulk delete is safe; DraftUpload pins cascade with them
// and the daily deleteUnusedImages sweep reaps the freed media on its next
// run. Recurrence is cron-owned (pgboss.schedule row abandonStaleDrafts) —
// no self-requeue; a permanently-failed run self-heals at the next tick.
// Error handling follows the repo convention (see abandonFeeItems): no local
// try/catch — worker/index.js's jobWrapper logs, alerts on permanent failure,
// and rethrows.

// The cutoff lives in the delete's own where-clause (not a scan-then-delete
// by ids) so a draft touched between scan and delete can never be swept.
export async function abandonStaleDrafts ({ models }) {
  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000)
  const { count } = await models.draft.deleteMany({
    where: { updatedAt: { lt: cutoff } }
  })
  if (count > 0) {
    console.log(`abandonStaleDrafts: deleted ${count} stale draft(s)`)
  }
  return { deleted: count }
}
