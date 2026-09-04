import { USER_ID } from '@/lib/constants'

// Founder nyms: accounts carrying founder properties (global trust seeding,
// the 0.5x curator handicap). Founder ids are resolved at RUNTIME by name —
// the founder's personal account ('untraceable') is created by ordinary
// signup, so its serial id is unpredictable across deployments while the nym
// is stable. 'stasher' (id 616) and 'sn' (id 4502) are migration-guaranteed;
// 'untraceable' resolves only once the founder has signed up with that nym.
export const TRUST_SEED_NYMS = ['stasher', 'untraceable']
export const HANDICAP_NYMS = ['stasher', 'sn', 'untraceable']

// Resolve nyms to user ids in nym-list order. Nyms with no matching user are
// skipped (a not-yet-created account simply carries no founder properties).
export async function nymsToIds (models, nyms) {
  const users = await models.user.findMany({
    where: { name: { in: nyms } },
    select: { id: true, name: true }
  })
  const idByName = new Map(users.map(u => [u.name, u.id]))
  return nyms.map(nym => idByName.get(nym)).filter(id => id !== undefined)
}

// Global trust seeds for the nightly walk (worker/trust.js). Never empty:
// falls back to the migration-guaranteed platform account.
export async function resolveTrustSeeds (models) {
  const ids = await nymsToIds(models, TRUST_SEED_NYMS)
  return ids.length > 0 ? ids : [USER_ID.stasher]
}
