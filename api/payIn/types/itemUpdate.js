import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'
import { alert } from '@/lib/alert'
import { logWarn } from '@/lib/logger'
import { uploadFees } from '../../resolvers/upload'
import { getItemMentions, getMentions, performBotBehavior, getSubs } from '../lib/item'
import { extractMentions } from '@/lib/lexical/server/mentions'
import { canonicalizeItemText } from '@/lib/url'
import { notifyItemMention, notifyMention } from '@/lib/webPush'
import * as MEDIA_UPLOAD from './mediaUpload'
import { getItem } from '@/api/resolvers/item'
import { subsDiff } from '@/lib/subs'
import { moneroWallEnabled } from '@/lib/monero-wall'
import { getTempImgproxyUrls } from '../lib/upload'
import { postFloorPiconerosForSubs, postFeePiconerosForSubs } from '@/api/monero/turfFeeRouting'
import { escalatedFeePiconeros, feeLegOrSubaddress } from './itemCreate'
import { serializePayInArgs, deserializePayInArgs } from '../lib/payInArgs'

export const anonable = true

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { id, uploadIds = [], bio, subNames }, { me }) {
  const beneficiaries = []
  let uploadFeesPiconeros = 0n
  if (uploadIds.length > 0) {
    const fees = await uploadFees(uploadIds, { models, me })
    uploadFeesPiconeros = fees.totalFeesPiconeros
    beneficiaries.push(await MEDIA_UPLOAD.getInitial(models, { uploadIds }, { me }))
    // the only reason updating an item costs anything is new uploads; refuse if
    // the item has no paid ITEM_CREATE payIn to attach the upload fee to
    if (uploadFeesPiconeros > 0n) {
      const oldWithPayIns = await models.item.findUnique({
        where: { id: parseInt(id) },
        include: { itemPayIns: { where: { payIn: { payInType: 'ITEM_CREATE', payInState: 'PAID' } }, select: { payInId: true } } }
      })
      if (oldWithPayIns.itemPayIns.length === 0) throw new Error('cannot increase item cost with unpaid invoice')
    }
  }

  // R10: charge for turfs ADDED by this edit, exactly as creation would price
  // them — the escalated platform floor for every added non-owned turf, with
  // the owner premium riding the owner-direct leg when the added set resolves
  // to one walleted owner and no upload fees are folded in (feeLegOrSubaddress
  // owns that decision). Additions only: removals and owned-turf additions are
  // free. Top-level posts only — the resolver strips comments and bios to
  // text-only edits — and only when the client actually sent subNames
  // (applyItemUpdate's [] default is deliberately untouched for callers that
  // omit the field).
  //
  // Turf repost (2026-09-24): updateItem now rejects any turf change, so this
  // edit-adds-turf fee path is reached only through repostItem, which adds
  // exactly one turf per call. The multi-add math below remains as engine
  // defense and is exercised only by direct pay calls in tests
  // (test/engine/payInItemUpdate.test.js).
  let addedSubs = []
  let turfFeePiconeros = 0n
  let turfPremiumPiconeros = 0n
  if (subNames != null) {
    const old = await models.item.findUnique({
      where: { id: parseInt(id) },
      select: { subNames: true, parentId: true }
    })
    if (old && !old.parentId) {
      addedSubs = await getSubs(models, { subNames: subsDiff(subNames, old.subNames ?? []) })
      const nonOwnedAdded = addedSubs.filter(s => Number(s.userId) !== Number(me.id))
      if (nonOwnedAdded.length > 0) {
        const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
        if (!config) throw new GqlInputError('fee config not initialized')
        turfFeePiconeros = await escalatedFeePiconeros(models, {
          parentId: null,
          userId: me.id,
          basePiconeros: postFloorPiconerosForSubs(config, nonOwnedAdded)
        })
        turfPremiumPiconeros = postFeePiconerosForSubs(config, nonOwnedAdded) - postFloorPiconerosForSubs(config, nonOwnedAdded)
      }
    }
  }

  if (turfFeePiconeros + turfPremiumPiconeros > 0n || uploadFeesPiconeros > 0n) {
    return await feeLegOrSubaddress(models, {
      subs: addedSubs,
      userId: me.id,
      fee: turfFeePiconeros,
      premiumPiconeros: turfPremiumPiconeros,
      uploadFeesPiconeros,
      description: turfFeePiconeros + turfPremiumPiconeros > 0n ? 'StasherNews posting fee' : 'StasherNews upload fee',
      payInType: 'ITEM_UPDATE',
      itemPayIn: { itemId: parseInt(id) },
      beneficiaries
    })
  }

  return {
    payInType: 'ITEM_UPDATE',
    userId: me?.id,
    piconeros: 0n,
    moneroUri: null,
    moneroSubaddressMajor: null,
    moneroSubaddressMinor: null,
    itemPayIn: { itemId: parseInt(id) },
    beneficiaries
  }
}

export async function onBegin (tx, payInId, args) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })

  // StasherNews: a fee-bearing edit (getInitial reserved a POSTING fee
  // subaddress for upload fees and/or added-turf fees, OR routed owner-direct
  // for a single added turf's fee+premium) is NOT applied here.
  // The edit is stored and rewardsWalletObserver.flipPendingToLive applies it
  // once the covering fee is observed on the rewards wallet — applying at
  // creation let a user attach >10MB media for free by dismissing the fee QR
  // (found 2026-09-17 on post 351432). A never-paid row is purged after
  // FEE_ITEM_ABANDON_DAYS and its unattached upload is reaped by
  // deleteUnusedImages.
  if (payIn.moneroSubaddressMajor != null || payIn.moneroPaymentId != null) {
    const item = await tx.item.findUnique({
      where: { id: parseInt(args.id) },
      select: { userId: true, text: true }
    })
    if (!item) throw new GqlInputError('item not found')

    await tx.pendingItemUpdate.create({
      data: {
        itemId: parseInt(args.id),
        payInId,
        oldText: item.text,
        args: serializePayInArgs(args)
      }
    })

    return await getItem(null, { id: args.id }, { models: tx, me: { id: item.userId } })
  }

  return await applyItemUpdate(tx, payIn, args)
}

// The edit body — factored out of onBegin so the observer can run it when a
// deferred edit's fee lands (applyPendingItemUpdate) and the free-edit path can
// run it immediately.
export async function applyItemUpdate (tx, payIn, args) {
  const { id, uploadIds = [], options: pollOptions = [], subNames = [], ...data } = args
  // never persist signed imgproxy preview urls: decode them to their embedded
  // source url (canonical https://<host>/uploads/N) so text survives key rotations
  if (data.text) data.text = canonicalizeItemText(data.text)

  const old = await tx.item.findUnique({
    where: { id: parseInt(id) },
    include: {
      threadSubscriptions: true,
      mentions: true,
      itemReferrers: true,
      itemUploads: true
    }
  })

  // createMany is the set difference of the new - old
  // deleteMany is the set difference of the old - new
  // updateMany is the intersection of the old and new
  const difference = (a = [], b = [], key = 'userId') => a.filter(x => !b.find(y => y[key] === x[key]))

  const { userNames, itemIds } = extractMentions(data.text)
  const mentions = await getMentions(tx, { names: userNames, userId: args.userId })
  const itemMentions = await getItemMentions(tx, { itemIds, userId: args.userId })
  const itemUploads = uploadIds.map(id => ({ uploadId: id }))

  const newUploadIds = difference(itemUploads, old.itemUploads, 'uploadId').map(({ uploadId }) => uploadId)
  const imgproxyUrls = await getTempImgproxyUrls(tx, newUploadIds, old.imgproxyUrls)

  // if it has changed concurrently
  // update cost if the update has a cost (e.g., moving to new territory ... or adding images)
  // cost is denominated in the fork's legacy sats (1 sats == 1000 piconeros)
  const additionalCost = Number(BigInt(payIn.piconeros) / 1000n)
  // Monerowall: the update path never stamps or clears the enable window.
  // Walls are created with the post (createItem stamps); removal goes
  // through the removeMoneroWall mutation only (2026-09-21 amendment).
  delete data.moneroWallEnabledAt
  // Deferred fee-bearing edits re-enter here long after assertMoneroWallWrite
  // ran (onBegin stores them; flipPendingToLive applies them once the fee
  // lands), so the resolver's freeze check can be stale: a tip observed while
  // the fee was in flight freezes the wall, yet the stored args still carry the
  // X/T delta. Re-check against the row loaded above and strip just the wall
  // keys — keeping the rest of the paid edit — when the wall is no longer
  // active or a tip has landed at/after its enable window.
  if (data.moneroWallPricePiconeros !== undefined || data.moneroWallThresholdPiconeros !== undefined) {
    let dropWall = !moneroWallEnabled(old)
    if (!dropWall) {
      // submitted legs may be BigInt, decimal strings or null (one leg
      // cleared); normalize before comparing and never let a bad value throw
      const toPiconeros = value => value == null ? null : BigInt(value)
      let changed
      try {
        const oldPrice = toPiconeros(old.moneroWallPricePiconeros)
        const oldThreshold = toPiconeros(old.moneroWallThresholdPiconeros)
        const price = data.moneroWallPricePiconeros === undefined ? oldPrice : toPiconeros(data.moneroWallPricePiconeros)
        const threshold = data.moneroWallThresholdPiconeros === undefined ? oldThreshold : toPiconeros(data.moneroWallThresholdPiconeros)
        changed = price !== oldPrice || threshold !== oldThreshold
      } catch {
        changed = true
      }
      if (changed) {
        // mirror assertMoneroWallWrite's freeze query exactly
        const detected = await tx.observedTip.findFirst({
          where: { postId: old.id, detectedAt: { gte: old.moneroWallEnabledAt }, state: { notIn: ['EXPIRED'] } },
          select: { id: true }
        })
        dropWall = !!detected
      }
    }
    if (dropWall) {
      delete data.moneroWallPricePiconeros
      delete data.moneroWallThresholdPiconeros
    }
  }
  await tx.item.update({
    where: { id: parseInt(id) },
    data: {
      ...data,
      ...(additionalCost > 0 && { cost: { increment: additionalCost } }),
      imgproxyUrls,
      pollOptions: {
        createMany: {
          data: pollOptions?.map(option => ({ option }))
        }
      },
      subs: {
        create: subsDiff(subNames, old.subNames).map(subName => ({ subName })),
        deleteMany: {
          subName: {
            in: subsDiff(old.subNames, subNames)
          }
        }
      },
      itemUploads: {
        create: difference(itemUploads, old.itemUploads, 'uploadId').map(({ uploadId }) => ({ uploadId })),
        deleteMany: {
          uploadId: {
            in: difference(old.itemUploads, itemUploads, 'uploadId').map(({ uploadId }) => uploadId)
          }
        }
      },
      mentions: {
        deleteMany: {
          userId: {
            in: difference(old.mentions, mentions).map(({ userId }) => userId)
          }
        },
        createMany: {
          data: difference(mentions, old.mentions)
        }
      },
      itemReferrers: {
        deleteMany: {
          refereeId: {
            in: difference(old.itemReferrers, itemMentions, 'refereeId').map(({ refereeId }) => refereeId)
          }
        },
        create: difference(itemMentions, old.itemReferrers, 'refereeId')
      }
    }
  })

  // propagate additional cost to ancestors if this is a comment with increased cost
  // NOTE: ancestors are ORDER BY id for consistent lock ordering to prevent deadlocks
  if (additionalCost > 0 && old.parentId) {
    await tx.$executeRaw`
      UPDATE "Item"
      SET "commentCost" = "Item"."commentCost" + ${additionalCost}::INTEGER
      FROM (
        SELECT id FROM "Item"
        WHERE path @> (SELECT path FROM "Item" WHERE id = ${parseInt(id)}::INTEGER)
          AND id <> ${parseInt(id)}::INTEGER
        ORDER BY id
      ) AS ancestors
      WHERE "Item".id = ancestors.id`
  }

  await tx.$executeRaw`
    INSERT INTO pgboss.job (name, data, retrylimit, retrybackoff, startafter, keepuntil)
    VALUES ('imgproxy', jsonb_build_object('id', ${id}::INTEGER), 21, true,
              now() + interval '5 seconds', now() + interval '1 day')`

  await performBotBehavior(tx, args)

  return await getItem(null, { id }, { models: tx, me: { id: old.userId } })
}

// Apply a deferred fee-bearing edit once its fee has been observed. Called by
// worker/rewardsWalletObserver.flipPendingToLive. The pending row is claimed
// (deleted) inside the same transaction that applies the edit, so concurrent or
// replayed flips cannot apply it twice. Returns false when there is no pending
// row, or the edit was dropped because the item is gone or changed after the
// deferral, or its uploads no longer exist — in that case the upload can be
// re-attached for free if it still exists, and the fee stays recorded.
export async function applyPendingItemUpdate (models, payIn) {
  const pending = await models.pendingItemUpdate.findUnique({ where: { payInId: payIn.id } })
  if (!pending) return false

  const applied = await models.$transaction(async tx => {
    const claimed = await tx.pendingItemUpdate.deleteMany({ where: { id: pending.id } })
    if (claimed.count === 0) return false

    // A dropped edit also drops its fee payIn: the pending row is consumed by
    // the claim above, so abandonFeeItems (which scans PendingItemUpdate rows)
    // would never reach this payIn — leaving it, its MEDIA_UPLOAD beneficiary
    // and the link rows behind forever. The fee WAS observed (this only runs
    // after coverage), so mark the linked uploads paid first — same gate as the
    // observer's shared flip — otherwise deleting the payIn would cascade the
    // UploadPayIn rows away and the payer would lose the upload exemption.
    const drop = async () => {
      await tx.$executeRaw`
        UPDATE "Upload" SET paid = true
        FROM "UploadPayIn"
        WHERE ("UploadPayIn"."payInId" = ${payIn.id}
          OR "UploadPayIn"."payInId" IN (SELECT id FROM "PayIn" WHERE "benefactorId" = ${payIn.id}))
          AND "Upload"."id" = "UploadPayIn"."uploadId"`
      await tx.payIn.deleteMany({ where: { id: payIn.id } })
      return false
    }

    const item = await tx.item.findUnique({
      where: { id: pending.itemId },
      select: { deletedAt: true, text: true, subNames: true }
    })
    if (!item || item.deletedAt) {
      logWarn('applyPendingItemUpdate: item missing/deleted; dropped deferred edit', { payInId: payIn.id, itemId: pending.itemId })
      return await drop()
    }
    if (item.text !== pending.oldText) {
      logWarn('applyPendingItemUpdate: item changed after the edit was deferred; dropped deferred edit', { payInId: payIn.id, itemId: pending.itemId })
      return await drop()
    }

    const args = deserializePayInArgs(pending.args)
    // Reposts are additive: the deferred list was captured at initiation, and a
    // concurrent repost may have landed since. Merge (union) so a paid-for turf
    // can never be deleted by a stale full-set list. Content edits carry the
    // unchanged list, so the union is a no-op for them.
    if (Array.isArray(args.subNames)) {
      args.subNames = [...new Set([...item.subNames, ...args.subNames])]
    }
    const uploadIds = args.uploadIds ?? []
    if (uploadIds.length > 0) {
      const existingUploads = await tx.upload.findMany({ where: { id: { in: uploadIds } }, select: { id: true } })
      if (existingUploads.length !== uploadIds.length) {
        // The uploads were reaped or removed while the fee was still payable.
        // Attaching them would violate the ItemUpload FK and, if uncaught, wedge
        // the observer (the cursor only advances on a clean run); drop the edit
        // instead. The fee stays recorded as an observation.
        logWarn('applyPendingItemUpdate: uploads missing; dropped deferred edit', { payInId: payIn.id, itemId: pending.itemId })
        alert('warn', 'deferred edit dropped: uploads missing', `payIn ${payIn.id}, item ${pending.itemId}`, { dedupeKey: `applyPendingItemUpdate-missing-${payIn.id}` })
        return await drop()
      }
    }

    await applyItemUpdate(tx, payIn, args)
    return true
  }, { timeout: 10000 })

  if (applied) await onPaidSideEffects(models, payIn.id)
  return applied
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
  // compare timestamps to only notify if mention or item referral was just created to avoid duplicates on edits
  for (const { userId, createdAt } of item.mentions) {
    if (item.updatedAt.getTime() !== createdAt.getTime()) continue
    notifyMention({ models, item, userId }).catch(console.error)
  }
  for (const { refereeItem, createdAt } of item.itemReferrers) {
    if (item.updatedAt.getTime() !== createdAt.getTime()) continue
    notifyItemMention({ models, referrerItem: item, refereeItem }).catch(console.error)
  }
}

export async function describe (models, payInId) {
  const { item } = await models.itemPayIn.findUnique({ where: { payInId }, include: { item: true } })
  return `SN: update ${item.parentId ? `reply #${item.id} to #${item.parentId}` : `post #${item.id}`}`
}
