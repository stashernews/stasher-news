import { whenRange } from '@/lib/time'
import { validateSchema, territorySchema, subBrandingSchema } from '@/lib/validate'
import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { notifyTerritoryTransfer } from '@/lib/webPush'
import pay from '../payIn'
import { GqlAuthenticationError, GqlInputError, GqlAuthorizationError } from '@/lib/error'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { uploadIdsFromText } from './upload'
import { Prisma } from '@prisma/client'
import { lexicalHTMLGenerator } from '@/lib/lexical/server/html'
import { DOMAIN_BETA_IDS, ACTIVE_SUBS_PRIORITY } from '@/lib/constants'
import { territoryReentryFunding, territoryFeePiconeros } from '@/api/monero/territoryFee'
import { NEVER_SEEN_FEE_PAY_IN_TYPES, isHiddenFromViewer } from '@/lib/territoryVisibility'

export async function getSub (parent, { name }, { models, me }) {
  if (!name) return null

  const sub = await models.sub.findUnique({
    where: {
      name
    },
    // never-seen PENDING_FEE gate: the billing PayIn's type discriminates
    // a fresh create/unarchive (hidden) from a renewal (visible mid-grace)
    include: {
      billingPayIn: {
        select: {
          payInType: true
        }
      },
      ...(me
        ? {
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
        : {})
    }
  })

  // never-seen PENDING_FEE turf: null for anon/strangers -> SSR notFound 404s
  // the /~name page; the owner gets it (they must be able to reach it to pay)
  if (isHiddenFromViewer(sub, me)) return null

  return sub
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
    -- counts items whose posting-fee PayIn is PAID (Item.feePayInId); free
    -- posts (feePayInId null) are excluded, paid comments may count - this
    -- is a fee-gated items count, not all posts in the sub
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
    subSuggestions: async (parent, { q, limit }, { models, me }) => {
      let subs = []
      subs = await models.$queryRaw`
          SELECT name
          FROM "Sub"
          LEFT JOIN "PayIn" bp ON bp.id = "Sub"."billingPayInId"
          WHERE status IN ('ACTIVE', 'GRACE') AND ${subVisibilityClause(me)}
          ${q ? Prisma.sql`AND SIMILARITY(name, ${q}) > 0.1` : Prisma.empty}
          ${q ? Prisma.sql`ORDER BY SIMILARITY(name, ${q}) DESC` : Prisma.sql`ORDER BY name ASC`}
          LIMIT ${limit}`

      return subs
    },
    subs: async (parent, { subNames }, { models, me }) => {
      if (!subNames || !subNames.length) {
        return []
      }

      const subs = await models.sub.findMany({
        where: {
          name: { in: subNames }
        },
        include: {
          billingPayIn: {
            select: {
              payInType: true
            }
          }
        }
      })

      // never-seen PENDING_FEE gate: hide from anon/strangers; the owner override
      // keeps their own pending turf reachable by name (mirrors getSub)
      return subs.filter(sub => !isHiddenFromViewer(sub, me))
    },
    activeSubs: async (parent, args, { models, me, userLoader }) => {
      if (me) {
        const currentUser = await userLoader.load(me.id)
        const showNsfw = currentUser ? currentUser.nsfwMode : false

        return sortActiveSubs(await models.$queryRaw`
          SELECT "Sub".*, "Sub".created_at as "createdAt", COALESCE("Sub"."postTypes", '{}') AS "postTypes", ss."userId" IS NOT NULL as "meSubscription", COALESCE(json_agg("MuteSub".*) FILTER (WHERE "MuteSub"."userId" IS NOT NULL), '[]') AS "MuteSub"
          FROM "Sub"
          LEFT JOIN "PayIn" bp ON bp.id = "Sub"."billingPayInId"
          LEFT JOIN "SubSubscription" ss ON "Sub".name = ss."subName" AND ss."userId" = ${me.id}::INTEGER
          LEFT JOIN "MuteSub" ON "Sub".name = "MuteSub"."subName" AND "MuteSub"."userId" = ${me.id}::INTEGER
          WHERE status <> 'STOPPED' AND "Sub".name NOT LIKE '\\_p4downvote\\_%' AND ${subVisibilityClause(me)} ${showNsfw ? Prisma.empty : Prisma.sql`AND ("Sub"."nsfw" = FALSE OR "Sub"."userId" = ${me.id}::INTEGER)`}
          GROUP BY "Sub".name, ss."userId", "MuteSub"."userId"
          ORDER BY "Sub".name ASC
        `)
      }

      return sortActiveSubs(await models.sub.findMany({
        where: {
          status: {
            not: 'STOPPED'
          },
          nsfw: false,
          name: {
            not: {
              startsWith: '_p4downvote_'
            }
          },
          OR: [
            { billingStatus: { not: 'PENDING_FEE' } },
            { billingPayInId: null },
            { billingPayIn: { isNot: { payInType: { in: NEVER_SEEN_FEE_PAY_IN_TYPES } } } }
          ]
        },
        orderBy: {
          name: 'asc'
        }
      }))
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
        LEFT JOIN "PayIn" bp ON bp.id = "Sub"."billingPayInId"
        WHERE "Sub".status <> 'STOPPED'
        AND "Sub".name NOT LIKE '\\_p4downvote\\_%'
        AND ${subVisibilityClause(me)}
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
        LEFT JOIN "PayIn" bp ON bp.id = "Sub"."billingPayInId"
        JOIN users ON users.id = "Sub"."userId" AND users.name = ${name}
        WHERE "Sub".status <> 'STOPPED'
        AND ${subVisibilityClause(me)}
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
        LEFT JOIN "PayIn" bp ON bp.id = "Sub"."billingPayInId"
        WHERE "SubSubscription"."userId" = ${me.id}
        AND "Sub".status <> 'STOPPED'
        AND ${subVisibilityClause(me)}
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

      // An ACTIVE turf with nothing pending returns the sub itself (no payIn).
      // A PENDING_FEE turf (fresh create or underpaid renewal) falls through to
      // the payment path below — the old bare ACTIVE early-return swallowed the
      // re-pay for fresh creates (status defaults ACTIVE even while PENDING_FEE).
      if (sub.status === 'ACTIVE' && sub.billingStatus !== 'PENDING_FEE') {
        return sub
      }

      // Re-entry: a PENDING_FEE turf with a billing PayIn gets the SAME subaddress
      // back with a remainder-quoted URI — no new PayIn, no new subaddress, no
      // re-point of billingPayInId. Top-ups to the original address now complete
      // the fee instead of stranding partials on an orphaned subaddress.
      const reentry = await territoryReentryFunding(models, sub)
      if (reentry) {
        return {
          ...reentry.payIn,
          moneroUri: reentry.moneroUri,
          receivedPiconeros: reentry.receivedPiconeros,
          expectedPiconeros: reentry.expectedPiconeros
        }
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
    },
    // StasherNews owner-gated turf fee fields (pending-fee modal hint). Null for
    // non-owners; received is the FeeObservation sum for the billing PayIn, expected
    // is the FULL fee quoted in the billing PayIn's stored URI (config fallback for
    // a legacy URI-less row).
    feeReceivedPiconeros: async (sub, args, { me, models }) => {
      if (!me || Number(sub.userId) !== Number(me.id)) return null
      if (!sub.billingPayInId) return 0n
      const agg = await models.feeObservation.aggregate({
        _sum: { piconeros: true },
        where: { payInId: sub.billingPayInId }
      })
      return agg._sum.piconeros ?? 0n
    },
    billingFeePiconeros: async (sub, args, { me, models }) => {
      if (!me || Number(sub.userId) !== Number(me.id)) return null
      if (!sub.billingPayInId) return null
      const payIn = await models.payIn.findUnique({ where: { id: sub.billingPayInId } })
      if (!payIn) return null
      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      return moneroUriAmountPiconeros(payIn.moneroUri) ?? territoryFeePiconeros(sub.billingType, config)
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

// Pin the priority turfs (monero, bitcoin, crypto) to the top of the dropdown in
// order; everything else keeps its alphabetical order (stable sort preserves it).
function sortActiveSubs (subs) {
  const priority = new Map(ACTIVE_SUBS_PRIORITY.map((name, i) => [name, i]))
  return [...subs].sort((a, b) =>
    (priority.get(a.name) ?? Infinity) - (priority.get(b.name) ?? Infinity))
}

// Never-seen PENDING_FEE turf visibility clause (spec 2026-08-17-turf-visibility-gate-design.md).
// AND-ed onto the existing status-based WHERE. Requires a `LEFT JOIN "PayIn" bp
// ON bp.id = "Sub"."billingPayInId"` in the query. Visible iff not a never-seen
// PENDING_FEE turf (renewal/update payIns and legacy no-payIn rows pass), or the
// viewer is its owner.
function subVisibilityClause (me) {
  return Prisma.sql`("Sub"."billingStatus" <> 'PENDING_FEE'
    OR "Sub"."billingPayInId" IS NULL
    OR bp."payInType"::text NOT IN (${Prisma.join(NEVER_SEEN_FEE_PAY_IN_TYPES)})
    ${me ? Prisma.sql`OR "Sub"."userId" = ${me.id}` : Prisma.empty})`
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
