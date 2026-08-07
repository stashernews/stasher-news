import { timeUnitForRange, whenRange } from '@/lib/time'
import { Prisma } from '@prisma/client'

const ALL_SUB = 'all'

// timeHelper builds the zero-filled generate_series buckets (kept from the
// Agg-table era). `series` buckets are timestamptz truncated at America/Chicago
// boundaries; every live aggregation below buckets observations the same way.
function timeHelper (when, from, to) {
  const [fromDate, toDate] = whenRange(when, from, to)
  const granularity = timeUnitForRange([fromDate, toDate]).toUpperCase()
  const step = Prisma.sql`${`1 ${granularity}`}::interval`
  const clamp = granularity === 'HOUR' ? Prisma.empty : Prisma.sql`- ${step}`
  const series = Prisma.sql`
    SELECT generate_series(date_trunc(${granularity}, ${fromDate}::timestamptz at time zone 'America/Chicago'),
      date_trunc(${granularity},
        ${toDate}::timestamptz at time zone 'America/Chicago' ${clamp}),
        ${step})::timestamp at time zone 'America/Chicago' as "timeBucket"`
  return { fromDate, toDate, granularity, step, series }
}

// Bucket expression for observation timestamps. confirmedAt/created_at are
// timestamp-without-time-zone columns holding UTC wall time (session TZ is
// UTC), so: naive -> UTC instant -> CT wall -> truncate -> CT instant. This
// matches series."timeBucket" exactly.
function bucket (granularity, column) {
  return Prisma.sql`date_trunc(${granularity}, ${column} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'`
}

// Range + UTC-interpretation guards used everywhere below.
function inRange (column, fromDate, toDate) {
  return Prisma.sql`${column} AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz AND ${column} AT TIME ZONE 'UTC' < ${toDate}::timestamptz`
}

const findSub = async (subName, { subLoader }) => {
  if (subName) {
    return subName === 'all' ? ALL_SUB : await subLoader.load(subName)
  }
  return null
}

// ---- observation scoping (per slice) ----

function tipScope (sub, me) {
  if (sub === ALL_SUB || (!sub && !me)) return Prisma.empty
  if (sub) {
    return Prisma.sql`AND t."postId" IN (SELECT "Item".id FROM "Item" WHERE "Item"."subName" = ${sub.name})`
  }
  return Prisma.sql`AND ma."ownerUserId" = ${me.id}`
}

function downvoteScope (sub, me) {
  if (sub === ALL_SUB || (!sub && !me)) return Prisma.empty
  if (sub) {
    return Prisma.sql`AND b."postId" IN (SELECT "Item".id FROM "Item" WHERE "Item"."subName" = ${sub.name})`
  }
  return Prisma.sql`AND b."downvoterId" = ${me.id}`
}

function feeScope (sub, me) {
  if (sub === ALL_SUB || (!sub && !me)) return Prisma.empty
  if (sub) {
    return Prisma.sql`AND (f."postId" IS NOT NULL AND f."postId" IN (SELECT "Item".id FROM "Item" WHERE "Item"."subName" = ${sub.name}) OR f."subName" = ${sub.name})`
  }
  return Prisma.sql`AND p."userId" = ${me.id}`
}

// Returns the slice's scope-able user (the viewer) for every resolver, or
// null when sub-scoped or global. Used uniformly by growthTotals + the time
// series resolvers so the scope helpers get one consistent shape.
function sliceUser (sub, me) {
  return sub === ALL_SUB || sub ? null : me
}

export default {
  Query: {
    growthTotals: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      const spendResult = await models.$queryRaw`
        SELECT
          COALESCE(SUM(x.piconeros), 0) / 1000 AS spending,
          COUNT(*)::int AS items
        FROM (
          SELECT b.piconeros
          FROM "ObservedDownvote" b
          WHERE b.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`b."confirmedAt"`, fromDate, toDate)}
            ${downvoteScope(sub, user)}
          UNION ALL
          SELECT f.piconeros
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
            ${feeScope(sub, user)}
        ) x`

      const stashResult = await models.$queryRaw`
        SELECT COALESCE(SUM(t.piconeros), 0) / 1000 AS stashing
        FROM "ObservedTip" t
        JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
        WHERE t.state = 'CONFIRMED'
          AND ma."ownerUserId" IS NOT NULL
          AND ${inRange(Prisma.sql`t."confirmedAt"`, fromDate, toDate)}
          ${tipScope(sub, user)}`

      let registrations = null
      if (sub === ALL_SUB && !mine) {
        const regResult = await models.$queryRaw`
          SELECT count(*)::int AS registrations
          FROM users
          WHERE ${inRange(Prisma.sql`users."created_at"`, fromDate, toDate)}`
        registrations = regResult[0]?.registrations || 0
      }

      return {
        spending: spendResult[0]?.spending || 0,
        items: spendResult[0]?.items || 0,
        stashing: stashResult[0]?.stashing || 0,
        registrations
      }
    },
    registrationGrowth: async (parent, { when, from, to }, { models }) => {
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), registrations AS (
          SELECT ${bucket(granularity, Prisma.sql`u."created_at"`)} AS "timeBucket",
            count(*) AS count,
            count(*) FILTER (WHERE u."inviteId" IS NOT NULL) AS "invitedCount",
            count(*) FILTER (WHERE u."referrerId" IS NOT NULL) AS "referredCount"
          FROM users u
          WHERE ${inRange(Prisma.sql`u."created_at"`, fromDate, toDate)}
          GROUP BY 1
        )
        SELECT series."timeBucket" AS time, json_build_array(
          json_build_object('name', 'invited', 'value', COALESCE(sum(registrations."invitedCount"), 0)),
          json_build_object('name', 'referrals', 'value', COALESCE(sum(registrations."referredCount"), 0) - COALESCE(sum(registrations."invitedCount"), 0)),
          json_build_object('name', 'organic', 'value', COALESCE(sum(registrations.count), 0) - COALESCE(sum(registrations."referredCount"), 0))
        ) AS data
        FROM series
        LEFT JOIN registrations ON registrations."timeBucket" = series."timeBucket"
        GROUP BY series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    },
    spenderGrowth: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), spenders AS (
          SELECT ${bucket(granularity, Prisma.sql`b."confirmedAt"`)} AS "timeBucket",
            'DOWNVOTE' AS name, count(DISTINCT b."downvoterId") AS value
          FROM "ObservedDownvote" b
          WHERE b.state = 'CONFIRMED' AND b."downvoterId" IS NOT NULL
            AND ${inRange(Prisma.sql`b."confirmedAt"`, fromDate, toDate)}
            ${downvoteScope(sub, user)}
          GROUP BY 1
          UNION ALL
          SELECT ${bucket(granularity, Prisma.sql`f."confirmedAt"`)} AS "timeBucket",
            'POSTING' AS name, count(DISTINCT p."userId") AS value
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED' AND f."feeType" = 'POSTING'
            AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
            ${feeScope(sub, user)}
          GROUP BY 1
          UNION ALL
          SELECT ${bucket(granularity, Prisma.sql`f."confirmedAt"`)} AS "timeBucket",
            'TERRITORY' AS name, count(DISTINCT p."userId") AS value
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED' AND f."feeType" IN ('TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE')
            AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
            ${feeScope(sub, user)}
          GROUP BY 1
        ), totals AS (
          SELECT "timeBucket", count(DISTINCT "userId") AS value FROM (
            SELECT ${bucket(granularity, Prisma.sql`b."confirmedAt"`)} AS "timeBucket", b."downvoterId" AS "userId"
            FROM "ObservedDownvote" b
            WHERE b.state = 'CONFIRMED' AND b."downvoterId" IS NOT NULL
              AND ${inRange(Prisma.sql`b."confirmedAt"`, fromDate, toDate)}
              ${downvoteScope(sub, user)}
            UNION ALL
            SELECT ${bucket(granularity, Prisma.sql`f."confirmedAt"`)} AS "timeBucket", p."userId"
            FROM "FeeObservation" f
            JOIN "PayIn" p ON p.id = f."payInId"
            WHERE f.state = 'CONFIRMED'
              AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
              ${feeScope(sub, user)}
          ) x
          GROUP BY 1
        )
        SELECT series."timeBucket" AS time,
          (COALESCE(jsonb_agg(jsonb_build_object('name', spenders.name, 'value', spenders.value)) FILTER (WHERE spenders.name IS NOT NULL), '[]'::jsonb)
            || COALESCE((SELECT jsonb_build_array(jsonb_build_object('name', 'total', 'value', t.value)) FROM totals t WHERE t."timeBucket" = series."timeBucket"), '[]'::jsonb)) AS data
        FROM series
        LEFT JOIN spenders ON spenders."timeBucket" = series."timeBucket"
        GROUP BY series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    },
    spendingGrowth: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), spends AS (
          SELECT ${bucket(granularity, Prisma.sql`b."confirmedAt"`)} AS "timeBucket",
            'DOWNVOTE' AS name, sum(b.piconeros) AS value
          FROM "ObservedDownvote" b
          WHERE b.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`b."confirmedAt"`, fromDate, toDate)}
            ${downvoteScope(sub, user)}
          GROUP BY 1
          UNION ALL
          SELECT ${bucket(granularity, Prisma.sql`f."confirmedAt"`)} AS "timeBucket",
            CASE WHEN f."feeType" = 'POSTING' THEN 'POSTING' ELSE 'TERRITORY' END AS name,
            sum(f.piconeros) AS value
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
            ${feeScope(sub, user)}
          GROUP BY 1, 2
        )
        SELECT series."timeBucket" AS time,
          COALESCE(
            jsonb_agg(jsonb_build_object('name', spends.name, 'value', spends.value / 1000)) FILTER (WHERE spends.name IS NOT NULL),
            '[]'::jsonb
          ) AS data
        FROM series
        LEFT JOIN spends ON spends."timeBucket" = series."timeBucket"
        GROUP BY series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    },
    itemGrowth: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), spends AS (
          SELECT ${bucket(granularity, Prisma.sql`b."confirmedAt"`)} AS "timeBucket",
            'DOWNVOTE' AS name, COUNT(*) AS value
          FROM "ObservedDownvote" b
          WHERE b.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`b."confirmedAt"`, fromDate, toDate)}
            ${downvoteScope(sub, user)}
          GROUP BY 1
          UNION ALL
          SELECT ${bucket(granularity, Prisma.sql`f."confirmedAt"`)} AS "timeBucket",
            CASE WHEN f."feeType" = 'POSTING' THEN 'POSTING' ELSE 'TERRITORY' END AS name,
            COUNT(*) AS value
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED'
            AND ${inRange(Prisma.sql`f."confirmedAt"`, fromDate, toDate)}
            ${feeScope(sub, user)}
          GROUP BY 1, 2
        )
        SELECT series."timeBucket" AS time,
          COALESCE(
            jsonb_agg(jsonb_build_object('name', spends.name, 'value', spends.value)) FILTER (WHERE spends.name IS NOT NULL),
            '[]'::jsonb
          ) AS data
        FROM series
        LEFT JOIN spends ON spends."timeBucket" = series."timeBucket"
        GROUP BY series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    },
    stasherGrowth: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), stashers AS (
          SELECT ${bucket(granularity, Prisma.sql`t."confirmedAt"`)} AS "timeBucket",
            count(DISTINCT ma."ownerUserId") AS value
          FROM "ObservedTip" t
          JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
          WHERE t.state = 'CONFIRMED'
            AND ma."ownerUserId" IS NOT NULL
            AND ${inRange(Prisma.sql`t."confirmedAt"`, fromDate, toDate)}
            ${tipScope(sub, user)}
          GROUP BY 1
        )
        SELECT series."timeBucket" AS time,
          jsonb_build_array(
            jsonb_build_object('name', 'TIP', 'value', COALESCE(stashers.value, 0)),
            jsonb_build_object('name', 'total', 'value', COALESCE(stashers.value, 0))
          ) AS data
        FROM series
        LEFT JOIN stashers ON stashers."timeBucket" = series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    },
    stashingGrowth: async (parent, { when, to, from, sub: subName, mine }, ctx) => {
      const { me, models } = ctx
      const { granularity, series, fromDate, toDate } = timeHelper(when, from, to)
      const sub = await findSub(subName, ctx)
      const user = sliceUser(sub, mine ? me : null)

      return await models.$queryRaw`
        WITH series AS (
          ${series}
        ), tips AS (
          SELECT ${bucket(granularity, Prisma.sql`t."confirmedAt"`)} AS "timeBucket",
            sum(t.piconeros) AS value
          FROM "ObservedTip" t
          JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
          WHERE t.state = 'CONFIRMED'
            AND ma."ownerUserId" IS NOT NULL
            AND ${inRange(Prisma.sql`t."confirmedAt"`, fromDate, toDate)}
            ${tipScope(sub, user)}
          GROUP BY 1
        )
        SELECT series."timeBucket" AS time,
          jsonb_build_array(
            jsonb_build_object('name', 'TIP', 'value', COALESCE(tips.value, 0) / 1000)
          ) AS data
        FROM series
        LEFT JOIN tips ON tips."timeBucket" = series."timeBucket"
        ORDER BY series."timeBucket" ASC`
    }
  }
}
