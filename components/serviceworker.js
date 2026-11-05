import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Workbox } from 'workbox-window'
import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { requestPersistentStorage } from './use-indexeddb'
import { CLEAR_NOTIFICATIONS, DELETE_SUBSCRIPTION, STORE_SUBSCRIPTION } from '@/lib/sw-messages'
import { getPushConfigError } from '@/lib/vapid-config'
import { SAVE_PUSH_SUBSCRIPTION, detachPushSubscription } from '@/lib/push-subscription'
import { useMe } from './me'

const ServiceWorkerContext = createContext()

export { CLEAR_NOTIFICATIONS, DELETE_SUBSCRIPTION, STORE_SUBSCRIPTION }

// A revocation must survive full-page navigations (the email sign-in round-trip
// reloads the document), so the transitioning state is mirrored in this session
// key, holding the id of the account whose delivery was revoked ('' when the
// transition started from an anonymous session).
const PUSH_TRANSITION_KEY = 'pushTransitionFrom'

export const ServiceWorkerProvider = ({ children }) => {
  const { me } = useMe()
  const userId = me?.id ? Number(me.id) : null
  const [registration, setRegistration] = useState(null)
  const [hasSubscription, setHasSubscription] = useState(false)
  const [pushError, setPushError] = useState(null)
  const [busy, setBusy] = useState(false)
  const transitioning = useRef(false)
  const pending = useRef(null)
  const latestUserId = useRef(userId)
  latestUserId.current = userId
  const [resumeVersion, setResumeVersion] = useState(0)
  const [support, setSupport] = useState({ serviceWorker: undefined, pushManager: undefined })
  const [permission, setPermission] = useState({ notification: undefined })
  const [savePushSubscription] = useMutation(gql(SAVE_PUSH_SUBSCRIPTION))
  const [deletePushSubscription] = useMutation(
    gql`
      mutation deletePushSubscription($endpoint: String!) {
        deletePushSubscription(endpoint: $endpoint) {
          id
        }
      }
    `)

  const getRegistration = useCallback(async () => {
    const active = registration ?? await navigator.serviceWorker.getRegistration()
    if (!active) {
      throw new Error('no active service worker found — push notifications are unavailable (service workers need HTTPS or localhost)')
    }
    return active
  }, [registration])

  const enqueue = useCallback(operation => {
    setBusy(true)
    const result = (pending.current ?? Promise.resolve()).catch(() => {}).then(operation)
    pending.current = result
    const finish = () => {
      if (pending.current === result) { pending.current = null; setBusy(false) }
    }
    result.then(finish, finish)
    return result
  }, [])

  const subscribeToPushNotifications = useCallback(async (sendConfirmation = true) => {
    const configError = getPushConfigError()
    if (configError) throw new Error(configError)
    if (!userId || latestUserId.current !== userId || transitioning.current) return
    const active = await getRegistration()
    const subscription = await active.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBKEY })
    const serialized = JSON.parse(JSON.stringify(subscription))
    try {
      await savePushSubscription({ variables: { endpoint: serialized.endpoint, ...serialized.keys, expectedUserId: userId, sendConfirmation } })
    } catch (err) {
      await subscription.unsubscribe()
      setHasSubscription(false)
      throw err
    }
    if (latestUserId.current !== userId || transitioning.current) {
      await subscription.unsubscribe()
      await deletePushSubscription({ variables: { endpoint: serialized.endpoint } })
      return
    }
    active.active?.postMessage({ action: STORE_SUBSCRIPTION, subscription: { ...serialized, userId, applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBKEY } })
    window.localStorage.setItem('pushEnabled', 'true')
    setHasSubscription(true)
    setPushError(null)
    requestPersistentStorage()
  }, [getRegistration, savePushSubscription, deletePushSubscription, userId])

  const unsubscribeFromPushNotifications = useCallback(async () => {
    const active = await navigator.serviceWorker?.getRegistration()
    await detachPushSubscription({ registration: active, deleteSubscription: endpoint => deletePushSubscription({ variables: { endpoint } }) })
    active?.active?.postMessage({ action: DELETE_SUBSCRIPTION })
    active?.active?.postMessage({ action: CLEAR_NOTIFICATIONS })
    setHasSubscription(false)
  }, [deletePushSubscription])

  const prepareAccountSwitch = useCallback(async () => {
    transitioning.current = true
    // only an account-bound transition persists across documents: an
    // anonymous-origin revocation has no account to protect, and persisting it
    // would block push changes for whoever signs in after a full-page reload
    if (userId) window.sessionStorage.setItem(PUSH_TRANSITION_KEY, String(userId))
    else window.sessionStorage.removeItem(PUSH_TRANSITION_KEY)
    try {
      await enqueue(unsubscribeFromPushNotifications)
    } catch (err) {
      transitioning.current = false
      window.sessionStorage.removeItem(PUSH_TRANSITION_KEY)
      throw err
    }
  }, [enqueue, unsubscribeFromPushNotifications, userId])

  const resumePushSubscription = useCallback(() => {
    transitioning.current = false
    window.sessionStorage.removeItem(PUSH_TRANSITION_KEY)
    setResumeVersion(version => version + 1)
  }, [])

  const togglePushSubscription = useCallback(async () => {
    if (transitioning.current) throw new Error('finish switching accounts before changing push notifications')
    await enqueue(async () => {
      const active = await getRegistration()
      if (await active.pushManager.getSubscription()) {
        window.localStorage.removeItem('pushEnabled')
        await unsubscribeFromPushNotifications()
      } else {
        await subscribeToPushNotifications()
      }
    })
  }, [enqueue, getRegistration, subscribeToPushNotifications, unsubscribeFromPushNotifications])

  const requestNotificationPermission = useCallback(async () => {
    const result = await window.Notification.requestPermission()
    setPermission({ notification: result })
    if (result === 'granted') await togglePushSubscription()
    else throw new Error('notifications are blocked; allow them in your browser settings')
  }, [togglePushSubscription])

  useEffect(() => {
    // a transition started in a previous document (email sign-in) carries over
    transitioning.current = window.sessionStorage.getItem(PUSH_TRANSITION_KEY) !== null
    setSupport({
      serviceWorker: 'serviceWorker' in navigator,
      notification: 'Notification' in window,
      pushManager: 'PushManager' in window
    })
    setPermission({ notification: 'Notification' in window ? window.Notification.permission : 'denied' })

    if (!('serviceWorker' in navigator)) {
      return
    }

    // public/sw.js is emitted only by the InjectManifest build step; it is
    // absent under `next dev`, where /sw.js 302-redirects to the 404 page and
    // register() rejects with SecurityError ("The operation is insecure"). Skip
    // registration in dev, and always swallow failures so a missing/inaccessible
    // sw.js never surfaces as an unhandled rejection.
    if (process.env.NODE_ENV !== 'production') {
      return
    }

    const wb = new Workbox('/sw.js', { scope: '/' })
    wb.register()
      .then(registration => {
        if (registration.active) setRegistration(registration)
        else navigator.serviceWorker.ready.then(setRegistration).catch(err => setPushError(err))
      })
      .catch(err => {
        console.warn('service worker registration failed:', err?.message ?? err)
      })
  }, [])

  const pushConfigured = useMemo(() => !getPushConfigError(), [])
  // true once the ME query settled into a user or a confirmed anonymous state;
  // until then push delivery must be left untouched. A boolean so effect deps
  // stay stable across renders with fresh identity objects.
  const identityKnown = me !== undefined

  useEffect(() => {
    if (!registration?.pushManager || !pushConfigured) return
    enqueue(async () => {
      if (transitioning.current) {
        // hold the persisted revocation until a confirmed identity differs
        // from the account it was revoked for (the switch completed), or an
        // explicit resume releases it (canceled). The same account hydrating
        // again — e.g. the email round-trip still authenticated as the old
        // account — must not restore delivery.
        const revokedFor = window.sessionStorage.getItem(PUSH_TRANSITION_KEY)
        if (identityKnown && revokedFor && String(userId ?? '') !== revokedFor) {
          transitioning.current = false
          window.sessionStorage.removeItem(PUSH_TRANSITION_KEY)
          setResumeVersion(version => version + 1)
        }
        return
      }
      // identity not confirmed yet (ME query in flight or failed): neither
      // revoke nor resume until it settles
      if (!identityKnown) return
      if (latestUserId.current !== userId) return
      const subscription = await registration.pushManager.getSubscription()
      if (!userId) return await unsubscribeFromPushNotifications()
      if (window.Notification?.permission === 'granted' && (subscription || window.localStorage.getItem('pushEnabled') === 'true')) {
        await subscribeToPushNotifications(false)
      }
    }).catch(setPushError)
  }, [registration, pushConfigured, identityKnown, userId, resumeVersion, enqueue, subscribeToPushNotifications, unsubscribeFromPushNotifications])

  const contextValue = useMemo(() => ({
    registration,
    support,
    permission,
    pushConfigured,
    hasSubscription,
    pushError,
    busy,
    prepareAccountSwitch,
    resumePushSubscription,
    requestNotificationPermission,
    togglePushSubscription
  }), [registration, support, permission, pushConfigured, hasSubscription, pushError, busy, prepareAccountSwitch, resumePushSubscription, requestNotificationPermission, togglePushSubscription])

  return (
    <ServiceWorkerContext.Provider value={contextValue}>
      {children}
    </ServiceWorkerContext.Provider>
  )
}

export function clearNotifications () {
  return navigator.serviceWorker?.controller?.postMessage({ action: CLEAR_NOTIFICATIONS })
}

export function useServiceWorker () {
  return useContext(ServiceWorkerContext)
}
