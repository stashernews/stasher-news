export const SAVE_PUSH_SUBSCRIPTION = `
  mutation savePushSubscription(
    $endpoint: String!, $p256dh: String!, $auth: String!, $oldEndpoint: String,
    $expectedUserId: Int!, $sendConfirmation: Boolean!
  ) {
    savePushSubscription(endpoint: $endpoint, p256dh: $p256dh, auth: $auth,
      oldEndpoint: $oldEndpoint, expectedUserId: $expectedUserId, sendConfirmation: $sendConfirmation) { id }
  }
`

// A browser-held replacement the server does not know about is persisted under
// this key and replayed by the service worker's background opportunities. Past
// this window the endpoint it names is too stale to be worth reviving.
export const PENDING_RENEWAL_KEY = 'pendingRenewal'
const PENDING_RENEWAL_TTL_MS = 48 * 60 * 60 * 1000
export const RENEWAL_RETRY_TAG = 'push-subscription-renewal'

async function saveSubscription (subscription, { oldEndpoint, expectedUserId, sendConfirmation = false }, fetch) {
  const response = await fetch('/api/graphql', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: SAVE_PUSH_SUBSCRIPTION,
      variables: {
        endpoint: subscription.endpoint,
        ...subscription.keys,
        oldEndpoint,
        expectedUserId,
        sendConfirmation
      }
    })
  })
  const result = await response.json()
  if (!response.ok || result.errors?.length || !result.data?.savePushSubscription?.id) {
    throw new Error('push subscription renewal failed')
  }
}

export async function flushPendingRenewal ({ storage, fetch }) {
  const pending = await storage.getItem(PENDING_RENEWAL_KEY)
  if (!pending) return
  if (!pending.endpoint || !pending.keys || !pending.expectedUserId ||
    !Number.isFinite(pending.at) || Date.now() - pending.at > PENDING_RENEWAL_TTL_MS) {
    await storage.removeItem(PENDING_RENEWAL_KEY)
    return
  }
  await saveSubscription(
    { endpoint: pending.endpoint, keys: pending.keys },
    { oldEndpoint: pending.oldEndpoint, expectedUserId: pending.expectedUserId },
    fetch
  )
  await storage.setItem('subscription', {
    endpoint: pending.endpoint,
    keys: pending.keys,
    userId: pending.expectedUserId,
    applicationServerKey: pending.applicationServerKey
  })
  await storage.removeItem(PENDING_RENEWAL_KEY)
}

export async function renewPushSubscription (event, { registration, storage, fetch }) {
  const saved = await storage.getItem('subscription')
  if (!saved?.userId) return
  const oldSubscription = event.oldSubscription ?? saved
  let replacement = event.newSubscription ?? await registration.pushManager.getSubscription()
  const applicationServerKey = oldSubscription?.options?.applicationServerKey ?? saved.applicationServerKey
  if (!replacement && applicationServerKey) {
    const options = { userVisibleOnly: true, applicationServerKey }
    if (await registration.pushManager.permissionState(options) !== 'granted') return
    replacement = await registration.pushManager.subscribe(options)
  }
  if (!replacement || oldSubscription?.endpoint === replacement.endpoint) return
  const subscription = JSON.parse(JSON.stringify(replacement))
  const meta = {
    oldEndpoint: oldSubscription?.endpoint,
    expectedUserId: saved.userId,
    applicationServerKey: saved.applicationServerKey
  }
  try {
    await saveSubscription(subscription, meta, fetch)
  } catch (err) {
    // the browser already holds the replacement; persist it for a background
    // retry so one failed request does not strand it until the site reopens.
    // The ownership check rides along (expectedUserId) and the server
    // re-validates it on every replay.
    await storage.setItem(PENDING_RENEWAL_KEY, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      ...meta,
      at: Date.now()
    })
    if (registration?.sync?.register) {
      // registered inside the event lifetime: the retry is only guaranteed to
      // be scheduled while the worker is still alive, i.e. before this
      // promise settles
      await registration.sync.register(RENEWAL_RETRY_TAG).catch(() => {})
    }
    throw err
  }
  await storage.setItem('subscription', { ...subscription, userId: saved.userId, applicationServerKey: saved.applicationServerKey })
}

export async function detachPushSubscription ({ registration, deleteSubscription }) {
  const subscription = await registration?.pushManager?.getSubscription()
  if (!subscription) return
  await subscription.unsubscribe()
  await deleteSubscription(subscription.endpoint)
}
