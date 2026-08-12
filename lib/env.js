import { logError } from '@/lib/logger'

const INSECURE_EXACT = new Set(['', 'test', 'password', 'secret'])
// substrings that indicate a placeholder default even when embedded in a value
// (e.g. DATABASE_URL="postgresql://sn:changeme@db:5432/..." — .env.development:92)
const INSECURE_SUBSTRING = ['changeme', 'change-me']

function isInsecure (v) {
  if (v == null) return true
  const s = String(v).trim()
  if (s === '' || INSECURE_EXACT.has(s.toLowerCase())) return true
  return INSECURE_SUBSTRING.some((sub) => s.toLowerCase().includes(sub))
}

// Required in production. Each is empty/insecure-by-default in the tracked env files
// and silently breaks a money-moving or crypto path if left unset.
const PROD_REQUIRED = [
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'JWT_SIGNING_PRIVATE_KEY',
  'EMAIL_SALT',
  'VIEWKEY_MASTER_KEY',
  'LWS_WEBHOOK_TOKEN',
  'MONERO_LWS_ADMIN_AUTH'
]

export function validateEnv ({ env = process.env, nodeEnv = process.env.NODE_ENV } = {}) {
  if (nodeEnv !== 'production') return true
  const missing = PROD_REQUIRED.filter((k) => isInsecure(env[k]))
  if (missing.length) {
    logError({ missing }, 'FATAL: required environment variables missing or insecure in production')
    throw new Error(`Missing or insecure required environment variables in production: ${missing.join(', ')}`)
  }
  return true
}
