import { BOSS_RETRY, TERRITORY_GRACE_DAYS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'
import { nextBillingWithGrace } from '@/lib/territory'
import { datePivot } from '@/lib/time'
import { notifyTerritoryStatusChange } from '@/lib/webPush'

export async function territoryBilling ({ data: { subName }, boss, models }) {
  let sub = await models.sub.findUnique({
    where: {
      name: subName
    },
    include: {
      user: true,
      billingPayIn: true
    }
  })

  // ONCE turfs are never billed again, but an unpaid PENDING_FEE ONCE fee
  // (switch/unarchive) still lapses below.
  if (!sub) return
  if (sub.billingType === 'ONCE' && sub.billingStatus !== 'PENDING_FEE') return

  // Unpaid fee still pending: wait for the rewardsWalletObserver to observe it, but
  // lapse the turf once the grace window has fully passed.
  if (sub.billingStatus === 'PENDING_FEE') {
    const anchor = sub.billPaidUntil || sub.billingPayIn?.createdAt
    if (anchor && datePivot(new Date(anchor), { days: TERRITORY_GRACE_DAYS }) < new Date()) {
      sub = await models.sub.update({
        where: { name: subName },
        data: { billingStatus: 'LAPSED', status: 'STOPPED', statusUpdatedAt: new Date() },
        include: { user: true }
      })
      await notifyTerritoryStatusChange({ sub })
    }
    try {
      await boss.send('territoryBilling', { subName }, { ...BOSS_RETRY, startAfter: datePivot(new Date(), { days: 1 }) })
    } catch (e) {
      logError('territoryBilling requeue send failed', e)
      alert('critical', 'territoryBilling requeue failed', `sub ${subName}: ${e.message}`, { dedupeKey: `territoryBilling-requeue-${subName}` })
      throw e // rethrow so pg-boss retries THIS run and the chain survives
    }
    return
  }

  // Paid up: nothing to do until the next billing boundary — one-shot, no daily churn.
  if (sub.billPaidUntil && new Date(sub.billPaidUntil) > new Date()) {
    try {
      await boss.send('territoryBilling', { subName }, { ...BOSS_RETRY, startAfter: new Date(sub.billPaidUntil) })
    } catch (e) {
      logError('territoryBilling requeue send failed', e)
      alert('critical', 'territoryBilling requeue failed', `sub ${subName}: ${e.message}`, { dedupeKey: `territoryBilling-requeue-${subName}` })
      throw e // rethrow so pg-boss retries THIS run and the chain survives
    }
    return
  }

  // Due: enter GRACE (or archive past grace) and remind the founder once on the
  // ACTIVE -> GRACE transition when they opted in to reminders.
  if (sub.status !== 'STOPPED') {
    const nextStatus = nextBillingWithGrace(sub) >= new Date() ? 'GRACE' : 'STOPPED'
    if (nextStatus !== sub.status) {
      sub = await models.sub.update({
        where: { name: subName },
        data: { status: nextStatus, statusUpdatedAt: new Date() },
        include: { user: true }
      })
      if (nextStatus === 'STOPPED' || sub.billingAutoRenew) {
        await notifyTerritoryStatusChange({ sub })
      }
    }
  }

  try {
    await boss.send('territoryBilling', { subName }, { ...BOSS_RETRY, startAfter: datePivot(new Date(), { days: 1 }) })
  } catch (e) {
    logError('territoryBilling requeue send failed', e)
    alert('critical', 'territoryBilling requeue failed', `sub ${subName}: ${e.message}`, { dedupeKey: `territoryBilling-requeue-${subName}` })
    throw e // rethrow so pg-boss retries THIS run and the chain survives
  }
}
