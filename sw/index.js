/* global self */
import { precacheAndRoute } from 'workbox-precaching'
import { offlineFallback } from 'workbox-recipes'
import { setDefaultHandler } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'
import { enable } from 'workbox-navigation-preload'

import ServiceWorkerStorage from 'serviceworker-storage'
import { CLEAR_NOTIFICATIONS, DELETE_SUBSCRIPTION, STORE_SUBSCRIPTION } from '@/lib/sw-messages'
import { renewPushSubscription, flushPendingRenewal, PENDING_RENEWAL_KEY, RENEWAL_RETRY_TAG } from '@/lib/push-subscription'

// we store existing push subscriptions for the onpushsubscriptionchange event
const storage = new ServiceWorkerStorage('sw:storage', 1)

// comment out to enable workbox console logs
self.__WB_DISABLE_DEV_LOGS = true

// Every storage mutation the service worker performs is serialized through
// this queue: concurrent events (a background replay and an account switch, a
// page-side subscription store and an in-flight replay) must not interleave
// read-decide-write cycles and clobber each other's records.
let storageQueue = Promise.resolve()
const withStorage = operation => {
  const next = storageQueue.catch(() => {}).then(operation)
  storageQueue = next
  return next
}

// preloading improves startup performance
// https://developer.chrome.com/docs/workbox/modules/workbox-navigation-preload/
enable()

precacheAndRoute(self.__WB_MANIFEST,
  {
    // this returns url fallbacks, we map CDN urls to the origin because that's how they are cached
    // source: https://github.com/GoogleChrome/workbox/blob/e26d8d7507f9412ba029922f3d9920e68710f2cf/packages/workbox-precaching/src/utils/generateURLVariations.ts#L54-L59
    urlManipulation: ({ url }) => {
      if (url.hostname === 'a.stasher.news') {
        const newUrl = new URL(url.pathname, 'https://stasher.news')
        return [newUrl]
      }
      return [url]
    }
  }
)

// immediately replace existing service workers with this one
// (no wait until this one becomes active)
self.addEventListener('install', () => self.skipWaiting())

// Using network-only as the default strategy ensures that we fallback
// to the browser as if the service worker wouldn't exist.
// The browser may use own caching (HTTP cache).
// Also, the offline fallback only works if request matched a route
setDefaultHandler(new NetworkOnly({
  plugins: [{
    fetchDidFail: async (args) => {
      //  tell us why a request failed in dev
      // process.env.NODE_ENV !== 'production' && console.log('fetch did fail', ...args)
    },
    fetchDidSucceed: async ({ request, response, event, state }) => {
      if (
        response.ok &&
        request.headers.get('x-nextjs-data') &&
        response.headers.get('x-nextjs-matched-path') &&
        response.headers.get('content-type') === 'application/json' &&
        response.headers.get('content-length') === '2' &&
        response.status === 200) {
        console.log('service worker detected a successful yet empty nextjs SSR data response')
        console.log('nextjs has a bug where it returns a 200 with empty data when it should return a 404')
        console.log('see https://github.com/vercel/next.js/issues/56852')
        console.log('HACK ... intercepting response and returning 404')

        const headers = new Headers(response.headers)
        headers.delete('x-nextjs-matched-path')
        headers.delete('content-type')
        headers.delete('content-length')
        return new Response(null, {
          status: 404,
          statusText: 'Not Found',
          headers,
          ok: false
        })
      }
      return response
    }
  }]
}))

// This won't work in dev because pages are never cached.
// See https://github.com/vercel/next.js/blob/337fb6a9aadb61c916f0121c899e463819cd3f33/server/render.js#L181-L185
offlineFallback({ pageFallback: '/offline' })

self.addEventListener('push', function (event) {
  let title, options

  try {
    const { notification } = event.data?.json()
    if (!notification) {
      throw new Error('no payload in push event')
    }

    // adapt declarative payload for legacy Push API
    options = notification || {}
    title = notification.title
  } catch (err) {
    // we show a default nofication on any error because we *must* show a notification
    // else the browser will show one for us or worse, remove our push subscription
    return event.waitUntil(
      self.registration.showNotification(
        // TODO: funny message as easter egg?
        // example: "dude i'm bugging, that's wild" from https://www.youtube.com/watch?v=QsQLIaKK2s0&t=176s but in wild west theme?
        'something went wrong',
        { icon: '/icons/icon_x96.png' }
      )
    )
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => self.registration.getNotifications())
      .then(notifications => self.navigator.setAppBadge?.(notifications.length))
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()

  const promises = []
  const url = event.notification.data?.url
  if (url) {
    // First try to find and focus an existing client before opening a new window
    promises.push(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => {
          if (clients.length > 0) {
            const client = clients[0]
            return client.focus().then(() => client.navigate(url))
          } else {
            return self.clients.openWindow(url)
          }
        })
    )
  }

  promises.push(
    self.registration.getNotifications()
      .then(notifications => self.navigator.setAppBadge?.(notifications.length))
  )

  event.waitUntil(Promise.all(promises))
})

// not supported by iOS
// see https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclose_event
self.addEventListener('notificationclose', function (event) {
  event.waitUntil(
    self.registration.getNotifications()
      .then(notifications => self.navigator.setAppBadge?.(notifications.length))
  )
})

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(withStorage(() =>
    // replay a renewal the server never acknowledged before replacing again
    flushPendingRenewal({ storage, fetch })
      .catch(() => {})
      .then(() => renewPushSubscription(event, { registration: self.registration, storage, fetch }))
  ))
})

// Background Sync replays a renewal the server could not be told about while
// no page is open (Chromium only; elsewhere the next pushsubscriptionchange or
// the next site visit retries instead)
self.addEventListener('sync', function (event) {
  if (event.tag === RENEWAL_RETRY_TAG) {
    event.waitUntil(withStorage(() => flushPendingRenewal({ storage, fetch })))
  }
})

self.addEventListener('message', function (event) {
  switch (event.data.action) {
    case STORE_SUBSCRIPTION: return event.waitUntil(withStorage(() => storage.setItem('subscription', { ...event.data.subscription, swVersion: 2 })))
    case DELETE_SUBSCRIPTION: return event.waitUntil(withStorage(() => Promise.all([storage.removeItem('subscription'), storage.removeItem(PENDING_RENEWAL_KEY)])))
    case CLEAR_NOTIFICATIONS:
      return event.waitUntil(
        Promise.all([
          self.registration.getNotifications()
            .then(notifications => notifications.forEach(notification => notification.close())),
          self.navigator.clearAppBadge?.()
        ])
      )
  }
})
