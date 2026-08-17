import { FEE_ITEM_ABANDON_DAYS } from '@/lib/constants'
import { deleteReminders } from '@/lib/item'

// abandonFeeItems — 1-day abandonment sweep for never-paid PENDING_FEE items.
//
// A fee-gated item (post or reply) is created PENDING_FEE and is invisible to
// everyone except its author until rewardsWalletObserver observes the posting
// fee on-chain (flipPendingToLive → FEE_PAID). A fee the author never pays
// would otherwise linger forever: author-only visible, no badge, no re-pay
// path, no expiry. This sweep soft-deletes PENDING_FEE items past
// FEE_ITEM_ABANDON_DAYS (1 day), deletes their fee PayIn (the subaddress pool
// is ASSIGN-never-freed, so deleting the PayIn cannot cause reuse or
// misattribution — a late payment to the abandoned subaddress simply finds no
// pending PayIn and is ignored, matching the observer's tested behavior), and
// clears queued pgboss jobs for the item.
//
// This module exports TWO things (mirrors worker/confirmFinalizer.js):
//   - runAbandonFeeItemsOnce: the testable per-sweep core (no pg-boss).
//   - abandonFeeItems: the pg-boss handler; recurrence is cron-owned
//     (pgboss.schedule row abandonFeeItems, hourly) — no self-requeue.

export async function runAbandonFeeItemsOnce ({ models }) {
  const cutoff = new Date(Date.now() - FEE_ITEM_ABANDON_DAYS * 24 * 60 * 60 * 1000)

  const stale = await models.item.findMany({
    where: {
      feeStatus: 'PENDING_FEE',
      feePayInId: { not: null },
      deletedAt: null,
      createdAt: { lt: cutoff }
    },
    select: { id: true, feePayInId: true, userId: true }
  })

  let abandoned = 0
  for (const item of stale) {
    await models.$transaction(async tx => {
      // Re-validate inside the transaction: the fee may have landed (flip → FEE_PAID)
      // or the item may already be deleted between the scan and the tx. The
      // feeStatus/deletedAt guards make the update a no-op in both cases.
      // Soft-delete mirrors deleteItemByAuthor's semantics (blank text/title/url, null pollCost).
      const [fresh] = await tx.$queryRaw`
        UPDATE "Item"
        SET "deletedAt" = NOW(),
          text = CASE WHEN text IS NOT NULL THEN '*deleted by author*' ELSE text END,
          title = CASE WHEN title IS NOT NULL THEN 'deleted by author' ELSE title END,
          url = NULL,
          "pollCost" = NULL
        WHERE id = ${item.id}::int
          AND "feeStatus" = 'PENDING_FEE'
          AND "deletedAt" IS NULL
          AND "feePayInId" IS NOT NULL
        RETURNING id`
      if (!fresh) return

      // The fee PayIn is orphaned once the item is gone; delete it so the
      // observer stops watching the subaddress (pool rows stay ASSIGNED).
      await tx.payIn.delete({ where: { id: item.feePayInId } })

      // Clear queued jobs for this item (timestampItem/imgproxy from onPaid;
      // deleteItem/reminder from performBotBehavior) so they don't fire on a
      // deleted item.
      await tx.$queryRaw`
        DELETE FROM pgboss.job
        WHERE (data->>'id' = ${String(item.id)} OR data->>'itemId' = ${String(item.id)})
          AND state <> 'completed'`
      await deleteReminders({ id: item.id, userId: item.userId, models: tx })
    })
    abandoned += 1
  }

  return { abandoned }
}

// pg-boss handler. Runs one sweep per invocation; recurrence is cron-owned
// (pgboss.schedule row abandonFeeItems) — no self-requeue.
export async function abandonFeeItems ({ models }) {
  const out = await runAbandonFeeItemsOnce({ models })
  if (out.abandoned) console.log(`abandonFeeItems: soft-deleted ${out.abandoned} unpaid item(s)`)
}
