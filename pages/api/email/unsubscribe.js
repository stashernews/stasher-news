import models from '@/api/models'
import { verifyUnsubscribeToken } from '@/lib/emailCrypto'
import { logError } from '@/lib/logger'

// One-click unsubscribe for the weekly digest. The link is signed (HMAC of the
// user id under EMAIL_MASTER_KEY), so no session is needed. Only POST mutates —
// the RFC 8058 one-click target or the confirm form's submission; GET renders a
// confirmation page and is scanner-safe (inbox scanners prefetch links, so a
// mutating GET would unsubscribe people who never clicked).

const CONFIRM_HTML = '<!doctype html><html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;"><h3>unsubscribed</h3><p>you will no longer receive the weekly digest. you can turn it back on in settings.</p></body></html>'
const CONFIRM_PAGE_HTML = '<!doctype html><html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;"><h3>unsubscribe from the weekly digest?</h3><p>confirm below and you will no longer receive it.</p><form method="post" action=""><button type="submit">unsubscribe</button></form></body></html>'
const INVALID_HTML = '<!doctype html><html><body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;"><h3>invalid link</h3><p>this unsubscribe link is invalid or expired.</p></body></html>'

function queryParam (value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

export async function handleUnsubscribe (req, res, modelsArg) {
  const userId = Number(queryParam(req.query?.u))
  const token = queryParam(req.query?.t)
  const isGet = req.method === 'GET'

  if (!Number.isInteger(userId) || userId <= 0 || !verifyUnsubscribeToken(userId, token)) {
    if (isGet) {
      res.setHeader('Content-Type', 'text/html')
      res.status(400).send(INVALID_HTML)
    } else {
      res.status(400).end()
    }
    return
  }

  if (isGet) {
    res.setHeader('Content-Type', 'text/html')
    res.status(200).send(CONFIRM_PAGE_HTML)
    return
  }

  try {
    await modelsArg.user.update({ where: { id: userId }, data: { emailNotifications: false } })
  } catch (err) {
    logError('unsubscribe: update failed', err)
    res.status(500).end()
    return
  }

  res.setHeader('Content-Type', 'text/html')
  res.status(200).send(CONFIRM_HTML)
}

export default async function handler (req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).end()
    return
  }
  return await handleUnsubscribe(req, res, models)
}
