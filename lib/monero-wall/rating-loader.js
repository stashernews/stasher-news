// lib/monero-wall/rating-loader.js
// Request-scoped DataLoader for Monerowall rating aggregates.
// One query per concern per request; viewer contribution comes from the
// existing moneroWallLoader (batched, cached per request).
import DataLoader from 'dataloader'

/**
 * @param {{ models: object, me: { id: number|string }|null, moneroWallLoader: object }} params
 * @returns {DataLoader<number, {average:number, count:number, myStars:number|null, canRate:boolean, pendingRating:boolean}>}
 */
export function createMoneroWallRatingLoader ({ models, me, moneroWallLoader }) {
  return new DataLoader(async (ids) => {
    const uniq = [...new Set(ids.map(Number))]
    const meId = me?.id != null ? Number(me.id) : null

    const [walls, aggs, mine] = await Promise.all([
      models.item.findMany({
        where: { id: { in: uniq } },
        select: { id: true, userId: true, moneroWallPricePiconeros: true, moneroWallEnabledAt: true }
      }),
      models.moneroWallRating.groupBy({
        by: ['itemId'],
        where: { itemId: { in: uniq } },
        _avg: { stars: true },
        _count: { _all: true }
      }),
      meId != null
        ? models.moneroWallRating.findMany({
          where: { itemId: { in: uniq }, userId: meId },
          select: { itemId: true, stars: true }
        })
        : Promise.resolve([])
    ])

    const aggById = new Map(aggs.map(a => [Number(a.itemId), a]))
    const myById = new Map(mine.map(m => [Number(m.itemId), m.stars]))

    // canRate candidates: logged-in non-author, wall with a price X
    // (removed walls keep their columns — rating eligibility survives removal)
    const candidates = walls.filter(w =>
      meId != null &&
      Number(w.userId) !== meId &&
      w.moneroWallEnabledAt != null &&
      w.moneroWallPricePiconeros != null)

    // Queue every load in one tick so the wall loader batches them all
    const entries = await Promise.all(candidates.map(async w => {
      const { myContributionPiconeros, myRateablePiconeros } = await moneroWallLoader.load({
        id: w.id, enabledAt: w.moneroWallEnabledAt
      })
      const paid = BigInt(myContributionPiconeros) >= BigInt(w.moneroWallPricePiconeros)
      const rateable = BigInt(myRateablePiconeros ?? 0n) >= BigInt(w.moneroWallPricePiconeros)
      return [Number(w.id), { paid, rateable }]
    }))
    const eligible = new Map(entries)

    return ids.map(id => {
      const agg = aggById.get(Number(id))
      const count = Number(agg?._count?._all ?? 0)
      const avg = Number(agg?._avg?.stars ?? 0)
      const e = eligible.get(Number(id))
      return {
        average: Math.round(avg * 10) / 10,
        count,
        myStars: myById.get(Number(id)) ?? null,
        canRate: e?.rateable === true,
        pendingRating: e != null && !e.rateable && e.paid
      }
    })
  })
}
