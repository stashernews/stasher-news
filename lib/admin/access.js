import { SN_ADMIN_IDS, USER_ID } from '@/lib/constants'
import { authMethodLinks, activatedAuthMethods } from '@/lib/authMethods'

export async function adminAccess (models) {
  const [user, accounts, health] = await Promise.all([
    models.user.findUnique({ where: { id: USER_ID.stasher }, select: { pubkey: true, emailVerified: true, emailHash: true, nostrAuthPubkey: true, phrasePubkey: true, apiKeyEnabled: true } }),
    models.account.findMany({ where: { userId: USER_ID.stasher }, select: { provider: true } }),
    models.healthSnapshot.findUnique({ where: { id: 1 }, select: { adminEdgeOk: true, adminEdgeCheckedAt: true } })
  ])
  const methods = user ? activatedAuthMethods(authMethodLinks(user, accounts.map(account => account.provider))) : []
  return [
    { key: 'gateSecret', label: 'Private gate secret', pass: Buffer.byteLength(process.env.ADMIN_GATE_SECRET ?? '') >= 32, detail: 'Must be configured in app and proxy, at least 32 bytes.' },
    { key: 'loginMethods', label: '@stasher login methods', pass: methods.length === 1 && ['nostr', 'phrase'].includes(methods[0]), detail: methods.join(', ') || 'No linked method found.' },
    { key: 'apiKey', label: '@stasher API key disabled', pass: !!user && !user.apiKeyEnabled, detail: 'Account API keys grant no panel access; disable the account key separately.' },
    { key: 'adminIds', label: 'Only @stasher is an app admin', pass: SN_ADMIN_IDS.length === 1 && SN_ADMIN_IDS[0] === USER_ID.stasher, detail: 'Checks the separate public-app admin identity list.' },
    { key: 'alerts', label: 'Alerts configured', pass: !!process.env.ALERT_WEBHOOK_URL?.trim(), detail: 'Applies are refused without a configured alert destination.' },
    { key: 'publicEdge', label: 'Public admin paths blocked', pass: health?.adminEdgeOk === true, checkedAt: health?.adminEdgeCheckedAt?.toISOString() ?? null, detail: 'Last recorded operator edge check, not a live probe. Re-run after any routing change.' }
  ]
}
