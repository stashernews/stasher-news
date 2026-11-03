import * as constants from '@/lib/constants'
import { TRUST_DEFAULTS } from '@/lib/trust-defaults'

const PROCESS_VALUES = [
  'REQUIRED_CONFIRMATIONS', 'RATING_CONFIRMATIONS', 'REORG_GRACE_BLOCKS',
  'CHAIN_TIP_MAX_AGE_MS', 'MONERO_POLL_INTERVAL_MS', 'CONFIRM_POLL_INTERVAL_MS',
  'RECONCILE_PENDING_AGE_MS', 'PENDING_EXPIRY_MS', 'DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS',
  'STALE_DETECTED_EXPIRY_MS', 'GRAPHQL_RATE_LIMIT', 'DB_TRANSACTION_TIMEOUT',
  'DATABASE_CONNECTION_LIMIT', 'PRISMA_SLOW_LOGS_MS'
]
const INFRASTRUCTURE = ['MONERO_NETWORK', 'NEXT_PUBLIC_URL', 'DATABASE_URL', 'LWS_URL', 'MONEROD_RPC_URL', 'AWS_S3_ENDPOINT', 'NEXT_PUBLIC_AWS_UPLOAD_BUCKET']
const SECRETS = ['ADMIN_GATE_SECRET', 'NEXTAUTH_SECRET', 'ALERT_WEBHOOK_URL', 'LWS_WEBHOOK_TOKEN', 'MONERO_SPEND_KEY', 'VIEW_KEY_MASTER_KEY', 'SITE_INVITE_CODES']
const SENSITIVE = /SECRET|KEY|TOKEN|PASSWORD|URL|CREDENTIAL|COOKIE|INVITE_CODES/i

export function adminEnvironment (env = process.env) {
  const keys = [...new Set([...PROCESS_VALUES, ...INFRASTRUCTURE, ...SECRETS, ...Object.keys(env).filter(key => SENSITIVE.test(key))])]
  const rows = keys.map(key => {
    const sensitive = SENSITIVE.test(key)
    const value = sensitive ? (env[key] ? 'set' : 'missing') : String(constants[key] ?? env[key] ?? 'not configured')
    return { key, value, kind: sensitive ? 'presence' : 'processStart', source: key in constants ? 'lib/constants.js' : 'process environment', help: 'Read-only; changes require an authorized environment update and process restart.' }
  })
  for (const [key, value] of Object.entries(TRUST_DEFAULTS)) rows.push({ key: `default:${key}`, value: String(value), kind: 'code', source: 'lib/trust-defaults.js:2', help: 'Fallback used only if the settings singleton cannot be read.' })
  return rows
}
