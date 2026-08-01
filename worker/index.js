// environment variables are loaded from files and imports run before the rest of the code
import './loadenv'
import PgBoss from 'pg-boss'
import createPrisma from '@/lib/create-prisma'
import { repin } from './repin'
import { trust } from './trust'
import { earn, earnRefill } from './earn'
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
import { penaltyIndexer } from './penaltyIndexer'
import { rewardsDistributor } from './rewardsDistributor'
import { rotateViewKeys } from './rotateViewKeys'
import { reconcilePendingTips } from './reconcilePendingTips'
import { webhookCleanup } from './webhookCleanup'

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

  boss.on('error', error => console.error(error))

  function jobWrapper (fn) {
    return async function (job) {
      console.log(`running ${job.name} with args`, job.data)
      if (job.retrycount > 0) {
        console.log(`  ... retry #${job.retrycount}/${job.retrylimit}`)
      }
      try {
        await fn({ ...job, ...args })
      } catch (error) {
        console.error(`error running ${job.name}`, error)
        throw error
      }
      console.log(`finished ${job.name}`)
    }
  }

  await boss.start()

  if (isServiceEnabled('search')) {
    await boss.work('indexItem', jobWrapper(indexItem))
    await boss.work('indexAllItems', jobWrapper(indexAllItems))
  }
  if (isServiceEnabled('images')) {
    await boss.work('imgproxy', jobWrapper(imgproxy))
    await boss.work('deleteUnusedImages', jobWrapper(deleteUnusedImages))
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
  await boss.work('timestampItem', { includeMetadata: true }, jobWrapper(timestampItem))
  await boss.work('earn', jobWrapper(earn))
  await boss.work('earnRefill', jobWrapper(earnRefill))
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

  // Seed the self-requeuing confirmFinalizer loop the same way as moneroIndexer
  // (singleton guard on the seed only). Confirmation is low-frequency
  // (CONFIRM_POLL_INTERVAL_MS, default 60s) so it gets its own loop rather
  // than being piggybacked on the indexer's 20s cadence.
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

  // penaltyIndexer: polls the platform rewards wallet for posting/territory fee
  // outputs (subaddress attribution). Same self-requeuing pattern as confirmFinalizer.
  await boss.work('penaltyIndexer', jobWrapper(penaltyIndexer))
  if (await boss.getQueueSize('penaltyIndexer') === 0) {
    await boss.send('penaltyIndexer', {})
  }

  // rewardsDistributor: weekly rewards-pool distribution (earmark inflow, compute
  // curator shares, write QUEUED payouts). Self-requeues weekly (7d startAfter).
  await boss.work('rewardsDistributor', jobWrapper(rewardsDistributor))
  // Unlike penaltyIndexer/confirmFinalizer (which seed immediately), the
  // rewardsDistributor seed starts AFTER a full week: the first payout needs a
  // week of inflow to accumulate first. `sndev monero distribute` covers any
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

  console.log('working jobs')
}

work()
