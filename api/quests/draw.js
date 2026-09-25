import { drawFor } from '@/lib/quests'

/** The day's draw for a user (deterministic in userId and day; no storage). */
export async function resolveDraw (models, userId, day) {
  return drawFor(userId, day)
}
