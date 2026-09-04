import { USER_ID } from '@/lib/constants'
import { nymsToIds, TRUST_SEED_NYMS } from '@/lib/founderNyms'

// Static fallback — the migration-guaranteed platform account. Runtime seed
// resolution lives in lib/founderNyms.js (founder nyms are name-resolved).
export const GLOBAL_SEEDS = [USER_ID.stasher]

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
