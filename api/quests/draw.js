import { QUEST, TURF_QUEST_EXCLUDED_TURFS, drawFor, pickTurf } from '@/lib/quests'

/** Resolve the day's draw for a user, including the drawn turf's name. */
export async function resolveDraw (models, userId, day) {
  const draw = drawFor(userId, day)
  if (draw.drawn !== QUEST.TURF) return { ...draw, turfName: null }
  const turfs = await models.sub.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true } })
  const eligible = turfs.filter(t => !TURF_QUEST_EXCLUDED_TURFS.includes(t.name.toLowerCase()))
  const turf = pickTurf(eligible, draw.turfHash)
  return { ...draw, turfName: turf?.name ?? null }
}
