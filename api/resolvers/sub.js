import { whenRange } from '@/lib/time'
import { validateSchema, territorySchema, subBrandingSchema } from '@/lib/validate'
import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { notifyTerritoryTransfer } from '@/lib/webPush'
import pay from '../payIn'
import { GqlAuthenticationError, GqlInputError, GqlAuthorizationError } from '@/lib/error'
import { uploadIdsFromText } from './upload'
import { Prisma } from '@prisma/client'
import { lexicalHTMLGenerator } from '@/lib/lexical/server/html'
import { DOMAIN_BETA_IDS } from '@/lib/constants'

export async function getSub (parent, { name }, { models, me }) {
  if (!name) return null

  return await models.sub.findUnique({
    where: {
      name
    },
    ...(me
      ? {
          include: {
            MuteSub: {
              where: {
                userId: Number(me?.id)
              }
            },
            SubSubscription: {
              where: {
                userId: Number(me?.id)
              }
            }
          }
        }
      : {})
  })
}

export async function topSubs (parent, { query, cursor, when, from, to, limit, by = 'stacked' }, { models, me }) {
  const decodedCursor = decodeCursor(cursor)
  const [fromDate, toDate] = whenRange(when, from, to || decodeCursor.time)

  let column
  switch (by) {
    case 'spent': column = Prisma.sql`spent`; break
    case 'stacked': column = Prisma.sql`stacked`; break
    case 'items': column = Prisma.sql`nitems`; break
    default: throw new GqlInputError('invalid sort')
  }

  const subs = await models.$queryRaw`
    WITH user_subs AS (
      ${query}
    ),
    sub_stacked AS (
      SELECT user_subs.name, sum(t.piconeros)::bigint AS stacked
      FROM user_subs
      JOIN "Item" i ON i."subName" = user_subs.name
      JOIN "ObservedTip" t ON t."postId" = i.id
      WHERE t.state = 'CONFIRMED'
        AND t."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
        AND t."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      GROUP BY user_subs.name
    ),
    sub_spent AS (
      SELECT user_subs.name, sum(x.piconeros)::bigint AS spent
      FROM user_subs
      JOIN (
        SELECT i."subName" AS name, d.piconeros
        FROM "ObservedDownvote" d
        JOIN "Item" i ON i.id = d."postId"
        WHERE d.state = 'CONFIRMED'
          AND d."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND d."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
        UNION ALL
        SELECT i."subName" AS name, f.piconeros
        FROM "FeeObservation" f
        JOIN "Item" i ON i.id = f."postId"
        WHERE f.state = 'CONFIRMED' AND f."feeType" = 'POSTING'
          AND f."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND f."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
        UNION ALL
        SELECT f."subName" AS name, f.piconeros
        FROM "FeeObservation" f
        WHERE f.state = 'CONFIRMED' AND f."feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE')
          AND f."subName" IS NOT NULL
          AND f."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND f."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      ) x ON x.name = user_subs.name
      GROUP BY user_subs.name
    ),
    sub_items AS (
      SELECT user_subs.name, count(*)::int AS nitems
      FROM user_subs
      JOIN "Item" i ON i."subName" = user_subs.name
      JOIN "PayIn" p ON p.id = i."feePayInId"
      WHERE p."payInType" = 'ITEM_CREATE' AND p."payInState" = 'PAID'
        AND p."payInStateChangedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
        AND p."payInStateChangedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      GROUP BY user_subs.name
    ),
    sub_stats AS (
      SELECT user_subs.name,
        COALESCE(sub_stacked.stacked, 0) AS stacked,
        COALESCE(sub_spent.spent, 0) AS spent,
        COALESCE(sub_items.nitems, 0) AS nitems
      FROM user_subs
      LEFT JOIN sub_stacked ON sub_stacked.name = user_subs.name
      LEFT JOIN sub_spent ON sub_spent.name = user_subs.name
      LEFT JOIN sub_items ON sub_items.name = user_subs.name
    )
    SELECT "Sub".*, sub_stats.name, sub_stats.stacked, sub_stats.spent, sub_stats.nitems, COALESCE("Sub"."postTypes", '{}') AS "postTypes"
    FROM sub_stats
    JOIN "Sub" ON sub_stats.name = "Sub".name
    ORDER BY ${column} DESC NULLS LAST, "Sub".created_at ASC
    OFFSET ${decodedCursor.offset}
    LIMIT ${limit}`

  return {
    cursor: subs.length === limit ? nextCursorEncoded(decodedCursor, limit) : null,
    subs
  }
}

export default {
  Query: {
    sub: getSub,
    subSuggestions: async (parent, { q, limit }, { models }) => {
      let subs = []
      subs = await models.$queryRaw`
          SELECT name
          FROM "Sub"
          WHERE status IN ('ACTIVE', 'GRACE')
          ${q ? Prisma.sql`AND SIMILARITY(name, ${q}) > 0.1` : Prisma.empty}
          ${q ? Prisma.sql`ORDER BY SIMILARITY(name, ${q}) DESC` : Prisma.sql`ORDER BY name ASC`}
          LIMIT ${limit}`

      return subs
    },
    subs: async (parent, { subNames }, { models, me }) => {
      if (!subNames || !subNames.length) {
        return []
      }

      return await models.sub.findMany({
        where: {
          name: { in: subNames }
        }
      })
    },
    activeSubs: async (parent, args, { models, me, userLoader }) => {
      if (me) {
        const currentUser = await userLoader.load(me.id)
        const showNsfw = currentUser ? currentUser.nsfwMode : false

        return await models.$queryRaw`
          SELECT "Sub".*, "Sub".created_at as "createdAt", COALESCE("Sub"."postTypes", '{}') AS "postTypes", ss."userId" IS NOT NULL as "meSubscription", COALESCE(json_agg("MuteSub".*) FILTER (WHERE "MuteSub"."userId" IS NOT NULL), '[]') AS "MuteSub"
          FROM "Sub"
          LEFT JOIN "SubSubscription" ss ON "Sub".name = ss."subName" AND ss."userId" = ${me.id}::INTEGER
          LEFT JOIN "MuteSub" ON "Sub".name = "MuteSub"."subName" AND "MuteSub"."userId" = ${me.id}::INTEGER
          WHERE status <> 'STOPPED' AND "Sub".name NOT LIKE '\\_p4downvote\\_%' ${showNsfw ? Prisma.empty : Prisma.sql`AND ("Sub"."nsfw" = FALSE OR "Sub"."userId" = ${me.id}::INTEGER)`}
          GROUP BY "Sub".name, ss."userId", "MuteSub"."userId"
          ORDER BY "Sub".name ASC
        `
      }

      return await models.sub.findMany({
        where: {
          status: {
            not: 'STOPPED'
          },
          nsfw: false,
          name: {
            not: {
              startsWith: '_p4downvote_'
            }
          }
        },
        orderBy: {
          name: 'asc'
        }
      })
    },
    subLatestPost: async (parent, { name }, { models, me }) => {
      const latest = await models.item.findFirst({
        where: {
          subName: name
        },
        orderBy: {
          createdAt: 'desc'
        }
      })

      return latest?.createdAt
    },
    topSubs: async (parent, { cursor, when, by = 'stacked', from, to, limit }, { models, me }) => {
      const query = Prisma.sql`
        SELECT "Sub".name, "Sub".id
        FROM "Sub"
        WHERE "Sub".status <> 'STOPPED'
        AND "Sub".name NOT LIKE '\\_p4downvote\\_%'
        GROUP BY "Sub".name
      `

      return await topSubs(parent, { query, cursor, when, from, to, limit, by }, { models, me })
    },
    userSubs: async (parent, { name, cursor, when, by = 'stacked', from, to, limit }, { models, me }) => {
      if (!name) {
        throw new GqlInputError('must supply user name')
      }

      const query = Prisma.sql`
        SELECT "Sub".name, "Sub".id
        FROM "Sub"
        JOIN users ON users.id = "Sub"."userId" AND users.name = ${name}
        WHERE "Sub".status <> 'STOPPED'
        GROUP BY "Sub".name
      `

      return await topSubs(parent, { query, cursor, when, from, to, limit, by }, { models, me })
    },
    mySubscribedSubs: async (parent, { cursor }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const query = Prisma.sql`
        SELECT "Sub".name, "Sub".id
        FROM "SubSubscription"
        JOIN "Sub" ON "SubSubscription"."subName" = "Sub".name
        WHERE "SubSubscription"."userId" = ${me.id}
        AND "Sub".status <> 'STOPPED'
        GROUP BY "Sub".name
      `

      const { subs, cursor: mySubscribedSubsCursor } = await topSubs(parent, { query, cursor, when: 'forever', limit: LIMIT }, { models, me })
      return {
        cursor: mySubscribedSubsCursor,
        subs: subs.map(sub => ({
          ...sub,
          meSubscription: true
        }))
      }
    }
  },
  Mutation: {
    upsertSub: async (parent, { ...data }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await validateSchema(territorySchema, data, { models, me, sub: { name: data.oldName } })

      data.uploadIds = uploadIdsFromText(data.desc)

      if (data.oldName) {
        return await updateSub(parent, data, { me, models })
      } else {
        return await createSub(parent, data, { me, models })
      }
    },
    paySub: async (parent, { name, sendProtocolId }, { me, models }) => {
      // check that they own the sub
      const sub = await models.sub.findUnique({
        where: {
          name
        }
      })

      if (!sub) {
        throw new GqlInputError('sub not found')
      }

      if (sub.userId !== me.id) {
        throw new GqlInputError('you do not own this sub')
      }

      if (sub.status === 'ACTIVE') {
        return sub
      }

      return await pay('TERRITORY_BILLING', { name }, { me, models, sendProtocolId })
    },
    toggleMuteSub: async (parent, { name }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const lookupData = { userId: Number(me.id), subName: name }
      const where = { userId_subName: lookupData }
      const existing = await models.muteSub.findUnique({ where })
      if (existing) {
        await models.muteSub.delete({ where })
        return false
      } else {
        await models.muteSub.create({ data: { ...lookupData } })
        return true
      }
    },
    toggleSubSubscription: async (sub, { name }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const lookupData = { userId: me.id, subName: name }
      const where = { userId_subName: lookupData }
      const existing = await models.subSubscription.findUnique({ where })
      if (existing) {
        await models.subSubscription.delete({ where })
        return false
      } else {
        await models.subSubscription.create({ data: lookupData })
        return true
      }
    },
    transferTerritory: async (parent, { subName, userName }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const sub = await models.sub.findUnique({
        where: {
          name: subName
        }
      })
      if (!sub) {
        throw new GqlInputError('sub not found')
      }
      if (sub.userId !== me.id) {
        throw new GqlInputError('you do not own this sub')
      }

      const user = await models.user.findFirst({ where: { name: userName } })
      if (!user) {
        throw new GqlInputError('user not found')
      }
      if (user.id === me.id) {
        throw new GqlInputError('cannot transfer territory to yourself')
      }

      const [, updatedSub] = await models.$transaction([
        models.territoryTransfer.create({ data: { subName, oldUserId: me.id, newUserId: user.id } }),
        models.sub.update({ where: { name: subName }, data: { userId: user.id, billingAutoRenew: false } })
      ])

      notifyTerritoryTransfer({ models, sub, to: user })

      return updatedSub
    },
    unarchiveTerritory: async (parent, { sendProtocolId, ...data }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const { name } = data

      await validateSchema(territorySchema, data, { models, me })

      const oldSub = await models.sub.findUnique({ where: { name } })
      if (!oldSub) {
        throw new GqlInputError('sub not found')
      }
      if (oldSub.status !== 'STOPPED') {
        throw new GqlInputError('sub is not archived')
      }
      if (oldSub.billingType === 'ONCE') {
        // sanity check. this should never happen but leaving this comment here
        // to stop error propagation just in case and document that this should never happen.
        // #defensivecode
        throw new GqlInputError('sub should not be archived')
      }

      data.uploadIds = uploadIdsFromText(data.desc)

      return await pay('TERRITORY_UNARCHIVE', data, { me, models, sendProtocolId })
    },
    upsertSubBranding: async (parent, { subName, branding }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      if (!DOMAIN_BETA_IDS.includes(Number(me.id))) {
        throw new GqlAuthorizationError('not allowed')
      }

      const sub = await models.sub.findUnique({
        where: { name: subName },
        select: { userId: true }
      })
      if (!sub) {
        throw new GqlInputError('sub not found')
      }
      if (sub.userId !== Number(me.id)) {
        throw new GqlAuthorizationError('you do not own this sub')
      }

      const domain = await models.domain.findUnique({ where: { subName } })
      if (!domain) {
        throw new GqlInputError('requires a custom domain')
      }

      const validBranding = await validateSchema(subBrandingSchema, branding)

      await models.subBranding.upsert({
        where: { subName },
        update: validBranding,
        create: { subName, ...validBranding }
      })

      return await models.sub.findUnique({ where: { name: subName } })
    }
  },
  Sub: {
    optional: sub => sub,
    user: async (sub, args, { models }) => {
      if (sub.user) {
        return sub.user
      }
      return await models.user.findUnique({ where: { id: sub.userId } })
    },
    meMuteSub: async (sub, args, { models }) => {
      if (sub.meMuteSub !== undefined) {
        return sub.meMuteSub
      }
      return sub.MuteSub?.length > 0
    },
    nitems: async (sub, { when, from, to }, { models }) => {
      if (typeof sub.nitems !== 'undefined') {
        return sub.nitems
      }
    },
    meSubscription: async (sub, args, { me, models }) => {
      if (sub.meSubscription !== undefined) {
        return sub.meSubscription
      }

      return sub.SubSubscription?.length > 0
    },
    createdAt: sub => sub.createdAt || sub.created_at,
    lexicalState: async (sub, args, { lexicalStateLoader }) => {
      if (!sub.desc) return null
      return lexicalStateLoader.load({ text: sub.desc })
    },
    html: async (sub, args, { lexicalStateLoader }) => {
      if (!sub.desc) return null
      try {
        const lexicalState = await lexicalStateLoader.load({ text: sub.desc })
        if (!lexicalState) return null
        return lexicalHTMLGenerator(lexicalState)
      } catch (error) {
        console.error('error generating HTML from Lexical State:', error)
        return null
      }
    },
    domain: async (sub, args, { me, models }) => {
      if (!canAccessDomainSettings({ sub, me })) return null
      return await models.domain.findUnique({
        where: { subName: sub.name },
        include: { records: true, attempts: true }
      })
    },
    branding: async (sub, args, { me, models }) => {
      if (!canAccessDomainSettings({ sub, me })) return null
      return await models.subBranding.findUnique({ where: { subName: sub.name } })
    }
  }
}

/** one can access domain settings if they are beta tester and the sub is owned by them */
function canAccessDomainSettings ({ sub, me }) {
  if (!me) return false
  if (!DOMAIN_BETA_IDS.includes(Number(me.id))) return false
  if (Number(sub.userId) !== Number(me.id)) return false
  return true
}

async function createSub (parent, { sendProtocolId, ...data }, { me, models }) {
  try {
    return await pay('TERRITORY_CREATE', data, { me, models, sendProtocolId })
  } catch (error) {
    if (error.code === 'P2002') {
      throw new GqlInputError('name taken')
    }
    throw error
  }
}

async function updateSub (parent, { oldName, sendProtocolId, ...data }, { me, models }) {
  const oldSub = await models.sub.findUnique({
    where: {
      name: oldName,
      userId: me.id,
      // this function's logic is only valid if the sub is not stopped
      // so prevent updates to stopped subs
      status: {
        not: 'STOPPED'
      }
    }
  })

  if (!oldSub) {
    throw new GqlInputError('sub not found')
  }

  try {
    return await pay('TERRITORY_UPDATE', { oldName, ...data }, { me, models, sendProtocolId })
  } catch (error) {
    if (error.code === 'P2002') {
      throw new GqlInputError('name taken')
    }
    throw error
  }
}
