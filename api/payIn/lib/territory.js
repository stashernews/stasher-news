import { USER_ID } from '@/lib/constants'
import { nymsToIds, TRUST_SEED_NYMS } from '@/lib/founderNyms'

// Static fallback — the migration-guaranteed platform account. Runtime seed
// resolution lives in lib/founderNyms.js (founder nyms are name-resolved).
export const GLOBAL_SEEDS = [USER_ID.stasher]

// OCC guard for Sub updates: spread the fetched row (minus the nullable-unique
// billingPayInId) into Prisma's update where. The full-row spread is deliberate
// — the auto-bumped updatedAt catches concurrent writes; do NOT trim it to
// "relevant fields". Prisma rejects null for unique fields in a where clause,
// and a null billingPayInId carries no OCC signal, so include it only when set.
export function subOccWhere (sub) {
  const { billingPayInId, ...guard } = sub
  return {
    ...guard,
    ...(billingPayInId != null && { billingPayInId }),
    postTypes: {
      equals: sub.postTypes
    }
  }
}

export async function initialTrust (models, { name, userId }) {
  const resolved = await nymsToIds(models, TRUST_SEED_NYMS)
  const seeds = resolved.length > 0 ? resolved : GLOBAL_SEEDS
  const results = seeds.map(id => ({
    subName: name,
    userId: id,
    zapPostTrust: 1,
    subZapPostTrust: 1,
    zapCommentTrust: 1,
    subZapCommentTrust: 1
  }))

  if (!seeds.includes(userId)) {
    results.push({
      subName: name,
      userId,
      zapPostTrust: 0,
      subZapPostTrust: 1,
      zapCommentTrust: 0,
      subZapCommentTrust: 1
    })
  }

  return results
}
