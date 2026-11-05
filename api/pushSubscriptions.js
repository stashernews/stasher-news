import { GqlInputError } from '@/lib/error'

export async function saveSubscription ({ models, userId, endpoint, p256dh, auth, oldEndpoint }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await models.$transaction(tx => persistSubscription(tx, { userId, endpoint, p256dh, auth, oldEndpoint }), { isolationLevel: 'Serializable' })
    } catch (err) {
      if (err.code !== 'P2034' || attempt === 2) throw err
    }
  }
}

async function persistSubscription (tx, { userId, endpoint, p256dh, auth, oldEndpoint }) {
  const existing = await tx.pushSubscription.findUnique({ where: { endpoint } })
  if (existing && existing.userId !== userId && (existing.p256dh !== p256dh || existing.auth !== auth)) {
    throw new GqlInputError('subscription belongs to another account')
  }
  const data = { userId, endpoint, p256dh, auth }
  const subscription = await tx.pushSubscription.upsert({ where: { endpoint }, create: data, update: data })
  if (oldEndpoint && oldEndpoint !== endpoint) {
    await tx.pushSubscription.deleteMany({ where: { endpoint: oldEndpoint, userId } })
  }
  return subscription
}

export async function deleteSubscription ({ models, userId, endpoint }) {
  const subscription = await models.pushSubscription.findFirst({ where: { endpoint, userId } })
  await models.pushSubscription.deleteMany({ where: { endpoint, userId } })
  return subscription ?? null
}
