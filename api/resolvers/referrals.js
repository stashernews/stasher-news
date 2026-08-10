import { whenToFrom } from '@/lib/time'
import { GqlAuthenticationError } from '@/lib/error'

export default {
  Query: {
    // Referral earnings for the caller: FOREVER_REFERRAL Earn rows (written
    // weekly by rewardsDistributor, A-09), bucketed per UTC day. `when` is one
    // of WHENS (day/week/month/year/forever/custom); `from`/`to` are ms
    // timestamps used only for custom ranges (the page sends them as strings).
    referrals: async (parent, { when, from, to }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const fromDate = when === 'custom'
        ? new Date(Number(from))
        : new Date(whenToFrom(when))
      const toDate = when === 'custom'
        ? new Date(Number(to))
        : new Date()

      const rows = await models.$queryRaw`
        SELECT date_trunc('day', created_at)::date AS time,
               COALESCE(sum(piconeros), 0)::bigint AS total
        FROM "Earn"
        WHERE "userId" = ${me.id}::int
          AND type = 'FOREVER_REFERRAL'
          AND created_at >= ${fromDate}
          AND created_at < ${toDate}
        GROUP BY 1
        ORDER BY 1`

      return rows.map(r => ({
        time: r.time,
        data: [{ name: 'referral piconeros', value: BigInt(r.total) }]
      }))
    }
  }
}
