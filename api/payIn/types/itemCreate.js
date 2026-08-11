import { ANON_COMMENT_FEE_MULTIPLIER, ANON_ITEM_SPAM_INTERVAL, ANON_POST_FEE_MULTIPLIER, ITEM_SPAM_INTERVAL, PAID_ACTION_PAYMENT_METHODS, USER_ID } from '@/lib/constants'
import { notifyItemMention, notifyItemParents, notifyMention, notifyTerritorySubscribers, notifyUserSubscribers, notifyThreadSubscribers } from '@/lib/webPush'
import { getItemMentions, getMentions, performBotBehavior } from '../lib/item'
import { extractMentions } from '@/lib/lexical/server/mentions'
import { GqlInputError } from '@/lib/error'
import { getItem } from '@/api/resolvers/item'
import { getTempImgproxyUrls } from '../lib/upload'
import { incrementFreeCommentCount, incrementFreePostCount } from '../lib/freebie'
import { canPostFree, postingFeePiconeros, commentsFreeLeft, postsFreeLeft } from '@/api/monero/postingFee'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import { uploadFees } from '@/api/resolvers/upload'
import * as MEDIA_UPLOAD from './mediaUpload'

export const anonable = true

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.OPTIMISTIC,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

// 10x spam-fee escalation: the flat posting/comment fee is multiplied by
// 10^(item_spam count) — the author's prior posts, or self-replies to this
// parent, within the window. Anons use interval '0' so item_spam returns 0
// (their x10 is a separate multiplier handled in the anon branch).
async function escalatedFeePiconeros (models, { parentId, userId, basePiconeros }) {
  if (basePiconeros <= 0n) return basePiconeros
  const within = userId === USER_ID.anon ? ANON_ITEM_SPAM_INTERVAL : ITEM_SPAM_INTERVAL
  const [{ n }] = await models.$queryRaw`
    SELECT item_spam(${parentId ? parseInt(parentId) : null}::INTEGER, ${userId}::INTEGER, ${within}::INTERVAL)::INTEGER AS n`
  return basePiconeros * 10n ** BigInt(n)
}

export async function getInitial (models, args, { me }) {
  // StasherNews posting-fee gate (spec §6.2, Q5). Posting is free for established
  // users (stacked >= 1e10 piconeros AND age >= 7d); low-rep users pay a posting fee
  // to the platform rewards wallet before their post goes live.
  //
  // piconeros is 0 in BOTH cases — StasherNews does not charge custodial sats for
  // posting. The fee (when required) is on-chain Monero to a rewards-wallet fee
  // subaddress, observed by the rewardsWalletObserver. The SN payIn engine therefore sees
  // piconeros=0 -> payInState=PAID; the post's VISIBILITY is gated independently by
  // Item.feeStatus (set in onBegin), which the rewardsWalletObserver flips PENDING_FEE ->
  // FEE_PAID when it observes the fee output.
  // Comments are free within the 15/month freebie quota; beyond it each comment
  // costs the flat comment fee (see below).
  const beneficiaries = []
  let uploadFeesPiconeros = 0n
  if (args.uploadIds?.length) {
    const fees = await uploadFees(args.uploadIds, { models, me })
    uploadFeesPiconeros = fees.totalFeesPiconeros
    beneficiaries.push(await MEDIA_UPLOAD.getInitial(models, { uploadIds: args.uploadIds }, { me }))
  }

  if (args.parentId) {
    // StasherNews comment fee (spec §6.2): comments are free while the author has
    // freebies left (15/month for all users); beyond the quota each comment costs
    // the flat comment fee (postingFeeFloorPiconeros) to the platform rewards
    // wallet, observed by the rewardsWalletObserver like the posting fee. Anon comments
    // pay the comment fee x ANON_COMMENT_FEE_MULTIPLIER.
    if (me.id === USER_ID.anon) {
      // anon has no freebie quota and pays the comment fee x ANON_COMMENT_FEE_MULTIPLIER.
      // No spam escalation: ANON_ITEM_SPAM_INTERVAL '0' -> item_spam returns 0.
      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      if (!config) throw new GqlInputError('fee config not initialized')
      const fee = postingFeePiconeros(config) * BigInt(ANON_COMMENT_FEE_MULTIPLIER)
      const sub = await reserveFeeSubaddress(models, 'POSTING')
      const moneroUri = buildMoneroUri(
        [{ address: sub.address, amount: fee + uploadFeesPiconeros }],
        { description: 'StasherNews anon comment fee' }
      )
      return {
        payInType: 'ITEM_CREATE',
        userId: me.id,
        piconeros: 0n,
        moneroUri,
        moneroSubaddressMajor: sub.major,
        moneroSubaddressMinor: sub.minor,
        beneficiaries
      }
    }
    const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    if (!config) throw new GqlInputError('fee config not initialized')
    const commenter = await models.user.findUnique({ where: { id: me.id } })
    if (commentsFreeLeft(commenter, config) > 0) {
      if (uploadFeesPiconeros > 0n) {
        const sub = await reserveFeeSubaddress(models, 'POSTING')
        const moneroUri = buildMoneroUri(
          [{ address: sub.address, amount: uploadFeesPiconeros }],
          { description: 'StasherNews upload fee' }
        )
        return {
          payInType: 'ITEM_CREATE',
          userId: me.id,
          piconeros: 0n,
          moneroUri,
          moneroSubaddressMajor: sub.major,
          moneroSubaddressMinor: sub.minor,
          beneficiaries
        }
      }
      return { payInType: 'ITEM_CREATE', userId: me.id, piconeros: 0n }
    }
    const fee = await escalatedFeePiconeros(models, {
      parentId: args.parentId,
      userId: me.id,
      basePiconeros: postingFeePiconeros(config)
    })
    const sub = await reserveFeeSubaddress(models, 'POSTING')
    const moneroUri = buildMoneroUri(
      [{ address: sub.address, amount: fee + uploadFeesPiconeros }],
      { description: 'StasherNews comment fee' }
    )
    return {
      payInType: 'ITEM_CREATE',
      userId: me.id,
      piconeros: 0n,
      moneroUri,
      moneroSubaddressMajor: sub.major,
      moneroSubaddressMinor: sub.minor,
      beneficiaries
    }
  }
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')
  const user = await models.user.findUnique({ where: { id: me.id } })
  if (!user) throw new GqlInputError('user not found')

  const established = canPostFree(user, config)
  const postsLeft = postsFreeLeft(user, config)

  if (established && postsLeft > 0) {
    if (uploadFeesPiconeros > 0n) {
      const sub = await reserveFeeSubaddress(models, 'POSTING')
      const moneroUri = buildMoneroUri(
        [{ address: sub.address, amount: uploadFeesPiconeros }],
        { description: 'StasherNews upload fee' }
      )
      return {
        payInType: 'ITEM_CREATE',
        userId: me.id,
        piconeros: 0n,
        moneroUri,
        moneroSubaddressMajor: sub.major,
        moneroSubaddressMinor: sub.minor,
        beneficiaries
      }
    }
    return {
      payInType: 'ITEM_CREATE',
      userId: me.id,
      piconeros: 0n
    }
  }

  // Low-rep user OR established user who has exhausted the free-post quota:
  // reserve a rewards-wallet posting-fee subaddress and build the URI. The post
  // is created PENDING_FEE (invisible) until rewardsWalletObserver observes the
  // fee and flips it to FEE_PAID. Anon posts pay the flat fee x
  // ANON_POST_FEE_MULTIPLIER (no spam escalation: ANON_ITEM_SPAM_INTERVAL '0'
  // -> item_spam returns 0).
  const fee = me.id === USER_ID.anon
    ? postingFeePiconeros(config) * BigInt(ANON_POST_FEE_MULTIPLIER)
    : await escalatedFeePiconeros(models, {
      parentId: null,
      userId: me.id,
      basePiconeros: postingFeePiconeros(config)
    })
  const sub = await reserveFeeSubaddress(models, 'POSTING')
  const moneroUri = buildMoneroUri(
    [{ address: sub.address, amount: fee + uploadFeesPiconeros }],
    { description: 'StasherNews posting fee' }
  )
  return {
    payInType: 'ITEM_CREATE',
    userId: me.id,
    piconeros: 0n,
    moneroUri,
    moneroSubaddressMajor: sub.major,
    moneroSubaddressMinor: sub.minor,
    beneficiaries
  }
}

export async function validateBeforeCreate (tx, payInProspect, payInArgs, { me }) {
  if (me.id === USER_ID.anon || payInArgs.bio || (payInArgs.parentId && payInProspect.piconeros === 0n)) {
    return
  }

  const recentItems = await tx.item.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: {
      id: true,
      itemPayIns: {
        where: {
          payIn: {
            payInType: 'ITEM_CREATE',
            payInState: 'PAID'
          }
        },
        select: { payInId: true },
        take: 1
      }
    }
  })

  if (recentItems.length >= 3 && recentItems.every(item => item.itemPayIns.length === 0)) {
    throw new GqlInputError('you have too many unpaid items')
  }
}

export async function onBegin (tx, payInId, args) {
  const { parentId, uploadIds = [], options: pollOptions = [], subNames = [], ...data } = args
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })

  // StasherNews posting-fee gate: a PayIn that reserved a rewards-wallet fee
  // subaddress (moneroSubaddressMajor set) creates the Item PENDING_FEE (invisible
  // until the rewardsWalletObserver observes the fee and flips it to FEE_PAID); otherwise
  // the Item is live (FEE_NOT_REQUIRED). feeStatus is derived here from the PayIn's
  // subaddress fields rather than threaded through the prospect, since feeStatus is
  // an Item column (not a PayIn column).
  const feeStatus = payIn.moneroSubaddressMajor != null ? 'PENDING_FEE' : 'FEE_NOT_REQUIRED'

  const { userNames, itemIds } = extractMentions(args.text)
  const mentions = await getMentions(tx, { names: userNames, userId: payIn.userId })
  const itemMentions = await getItemMentions(tx, { itemIds, userId: payIn.userId })

  // start with median vote
  if (payIn.userId !== USER_ID.anon) {
    const [row] = await tx.$queryRaw`SELECT
      COALESCE(percentile_cont(0.5) WITHIN GROUP(
        ORDER BY "weightedVotes" - "weightedDownVotes"), 0)
      AS median FROM "Item" WHERE "userId" = ${payIn.userId}::INTEGER`
    if (row?.median < 0) {
      data.weightedDownVotes = -row.median
    }
  }

  const imgproxyUrls = await getTempImgproxyUrls(tx, uploadIds)

  // freebie is true when no on-chain fee is required and it's a comment or bio
  const isFreebie = payIn.moneroSubaddressMajor == null && !!(parentId || data.bio)

  const itemData = {
    parentId: parentId ? parseInt(parentId) : null,
    ...data,
    cost: Number(BigInt(payIn.piconeros) / 1000n),
    freebie: isFreebie,
    imgproxyUrls,
    feeStatus,
    feePayInId: feeStatus === 'PENDING_FEE' ? payInId : null,
    itemPayIns: {
      create: [{ payInId }]
    },
    subs: {
      createMany: {
        data: subNames.map(subName => ({ subName }))
      }
    },
    threadSubscriptions: {
      createMany: {
        data: [{ userId: data.userId }]
      }
    },
    pollOptions: {
      createMany: {
        data: pollOptions.map(option => ({ option }))
      }
    },
    itemUploads: {
      create: uploadIds.map(id => ({ uploadId: id }))
    },
    mentions: {
      createMany: {
        data: mentions
      }
    },
    itemReferrers: {
      create: itemMentions
    }
  }

  let item
  if (data.bio && payIn.userId !== USER_ID.anon) {
    item = (await tx.user.update({
      where: { id: data.userId },
      include: { bio: true },
      data: {
        bio: {
          create: itemData
        }
      }
    })).bio
  } else {
    try {
      item = await tx.item.create({ data: itemData })
    } catch (err) {
      if (err.message.includes('violates exclusion constraint \\"Item_unique_time_constraint\\"')) {
        const message = `you already submitted this ${itemData.title ? 'post' : 'comment'}`
        throw new GqlInputError(message)
      }
      throw err
    }
  }

  await performBotBehavior(tx, { ...item, userId: payIn.userId })

  return await getItem(null, { id: item.id }, { models: tx, me: { id: payIn.userId } })
}

export async function onRetry (tx, oldPayInId, newPayInId) {
  const itemPayIn = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  return await getItem(null, { id: itemPayIn.itemId }, { models: tx, me: { id: itemPayIn.payIn.userId } })
}

export async function onPaid (tx, payInId) {
  const { item, payIn } = await tx.itemPayIn.findUnique({
    where: { payInId },
    include: { item: true, payIn: true }
  })
  if (!item) {
    throw new Error('Item not found')
  }

  // If this is a freebie comment, increment the free comment counter.
  await incrementFreeCommentCount(tx, { item, userId: payIn.userId })
  // If this is a free top-level post within the monthly quota, increment the
  // free post counter. Self-guarding (no-op for comments, bios, paid posts).
  await incrementFreePostCount(tx, { item, userId: payIn.userId })

  // retry OpenTimestamps stamp up to 12x with 10 minutes spacing
  //
  // NOTE: we cannot use pgboss' backoff mechanism as its jitter is up to an entire
  // `retrydelay` period, and thus would make it possible for a parent to be
  // consistently processed after a child, making this fragile; we have to maintain
  // item creation order for this.
  // pg-boss v9 dropped the DB-side default on pgboss.job.id (uuids are now minted
  // by the JS client), so these raw INSERTs must supply it via gen_random_uuid.
  await tx.$executeRaw`INSERT INTO pgboss.job (id, name, data, startafter, priority, retrylimit, retrydelay, retrybackoff)
    VALUES (gen_random_uuid(), 'timestampItem', jsonb_build_object('id', ${item.id}::INTEGER), now() + interval '10 minutes', -2, 12, 600, false)`
  await tx.$executeRaw`
    INSERT INTO pgboss.job (id, name, data, retrylimit, retrybackoff, startafter)
    VALUES (gen_random_uuid(), 'imgproxy', jsonb_build_object('id', ${item.id}::INTEGER), 21, true, now() + interval '5 seconds')`

  if (item.parentId) {
    // denormalize ncomments, lastCommentAt, commentCost for ancestors, and insert into reply table
    // NOTE: ancestors are ORDER BY id for consistent lock ordering to prevent deadlocks
    await tx.$executeRaw`
      WITH comment AS (
        SELECT "Item".*
        FROM "Item"
        JOIN users ON "Item"."userId" = users.id
        WHERE "Item".id = ${item.id}::INTEGER
      ), ancestors AS (
        SELECT "Item".*
        FROM "Item", comment
        WHERE "Item".path @> comment.path AND "Item".id <> comment.id
        ORDER BY "Item".id
      ), updated_ancestors AS (
        UPDATE "Item"
        SET ncomments = "Item".ncomments + 1,
          "lastCommentAt" = GREATEST("Item"."lastCommentAt", comment.created_at),
          "nDirectComments" = "Item"."nDirectComments" +
            CASE WHEN comment."parentId" = "Item".id THEN 1 ELSE 0 END,
          "commentCost" = "Item"."commentCost" + comment.cost
        FROM comment, ancestors
        WHERE "Item".id = ancestors.id
        RETURNING "Item".*
      )
      INSERT INTO "Reply" (created_at, updated_at, "ancestorId", "ancestorUserId", "itemId", "userId", level)
        SELECT comment.created_at, comment.updated_at, ancestors.id, ancestors."userId",
          comment.id, comment."userId", nlevel(comment.path) - nlevel(ancestors.path)
        FROM ancestors, comment`
  }
}

export async function onPaidSideEffects (models, payInId) {
  const { item } = await models.itemPayIn.findUnique({
    where: { payInId },
    include: {
      item: {
        include: {
          mentions: true,
          itemReferrers: { include: { refereeItem: true } },
          user: true
        }
      }
    }
  })

  // StasherNews: a PENDING_FEE post is not live yet (invisible until the
  // rewardsWalletObserver observes its posting fee and flips feeStatus to FEE_PAID), so
  // suppress all creation notifications here. They will fire once the post goes live.
  if (item.feeStatus === 'PENDING_FEE') {
    return
  }

  if (item.parentId) {
    notifyItemParents({ item, models }).catch(console.error)
    notifyThreadSubscribers({ models, item }).catch(console.error)
  }
  for (const { userId } of item.mentions) {
    notifyMention({ models, item, userId }).catch(console.error)
  }
  for (const { refereeItem } of item.itemReferrers) {
    notifyItemMention({ models, referrerItem: item, refereeItem }).catch(console.error)
  }

  notifyUserSubscribers({ models, item }).catch(console.error)
  notifyTerritorySubscribers({ models, item }).catch(console.error)
}

export async function describe (models, payInId) {
  const itemPayIn = await models.itemPayIn.findUnique({ where: { payInId }, include: { item: true } })
  if (itemPayIn?.item) {
    return `SN: create ${itemPayIn.item.parentId ? `reply #${itemPayIn.item.id} to #${itemPayIn.item.parentId}` : `post #${itemPayIn.item.id}`}`
  }
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { pessimisticEnv: true } })
  if (payIn.pessimisticEnv?.args) {
    const { subNames, parentId, bio } = payIn.pessimisticEnv.args
    if (bio) {
      return 'SN: create bio'
    }
    if (parentId) {
      return `SN: create reply to #${parentId}`
    }
    return `SN: create post in ${subNames.join(', ')}`
  }
  return 'SN: create item'
}
