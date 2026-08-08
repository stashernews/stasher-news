// environment variables are loaded from files and imports run before the rest of the code
import './loadenv'
import PgBoss from 'pg-boss'
import createPrisma from '@/lib/create-prisma'
import { repin } from './repin'
import { trust } from './trust'
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client'
import { indexItem, indexAllItems } from './search'
import { timestampItem } from './ots'
import { computeStreaks, checkStreak } from './streak'
import { nip57 } from './nostr'
import fetch from 'cross-fetch'
import { imgproxy } from './imgproxy'
import { deleteItem } from './ephemeralItems'
import { deleteUnusedImages } from './deleteUnusedImages'
import { territoryBilling } from './territory'
import { ofac } from './ofac'
import { saltAndHashEmails } from './saltAndHashEmails'
import { remindUser } from './reminder'
import { thisDay } from './thisDay'
import { isServiceEnabled } from '@/lib/sndev'
import { payWeeklyPostBounty, weeklyPost } from './weeklyPosts'
import { postToSocial } from './socialPoster'
import {
  domainVerification,
  deleteCertificateExternal,
  checkActiveDomainsDNS,
  clearLongHeldDomains
} from './domainVerification.js'
import { untrackOldItems } from './untrackOldItems'
import { confirmFinalizer } from './confirmFinalizer'
import { rewardsWalletObserver } from './rewardsWalletObserver'
import { rewardsDistributor } from './rewardsDistributor'
import { rotateViewKeys } from './rotateViewKeys'
import { reconcilePendingTips } from './reconcilePendingTips'
import { webhookCleanup } from './webhookCleanup'
import { dbBackup } from './dbBackup'
import { writeWorkerHeartbeat } from './heartbeat'
import { logInfo, logError } from '@/lib/logger'

// WebSocket polyfill
import ws from 'isomorphic-ws'

if (typeof WebSocket === 'undefined') {
  global.WebSocket = ws
}

async function work () {
  const CLEANUP_INTERVAL_SECONDS = 60 * 60 // hourly — must match worker/webhookCleanup.js
  const boss = new PgBoss(process.env.DATABASE_URL)
  const models = createPrisma({
    connectionParams: { connection_limit: process.env.DB_WORKER_CONNECTION_LIMIT }
  })

  const apollo = new ApolloClient({
    link: new HttpLink({
      uri: `${process.env.SELF_URL}/api/graphql`,
      fetch
    }),
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache'
      },
      query: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache'
      }
    }
  })

  const args = { boss, models, apollo }

  boss.on('error', error => logError(error))

  function jobWrapper (fn) {
    return async function (job) {
      writeWorkerHeartbeat()
      logInfo(`running ${job.name} with args`, job.data)
      if (job.retrycount > 0) {
        logInfo(`  ... retry #${job.retrycount}/${job.retrylimit}`)
      }
      try {
        await fn({ ...job, ...args })
      } catch (error) {
        logError(`error running ${job.name}`, error)
        throw error
      }
      logInfo(`finished ${job.name}`)
    }
  }

  await boss.start()
  writeWorkerHeartbeat()

  if (isServiceEnabled('search')) {
    await boss.work('indexItem', jobWrapper(indexItem))
    await boss.work('indexAllItems', jobWrapper(indexAllItems))
  }
  if (isServiceEnabled('images')) {
    await boss.work('imgproxy', jobWrapper(imgproxy))
    await boss.work('deleteUnusedImages', jobWrapper(deleteUnusedImages))
    // daily unused-image sweep; self-requeues on a 24h startAfter. Seed on
    // fresh installs (deferred 24h) so a brand-new stack lands a first run,
    // mirroring the trust deferred-seed pattern.
    if (await boss.getQueueSize('deleteUnusedImages') === 0) {
      await boss.send('deleteUnusedImages', {}, { startAfter: 24 * 60 * 60 })
    }
  }
  if (isServiceEnabled('domains')) {
    await boss.work('domainVerification', jobWrapper(domainVerification))
    await boss.work('deleteDomainCertificate', jobWrapper(deleteCertificateExternal))
    await boss.work('checkActiveDomainsDNS', jobWrapper(checkActiveDomainsDNS))
    await boss.work('clearLongHeldDomains', jobWrapper(clearLongHeldDomains))
  }
  await boss.work('weeklyPost-*', jobWrapper(weeklyPost))
  await boss.work('payWeeklyPostBounty', jobWrapper(payWeeklyPostBounty))
  await boss.work('repin-*', jobWrapper(repin))
  await boss.work('trust', jobWrapper(trust))
  // trust recomputes nightly via the pgboss.schedule row (0 2 * * * America/Chicago).
  // Self-seed on fresh installs (deferred 24h) so a brand-new stack lands a first run
  // without waiting on the cron, mirroring the rewardsDistributor deferred-seed pattern.
  if (await boss.getQueueSize('trust') === 0) {
    await boss.send('trust', {}, { startAfter: 24 * 60 * 60 })
  }
  await boss.work('timestampItem', { includeMetadata: true }, jobWrapper(timestampItem))
  await boss.work('streak', jobWrapper(computeStreaks))
  await boss.work('checkStreak', jobWrapper(checkStreak))
  await boss.work('nip57', jobWrapper(nip57))
  await boss.work('deleteItem', jobWrapper(deleteItem))
  await boss.work('territoryBilling', jobWrapper(territoryBilling))
  await boss.work('ofac', jobWrapper(ofac))
  await boss.work('saltAndHashEmails', jobWrapper(saltAndHashEmails))
  await boss.work('reminder', jobWrapper(remindUser))
  await boss.work('thisDay', jobWrapper(thisDay))
  await boss.work('socialPoster', jobWrapper(postToSocial))
  await boss.work('untrackOldItems', jobWrapper(untrackOldItems))

  await boss.work('confirmFinalizer', jobWrapper(confirmFinalizer))

  // Seed the self-requeuing confirmFinalizer loop (singleton guard on the seed
  // only). Confirmation is low-frequency (CONFIRM_POLL_INTERVAL_MS, default 60s).
  if (await boss.getQueueSize('confirmFinalizer') === 0) {
    await boss.send('confirmFinalizer', {})
  }

  // reconcilePendingTips: recover PENDING tips stranded by a missed 0-conf webhook, and
  // expire never-paid tips. Self-requeues on a 2min startAfter.
  await boss.work('reconcilePendingTips', jobWrapper(reconcilePendingTips))
  if (await boss.getQueueSize('reconcilePendingTips') === 0) {
    await boss.send('reconcilePendingTips', {})
  }

  // webhookCleanup: hourly sweep of orphaned lws webhooks (CONFIRMED/EXPIRED tips).
  await boss.work('webhookCleanup', jobWrapper(webhookCleanup))
  if (await boss.getQueueSize('webhookCleanup') === 0) {
    await boss.send('webhookCleanup', {}, { startAfter: CLEANUP_INTERVAL_SECONDS / 4 }) // first sweep after 15min
  }

  // rewardsWalletObserver: polls the platform rewards wallet for posting/territory
  // fee outputs (subaddress attribution) and downvote payments (payment_id
  // attribution). Same self-requeuing pattern as confirmFinalizer.
  await boss.work('rewardsWalletObserver', jobWrapper(rewardsWalletObserver))
  if (await boss.getQueueSize('rewardsWalletObserver') === 0) {
    await boss.send('rewardsWalletObserver', {})
  }

  // rewardsDistributor: weekly rewards-pool distribution (earmark inflow, compute
  // curator shares, write QUEUED payouts). Recurring runs are owned by the
  // pgboss.schedule row (cron 0 0 * * 1 UTC, migration
  // 20260807160000_schedule_rewards_distributor) — NOT a self-requeue — so each
  // run lands on the Monday 00:00 UTC the rewards resolver counts down to.
  await boss.work('rewardsDistributor', jobWrapper(rewardsDistributor))
  // Fresh-install seed only: the first payout needs a week of inflow to
  // accumulate, so on a brand-new stack we defer one run 7d (the cron then owns
  // every subsequent week). The handler does NOT self-requeue, so this cannot
  // create recurring double scheduling. `sndev monero distribute` covers any
  // out-of-band run before that.
  if (await boss.getQueueSize('rewardsDistributor') === 0) {
    await boss.send('rewardsDistributor', {}, { startAfter: 7 * 24 * 60 * 60 })
  }

  // rotateViewKeys: quarterly DEK-hygiene re-wrap of every encrypted view key.
  // Self-requeues on a 90d startAfter; the seed starts it after a day so it doesn't
  // fire on every fresh boot. Mirrors the rewardsDistributor deferred-seed pattern.
  await boss.work('rotateViewKeys', jobWrapper(rotateViewKeys))
  if (await boss.getQueueSize('rotateViewKeys') === 0) {
    await boss.send('rotateViewKeys', {}, { startAfter: 24 * 60 * 60 })
  }

  // dbBackup: nightly encrypted DB dump (pg_dump | gpg -> BACKUP_DIR) with
  // retention pruning + optional S3 upload. Recurring runs are owned by the
  // pgboss.schedule row (cron 0 3 * * * UTC, migration
  // 20260808160000_schedule_db_backup) — NOT a self-requeue — mirroring
  // rewardsDistributor. Fresh installs get one deferred (24h) run so a
  // brand-new stack lands a first backup before waiting on the cron.
  await boss.work('dbBackup', jobWrapper(dbBackup))
  if (await boss.getQueueSize('dbBackup') === 0) {
    await boss.send('dbBackup', {}, { startAfter: 24 * 60 * 60 })
  }

  logInfo('working jobs')
}

work()
